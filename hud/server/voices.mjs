/**
 * The voices Jarvis can speak with (Microsoft Edge neural voices) and how the current one is chosen:
 *
 *   config/jarvis.json "voice.id"  →  JARVIS_EDGE_VOICE in .env  →  default for the language and
 *   the assistant's gender (sk: Lukáš / Viktória, cs: Antonín / Vlasta)
 *
 * The voice is resolved again for every sentence, so a change in the config applies at once.
 * The multilingual voices speak Slovak and Czech with a light foreign accent. Only those are listed
 * whose Slovak a Whisper transcribes back word for word (the German multilingual voices do not pass).
 */
export const VOICES = [
  { id: 'sk-SK-LukasNeural', label: 'Lukáš', gender: 'male', lang: 'sk' },
  { id: 'sk-SK-ViktoriaNeural', label: 'Viktória', gender: 'female', lang: 'sk' },
  { id: 'cs-CZ-AntoninNeural', label: 'Antonín', gender: 'male', lang: 'cs' },
  { id: 'cs-CZ-VlastaNeural', label: 'Vlasta', gender: 'female', lang: 'cs' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew (viacjazyčný)', gender: 'male', lang: 'multi' },
  { id: 'en-US-BrianMultilingualNeural', label: 'Brian (viacjazyčný)', gender: 'male', lang: 'multi' },
  { id: 'fr-FR-RemyMultilingualNeural', label: 'Rémy (viacjazyčný)', gender: 'male', lang: 'multi' },
  { id: 'en-US-AvaMultilingualNeural', label: 'Ava (viacjazyčná)', gender: 'female', lang: 'multi' },
  { id: 'en-US-EmmaMultilingualNeural', label: 'Emma (viacjazyčná)', gender: 'female', lang: 'multi' },
  { id: 'fr-FR-VivienneMultilingualNeural', label: 'Vivienne (viacjazyčná)', gender: 'female', lang: 'multi' },
]

const DEFAULTS = {
  sk: { male: 'sk-SK-LukasNeural', female: 'sk-SK-ViktoriaNeural' },
  cs: { male: 'cs-CZ-AntoninNeural', female: 'cs-CZ-VlastaNeural' },
}
export const DEFAULT_RATE = '+4%'
export const DEFAULT_PITCH = '-2Hz'

/** Shape of an Edge voice id (sk-SK-LukasNeural, en-US-AndrewMultilingualNeural, zh-CN-liaoning-XiaobeiNeural). */
export const isVoiceId = (v) => typeof v === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,12}){1,2}-[A-Za-z0-9]{2,40}Neural$/.test(v)
export const isRate = (v) => typeof v === 'string' && /^[+-]\d{1,3}%$/.test(v)
export const isPitch = (v) => typeof v === 'string' && /^[+-]\d{1,3}Hz$/.test(v)

export const langOf = (value) => (String(value ?? '').toLowerCase().startsWith('cs') ? 'cs' : 'sk')
export const voiceById = (id) => VOICES.find((v) => v.id === id) ?? null
export const defaultVoiceId = (lang, gender) => DEFAULTS[langOf(lang)][gender === 'female' ? 'female' : 'male']

/**
 * The list for the settings: the built-in voices plus a voice the user set by hand in .env or the
 * config that is not among them (it must stay selectable, otherwise saving would lose it).
 */
export function voiceList(cfg, env = process.env) {
  const list = [...VOICES]
  for (const id of [cfg?.voice?.id, env.JARVIS_EDGE_VOICE]) {
    if (isVoiceId(id) && !list.some((v) => v.id === id)) list.push({ id, label: id.replace(/Neural$/, '').split('-').pop(), gender: null, lang: 'custom' })
  }
  return list
}

/** The voice to speak with right now: { id, rate, pitch }. */
export function resolveVoice(cfg, env = process.env) {
  const lang = langOf(env.JARVIS_LANG || cfg?.language)
  const id = isVoiceId(cfg?.voice?.id) ? cfg.voice.id : isVoiceId(env.JARVIS_EDGE_VOICE) ? env.JARVIS_EDGE_VOICE : defaultVoiceId(lang, cfg?.assistant?.gender)
  const rate = isRate(cfg?.voice?.rate) ? cfg.voice.rate : isRate(env.JARVIS_EDGE_RATE) ? env.JARVIS_EDGE_RATE : DEFAULT_RATE
  const pitch = isPitch(cfg?.voice?.pitch) ? cfg.voice.pitch : isPitch(env.JARVIS_EDGE_PITCH) ? env.JARVIS_EDGE_PITCH : DEFAULT_PITCH
  return { id, rate, pitch }
}
