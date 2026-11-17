"""
Launcher for yt-dlp and the ffmpeg binary that ships with imageio-ffmpeg. The HUD server
(hud/server/media.mjs) starts it through uv, which brings both packages without any manual install:

  uv run --no-project --with "yt-dlp[default]==<pin>" --with "imageio-ffmpeg==<pin>" python ytdlp_worker.py <mode> ...

  ytdlp <args...>   yt-dlp's own command line, with --ffmpeg-location set to the bundled ffmpeg
  ffmpeg <args...>  the ffmpeg binary itself (alarm clip, audio for the waveform and for Whisper)
  where             one JSON line: {"ytdlp": "<version>", "ffmpeg": "<path>"}

JARVIS_FFMPEG_BIN (a path to a system ffmpeg) replaces the bundled binary.
Nothing is logged here, stdout and stderr belong to the tool that runs.
"""
import json
import os
import signal
import subprocess
import sys


def ffmpeg_exe() -> str:
    override = os.environ.get("JARVIS_FFMPEG_BIN", "").strip()
    if override and os.path.isfile(override):
        return override
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def run_ffmpeg(args: list[str]) -> int:
    proc = subprocess.Popen([ffmpeg_exe(), *args], stdin=subprocess.DEVNULL)

    def stop(*_):
        try:
            proc.terminate()
        except OSError:
            pass

    for name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    return proc.wait()


def run_ytdlp(args: list[str]) -> int:
    import yt_dlp

    try:
        exe = ffmpeg_exe()
    except Exception:  # no ffmpeg at all: downloads that need no merge still work
        exe = ""
    argv = (["--ffmpeg-location", exe] if exe else []) + args
    try:
        yt_dlp.main(argv)
    except SystemExit as done:
        code = done.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        sys.stderr.write(f"{code}\n")
        return 1
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: ytdlp_worker.py ytdlp|ffmpeg|where [args]\n")
        return 2
    mode, args = sys.argv[1], sys.argv[2:]
    if mode == "where":
        import yt_dlp.version

        sys.stdout.write(json.dumps({"ytdlp": yt_dlp.version.__version__, "ffmpeg": ffmpeg_exe()}) + "\n")
        return 0
    if mode == "ffmpeg":
        return run_ffmpeg(args)
    if mode == "ytdlp":
        return run_ytdlp(args)
    sys.stderr.write(f"unknown mode {mode}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
