# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["openwakeword==0.6.0", "numpy==2.3.5", "onnxruntime>=1.20,<1.32"]
#
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""
"Ahoj Jarvis" from the browser microphone stream, two ways at once:
  1. openWakeWord hey_jarvis on 80 ms frames: instant, but trained on English "hey jarvis".
  2. Probe: Silero VAD cuts every spoken phrase, the first ~3 s of it go to Node, Whisper reads
     them and when the phrase says "Ahoj Jarvis", Node answers take/listen and the rest of the
     sentence is recorded as the command. This is what catches Slovak "Ahoj Jarvis".
Transcription is done by Node through the Whisper worker. Audio arrives over the WebSocket
/api/mic into Node and from there to this process.

stdin, frames: [1 B type][4 B length little-endian][data]
  type 1 = audio: 16 kHz mono int16 PCM (any length, processed in chunks of 1280 samples)
  type 2 = control, JSON: {"cmd": "suppress", "on": true} | {"cmd": "reset"} | {"cmd": "threshold", "value": 0.5}
           probe answers: {"cmd": "drop"} | {"cmd": "take"} (keep recording the phrase as the command)
           | {"cmd": "listen"} (the phrase was only the wake word, record the next one)
stdout, JSON lines:
  {"event": "ready"}
  {"event": "probe", "path": "/abs/p.wav", "ended": false, "peak": 0.12, "audio_ms": 3000}
  {"event": "wake", "score": 0.97, "via": "model" | "probe"}
  {"event": "level", "level": 0.42, "speech": true}            while recording, every frame (80 ms)
  {"event": "end", "reason": "silence|max|nospeech|cancel", "path": "/abs/x.wav" | null, "audio_ms": 2400}
