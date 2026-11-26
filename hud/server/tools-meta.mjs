/**
 * How a brain tool shows up in the HUD: a chip like "Pozerám kalendár" with an icon and a node
 * of the 3D world. Names are without the mcp__server__ prefix. HUD tools are not shown as chips,
 * their effect arrives as a card, a focus or a LOG line.
 */
export const NODES = ['ludia', 'projekty', 'questy', 'kalendar', 'rutiny', 'udalosti', 'spravy', 'fotky', 'spanok', 'ulohy', 'posta', 'appky']

export const ICONS = [
  'calendar', 'moon', 'heart', 'message', 'photo', 'check', 'quest', 'search', 'book', 'globe', 'bolt', 'music',
  'volume', 'chart', 'memory', 'eye', 'info', 'alarm', 'gift', 'routine', 'cloud', 'sun', 'code', 'wave', 'shield',
]

const META = {
  calendar_list: { label: 'Pozerám kalendár', icon: 'calendar', node: 'kalendar' },
  upcoming_celebrations: { label: 'Pozerám meniny a narodeniny', icon: 'gift', node: 'kalendar' },
  get_health: { label: 'Pozerám spánok', icon: 'moon', node: 'spanok' },
  garmin_sync: { label: 'Sťahujem dáta z hodiniek', icon: 'heart', node: 'spanok' },
  view_todo: { label: 'Pozerám úlohy', icon: 'check', node: 'projekty' },
  list_goals: { label: 'Pozerám ciele', icon: 'quest', node: 'questy' },
  read_note: { label: 'Čítam poznámku', icon: 'book', node: 'fotky' },
  search_notes: { label: 'Hľadám v pamäti', icon: 'search', node: 'fotky' },
  memory_stats: { label: 'Počítam pamäť', icon: 'chart', node: 'fotky' },
  remember: { label: 'Zapisujem do pamäte', icon: 'memory', node: 'ludia' },
  add_todo: { label: 'Pridávam úlohu', icon: 'check', node: 'projekty' },
  call_user: { label: 'Volám na mobil', icon: 'alarm', node: null },
  remind: { label: 'Nastavujem pripomienku', icon: 'alarm', node: 'kalendar' },
  set_alarm: { label: 'Nastavujem budík', icon: 'alarm', node: 'rutiny' },
  watch: { label: 'Nastavujem stráž', icon: 'eye', node: 'rutiny' },
  settings: { label: 'Mením nastavenia', icon: 'volume', node: null },
  set_alarm_sound: { label: 'Mením zvuk budíka', icon: 'music', node: 'rutiny' },
  video_open: { label: 'Otváram video', icon: 'eye', node: null },
  video_seek: { label: 'Preskakujem vo videu', icon: 'eye', node: null },
  video_transcript: { label: 'Čítam prepis videa', icon: 'book', node: null },
  video_info: { label: 'Pozerám údaje o videu', icon: 'info', node: null },
  video_control: { label: 'Ovládam video', icon: 'eye', node: null },
  video_close: { label: 'Zatváram video', icon: 'eye', node: null },
  search_messages: { label: 'Hľadám v rozhovoroch', icon: 'search', node: 'spravy' },
  read_thread: { label: 'Čítam rozhovor', icon: 'search', node: 'spravy' },
  complete_todo: { label: 'Odškrtávam úlohu', icon: 'check', node: 'projekty' },
  add_event: { label: 'Zapisujem do kalendára', icon: 'calendar', node: 'kalendar' },
  log_day: { label: 'Píšem do denníka', icon: 'book', node: 'udalosti' },
  write_note: { label: 'Píšem poznámku', icon: 'book', node: 'fotky' },
  open_app: { label: 'Otváram aplikáciu', icon: 'bolt', node: null },
  open_url: { label: 'Otváram web', icon: 'globe', node: null },
  screen_look: { label: 'Pozerám sa na obrazovku', icon: 'eye', node: null },
  open_terminal: { label: 'Otváram okno', icon: 'code', node: null },
  ask_login: { label: 'Pripravujem prihlásenie', icon: 'shield', node: null },
  record_start: { label: 'Zapínam záznam', icon: 'wave', node: null },
  record_stop: { label: 'Končím záznam', icon: 'wave', node: null },
  record_status: { label: 'Pozerám záznam', icon: 'wave', node: null },
  weather: { label: 'Pozerám počasie', icon: 'cloud', node: null },
  agent_task: { label: 'Spúšťam úlohu', icon: 'bolt', node: 'projekty' },
  agent_jobs: { label: 'Pozerám úlohy na pozadí', icon: 'check', node: 'projekty' },
  agent_reply: { label: 'Posielam doplnenie úlohy', icon: 'bolt', node: 'projekty' },
  agent_stop: { label: 'Zastavujem úlohu', icon: 'shield', node: 'projekty' },
  WebSearch: { label: 'Hľadám na webe', icon: 'globe', node: null },
  WebFetch: { label: 'Čítam web', icon: 'globe', node: null },
}

export const HIDDEN_TOOLS = new Set(['hud_focus', 'hud_card', 'hud_log'])

/** mcp__memory__calendar_list → calendar_list */
export const shortName = (name = '') => (name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name)

/**
 * Chip description. `input` is known only from the full assistant message, not at the first `run`
 * (a second event with the same id refines it). In filming mode without input details.
 */
export function toolMeta(rawName, input, { film = false } = {}) {
  const name = shortName(rawName)
  const base = META[name] ?? { label: `Používam ${name}`, icon: 'bolt', node: null }
  const meta = { name, ...base }
  if (!input || typeof input !== 'object') return meta
  if (name === 'open_app' && typeof input.name === 'string' && !film) {
    meta.label = `Otváram ${input.name.trim().slice(0, 40)}`
    if (/spotify|hudb|music/i.test(input.name)) meta.icon = 'music'
  }
  if (name === 'remember' && typeof input.about === 'string' && input.about && !/^(ja|me)$/i.test(input.about)) meta.node = input.kind === 'project' ? 'projekty' : 'ludia'
  if (name === 'weather' && typeof input.place === 'string' && input.place && !film) meta.label = `Počasie ${input.place.slice(0, 24)}`
  if (name === 'agent_task' && typeof input.title === 'string' && input.title && !film) meta.label = `Úloha: ${input.title.slice(0, 40)}`
  if (name === 'WebSearch' && typeof input.query === 'string' && !film) meta.label = `Hľadám: ${input.query.slice(0, 40)}`
  return meta
}
