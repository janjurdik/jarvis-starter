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

## Endpoints

| Method and path | What it does |
|---|---|
| `POST /api/chat` | `{ text, via: "text"\|"voice", mock?, silent?, attachments? }` → `202 { ok, turn }`. The answer arrives over SSE. A new message interrupts the running one. `attachments` are paths returned by an upload (`prilohy/2026-11/foto.jpg`); the brain gets them on an extra line `[prílohy: /abs/path, …]` and opens them with `Read`. |
| `POST /api/chat/stop` | Interrupts Claude and the voice. |
| `GET /api/chat/history` | Last 20 exchanges. |
| `POST /api/stt` | Body = recording from `MediaRecorder` (webm, ogg, wav, mp4). Transcribed by the local Whisper and sent to the chat. `409` when `JARVIS_STT` is `browser`. `?attach=<JSON list of attachment paths>` sends files with the spoken message. |
| `POST /api/listen/wake` | `{ on }` turns "Hey Jarvis" on or off (needs a local Whisper). |
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
| `POST /api/announce` | `{ title, text, say?, silent? }` from routines: card + LOG line + voice. Loopback only. |
| `POST /api/event` | `{ type, text, icon?, node? }` adds a LOG line. Loopback only. |
| `GET /api/jobs`, `POST /api/jobs` | Background jobs (full Claude Code runs, full access). `GET /api/jobs/:id` → one job with its assignment and feed `[{ t, kind: task\|reply\|step\|say\|state, text }]`. `POST /api/jobs/:id/stop` ends it with everything it started, `POST /api/jobs/:id/reply` `{ text }` continues an ended job in the same session. |
| `POST /api/mode` | `{ film }` filming mode: names of people and private titles are hidden. |
| `POST /api/brain/restart` | Restarts the Claude process. |
| `GET /tts/<hash>.mp3` | Synthesised voice clips (cached in `data/tts/`). |

### Files and imports

Dropped files are streamed to `data/inbox/<id>/<name>` (never held in memory), then `scripts/import.mjs detect`
says what they are. An ordinary file is copied to `memory/prilohy/<YYYY-MM>/` and comes back as an attachment for
the chat. A data export (Instagram, WhatsApp, ChatGPT, …) is imported in the background, one at a time, and ends
with the people review. Nothing that was uploaded is ever opened or run by the server.

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

## SSE `/api/events`

Named events: `status`, `mode`, `voice`, `chat`, `tts`, `world`, `snapshot`, `job`, `job-feed` (`{ id, entry }`, one new line of a job's feed), `import`, `hud`, `history`.

One chat turn:

```text
chat {turn:7, phase:"user", text:"…", via:"voice", attachments?: [{ rel, name, type }]}
chat {turn:7, phase:"start"}
chat {turn:7, phase:"delta", text:"Pozriem "}
chat {turn:7, phase:"tool", id:"toolu_01", name:"calendar_list", label:"Pozerám kalendár", icon:"calendar", node:"kalendar", status:"run"}
chat {turn:7, phase:"tool", id:"toolu_01", …, status:"ok"}
chat {turn:7, phase:"card", card:{ id, kind:"stat"|"list"|"chart"|"text", title, … }}
chat {turn:7, phase:"done", text:"<whole answer>", ms:5230, stopped:false}
```

- `tts { turn, seq, url, text, last, durMs, speak }`: clips sentence by sentence, play them in `seq` order.
  `speak: true` with `url: null` means the page reads the sentence itself (`speechSynthesis`).
  `{ turn, stop: true }` silences the turn.
- `voice { state, heard, level }`: `idle | wake | listening | transcribing | thinking | speaking`.
- `world { focus, caption }`: the camera flies to a node. Nodes: `ludia projekty questy kalendar rutiny udalosti spravy fotky spanok`.
- `import { id, name, source, label, detail, stage, progress, state, result?, error?, pending }`: one import changed.
  `state`: `importing` (waiting in the queue or running, `progress` 0 to 1), `review` (people wait for the user),
  `applying`, `done`, `error`. `result`: `{ threads, messages, people, from, to, me, candidates, summary, notes, warnings }`.
  `{ pending }` alone updates the number of people waiting, `{ id, removed: true }` takes a card away.

## Brain tools

The voice brain is a warm `claude -p` process with three MCP servers from `hud/server/mcp/`:

- `memory`: `calendar_list`, `view_todo`, `list_goals`, `upcoming_celebrations`, `get_health`, `memory_stats`, `search_notes`, `read_note`, `remember`, `add_todo`, `complete_todo`, `add_event`, `log_day`, `write_note`
- `computer`: `open_app`, `open_url`
- `jarvis-hud`: `hud_focus`, `hud_card`, `hud_log`, `weather`, `agent_task`, `agent_jobs`, `agent_reply`, `agent_stop`

plus the built-in `WebSearch` and `WebFetch`, and `Read` limited to `memory/prilohy` (files dropped into the HUD;
`data/brain` is denied explicitly).
