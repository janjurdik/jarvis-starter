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
| `POST /api/chat` | `{ text, via: "text"\|"voice", mock?, silent? }` → `202 { ok, turn }`. The answer arrives over SSE. A new message interrupts the running one. |
| `POST /api/chat/stop` | Interrupts Claude and the voice. |
| `GET /api/chat/history` | Last 20 exchanges. |
| `POST /api/stt` | Body = recording from `MediaRecorder` (webm, ogg, wav, mp4). Transcribed by the local Whisper and sent to the chat. `409` when `JARVIS_STT` is `browser`. |
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
| `GET /api/jobs`, `POST /api/jobs` | Background jobs (full Claude Code runs). `POST /api/jobs/:id/stop`, `POST /api/jobs/:id/reply`. |
| `POST /api/mode` | `{ film }` filming mode: names of people and private titles are hidden. |
| `POST /api/brain/restart` | Restarts the Claude process. |
| `GET /tts/<hash>.mp3` | Synthesised voice clips (cached in `data/tts/`). |

## SSE `/api/events`

Named events: `status`, `mode`, `voice`, `chat`, `tts`, `world`, `snapshot`, `job`, `hud`, `history`.

One chat turn:

```text
chat {turn:7, phase:"user", text:"…", via:"voice"}
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

## Brain tools

The voice brain is a warm `claude -p` process with three MCP servers from `hud/server/mcp/`:

- `memory`: `calendar_list`, `view_todo`, `list_goals`, `upcoming_celebrations`, `get_health`, `memory_stats`, `search_notes`, `read_note`, `remember`, `add_todo`, `complete_todo`, `add_event`, `log_day`, `write_note`
- `computer`: `open_app`, `open_url`
- `jarvis-hud`: `hud_focus`, `hud_card`, `hud_log`, `weather`, `agent_task`, `agent_jobs`, `agent_reply`, `agent_stop`

plus the built-in `WebSearch` and `WebFetch`.
