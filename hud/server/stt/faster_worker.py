# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["faster-whisper>=1.1,<2"]
# ///
"""
Speech to text for the HUD with faster-whisper (CPU, works on Windows, Linux and Intel Macs).
Same line protocol as whisper_worker.py. Audio is decoded by PyAV, no system ffmpeg needed.
The built-in Silero VAD drops silence, so an empty recording gives an empty text.

stdin  {"id": "…", "path": "/abs/audio.webm", "prompt": "…"}
stdout {"ready": true} once the model is loaded
       {"id": "…", "ok": true, "text": "…", "ms": 900} | {"id": "…", "ok": false, "error": "…"}
Neither audio nor text is logged anywhere.
"""
import json
import os
import sys
import time

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
LANG = os.environ.get("JARVIS_LANG", "sk")


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main() -> None:
    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    emit({"ready": True})
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t0 = time.monotonic()
        try:
            segments, _ = model.transcribe(
                req["path"],
                language=LANG,
                temperature=0.0,
                condition_on_previous_text=False,
                initial_prompt=req.get("prompt") or None,
                vad_filter=True,
                beam_size=3,
            )
            kept = [s.text.strip() for s in segments if s.no_speech_prob < 0.6 and s.avg_logprob > -1.0]
            emit({"id": req.get("id"), "ok": True, "text": " ".join(kept).strip(),
                  "ms": round((time.monotonic() - t0) * 1000)})
        except Exception as err:  # noqa: BLE001, the error goes to Node, the worker keeps running
            emit({"id": req.get("id"), "ok": False, "error": str(err)[:300]})


if __name__ == "__main__":
    main()
