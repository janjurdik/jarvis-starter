# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["openwakeword==0.6.0", "numpy==2.3.5", "onnxruntime>=1.20,<1.32"]
#
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""
"Ahoj Jarvis" from the browser microphone stream. openWakeWord hey_jarvis on 80 ms frames (it also
reacts to "Ahoj Jarvis", only weaker, so the threshold is lower and Node checks the transcript) and
Silero VAD for the end of the sentence. Transcription is done by Node through the Whisper worker.
Audio arrives over the WebSocket /api/mic into Node and from there to this process.

stdin, frames: [1 B type][4 B length little-endian][data]
  type 1 = audio: 16 kHz mono int16 PCM (any length, processed in chunks of 1280 samples)
  type 2 = control, JSON: {"cmd": "suppress", "on": true} | {"cmd": "reset"} | {"cmd": "threshold", "value": 0.5}
stdout, JSON lines:
  {"event": "ready"}
  {"event": "wake", "score": 0.97}
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

    def reset(self, reason: str = "cancel") -> None:
        if self.mode == "record":
            emit({"event": "end", "reason": reason, "path": None, "audio_ms": round(len(self.rec) * BLOCK_S * 1000)})
        self.mode = "idle"
        self.pending = np.zeros(0, dtype=np.int16)
        self.ring = []
        self.rec = []
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
            return
        if self.need_reset:
            wake_model.reset()
            self.need_reset = False
        score = float(wake_model.predict(block)["hey_jarvis"])
        if score < threshold or time.monotonic() < self.cooldown_until:
            return
        emit({"event": "wake", "score": round(score, 3)})
        self.mode = "record"
        self.rec = list(self.ring)
        self.blocks_since_wake = 0
        self.speech_run = 0
        self.heard = False
        self.silent_s = 0.0
        vad.reset_states()

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
            self.seq += 1
            path = os.path.join(REC_DIR, f"wake-{os.getpid()}-{self.seq}.wav")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as fh, wave.open(fh, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(audio.astype("<i2").tobytes())
        emit({"event": "end", "reason": reason, "path": path, "audio_ms": round(audio.size / RATE * 1000)})
        self.mode = "idle"
        self.rec = []
        self.ring = []
        wake_model.reset()
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
            elif cmd == "threshold":
                threshold = float(msg.get("value", threshold))


if __name__ == "__main__":
    main()
