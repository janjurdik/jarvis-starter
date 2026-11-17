# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "mlx-whisper==0.4.3",
#   "numpy==2.3.5",
#   "openwakeword==0.6.0",
#   "onnxruntime>=1.20,<1.32",
#   "imageio-ffmpeg==0.6.0",
# ]
#
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""
Speech to text for the HUD (push-to-talk and commands after "Hey Jarvis") with mlx-whisper.
Apple Silicon only. Audio is decoded by the ffmpeg binary that comes with the imageio-ffmpeg
package, so nothing has to be installed by hand. Silero VAD checks that the recording contains
speech first, otherwise the result is an empty text.

WHISPER_MODEL is a folder with the model (config.json and weights) or a Hugging Face repository id.
Package versions are pinned and `exclude-newer` freezes everything they pull in. onnxruntime is a
range on purpose: its newest builds need macOS 14, older Macs get the last one that still runs there.

stdin  {"id": "…", "path": "/abs/audio.webm", "prompt": "…"}
stdout {"ready": true, "engine": "mlx", "device": "metal"} once the model is loaded
       {"id": "…", "ok": true, "text": "…", "ms": 420} | {"id": "…", "ok": false, "error": "…"}
Neither audio nor text is logged anywhere.
"""
import json
import os
import shutil
import subprocess
import sys
import time

import mlx_whisper
import numpy as np
import openwakeword
from openwakeword.vad import VAD

MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
LANG = os.environ.get("JARVIS_LANG", "sk")
MIN_SPEECH_S = 0.16  # menej reči podľa VAD = ticho alebo šum, Whisper by si vetu vymyslel


def find_ffmpeg() -> str:
    """The bundled ffmpeg, or one from PATH when the package has none for this machine."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001, any failure here just means: look on PATH
        found = shutil.which("ffmpeg")
        if not found:
            raise RuntimeError("ffmpeg sa nenašiel") from None
        return found


FFMPEG = find_ffmpeg()


def load_audio(path: str) -> np.ndarray:
    """Any audio file (webm, ogg, wav, mp4, mp3) as 16 kHz mono float32."""
    cmd = [FFMPEG, "-nostdin", "-loglevel", "error", "-threads", "0", "-i", path,
           "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "16000", "-"]
    res = subprocess.run(cmd, capture_output=True, timeout=60, check=False)
    if res.returncode != 0:
        # ffmpeg's own message names the temporary file: that path is nobody's business.
        raise RuntimeError("zvuk sa nedá prečítať, nahrávka je poškodená alebo v neznámom formáte")
    return np.frombuffer(res.stdout, np.int16).astype(np.float32) / 32768.0

# Silero VAD z openWakeWord (stiahne sa raz spolu s malým modelom hey_jarvis).
openwakeword.utils.download_models(["hey_jarvis"])
vad = VAD()


def speech_seconds(audio: np.ndarray) -> float:
    """Koľko sekúnd reči je v nahrávke (16 kHz float32). Rámce po 80 ms ako wake worker."""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    vad.reset_states()
    frames = 0
    for i in range(0, len(pcm) - 1279, 1280):
        if float(vad.predict(pcm[i : i + 1280], frame_size=640)) >= 0.5:
            frames += 1
    return frames * 0.08


def transcribe(audio, prompt: str) -> str:
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=MODEL,
        language=LANG,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=prompt or None,
    )
    kept = [
        s["text"]
        for s in result.get("segments", [])
        if s.get("no_speech_prob", 0) < 0.6 and s.get("avg_logprob", 0) > -1.0
    ]
    return " ".join(t.strip() for t in kept).strip()


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main() -> None:
    transcribe(np.zeros(8000, dtype=np.float32), "")  # načíta váhy pred prvou vetou
    speech_seconds(np.zeros(16000, dtype=np.float32))
    emit({"ready": True, "engine": "mlx", "device": "metal"})
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t0 = time.monotonic()
        try:
            audio = load_audio(req["path"])
            speech = speech_seconds(audio)
            # Bez reči Whisper nespúšťame: pri tichu by zopakoval vetu z nápovedy (prompt).
            text = transcribe(audio, req.get("prompt") or "") if speech >= MIN_SPEECH_S else ""
            emit({"id": req.get("id"), "ok": True, "text": text, "speech": round(speech, 2),
                  "ms": round((time.monotonic() - t0) * 1000)})
        except Exception as err:  # noqa: BLE001, chyba ide do Node, worker beží ďalej
            emit({"id": req.get("id"), "ok": False, "error": str(err)[:300]})


if __name__ == "__main__":
    main()
