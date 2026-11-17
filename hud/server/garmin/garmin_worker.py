# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "garminconnect==0.3.20",
#   "curl_cffi==0.17.0",
#   "requests==2.34.2",
#   "ua-generator==2.1.9",
# ]
# ///
"""
Garmin Connect worker for Jarvis: the only place that talks to Garmin.

It uses the user's own Garmin Connect login through the unofficial `garminconnect` library
(https://github.com/cyberjunky/python-garminconnect). Started by hud/server/garmin/index.mjs
through `uv run`, so nothing is installed into the user's Python.

  login              interactive, in a real terminal only: asks for the e-mail and the password
                     (hidden input), answers a two-factor code prompt and saves the session tokens
  status [--check]   is there a saved session (with --check it is verified against Garmin)
  sync --days N      one JSON document on stdout with the last N days (see below)
  logout             deletes the saved session tokens

Security rules of this file:
  - the password exists only in memory of this process during `login`. It is never read from the
    arguments or the environment, never written to disk, never printed and never logged,
  - only the session tokens are stored, in <tokens dir>/garmin_tokens.json (file 0600, folder 0700),
  - stdout of `sync` and `status` is JSON without any secret, diagnostics go to stderr.

Output of `sync` (missing metrics are null, older watches simply do not have them):
  { "ok": true, "source": "garmin", "range": { "from": "2026-11-16", "to": "2026-11-17" },
    "activitiesOk": true, "partial": false, "warnings": [],
    "days": [ { "day": "2026-11-17",
                "sleep": { "minutes": 432, "deep": 85, "light": 230, "rem": 100, "awake": 17,
                           "score": 82, "bed": "23:41", "wake": "06:53" },
                "hrv": 62, "hrvStatus": "BALANCED", "rhr": 48,
                "bodyBattery": { "max": 88, "min": 21, "wake": 85 },
                "steps": 9412, "stress": 31,
                "readiness": { "score": 74, "level": "HIGH" },
                "activities": [ { "id": "123", "type": "running", "name": "Evening run",
                                  "start": "2026-11-17T17:42", "minutes": 45, "distanceKm": 8.21,
                                  "avgHr": 148, "calories": 520 } ] } ] }
On failure: { "ok": false, "error": "not_connected" | "needs_login" | "rate_limited" | "network"
              | "failed", "message": "…" } and a non-zero exit code (3, 4, 5, 6, 7 in that order).
"""
import argparse
import contextlib
import getpass
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

TOKEN_NAME = "garmin_tokens.json"
EXIT = {"ok": 0, "usage": 2, "not_connected": 3, "needs_login": 4, "rate_limited": 5, "network": 6, "failed": 7}
# Waits after a "too many requests" answer before the same call is tried again.
BACKOFF_S = (4.0, 12.0, 30.0)
NEEDS_LOGIN = "Prihlásenie do Garminu vypršalo alebo ho Garmin zrušil. Treba sa prihlásiť znova: node scripts/garmin.mjs login"

# The library also accepts tokens from this variable: the worker only ever uses its own folder.
os.environ.pop("GARMINTOKENS", None)

for _stream in (sys.stdout, sys.stderr):
    with contextlib.suppress(Exception):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def emit(obj: dict) -> None:
    """Machine output: one ASCII JSON line, safe for any console code page."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def note(msg: str) -> None:
    """Diagnostics for the log. Never contains credentials or tokens."""
    sys.stderr.write(f"[garmin] {msg}\n")
    sys.stderr.flush()


def fail(code: str, message: str) -> None:
    emit({"ok": False, "error": code, "message": message})
    sys.exit(EXIT.get(code, 7))


class Stop(Exception):
    """Ends the whole run with an error code (needs_login, rate_limited)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ── token store ─────────────────────────────────────────────────────────


def token_dir(arg: str | None) -> Path:
    """
    Folder with the session tokens. The library refuses token paths that go through a symlink,
    so the path is resolved first: this is the user's own data folder on their own computer.
    """
    if arg:
        raw = Path(arg)
    else:
        data = os.environ.get("JARVIS_DATA_DIR") or str(Path(__file__).resolve().parents[3] / "data")
        raw = Path(data) / "garmin"
    return Path(os.path.realpath(raw.expanduser()))


def secure_dir(folder: Path) -> None:
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        folder.chmod(0o700)


