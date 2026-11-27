# HUD server API

Server: `http://localhost:4545` (`npm start` or `node scripts/hud.mjs`). JSON, UTF-8.
Errors come back as `{ "ok": false, "error": "…" }` with an HTTP 4xx/5xx status.

Try it without Claude: `JARVIS_MOCK=1 npm start`, or send `"mock": true` in a request.

```bash
curl -s localhost:4545/api/chat -H 'content-type: application/json' -d '{"text":"Čo mám dnes?","mock":true}'
curl -N localhost:4545/api/events        # SSE stream
curl -s localhost:4545/api/setup         # what is installed and configured
```

## Access

Everything is open from loopback. POST requests from a browser must come from the HUD page itself (same Origin).
With `HUD_HOST=0.0.0.0` other machines need the token from `data/brain/token` (header `x-hud-token` or `?token=`).
The token is never accepted through the Mobil tunnel (the tunnel's host name, or any `cf-*` header from cloudflared):
there only the login counts.

From outside (the phone through the Mobil tunnel, docs/MOBIL.md) every request needs the session cookie
`__Host-jarvis_session` from `POST /api/remote/login` (the 1.10.0 name `jarvis_session` is still accepted in 1.10.1
and moved to the new name on first use). Without it only the login page, its assets, the manifest and the icons
load; pages redirect to `/m/login.html?next=…`, everything else answers `401`. With it a phone gets what a local page
gets (reads, POSTs, `WS /api/mic`), except the `/api/remote/*` management endpoints and the loopback-only ones
(`event`, `announce`, `brain/hud`, `control`, `restart`, `quit`, `surface/keep`, …). An event stream from outside is
always a `phone` or a `browser`, never the `desktop` or the `app`. The tunnel's host name is accepted only while
the tunnel runs; anything served through it is `cache-control: private`.

## Endpoints

| Method and path | What it does |
|---|---|
| `POST /api/chat` | `{ text, via: "text"\|"voice", mock?, silent?, attachments? }` → `202 { ok, turn }`. The answer arrives over SSE. A new message interrupts the running one. `attachments` are paths returned by an upload (`prilohy/2026-11/foto.jpg`); the brain gets them on an extra line `[prílohy: /abs/path, …]` and opens them with `Read`. |
| `POST /api/chat/stop` | Interrupts Claude and the voice. |
| `GET /api/chat/history` | Last 20 exchanges. |
| `POST /api/stt` | Body = recording from `MediaRecorder` (webm, ogg, wav, mp4). Transcribed by the local Whisper and sent to the chat (`?send=0` only returns the text). `409` while the speech engine is the browser (`sttEngine` in the status is `browser`: by choice, on a weak computer, or until the local Whisper is prepared). `?attach=<JSON list of attachment paths>` sends files with the spoken message. |
| `POST /api/listen/wake` | `{ on }` turns "Ahoj Jarvis" on or off (needs a local Whisper). |
| `WS /api/mic` | Microphone stream for the wake word: 16 kHz mono Int16 PCM frames of 1280 samples. |
| `GET /api/status` | Brain, model, voice, speech engine, memory, agent mode. Also pushed as SSE `status`. |
| `GET /api/setup` | Installation summary for the onboarding. |
| `GET /api/snapshot` | Everything the panels show: memory counts, sleep, schedule, to-dos, routines, weather, goals. |
| `POST /api/snapshot/refresh` | Rebuilds the snapshot now. |
| `GET /api/inner` | Item counts per planet. |
| `GET /api/inner/:node` | Items of one planet for the 3D dive: `{ title, color, layout, groups, items }`. |
| `GET /api/inner/:node/:id` | Detail of one item. |
| `GET /api/weather?place=` | Weather (Open-Meteo). |
| `POST /api/say` | `{ text }` speaks a sentence without Claude. |
| `POST /api/announce` | `{ title, text, say?, silent?, log?, icon?, node? }` from routines and stráže: card + LOG line (`log` replaces „pripravené") + voice. Loopback only. |
| `POST /api/event` | `{ type, text, icon?, node? }` adds a LOG line. Loopback only. |
| `GET /api/jobs`, `POST /api/jobs` | Background jobs (full Claude Code runs, full access). `GET /api/jobs/:id` → one job with its assignment and feed `[{ t, kind: task\|reply\|step\|say\|state, text }]`. `POST /api/jobs/:id/stop` ends it with everything it started, `POST /api/jobs/:id/reply` `{ text }` continues an ended job in the same session. |
| `POST /api/mode` | `{ film }` filming mode: names of people and private titles are hidden. |
| `POST /api/brain/restart` | Restarts the Claude process. |
| `GET /tts/<hash>.mp3` | Synthesised voice clips (cached in `data/tts/`, one set per voice). |
| `GET /api/settings` | Voice, persona and speech settings with the options to choose from. See Settings below. |
| `POST /api/settings` | A partial settings object. Checked strictly, merged into `config/jarvis.json`, applied without a restart. |
| `POST /api/settings/preview` | `{ voice, text?, rate?, pitch? }` → `{ ok, url, voice, label, text, durMs, cached }`: a short clip in that voice (`url` is under `/tts/`), nothing is saved. |

### Settings

`GET /api/settings` (private like the conversation: from the network only with the token):

```jsonc
{
  "ok": true,
  "assistant": { "name": "Jarvis", "gender": "male" },                 // gender: male | female
  "voice": { "id": "sk-SK-LukasNeural", "rate": "+4%", "pitch": "-2Hz", "label": "Lukáš", "gender": "male",
             "source": "default",                                         // config | env | default
             "provider": "edge" },                                        // edge | say | browser | elevenlabs | off
  "voices": [{ "id": "sk-SK-ViktoriaNeural", "label": "Viktória", "gender": "female", "lang": "sk" }],
                                                                          // lang: sk | cs | multi | custom
  "user": { "name": "Martin", "address": "pane", "formal": true, "gender": null, "city": "Bratislava" },
  "quiet": "22:30-07:00",
  "alarm": { "enabled": true, "time": "06:30", "days": "weekdays", "call": false },   // read-only, null without an alarm
  "stt": {
    "engine": "mlx",                 // in use right now: mlx | faster | browser | off
    "model": "large-v3-turbo",
    "choice": "auto",                // what was asked for: auto | browser | whisper (config), mlx | faster | off (.env)
    "locked": false,                 // true: JARVIS_STT in .env decides, the setting cannot change it
    "pending": false,                // true: the local Whisper is still being prepared, the browser listens meanwhile
    "plan": { "engine": "mlx", "model": "large-v3-turbo", "sizeMb": 1614, "device": "metal",
              "status": "ready",     // ready | pending | fallback | failed | missing
              "reason": "Mac s Apple Silicon, 32 GB pamäte: najpresnejší model large-v3-turbo (1,6 GB).", "notes": [] },
    "specs": { "platform": "darwin", "arch": "arm64", "cpu": "Apple M3", "cores": 8, "ramGb": 36, "freeDiskMb": 84480,
               "gpu": { "vendor": "apple", "name": "Apple Silicon", "vramMb": null }, "uv": true, "modelsDir": "…" },
    "prepare": null                  // while `voice.mjs prepare` runs: { step, state, pct, text }
  },
  "wake": { "available": true, "on": false },
  "language": "sk",                  // sk | cs
  "languageLocked": false,           // true: JARVIS_LANG in .env decides
  "configured": true
}
```

`POST /api/settings` takes any part of this, nothing else:

```jsonc
{
  "assistant": { "name": "Friday", "gender": "female" },   // name: at most 24 characters
  "voice": { "id": "sk-SK-ViktoriaNeural", "rate": "+10%", "pitch": "-5Hz" },   // id from `voices`; null puts a value back to its default
  "user": { "name": "Martin", "address": "šéfe", "formal": false, "gender": "male", "city": "Košice" },
  "quiet": "23:00-06:30",          // "" turns quiet hours off
  "stt": "auto",                   // auto | browser | whisper
  "language": "sk",                // sk | cs
  "wake": true                     // "Ahoj Jarvis" on or off (409 without a local Whisper)
}
```

It answers with the new settings (the same shape as GET) plus `changed`, the groups that were sent. Unknown keys,
a voice that is not in `voices`, a text that is too long or holds anything but letters, digits and common punctuation
are refused with `400` and nothing is written. `409` when `config/jarvis.json` is not valid JSON (it is never
overwritten then). Keys of the config file the settings do not know (`routines`, `alarm`, `pulse`, anything the
user added) stay as they are. When the file does not exist yet it is created from `config/jarvis.example.json`.

Voice and gender follow each other: a new `assistant.gender` without a `voice.id` switches to the matching voice of
the language, a new `voice.id` without a gender sets the gender of that voice, a new `language` switches a native
voice to its counterpart. The next sentence already uses the new voice. A change of `stt` reloads the speech engine
(a local Whisper that is not on the disk yet is downloaded in the background, see `scripts/voice.mjs`). Every
change is broadcast as SSE `settings`.

### Files and imports

Dropped files are streamed to `data/inbox/<id>/<name>` (never held in memory), then `scripts/import.mjs detect`
says what they are. An ordinary file is copied to `memory/prilohy/<YYYY-MM>/` and comes back as an attachment for
the chat. A copy of data from an app (a folder, an archive, a big data file) goes to a background job: there is no
parser per app, the agent reads the format himself and loads the messages with `scripts/import.mjs ingest`. People
found in them wait for the review. Nothing that was uploaded is ever opened or run by the server.

| Method and path | What it does |
|---|---|
| `POST /api/upload?name=<name>` | The whole file as the raw body (`content-length` optional). → `{ ok, id, name, size, kind: "file"\|"export", detect, attachment?, import? }`. `attachment` is `{ id, name, path, rel, type, thumb? }`, `import` the entry described under SSE `import`. `413` too big, `507` not enough disk space. |
| `POST /api/upload/begin` | `{ name, size, folder? }` → `{ ok, id }`. Checks the name, the size and the free disk space before anything is sent. Used by the page for every upload and for dropped folders. |
| `POST /api/upload?id=<id>&path=<relative path>` | One file of an upload opened by `begin` (raw body). For a folder `path` is the file's path inside it. |
| `POST /api/upload/finish` | `{ id }` → same answer as the single request above. |
| `POST /api/upload/cancel` | `{ id }` drops an unfinished upload. |
| `POST /api/upload/local` | `{ path }` imports a file or folder by its absolute path on this computer without copying it (used by the desktop app). Only from this computer, never with a token from the network. |
| `GET /api/attachment?path=<rel>` | A file from `memory/prilohy`. Images are shown inline, everything else is sent as a download. |
| `GET /api/import/status` | `{ imports, running, pending, available }`: imports of this session, the number of people waiting for the review, whether the importer is installed. |
| `POST /api/import/dismiss` | `{ id }` stops a running import or hides a finished one. |
| `GET /api/import/people` | People found in the imported conversations: `{ candidates, existing, relations, me, total, hiddenSmall }`. Photos come as `{ rel, url }`. `403` in filming mode. |
| `GET /api/import/media?path=<rel>` | A photo from `memory/archiv/**/media` or `memory/ludia/_fotky`, nothing else. `403` in filming mode. |
| `POST /api/import/apply` | `{ decisions: [{ key, action: "new"\|"merge"\|"skip", name?, vztah?, note?, avatar? }] }` → `{ ok, created, merged, skipped, pending, job, say }`. Writes the people into the memory and starts the background job "Spoznávam ľudí z konverzácií" (`routines/import-analyza.md`). `avatar` is a `rel` from the candidate's photos. |

All of them follow the rules from Access: POST only from the HUD page on this computer or with the token, the GET
ones are private like the conversation. Limits: `JARVIS_UPLOAD_MAX_GB` (default 200), `JARVIS_KEEP_INBOX=1` keeps
the uploaded copy of an export after its import (otherwise it is removed, the archive in `memory/archiv` stays).

### Video theater

Jarvis takes a link to a video, downloads it with yt-dlp (through uv, `hud/server/media.mjs`) and shows it on the
HUD with its chapters, a waveform and a transcript (`hud/server/video.mjs`, `hud/public/js/video.js`). Details for
users are in `docs/VIDEO.md`. `:id` is the id from the answer (`youtube-<id>`) or the word `current` for the video
that is open right now.

| Method and path | What it does |
|---|---|
| `POST /api/video` | `{ url }` → `{ ok, video }` as soon as the metadata is known (2 to 5 s), the download and the analysis go on in the background. Opens the theater on every connected page. The URL must be http(s) to a public host. An analysed video opens at once. Errors: `400` not a link, `502` with a Slovak message and `code` (`unavailable`, `age`, `login`, `live`, `network`, `unsupported`, `too-long`, `too-big`, `no-uv`, …). |
| `GET /api/video` | `{ ok, current, available, videos }`: the open video's id, whether yt-dlp can run, recent analyses newest first. |
| `GET /api/video/:id` | `{ ok, video, transcript: [{ start, end, text }], peaks: [0..1], position }`. `?brief=1` leaves the transcript and the peaks out. |
| `GET /api/video/:id/file` | The video file (mp4 when the site has H.264), with range requests. `404` while it downloads. |
| `GET /api/video/:id/thumb` | The thumbnail. |
| `GET /api/video/:id/transcript?from=&to=&q=&max=` | The transcript as text for the brain, one line per segment `[12:40] text`. `from`/`to` take seconds, `mm:ss`, `h:mm:ss` or `+30`/`-10` relative to playback, `q` keeps the lines that contain all its words (plus one line of context), `max` is the size limit in characters (default 9000). → `{ ok, text, lines, total, matches, truncated, note, position, state, source, lang }`. |
| `POST /api/video/:id/seek` | `{ t }` (same time formats) → `{ ok, id, t, label, ready }`. The page animates the jump. Opens the theater on that video when another one or none is on screen. |
| `POST /api/video/:id/control` | `{ action: "play" \| "pause" \| "rate" \| "close", rate? }`. `rate` is 0.25 to 3. `close` also ends a download that has not finished. |
| `POST /api/video/:id/position` | `{ t, paused, rate }` from the page every few seconds, so the tools know where playback is. Not broadcast. |

`video`: `{ id, url, title, uploader, duration, chapters: [{ start, end, title }], state: "downloading" | "ready" | "error",
step, hasFile, fileUrl, thumbUrl, bytes, peaks, transcript: { state: "pending" | "ready" | "none" | "error", source:
"subtitles" | "auto" | "whisper", lang, lines, words, note }, error: { code, text } | null, open, views, uploaded }`.

Files live in `data/video/<id>/` (`meta.json`, `video.<ext>`, `thumb.<ext>`, `transcript.json`, `peaks.json`). Limits in
`.env`: `JARVIS_VIDEO_MAX_MIN` (180), `JARVIS_VIDEO_MAX_MB` (1500), `JARVIS_VIDEO_HEIGHT` (720), `JARVIS_VIDEO_KEEP` (6
videos), `JARVIS_VIDEO_CACHE_GB` (6), `JARVIS_VIDEO_WHISPER_MAX_MIN` (60). yt-dlp is pinned in `hud/server/media.mjs`
(`JARVIS_YTDLP_VERSION` overrides it, `JARVIS_YTDLP_BIN` uses a system yt-dlp, `JARVIS_YTDLP_AUTOUPDATE=0` turns off the
one retry with the newest yt-dlp when the pinned one no longer understands a site).

### Mobil (remote access)

| Method and path | What it does |
|---|---|
| `GET /api/remote/session` | Anyone: `{ local, loggedIn, enabled, device }`. The login page asks it first. |
| `POST /api/remote/login` | `{ email, password, next? }` → `200 { ok, device, next }` and two cookies: `__Host-jarvis_session=…; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` and the known-device cookie `__Host-jarvis_device=…` (same flags, 400 days, survives a logout; `logout-all` and a new password forget it). `401` wrong email or password (one message for both), `403` mobile access off, `429 { retryAfter }` with a `retry-after` header while the address (IPv6: its /64) or everybody waits; a known device is not stopped by the lock for everybody. A device that logs in for the first time is announced on the computer (notification, LOG, card). |
| `POST /api/remote/logout` | This device logs out. |
| `POST /api/remote/alive` | `{ id }` (the window id from SSE `you`): the phone page is still in front and keeps Jarvis's voice. |
| `GET /api/remote/status` | Loopback: `{ enabled, email, hasPassword, passwordMin, passwordLong, mode: quick\|named, hostname, hasToken, devices: [{ id, device, created, seen }], known: [{ device, created, lastLogin, active }], lock: { until } \| null, tunnel: { state: off\|starting\|running\|error, mode, url, error, installing }, cloudflared, address }`. A phone gets only `{ local: false, enabled }`. |
| `POST /api/remote/settings` | Loopback and only from a browser page (Origin required): `{ email?, password?, password2?, mode?, hostname?, token?, enabled? }`. Password: at least 12 characters with three of small letters, capitals, digits and other characters, or at least 16. A new password logs every device out and forgets the known devices. Every change of email or password is announced on the computer. Never reachable from the brain's `settings` tool. |
| `POST /api/remote/tunnel` | Loopback: `{ action: start \| stop \| restart \| show, mode? }`. `start` turns mobile access on (needs email and password), `stop` turns it off and logs every device out, `show` opens Settings → Mobil on the screen (SSE `world { panel: "settings", tab: "mobil" }`). |
| `POST /api/remote/logout-all` | Loopback: every device logs out and the known devices are forgotten → `{ count }`. |
| `WS /api/events/ws` | The SSE stream of `/api/events` over a WebSocket, one text message per write, same frames. Used by pages opened through the tunnel (a Cloudflare quick tunnel holds back SSE). `?client=phone` makes the window a phone: while it says it is alive (`{"alive":"<id>"}` or `POST /api/remote/alive`, every 20 s) it owns the voice. |

### Record mode

`docs/ZAZNAM.md` says what it does. Files: `data/recordings/<id>/` (`session.json`, `chunks.jsonl`, `audio/*.wav`,
`zvuk.m4a`, `screen/video-<part>.webm`, `screen/shots/*.jpg`, `frames/*.jpg`, `transcript.md`). The id is the start:
`2026-11-26-1432`. POST like every other POST (only this computer, or the token from the network), GET private like the
conversation.

| Method and path | What it does |
|---|---|
| `POST /api/record/start` | `{ title?, via? }` → `{ ok, session, already? }`. Starts a recording, or returns the running one (`already: true`). `507` with less than a gigabyte free. |
| `POST /api/record/stop` | `{ id? }` → `{ ok, session }` with `status: "finishing"`. The open window sends its last chunk, the rest of the transcript is made, the sound is compressed, then a background job does the after-actions (`status: "processing"`, `job`). |
| `POST /api/record/finish` | `{ id }` runs the after-actions again (an interrupted or failed recording). |
| `POST /api/record/chunk?id=&kind=audio&seq=&at=&final=1` | Raw body: one WAV (PCM 16 bit, 16 kHz mono from the page) of about 5 s. `seq` is the chunk's place in time (80 ms frames from the start, so it never repeats across reloads), `at` the start in ms since the epoch. Written and fsynced before the answer; the same `seq` twice is taken once. `409` with `state` when the recording no longer runs. |
| `POST /api/record/chunk?id=&kind=video&part=` | Raw body: a piece of the screen video (`MediaRecorder`, webm), appended to `screen/video-<part>.webm`. While pieces come, the server takes no pictures of its own. |
| `POST /api/record/chunk?id=&kind=frame&at=` | Raw body: one JPEG taken from the screen video, for the after-actions. |
| `GET /api/record` | `{ ok, active, recent, sttReady }`. A session: `{ id, title, status: recording\|finishing\|processing\|done\|failed, startedAt, endedAt, lastChunkAt, seconds, chunks, nextSeq, nextPart, bytes, screen: video\|shots, shots, transcribedSeconds, stt, interrupted, job, note, warn, dir }`. |
| `GET /api/record/:id` | One session plus `transcript` (its last 6000 characters) and `transcriptFile`. |

### Login card

A service that needs the user's own credentials (Garmin) gets a card in the conversation instead of a terminal
(`hud/server/login.mjs`). These three answer **only this computer** (loopback, a localhost `Host`, the page's own
`Origin` or none): never the phone or the network, not even with the token or a phone session, so a password never
travels through the tunnel.

| Method and path | What it does |
|---|---|
| `POST /api/login/card` | `{ service: "garmin", reason?: "expired" }` → `{ ok, card }`. Puts the card into the conversation (what the voice tool `ask_login` does; `node scripts/garmin.mjs connect` uses it). |
| `GET /api/alarm` | `{ ok, ring, songs }`. `ring` is the alarm that is ringing right now (`{ id, at, seconds, time, greeting, sound, formal, test }`) or `null`; `songs` are the songs offered for the alarm (`[{ id, title, artist, ready, selected }]`). |
| `POST /api/alarm/ring` | From the alarm script (`scripts/alarm.mjs ring`): `{ ring }` when the alarm sound starts, `{ ring: null, id, stopped }` when it is over. Open windows get the SSE event `alarm` and show or take away "Dobré ráno" with the button. Loopback only. |
| `POST /api/alarm/stop` | `{ id? }` → `{ ok, stopped }`. The button on the ringing alarm: the alarm script silences the sound and says the brief at once (`hud/server/alarm.mjs`, `data/alarm/ringing.json`). |
| `POST /api/alarm/card` | `{ time?, days? }` → `{ ok, card }`. Puts the alarm card into the conversation (what the voice tool `ask_alarm` does; `node scripts/alarm.mjs card` uses it). Loopback only. |
| `POST /api/alarm/card/step` | One step of the alarm card: `{ card, step: "preview", song }` plays or stops a short listen through the speakers, `{ card, step: "set", time, song }` sets the alarm and the song, `{ card, step: "cancel" }` closes it. → `{ ok, card }` (`hud/server/alarm-card.mjs`). |
| `POST /api/login` | `{ card, step: "credentials", values: { email, password } }`, `{ card, step: "code", code }` or `{ card, step: "cancel" }` → `{ ok, card }`. The values go to the service's own client and nowhere else. `404` unknown card, `409` a step is still running, `410` the card is done or closed. |
| `POST /api/terminal` | `{ action }` → `{ ok, say }`. Opens a terminal window with one of the known commands (`hud/server/terminal.mjs`): the button under "not signed in". |

The card (`kind: "login"`) never carries a value the user typed: `{ id, kind, service, title, icon, node, text,
fields: [{ name, label, type, autocomplete }], code: { label, hint }, submit, state: form|code|done|closed, message, accent }`.
It changes in place with `chat { turn, phase: "card-update", card }`. The brain hears the outcome as a hidden turn
`[systém: prihlásenie cez kartu …]`.

## SSE `/api/events`

Named events: `status`, `mode`, `voice`, `chat`, `tts`, `world`, `snapshot`, `job`, `job-feed` (`{ id, entry }`, one new line of a job's feed), `import`, `hud`, `history`, `settings`, `video`, `record` (a session as in `GET /api/record`, on every change of state and every few seconds while it records).

One chat turn:

```text
chat {turn:7, phase:"user", text:"…", via:"voice", attachments?: [{ rel, name, type }]}
chat {turn:7, phase:"start"}
chat {turn:7, phase:"delta", text:"Pozriem "}
chat {turn:7, phase:"tool", id:"toolu_01", name:"calendar_list", label:"Pozerám kalendár", icon:"calendar", node:"kalendar", status:"run"}
chat {turn:7, phase:"tool", id:"toolu_01", …, status:"ok"}
chat {turn:7, phase:"card", card:{ id, kind:"stat"|"list"|"chart"|"text", title, … }}
chat {turn:7, phase:"done", text:"<whole answer>", ms:5230, stopped:false}
chat {turn:7, phase:"error", message:"Claude nie je prihlásený.", fix?:"claude_login"}
chat {turn:7, phase:"card-update", card:{ id, … }}
```

`fix` is an action of `POST /api/terminal`: the page shows a button that opens the login window.

- `tts { turn, seq, url, text, last, durMs, speak }`: clips sentence by sentence, play them in `seq` order.
  `speak: true` with `url: null` means the page reads the sentence itself (`speechSynthesis`).
  `{ turn, stop: true }` silences the turn.
- `voice { state, heard, level }`: `idle | wake | listening | transcribing | thinking | speaking`.
- `settings { … }`: the whole body of `GET /api/settings`, after every change and about once a second while the
  local Whisper is being prepared (`stt.prepare` carries the progress, `stt.engine` flips when it is ready).
- `world { focus, caption }`: the camera flies to a node. Nodes: `ludia projekty questy kalendar rutiny udalosti spravy fotky spanok`.
- `import { id, name, source, label, detail, stage, progress, state, result?, error?, pending }`: one import changed.
  `state`: `importing` (waiting in the queue or running, `progress` 0 to 1), `review` (people wait for the user),
  `applying`, `done`, `error`. `result`: `{ threads, messages, people, from, to, me, candidates, summary, notes, warnings }`.
  `{ pending }` alone updates the number of people waiting, `{ id, removed: true }` takes a card away.

- `video`: one of `{ type: "open", url, video | null, startAt }` (the theater opens, `video` is null until the
  metadata is known), `{ type: "state", video }`, `{ type: "progress", id, step: "transcript" | "video" | "waveform" | "done",
  state: "checking" | "downloading" | "converting" | "done", pct, text }`, `{ type: "transcript", id }` (new lines to fetch),
  `{ type: "seek", id, t, label, by: "jarvis" | "user" }`, `{ type: "control", id, action, rate? }`,
  `{ type: "error", url, error: { code, text } }` (the link could not be opened).

## Brain tools

The voice brain is a warm `claude -p` process with three MCP servers from `hud/server/mcp/`:

- `memory`: `calendar_list`, `view_todo`, `list_goals`, `upcoming_celebrations`, `get_health`, `memory_stats`, `search_notes`, `read_note`, `remember`, `add_todo`, `complete_todo`, `edit_todo`, `delete_todo`, `add_event`, `log_day`, `write_note`
- `computer`: `open_app`, `open_url`, `media`, `volume`, `screen_look` (`{ selection?, whole? }`: a picture of the front window that is not Jarvis, or of the main screen; returns the picture itself and its path in `data/screen/`, plus the selected text with `selection`), `open_terminal` (`{ action }`: a terminal window with one known command, `hud/server/terminal.mjs`)
- `jarvis-hud`: `hud_focus`, `hud_card`, `hud_log`, `show_media` (`{ paths, title? }`: photos, videos and audio as floating cards on the screen and thumbnails in a chat card; the files are allowed one by one under `GET /api/media/<id>`, see `hud/server/shown-media.mjs`), `weather`, `call_user`, `agent_task`, `agent_jobs`, `agent_reply`, `agent_stop`, `set_alarm` (runs `scripts/alarm.mjs`), `set_alarm_sound` (`{ sound }`: a file path, a link, `default` or `builtin`; runs `scripts/alarm.mjs sound`), `video_open` (`{ url }`), `video_seek` (`{ time, id? }`), `video_transcript` (`{ id?, from?, to?, query? }`), `video_info` (`{ id? }`), `video_control` (`{ action, rate?, id? }`), `video_close` (the video tools call `/api/video…`; text from a video is framed as data, never as instructions), `settings` (`{ set? }`: the same change as `POST /api/settings`, without `set` the current values and the voices), `record_start` (`{ title? }`), `record_stop`, `record_status` (record mode, `docs/ZAZNAM.md`), `ask_login` (`{ service }`: the login card, see Login card)

plus the built-in `WebSearch` and `WebFetch`, and `Read` limited to `memory/prilohy` (files dropped into the HUD;
`data/brain` is denied explicitly).

## Scripts that talk to the server

- `scripts/voice.mjs prepare [--progress] [--json] [--force]` gets the voice ready before the HUD opens: picks the
  speech-to-text plan for this computer (`hud/server/stt-plan.mjs`), downloads the Whisper model (resumable, every
  file checked against its SHA-256), warms the Python packages of the voice and of Whisper and transcribes a test
  sentence. With `--progress` it prints one JSON object per line,
  `{"step":"uv"|"plan"|"tts"|"whisper","state":"checking"|"downloading"|"verifying"|"done"|"skipped"|"error","pct":0-100|null,"text":"…"}`,
  and the result on the last line: `{"ok":true,"stt":{"engine","model","status","device","sizeMb","reason","modelDir"},"tts":{"provider","voice","ok"},"notes":[…]}`.
  `ok` is true and the exit code 0 also when it ends in a fallback to the browser (`stt.status` is then `fallback`
  or `failed` and `stt.reason` says why). The plan is recorded in `data/voice/stt-plan.json`, the progress of a
  running prepare in `data/voice/prepare.json`. The server reads both: it switches the speech engine when the plan
  is ready and starts a prepare itself when one is needed. `scripts/voice.mjs plan [--json]` only shows the plan.
  `scripts/hud.mjs` runs the prepare before it opens the window for the first time and waits for it at most
  `JARVIS_PREPARE_WAIT_S` seconds (default 900).

- `scripts/job.mjs "<task>" --title "<title>"` → `POST /api/jobs` (starts the server when it is not running), `--list` → `GET /api/jobs`.
- `scripts/record.mjs start ["<title>"] | stop | status | list | finish <id> [--json]` → `/api/record…` (record mode).
- `scripts/say.mjs "<text>"` → `POST /api/say` when a HUD window is connected (`GET /api/health` → `clients`), otherwise the
  computer's speakers (`hud/server/speak.mjs`).
- `scripts/pulse.mjs` and `scripts/routine.mjs` post `/api/announce` with `silent: true` when no window is connected and
  speak through the speakers instead. `scripts/alarm.mjs ring` always speaks through the speakers and only shows the card.
- `scripts/watch.mjs` (stráže, docs/STRAZE.md) posts `/api/announce` when a watch comes true and `POST /api/orbs { action: "reload" }`
  after every change, so the orb Stráže redraws. The voice tool `watch` runs the same script with `--json`.

- `scripts/media.mjs video <url>` → `POST /api/video` when the server runs (the theater opens), otherwise it analyses the
  video into `data/video` on its own. `prepare`, `info`, `audio` and `transcript` need no server. `--progress` prints one
  JSON object per line: `{ step: "ytdlp" | "alarm-song" | "video" | "transcript", state: "checking" | "downloading" | "converting" | "done" | "skipped" | "error", pct, text }` and a last `{ ok, … }`.
- `scripts/alarm.mjs sound [<file|url>|default|builtin] [--seconds n]` sets `alarm.sound` (and `alarm.soundSeconds`) in
  `config/jarvis.json` and keeps the files in `data/alarm/` (`hud/server/alarm-sound.mjs`).

For development on a machine that runs its own Jarvis: `JARVIS_SCHEDULE_DRY=1` keeps `schedule.mjs install` (and
`alarm.mjs set`) away from launchd and Task Scheduler, `JARVIS_AUDIO=off` prepares the voice files but plays nothing.


## Orby a nastavenie (od 1.4.0)

| | |
|---|---|
| `GET /api/orbs` | `{ ok, hidden, pinned, custom: [{ id, label, icon, color, shape, kind, folder? }], content: { <id>: { value, sub, alert, count, panel, updatedAt } } }` |
| `POST /api/orbs` | `{ action: add \| update \| remove \| hide \| show \| pin \| unpin \| content \| clear \| reload, id, … }`. Odpoveď má `summary` a nový stav. Otvorené stránky dostanú SSE `orbs`. Tvar obsahu je v `docs/ORBY.md`. |
| `POST /api/todos` | Jedna úloha z `memory/ulohy.md`: `{ action: delete \| edit \| done \| restore, ref: { text, due, n }, text?, due?, undo? }`. `ref` dáva svet Úlohy (`GET /api/inner/ulohy`, pole `ref` pri položke), `due: null` termín zruší, `restore` vezme `undo` z odpovede a vráti riadok na jeho miesto. Ostatné riadky súboru ostanú bajt po bajte. `409`, keď úloha v súbore už nie je. Otvorené stránky dostanú SSE `inner` `{ node: "ulohy" }`. To isté robia nástroje mozgu `edit_todo` a `delete_todo`. |
| `GET /api/inner/<id>` | Vnútro orbu: `items`, `groups` a pri orbe s obsahom aj `panel` (komponenty). Platí aj pre vlastné orby. |
| `GET /api/setup` | Stav inštalácie vrátane `setup: { done, hotove, caka, ciel, next }` a `ai` (`claude` alebo `codex`). |
| `GET /api/apps`, `POST /api/apps` | `{ picked, own, detected, connected }`. `own` sú appky, ktoré používateľ dopísal menom. |

SSE udalosti navyše: `orbs` (nová sada orbov), `setup` (zmena stavu nastavenia), `settings`, `video`, `world` s `flare` (orb sa rozžiari) alebo `panel: "settings"`.

Hlasový mozog má k tomu nástroje `hud_orb`, `setup_note`, `settings`, `video_*`, `set_alarm_sound` (server `jarvis-hud`), `media` a `volume` (server `computer`), `activity_today`, `activity_set`, `garmin_sync` (server `memory`).

### Anonymné štatistiky

| Method and path | What it does |
|---|---|
| `GET /api/telemetry` | `{ on, reason, lastSent, endpoint, preview }`: whether statistics are on (`reason`: `settings`, `env`, `do-not-track`, `test` when off) and exactly the next ping. `POST /api/settings { telemetry: false }` turns them off. |
