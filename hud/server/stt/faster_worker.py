# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["faster-whisper==1.2.1", "av==16.1.0"]
#
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""
Speech to text for the HUD with faster-whisper (Windows, Linux and Intel Macs). Same line protocol
as whisper_worker.py. Audio is decoded by PyAV, no system ffmpeg needed. The built-in Silero VAD
drops silence, so an empty recording gives an empty text.

Environment:
  WHISPER_MODEL    folder with the model (model.bin, config.json, tokenizer) or a model name
  WHISPER_DEVICE   cpu (default) or cuda. With cuda the NVIDIA libraries come from the packages
                   nvidia-cublas-cu12 and nvidia-cudnn-cu12 that Node adds with `uv run --with`.
  WHISPER_THREADS  CPU threads
Package versions are pinned and `exclude-newer` freezes everything they pull in. PyAV is pinned
too: faster-whisper 1.2.1 opens audio with an argument that PyAV 19 no longer has.

  faster_worker.py --probe   prints {"probe": true, "cuda_devices": n, "libs": bool} and exits:
                             can this computer run the model on an NVIDIA card?

stdin  {"id": "…", "path": "/abs/audio.webm", "prompt": "…"}
stdout {"ready": true, "engine": "faster", "device": "cpu"} once the model is loaded
       {"id": "…", "ok": true, "text": "…", "ms": 900} | {"id": "…", "ok": false, "error": "…"}
Neither audio nor text is logged anywhere.
"""
import ctypes
import glob
import importlib.util
import json
import os
import sys
import time

MODEL = os.environ.get("WHISPER_MODEL", "small")
LANG = os.environ.get("JARVIS_LANG", "sk")
DEVICE = "cuda" if os.environ.get("WHISPER_DEVICE", "cpu").lower() == "cuda" else "cpu"
THREADS = int(os.environ.get("WHISPER_THREADS", "0") or 0)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def nvidia_dirs() -> list[str]:
    """Folders with the cuBLAS and cuDNN libraries from the pip packages, when they are installed."""
    dirs = []
    for name in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            spec = importlib.util.find_spec(name)
        except (ImportError, ValueError):
            spec = None
        for base in (spec.submodule_search_locations or []) if spec else []:
            for sub in ("bin", "lib"):
                path = os.path.join(base, sub)
                if os.path.isdir(path):
                    dirs.append(path)
    return dirs


def load_nvidia_libs() -> bool:
    """Makes the NVIDIA libraries findable for CTranslate2. True when both cuBLAS and cuDNN loaded."""
    dirs = nvidia_dirs()
    if not dirs:
        return False
    if os.name == "nt":
        os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
        for path in dirs:
            os.add_dll_directory(path)
        patterns = ("cublas64_*.dll", "cudnn64_*.dll")
    else:
        patterns = ("libcublas.so.*", "libcudnn.so.*")
    loaded = 0
    for pattern in patterns:
        for path in dirs:
            found = sorted(glob.glob(os.path.join(path, pattern)))
            if not found:
                continue
            try:
                ctypes.CDLL(found[0], mode=getattr(ctypes, "RTLD_GLOBAL", 0))
                loaded += 1
            except OSError:
                pass
            break
    if os.name != "nt":
        # The rest of cuDNN is opened by name later: load every part now, while the folder is known.
        for path in dirs:
            for lib in sorted(glob.glob(os.path.join(path, "libcudnn_*.so.*"))):
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
    return loaded == len(patterns)


def probe() -> None:
    import ctranslate2

    try:
        devices = int(ctranslate2.get_cuda_device_count())
    except Exception:  # noqa: BLE001, no driver or a build without CUDA
        devices = 0
    emit({"probe": True, "cuda_devices": devices, "libs": load_nvidia_libs() if devices else False})


def main() -> None:
    from faster_whisper import WhisperModel

    if DEVICE == "cuda":
        load_nvidia_libs()
        model = WhisperModel(MODEL, device="cuda", compute_type="float16")
    else:
        model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
    emit({"ready": True, "engine": "faster", "device": DEVICE})
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
    if "--probe" in sys.argv[1:]:
        probe()
    else:
        main()