def has_tokens(folder: Path) -> bool:
    try:
        data = json.loads((folder / TOKEN_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and bool(data.get("di_token") or data.get("di_refresh_token"))


def saved_at(folder: Path) -> str | None:
    try:
        ts = (folder / TOKEN_NAME).stat().st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def drop_tokens(folder: Path) -> bool:
    removed = False
    with contextlib.suppress(OSError):
        (folder / TOKEN_NAME).unlink()
        removed = True
    # Leftovers of an interrupted atomic write.
    with contextlib.suppress(OSError):
        for tmp in folder.glob(f".{TOKEN_NAME}.*.tmp"):
            with contextlib.suppress(OSError):
                tmp.unlink()
    return removed


# ── small helpers ───────────────────────────────────────────────────────


def num(v):
    """Number or None. Garmin sends nulls, empty strings and negative "no data" markers."""
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    return int(f) if f.is_integer() else f


def pos(v):
    """Number greater than zero, else None."""
    n = num(v)
    return n if n is not None and n > 0 else None


def first(d, *keys):
    if not isinstance(d, dict):
        return None
    for k in keys:
        if d.get(k) is not None:
            return d.get(k)
    return None


def minutes(seconds) -> int | None:
    s = num(seconds)
    return int(round(s / 60)) if s is not None and s >= 0 else None


def clock(gmt_ms, local_ms) -> str | None:
    """
    HH:MM of a sleep timestamp. The GMT value converted to this computer's time zone is the
    reliable one. The "local" value (wall clock stored as if it were UTC) is the fallback.
    """
    g = num(gmt_ms)
    if g and g > 1e11:
        return datetime.fromtimestamp(g / 1000).strftime("%H:%M")
    loc = num(local_ms)
    if loc and loc > 1e11:
        return datetime.fromtimestamp(loc / 1000, tz=timezone.utc).strftime("%H:%M")
    return None


# ── normalisation of Garmin's answers ───────────────────────────────────


def norm_sleep(raw) -> dict | None:
    dto = (raw or {}).get("dailySleepDTO") if isinstance(raw, dict) else None
    if not isinstance(dto, dict):
        return None
    total = minutes(dto.get("sleepTimeSeconds"))
    if not total:
        return None
    score = None
    overall = (dto.get("sleepScores") or {}).get("overall") if isinstance(dto.get("sleepScores"), dict) else None
    if isinstance(overall, dict):
        score = pos(overall.get("value"))
    if score is None:
        score = pos(dto.get("sleepScore"))
    return {
        "minutes": total,
        "deep": minutes(dto.get("deepSleepSeconds")),
        "light": minutes(dto.get("lightSleepSeconds")),
        "rem": minutes(dto.get("remSleepSeconds")),
        "awake": minutes(dto.get("awakeSleepSeconds")),
        "score": score,
        "bed": clock(dto.get("sleepStartTimestampGMT"), dto.get("sleepStartTimestampLocal")),
        "wake": clock(dto.get("sleepEndTimestampGMT"), dto.get("sleepEndTimestampLocal")),
    }


def norm_readiness(raw) -> dict | None:
    rows = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    rows = [r for r in rows if isinstance(r, dict) and pos(r.get("score")) is not None]
    if not rows:
        return None
    # The value from right after waking up is the one Garmin shows in its morning report.
    best = next((r for r in rows if r.get("inputContext") == "AFTER_WAKEUP_RESET"), rows[0])
    level = best.get("level")
    return {"score": pos(best.get("score")), "level": str(level) if level else None}


def norm_activity(a) -> dict | None:
    if not isinstance(a, dict):
        return None
    start = str(first(a, "startTimeLocal", "startTimeGMT") or "").replace(" ", "T")[:16]
    dur = pos(first(a, "duration", "elapsedDuration", "movingDuration"))
    if len(start) < 16 or dur is None:
        return None
    kind = (a.get("activityType") or {}).get("typeKey") if isinstance(a.get("activityType"), dict) else None
    dist = pos(a.get("distance"))
    name = a.get("activityName")
    return {
        "id": str(a.get("activityId") or ""),
        "type": str(kind or "other").lower(),
        "name": str(name).strip()[:120] if name else None,
        "start": start,
        "minutes": max(1, int(round(dur / 60))),
        "distanceKm": round(dist / 1000, 2) if dist else None,
        "avgHr": pos(first(a, "averageHR", "avgHr")),
        "calories": pos(a.get("calories")),
    }


# ── talking to Garmin ───────────────────────────────────────────────────


class FixtureApi:
    """
    Stand-in for the Garmin client that answers from a JSON file (tests, no network, no account):
      { "summary": { "<day>": {…} }, "sleep": { "<day>": {…} }, "hrv": { "<day>": {…} },
        "readiness": { "<day>": […] }, "activities": […],
        "fail": { "hrv": "notfound", "sleep:<day>": "rate", "summary": "auth" } }
    `fail` raises the library's own errors: notfound, rate (twice, then it answers), ratehard, auth.
    """

    def __init__(self, path: str) -> None:
        self.data = json.loads(Path(path).read_text(encoding="utf-8"))
        self.rate_hits: dict[str, int] = {}

    def _maybe_fail(self, what: str, day: str | None) -> None:
        import garminconnect as gc

        rules = self.data.get("fail") or {}
        rule = rules.get(f"{what}:{day}") if day else None
        rule = rule or rules.get(what)
        if rule == "notfound":
            raise gc.GarminConnectNotFoundError(f"{what} not found")
        if rule == "auth":
            raise gc.GarminConnectAuthenticationError("Authentication failed (401)")
        if rule == "ratehard":
            raise gc.GarminConnectTooManyRequestsError("Rate limit exceeded")
        if rule == "rate":
            key = f"{what}:{day}"
            self.rate_hits[key] = self.rate_hits.get(key, 0) + 1
            if self.rate_hits[key] <= 2:
                raise gc.GarminConnectTooManyRequestsError("Rate limit exceeded")

    def _get(self, what: str, day: str):
        self._maybe_fail(what, day)
        return (self.data.get(what) or {}).get(day)

    def get_user_summary(self, day):
        return self._get("summary", day)

    def get_sleep_data(self, day):
        return self._get("sleep", day)

    def get_hrv_data(self, day):
        return self._get("hrv", day)

    def get_training_readiness(self, day):
        return self._get("readiness", day)

    def get_activities_by_date(self, start, end):
        self._maybe_fail("activities", None)
        out = []
        for a in self.data.get("activities") or []:
            d = str(a.get("startTimeLocal") or "")[:10]
            if start <= d <= end:
                out.append(a)
        return out


def connect(folder: Path):
    """Garmin client from the saved session. Never uses a password and never asks for one."""
    import garminconnect as gc

    if not has_tokens(folder):
        raise Stop("not_connected", "Garmin nie je pripojený. Pripojenie: node scripts/garmin.mjs login")
    api = gc.Garmin()
    try:
        api.login(str(folder))
    except gc.GarminConnectTooManyRequestsError:
        raise Stop("rate_limited", "Garmin dočasne odmieta požiadavky (priveľa pokusov).") from None
    except gc.GarminConnectAuthenticationError:
        raise Stop("needs_login", NEEDS_LOGIN) from None
    except gc.GarminConnectConnectionError as e:
        raise Stop("network", f"Garmin sa nepodarilo zastihnúť: {str(e)[:200]}") from None
    return api


class Puller:
    """Calls one endpoint at a time, with backoff on rate limits and tolerance for missing metrics."""

    def __init__(self, api, fast: bool = False) -> None:
        self.api = api
        self.scale = 0.01 if fast else 1.0
        self.unsupported: set[str] = set()
        self.misses: dict[str, int] = {}
        self.warnings: list[str] = []

    def call(self, what: str, *args):
        import garminconnect as gc

        if what in self.unsupported:
            return None
        fn = getattr(self.api, what)
        for attempt in range(len(BACKOFF_S) + 1):
            try:
                out = fn(*args)
                self.misses[what] = 0
                return out
            except gc.GarminConnectTooManyRequestsError:
                if attempt == len(BACKOFF_S):
                    raise Stop("rate_limited", "Garmin dočasne odmieta požiadavky (priveľa naraz). Skúsim to neskôr.") from None
                wait = BACKOFF_S[attempt] * self.scale
                note(f"{what}: rate limit, waiting {BACKOFF_S[attempt]:.0f} s")
                time.sleep(wait)
            except gc.GarminConnectAuthenticationError:
                raise Stop("needs_login", NEEDS_LOGIN) from None
            except gc.GarminConnectNotFoundError:
                # Twice in a row: the account or the watch does not have this metric, stop asking in this run.
                self.misses[what] = self.misses.get(what, 0) + 1
                if self.misses[what] >= 2:
                    self.unsupported.add(what)
                    self.warnings.append(f"{what}: not available")
                return None
            except gc.GarminConnectConnectionError as e:
                self.warnings.append(f"{what} {args[0] if args else ''}: {str(e)[:120]}")
                note(f"{what} failed: {str(e)[:160]}")
                return None
            except Exception as e:  # noqa: BLE001  one odd answer must not end the whole sync
                self.warnings.append(f"{what} {args[0] if args else ''}: {type(e).__name__}")
                note(f"{what} failed: {type(e).__name__}")
                return None
        return None

    def day(self, day: str) -> dict:
        s = self.call("get_user_summary", day)
        s = s if isinstance(s, dict) else {}
        sleep_raw = self.call("get_sleep_data", day)
        hrv_raw = self.call("get_hrv_data", day)
        ready_raw = self.call("get_training_readiness", day)

        summary = (hrv_raw or {}).get("hrvSummary") if isinstance(hrv_raw, dict) else None
        hrv = pos(first(summary, "lastNightAvg"))
        if hrv is None and isinstance(sleep_raw, dict):
            hrv = pos(sleep_raw.get("avgOvernightHrv"))
        rhr = pos(first(s, "restingHeartRate"))
        if rhr is None and isinstance(sleep_raw, dict):
            rhr = pos(sleep_raw.get("restingHeartRate"))
        bb = {
            "max": pos(first(s, "bodyBatteryHighestValue")),
            "min": pos(first(s, "bodyBatteryLowestValue")),
            "wake": pos(first(s, "bodyBatteryAtWakeTime")),
        }
        return {
            "day": day,
            "sleep": norm_sleep(sleep_raw),
            "hrv": round(hrv) if hrv is not None else None,
            "hrvStatus": str(summary.get("status")) if isinstance(summary, dict) and summary.get("status") else None,
            "rhr": rhr,
            "bodyBattery": bb if any(v is not None for v in bb.values()) else None,
            "steps": pos(first(s, "totalSteps")),
            "stress": pos(first(s, "averageStressLevel")),
            "readiness": norm_readiness(ready_raw),
            "activities": [],
        }


# ── commands ────────────────────────────────────────────────────────────


def cmd_status(args) -> None:
    folder = token_dir(args.tokens)
    out = {"ok": True, "connected": has_tokens(folder), "savedAt": saved_at(folder)}
    try:
        from importlib.metadata import version

        out["library"] = version("garminconnect")
    except Exception:  # noqa: BLE001
        out["library"] = None
    if args.check and out["connected"]:
        try:
            api = connect(folder)
            out["valid"] = True
            out["name"] = api.get_full_name()
        except Stop as e:
            out["valid"] = False
            out["error"] = e.code
            out["message"] = e.message
    emit(out)


def cmd_logout(args) -> None:
    folder = token_dir(args.tokens)
    removed = drop_tokens(folder)
    emit({"ok": True, "removed": removed})


def cmd_sync(args) -> None:
    days_back = max(1, min(int(args.days), 120))
    try:
        today = date.fromisoformat(args.today) if args.today else date.today()
    except ValueError:
        fail("failed", "--today musí byť YYYY-MM-DD")
    day_list = [(today - timedelta(days=i)).isoformat() for i in range(days_back - 1, -1, -1)]
    try:
        if args.fixture:
            api = FixtureApi(args.fixture)
        else:
            api = connect(token_dir(args.tokens))
        pull = Puller(api, fast=bool(args.fixture))
        days: list[dict] = []
        partial = False
        try:
            for d in day_list:
                days.append(pull.day(d))
        except Stop as e:
            # Rate limited in the middle: what is complete is still worth keeping.
            if e.code != "rate_limited" or not days:
                raise
            partial = True
            pull.warnings.append(e.message)
        acts = None if partial else pull.call("get_activities_by_date", day_list[0], day_list[-1])
        activities_ok = isinstance(acts, list)
        by_day = {d["day"]: d for d in days}
        for raw in acts or []:
            a = norm_activity(raw)
            if a and a["start"][:10] in by_day:
                by_day[a["start"][:10]]["activities"].append(a)
        for d in days:
            d["activities"].sort(key=lambda a: a["start"])
    except Stop as e:
        fail(e.code, e.message)
    except ImportError as e:
        fail("failed", f"Chýba knižnica garminconnect: {e}")
    emit(
        {
            "ok": True,
            "source": "fixture" if args.fixture else "garmin",
            "range": {"from": days[0]["day"], "to": days[-1]["day"]},
            "activitiesOk": activities_ok,
            "partial": partial,
            "warnings": pull.warnings[:20],
            "days": days,
        }
    )


def cmd_login(args) -> None:
    """Interactive login. Human text goes to the terminal, nothing here is machine output."""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        sys.stderr.write(
            "Prihlásenie do Garminu sa dá spustiť len v termináli, lebo sa pri ňom zadáva heslo.\n"
            "Otvor Terminál (macOS) alebo PowerShell (Windows) v priečinku Jarvisa a napíš:\n"
            "  node scripts/garmin.mjs login\n"
        )
        sys.exit(EXIT["usage"])
    import garminconnect as gc

    folder = token_dir(args.tokens)
    secure_dir(folder)
    print("Pripojenie Garmin Connect")
    print("Heslo sa posiela len Garminu. Jarvis si ho neukladá, uloží sa iba prihlásenie tohto počítača.")
    print("")
    try:
        email = input("E-mail ku Garmin účtu: ").strip()
        password = getpass.getpass("Heslo (pri písaní sa nezobrazuje): ")
    except (EOFError, KeyboardInterrupt):
        print("\nZrušené.")
        sys.exit(EXIT["usage"])
    if not email or not password:
        print("Chýba e-mail alebo heslo. Nič sa nezmenilo.")
        sys.exit(EXIT["usage"])

    def ask_code() -> str:
        print("")
        print("Garmin chce overovací kód (dvojfázové overenie). Príde e-mailom alebo SMS, podľa nastavenia účtu.")
        return input("Overovací kód: ").strip()

    def scrub(text: str) -> str:
        """An error text from the library must never carry the password or the e-mail to the screen."""
        out = str(text)
        for secret in (password, email):
            if secret:
                out = out.replace(secret, "***")
        return out[:300]

    api = gc.Garmin(email=email, password=password, prompt_mfa=ask_code)
    print("Prihlasujem…")
    code = None
    try:
        # No token store on purpose: the old session stays untouched until the new login succeeds.
        api.login()
        api.client.dump(str(folder))
    except KeyboardInterrupt:
        print("\nZrušené.")
        code = "usage"
    except gc.GarminConnectTooManyRequestsError:
        print("Garmin teraz prihlásenia odmieta (priveľa pokusov). Počkaj aspoň hodinu a skús to znova.")
        code = "rate_limited"
    except gc.GarminConnectAuthenticationError as e:
        print("Prihlásenie sa nepodarilo. Skontroluj e-mail, heslo a overovací kód.")
        print(f"Podrobnosti: {scrub(e).splitlines()[0] if scrub(e) else ''}")
        code = "needs_login"
    except gc.GarminConnectConnectionError as e:
        print("Garmin sa nepodarilo zastihnúť alebo prihlásenie zablokoval. Skús to o chvíľu.")
        print(f"Podrobnosti: {scrub(e).splitlines()[0] if scrub(e) else ''}")
        code = "network"
    except Exception as e:  # noqa: BLE001
        print(f"Prihlásenie zlyhalo: {type(e).__name__}: {scrub(e)}")
        code = "failed"
    finally:
        password = None
        api.password = None
    if code:
        sys.exit(EXIT[code])
    if not has_tokens(folder):
        print("Prihlásenie prešlo, ale nepodarilo sa ho uložiť do priečinka s dátami Jarvisa.")
        sys.exit(EXIT["failed"])
    with contextlib.suppress(OSError):
        (folder / TOKEN_NAME).chmod(0o600)
    name = None
    with contextlib.suppress(Exception):
        name = api.get_full_name()
    print("")
    print(f"Hotovo. Garmin je pripojený{f' ({name})' if name else ''}.")


def main() -> None:
    p = argparse.ArgumentParser(prog="garmin_worker.py", description="Garmin Connect worker for Jarvis (login, status, sync, logout).")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--tokens", help="folder with the session tokens (default <data>/garmin)")
        return sp

    common(sub.add_parser("login", help="interactive login in a terminal (password is typed here, never stored)"))
    st = common(sub.add_parser("status", help="is there a saved session"))
    st.add_argument("--check", action="store_true", help="verify the session against Garmin")
    sy = common(sub.add_parser("sync", help="print the last N days as JSON"))
    sy.add_argument("--days", type=int, default=14)
    sy.add_argument("--today", help="YYYY-MM-DD, the last day of the range (default today)")
    sy.add_argument("--fixture", help="answer from a JSON file instead of Garmin (tests)")
    common(sub.add_parser("logout", help="delete the saved session tokens"))
    args = p.parse_args()
    {"login": cmd_login, "status": cmd_status, "sync": cmd_sync, "logout": cmd_logout}[args.cmd](args)


if __name__ == "__main__":
    main()