Audio is stored only while it is being transcribed, in the folder given by Node (WAKE_REC_DIR, mode 0700).
Nothing is logged.
"""
import json
import os
import struct
import sys
import time
import wave

import numpy as np
import openwakeword
from openwakeword.model import Model
from openwakeword.vad import VAD

RATE = 16000
BLOCK = 1280                    # 80 ms, openWakeWord chce presne takéto rámce
BLOCK_S = BLOCK / RATE
PRE_ROLL_BLOCKS = 20            # ~1,6 s pred detekciou: celé „Ahoj Jarvis“, aby ho Node našiel v prepise
SPEECH_GRACE_S = 0.32           # reč tesne po detekcii je ešte chvost wake wordu, nie príkaz
SPEECH_START_BLOCKS = 3         # príkaz začal = 3 rámce reči za sebou (240 ms)
END_SILENCE_S = 0.8
START_WINDOW_S = 4.0            # po „Ahoj Jarvis“ je čas začať hovoriť
MAX_COMMAND_S = 12.0
COOLDOWN_S = 1.0
# Probe (Whisper): fráza = 2 rámce reči za sebou, koniec = 0,5 s ticha.
PROBE_S = 3.0                   # po toľkých sekundách reči ide začiatok frázy na prepis, aj keď sa ešte hovorí
SEG_PRE_BLOCKS = 6              # ~0,5 s pred začiatkom reči
SEG_START_BLOCKS = 2
SEG_END_SILENCE_S = 0.5
SEG_MIN_S = 0.4
AWAIT_TIMEOUT_S = 5.0           # Node neodpovedal: fráza sa zahodí
probe_on = os.environ.get("WAKE_PROBE", "1") != "0"

REC_DIR = os.environ.get("WAKE_REC_DIR", "/tmp")
threshold = float(os.environ.get("WAKE_THRESHOLD", "0.25"))

openwakeword.utils.download_models(["hey_jarvis"])
wake_model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
vad = VAD()


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def rms(block: np.ndarray) -> float:
    return float(np.sqrt(np.mean((block.astype(np.float32) / 32768.0) ** 2)))


def level_of(block: np.ndarray) -> float:
    # Zvuk z Chromu má AGC, reč je typicky 0,02 až 0,2 RMS. Odmocnina = prirodzenejšia krivka.
    return round(min(1.0, (rms(block) / 0.12) ** 0.5), 3)


class Stream:
    def __init__(self) -> None:
        self.pending = np.zeros(0, dtype=np.int16)
        self.ring: list = []
        self.mode = "idle"
        self.suppressed = False
        self.need_reset = False
        self.cooldown_until = 0.0
        self.rec: list = []
        self.blocks_since_wake = 0
        self.speech_run = 0
        self.heard = False
        self.silent_s = 0.0
        self.seq = 0
        self.seg = None                 # rozpracovaná fráza pre probe
        self.seg_run = 0
        self.seg_silent = 0.0
        self.seg_peak = 0.0
        self.seg_ended = False
        self.awaiting = False
        self.await_since = 0.0
        self.skip_until_silence = False

    def reset(self, reason: str = "cancel") -> None:
        if self.mode == "record":
            emit({"event": "end", "reason": reason, "path": None, "audio_ms": round(len(self.rec) * BLOCK_S * 1000)})
        self.mode = "idle"
        self.pending = np.zeros(0, dtype=np.int16)
        self.ring = []
        self.rec = []
        self.drop_segment()
        wake_model.reset()

    def feed(self, data: bytes) -> None:
        samples = np.frombuffer(data[: len(data) - (len(data) % 2)], dtype="<i2").astype(np.int16)
        self.pending = np.concatenate([self.pending, samples]) if self.pending.size else samples
        while self.pending.size >= BLOCK:
            block = self.pending[:BLOCK].copy()
            self.pending = self.pending[BLOCK:]
            self.block(block)

    def block(self, block: np.ndarray) -> None:
        if self.mode == "record":
            self.record(block)
            return
        self.ring.append(block)
        if len(self.ring) > PRE_ROLL_BLOCKS:
            self.ring.pop(0)
        if self.suppressed:
            # Jarvis práve hovorí: wake word sa nehľadá (ozvena z reproduktorov).
            self.need_reset = True
            if self.seg is not None or self.awaiting:
                self.drop_segment()
            return
        if self.need_reset:
            wake_model.reset()
            vad.reset_states()
            self.need_reset = False
        score = float(wake_model.predict(block)["hey_jarvis"])
        if score >= threshold and time.monotonic() >= self.cooldown_until:
            self.drop_segment()
            self.start_record(list(self.ring), score, "model")
            return
        if probe_on and time.monotonic() >= self.cooldown_until:
            self.segment(block, score)

    def start_record(self, rec: list, score: float, via: str, heard: bool = False, silent_s: float = 0.0) -> None:
        emit({"event": "wake", "score": round(score, 3), "via": via})
        self.mode = "record"
        self.rec = rec
        # Pri pokračujúcej fráze (take) je wake word už za nami: grace sa nečaká.
        self.blocks_since_wake = 0 if not heard else int(SPEECH_GRACE_S / BLOCK_S) + 1
        self.speech_run = 0
        self.heard = heard
        self.silent_s = silent_s
        vad.reset_states()

    # ── probe: frázy pre Whisper ─────────────────────────────────────────

    def drop_segment(self) -> None:
        if self.seg is not None and not self.seg_ended:
            # Fráza ešte beží: ďalšia sa začne až po tichu (inak by išiel na prepis každý 3 s kus monológu).
            self.skip_until_silence = True
        self.seg = None
        self.seg_run = 0
        self.seg_silent = 0.0
        self.seg_peak = 0.0
        self.seg_ended = False
        self.awaiting = False

    def segment(self, block: np.ndarray, score: float) -> None:
        speech = float(vad.predict(block, frame_size=640)) >= 0.5
        if self.awaiting:
            self.seg_peak = max(self.seg_peak, score)
            if not self.seg_ended:
                self.seg.append(block)
                self.seg_silent = 0.0 if speech else self.seg_silent + BLOCK_S
                if self.seg_silent >= END_SILENCE_S or len(self.seg) * BLOCK_S >= MAX_COMMAND_S:
                    self.seg_ended = True
            if time.monotonic() - self.await_since > AWAIT_TIMEOUT_S:
                self.drop_segment()
            return
        if self.seg is None:
            if self.skip_until_silence:
                self.seg_silent = 0.0 if speech else self.seg_silent + BLOCK_S
                if self.seg_silent >= SEG_END_SILENCE_S:
                    self.skip_until_silence = False
                    self.seg_silent = 0.0
                return
            self.seg_run = self.seg_run + 1 if speech else 0
            if self.seg_run >= SEG_START_BLOCKS:
                self.seg = list(self.ring[-(SEG_START_BLOCKS + SEG_PRE_BLOCKS):])
                self.seg_silent = 0.0
                self.seg_peak = score
            return
        self.seg.append(block)
        self.seg_peak = max(self.seg_peak, score)
        self.seg_silent = 0.0 if speech else self.seg_silent + BLOCK_S
        length = len(self.seg) * BLOCK_S
        if self.seg_silent >= SEG_END_SILENCE_S:
            if length - self.seg_silent >= SEG_MIN_S:
                self.probe(ended=True)
            else:
                self.drop_segment()
        elif length >= PROBE_S:
            self.probe(ended=False)

    def probe(self, ended: bool) -> None:
        audio = np.concatenate(self.seg)
        if ended:
            keep = audio.size - max(0, int((self.seg_silent - 0.2) * RATE))
            audio = audio[: max(keep, RATE // 2)]
        path = self.write_wav(audio, "probe")
        self.seg_ended = ended
        self.awaiting = True
        self.await_since = time.monotonic()
        emit({"event": "probe", "path": path, "ended": ended, "peak": round(self.seg_peak, 3), "audio_ms": round(audio.size / RATE * 1000)})

    def answer(self, cmd: str) -> None:
        """Odpoveď Node na probe. Platí, len kým fráza naozaj čaká (inak ju už prebila rýchla cesta)."""
        if not self.awaiting or self.mode != "idle":
            return
        seg, ended, silent, peak = self.seg, self.seg_ended, self.seg_silent, self.seg_peak
        self.seg = None
        self.drop_segment()
        if cmd == "take":
            self.start_record(seg, max(peak, 0.0), "probe", heard=True, silent_s=silent)
            if ended:
                self.finish("silence")
        elif cmd == "listen":
            self.start_record([], max(peak, 0.0), "probe")
        else:
            if not ended:
                self.skip_until_silence = True

    def write_wav(self, audio: np.ndarray, kind: str) -> str:
        self.seq += 1
        path = os.path.join(REC_DIR, f"{kind}-{os.getpid()}-{self.seq}.wav")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh, wave.open(fh, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(audio.astype("<i2").tobytes())
        return path

    def record(self, block: np.ndarray) -> None:
        self.rec.append(block)
        self.blocks_since_wake += 1
        since_wake = self.blocks_since_wake * BLOCK_S
        speech = float(vad.predict(block, frame_size=640)) >= 0.5
        emit({"event": "level", "level": level_of(block), "speech": speech})
        self.speech_run = self.speech_run + 1 if speech else 0
        if not self.heard and since_wake >= SPEECH_GRACE_S and self.speech_run >= SPEECH_START_BLOCKS:
            self.heard = True
        if self.heard:
            self.silent_s = 0.0 if speech else self.silent_s + BLOCK_S
        if self.heard and self.silent_s >= END_SILENCE_S:
            self.finish("silence")
        elif not self.heard and since_wake >= START_WINDOW_S:
            self.finish("nospeech")
        elif len(self.rec) * BLOCK_S >= MAX_COMMAND_S:
            self.finish("max")

    def finish(self, reason: str) -> None:
        audio = np.concatenate(self.rec) if self.rec else np.zeros(0, dtype=np.int16)
        path = None
        if self.heard and audio.size:
            # Ticho na konci (okrem 0,3 s) Whisper nepotrebuje.
            keep = audio.size - max(0, int((self.silent_s - 0.3) * RATE))
            audio = audio[: max(keep, RATE // 2)]
            path = self.write_wav(audio, "wake")
        emit({"event": "end", "reason": reason, "path": path, "audio_ms": round(audio.size / RATE * 1000)})
        self.mode = "idle"
        self.rec = []
        self.ring = []
        wake_model.reset()
        vad.reset_states()
        self.cooldown_until = time.monotonic() + COOLDOWN_S


def read_exact(stream, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def main() -> None:
    global threshold
    # Zahriatie: prvá inferencia ONNX je pomalšia.
    wake_model.predict(np.zeros(BLOCK, dtype=np.int16))
    vad.predict(np.zeros(BLOCK, dtype=np.int16), frame_size=640)
    wake_model.reset()
    vad.reset_states()
    emit({"event": "ready"})
    stream = Stream()
    stdin = sys.stdin.buffer
    while True:
        head = read_exact(stdin, 5)
        if head is None:
            break
        kind, length = head[0], struct.unpack("<I", head[1:5])[0]
        data = read_exact(stdin, length) if length else b""
        if data is None:
            break
        if kind == 1:
            stream.feed(data)
        elif kind == 2:
            try:
                msg = json.loads(data.decode("utf-8"))
            except ValueError:
                continue
            cmd = msg.get("cmd")
            if cmd == "suppress":
                stream.suppressed = bool(msg.get("on"))
            elif cmd == "reset":
                stream.reset("cancel")
            elif cmd in ("drop", "take", "listen"):
                stream.answer(cmd)
            elif cmd == "threshold":
                threshold = float(msg.get("value", threshold))


if __name__ == "__main__":
    main()
