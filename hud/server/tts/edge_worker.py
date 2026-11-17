# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["edge-tts==7.3.1", "certifi==2026.10.23"]
#
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""
Persistent Edge TTS worker for the HUD. The voice arrives with every request (server/voices.mjs).
Package versions are pinned and `exclude-newer` freezes everything they pull in.

Why a custom websocket instead of `edge_tts.Communicate`: Communicate opens a new connection for
every sentence (TLS + DRM token), which costs about 0.6 s. Here three connections stay open and
sentences go over them one after another, so the first audio arrives in roughly half a second.
Only the DRM token, headers and SSML come from edge_tts, the protocol is the same as Communicate.

Protocol (JSON lines):
  stdin  {"id": "…", "text": "…", "voice": "sk-SK-LukasNeural", "rate": "+0%", "pitch": "+0Hz", "out": "/abs/x.mp3"}
         {"warm": true}                    opens the connections ahead (start of a turn)
  stdout {"ready": true}
         {"id": "…", "ok": true, "ms": 640, "first_ms": 450, "bytes": 14400}
         {"id": "…", "ok": false, "error": "…"}
Neither text nor audio is logged anywhere.
"""
import asyncio
import json
import os
import ssl
import sys
import time
from xml.sax.saxutils import escape

import aiohttp
import certifi
from edge_tts.communicate import (
    TTSConfig,
    connect_id,
    date_to_string,
    mkssml,
    remove_incompatible_characters,
    ssml_headers_plus_data,
)
from edge_tts.constants import SEC_MS_GEC_VERSION, WSS_HEADERS, WSS_URL
from edge_tts.drm import DRM

SSL_CTX = ssl.create_default_context(cafile=certifi.where())
POOL_SIZE = 3
REQUEST_TIMEOUT_S = 12.0
IDLE_CLOSE_S = 240.0  # Microsoft spojenie po chvíli ticha aj tak zavrie
CONFIG_MSG = (
    "Content-Type:application/json; charset=utf-8\r\n"
    "Path:speech.config\r\n\r\n"
    '{"context":{"synthesis":{"audio":{"metadataoptions":{'
    '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def request_id_of(header_blob: bytes) -> bytes | None:
    for line in header_blob.split(b"\r\n"):
        if line.lower().startswith(b"x-requestid:"):
            return line.split(b":", 1)[1].strip()
    return None


class Conn:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        self.session = session
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.lock = asyncio.Lock()
        self.waiting = 0
        self.last_use = 0.0

    @property
    def open(self) -> bool:
        return self.ws is not None and not self.ws.closed

    async def connect(self) -> None:
        if self.open:
            return
        url = (
            f"{WSS_URL}&ConnectionId={connect_id()}"
            f"&Sec-MS-GEC={DRM.generate_sec_ms_gec()}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}"
        )
        try:
            self.ws = await self.session.ws_connect(
                url, compress=15, headers=DRM.headers_with_muid(WSS_HEADERS), ssl=SSL_CTX, heartbeat=20
            )
        except aiohttp.WSServerHandshakeError as err:
            # 403 = rozbehnuté hodiny, edge_tts si posun dopočíta z hlavičky Date
            if err.status == 403 and err.headers:
                server_date = err.headers.get("Date")
                parsed = DRM.parse_rfc2616_date(server_date) if server_date else None
                if parsed is not None:
                    DRM.adj_clock_skew_seconds(parsed - DRM.get_unix_timestamp())
            raise
        await self.ws.send_str(f"X-Timestamp:{date_to_string()}\r\n{CONFIG_MSG}")
        self.last_use = time.monotonic()

    async def close(self) -> None:
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001
                pass
        self.ws = None

    async def synth_once(self, req: dict) -> dict:
        assert self.ws is not None
        t0 = time.monotonic()
        rid = connect_id()
        tc = TTSConfig(
            req.get("voice") or "sk-SK-LukasNeural",
            req.get("rate") or "+0%",
            req.get("volume") or "+0%",
            req.get("pitch") or "+0Hz",
            "SentenceBoundary",
        )
        text = escape(remove_incompatible_characters(req["text"]))
        await self.ws.send_str(ssml_headers_plus_data(rid, date_to_string(), mkssml(tc, text)))
        out = req["out"]
        tmp = out + ".part"
        first = None
        size = 0
        with open(tmp, "wb") as f:
            while True:
                msg = await asyncio.wait_for(self.ws.receive(), timeout=REQUEST_TIMEOUT_S)
                if msg.type == aiohttp.WSMsgType.TEXT:
                    head = msg.data.split("\r\n\r\n", 1)[0].encode()
                    if request_id_of(head) not in (None, rid.encode()):
                        continue
                    if b"Path:turn.end" in head:
                        break
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    if len(msg.data) < 2:
                        continue
                    hl = int.from_bytes(msg.data[:2], "big")
                    head = msg.data[2 : 2 + hl]
                    if request_id_of(head) not in (None, rid.encode()):
                        continue
                    data = msg.data[2 + hl :]
                    if data:
                        if first is None:
                            first = time.monotonic()
                        f.write(data)
                        size += len(data)
                else:
                    raise ConnectionError(f"websocket {msg.type.name}")
        if size == 0:
            os.remove(tmp)
            raise RuntimeError("Edge TTS nevrátil žiadny zvuk")
        os.replace(tmp, out)
        self.last_use = time.monotonic()
        return {
            "id": req["id"],
            "ok": True,
            "ms": round((time.monotonic() - t0) * 1000),
            "first_ms": round(((first or time.monotonic()) - t0) * 1000),
            "bytes": size,
        }

    async def synth(self, req: dict) -> dict:
        self.waiting += 1
        try:
            async with self.lock:
                last_err: Exception | None = None
                for attempt in range(2):
                    try:
                        fresh = not self.open
                        await self.connect()
                        res = await self.synth_once(req)
                        res["fresh"] = fresh
                        res["attempt"] = attempt
                        return res
                    except Exception as err:  # noqa: BLE001, druhý pokus ide po novom spojení
                        last_err = err
                        await self.close()
                        try:
                            os.remove(req["out"] + ".part")
                        except OSError:
                            pass
                return {"id": req.get("id"), "ok": False, "error": str(last_err)[:300]}
        finally:
            self.waiting -= 1


async def main() -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 20)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    session = aiohttp.ClientSession(trust_env=True, timeout=aiohttp.ClientTimeout(total=None, connect=8, sock_connect=8))
    pool = [Conn(session) for _ in range(POOL_SIZE)]
    pending: set[asyncio.Task] = set()
    emit({"ready": True})

    def pick() -> Conn:
        free = [c for c in pool if not c.lock.locked()]
        if free:
            return max(free, key=lambda c: (c.open, c.last_use))
        return min(pool, key=lambda c: c.waiting)

    async def warm() -> None:
        async def one(c: Conn) -> None:
            if c.lock.locked():
                return
            async with c.lock:
                try:
                    await c.connect()
                except Exception:  # noqa: BLE001, zahrievanie je len pokus
                    await c.close()
        await asyncio.gather(*(one(c) for c in pool))

    async def reaper() -> None:
        while True:
            await asyncio.sleep(30)
            for c in pool:
                if c.open and not c.lock.locked() and time.monotonic() - c.last_use > IDLE_CLOSE_S:
                    await c.close()

    async def handle(line: bytes) -> None:
        try:
            req = json.loads(line)
        except ValueError:
            return
        if not isinstance(req, dict):
            return
        if req.get("warm"):
            await warm()
            return
        if not req.get("text") or not req.get("out"):
            emit({"id": req.get("id"), "ok": False, "error": "chýba text alebo out"})
            return
        emit(await pick().synth(req))

    reap = asyncio.create_task(reaper())
    while True:
        line = await reader.readline()
        if not line:
            break
        task = asyncio.create_task(handle(line))
        pending.add(task)
        task.add_done_callback(pending.discard)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    reap.cancel()
    for c in pool:
        await c.close()
    await session.close()


if __name__ == "__main__":
    asyncio.run(main())
