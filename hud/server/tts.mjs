/**
 * Jarvis's voice: a chain of providers, a cache keyed by hash and a per-turn sentence queue.
 *
 *   edge        Microsoft Edge neural voices, persistent Python worker started through uv. Free,
 *               works on macOS and Windows. The voice comes from the settings (server/voices.mjs)
 *               and is read again for every sentence, so a change applies without a restart.
 *   elevenlabs  only with JARVIS_TTS=elevenlabs and ELEVENLABS_API_KEY in .env
 *   say         macOS `say`, offline fallback
 *   browser     no audio file: the page speaks the sentence with the browser's own voice
 *               (last resort when uv is missing or the network is down)
 *
 * Files: data/tts/<sha1>.mp3 (say: .m4a). The hash covers provider, voice, rate, pitch and text, so
 * every voice has its own clips and content never changes for a hash (the browser may cache it).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { getConfig } from './config.mjs'
import { errMsg, findBin, IS_MAC, log, ROOT, spawnBin, TTS_DIR, workerEnv } from './util.mjs'
import { resolveVoice } from './voices.mjs'

const UV = findBin('uv', { override: process.env.UV_BIN })
/** The Edge voice of this moment: { id, rate, pitch } from the config, .env or the default. */
const edgeVoice = () => resolveVoice(getConfig())
const SAY_VOICE = process.env.JARVIS_SAY_VOICE || 'Laura'
const WANT = (process.env.JARVIS_TTS || 'edge').toLowerCase()
const CACHE_MAX_FILES = 1500

// ── text na reč ──────────────────────────────────────────────────────────

const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many)

/**
 * Text odpovede → text na vyslovenie. Markdown, emoji a URL by Edge čítal doslova
 * („hviezdička hviezdička"), skratky jednotiek po slovensky so správnym tvarom.
 */
export function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'odkaz')
    .replace(/(\*\*|__|\*|_)(?=\S)([^*_]+?)\1/g, '$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*\|\s*|\s*\|\s*$/gm, '')
    .replace(/\s*\|\s*/g, ', ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+[–—]\s+/g, ', ')
    .replace(/\b(\d+)\s*h\b/g, (_, n) => `${n} ${plural(Number(n), 'hodina', 'hodiny', 'hodín')}`)
    .replace(/\b(\d+)\s*min\b\.?/g, (_, n) => `${n} ${plural(Number(n), 'minúta', 'minúty', 'minút')}`)
    .replace(/\bnapr\./g, 'napríklad')
    .replace(/\batď\./g, 'a tak ďalej')
    .replace(/\btzn\./g, 'to znamená')
    // Whatever markup is left (an unclosed **, a stray #, ~~, a backtick) would be read out as "hviezdička".
    .replace(/[*~#`]+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

const ABBREV = new Set(['napr', 'tzn', 'atď', 'resp', 'cca', 'č', 'str', 'sv', 'p', 'prof', 'doc', 'ing', 'mgr', 'bc', 'tj', 'príp', 'odd', 'ul', 'tr', 'vs', 'min'])

/**
 * Seká streamovaný text na vety pre TTS. Prvá veta ide von hneď, aby prvý zvuk
 * zaznel čo najskôr, kratučké vety v strede sa lepia k ďalšej (menej požiadaviek).
 */
export class SentenceSplitter {
  constructor(onSentence) {
    this.onSentence = onSentence
    this.buf = ''
    this.held = ''
    this.count = 0
  }

  push(delta) {
    this.buf += delta
    this.drain(false)
    clearTimeout(this.timer)
    // Veta skončila bodkou a nič ďalšie nechodí (Claude volá nástroj): po chvíli ju pošli.
    if (/[.!?…]["“”')»]*$/.test(this.buf.trimEnd())) this.timer = setTimeout(() => this.softFlush(), 140)
  }

  /** Pošle hotové vety hneď (začiatok nástroja, koniec bloku). Nedokončenú vetu nechá. */
  softFlush() {
    clearTimeout(this.timer)
    const trimmed = this.buf.trimEnd()
    if (!/[.!?…:]["“”')»]*$/.test(trimmed)) return
    this.buf += ' '
    this.drain(false)
    const rest = this.buf.trim()
    if (rest && /[.!?…:]["“”')»]*$/.test(rest)) {
      this.buf = ''
      this.emit(rest)
    }
  }

  flush() {
    clearTimeout(this.timer)
    this.drain(true)
    const rest = `${this.held} ${this.buf}`.trim()
    this.buf = ''
    this.held = ''
    if (rest) this.emit(rest, true)
  }

  emit(sentence, final = false) {
    const text = speakable(sentence)
    if (!/[\p{L}\p{N}]/u.test(text)) return
    if (!final && this.count > 0 && text.length < 22 && !this.held) {
      this.held = text
      return
    }
    const joined = this.held ? `${this.held} ${text}` : text
    this.held = ''
    // Dlhá veta = dlhá syntéza (Edge ~3x rýchlejšie než reálny čas): rozdeliť pri čiarke v strede,
    // prvý kúsok zaznie skôr a pauza pri čiarke je prirodzená.
    if (joined.length > 110) {
      const lo = Math.floor(joined.length * 0.3)
      const hi = Math.floor(joined.length * 0.7)
      let cut = -1
      for (let i = lo; i <= hi; i++) if (joined[i] === ',' && joined[i + 1] === ' ' && (cut < 0 || Math.abs(i - joined.length / 2) < Math.abs(cut - joined.length / 2))) cut = i
      if (cut > 0) {
        this.count += 2
        this.onSentence(joined.slice(0, cut + 1))
        this.onSentence(joined.slice(cut + 2))
        return
      }
    }
    this.count++
    this.onSentence(joined)
  }

  boundary(final) {
    const s = this.buf
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === '\n') {
        if (s.slice(0, i).trim()) return i + 1
        continue
      }
      if (!'.!?…'.includes(ch)) continue
      let j = i + 1
      while (j < s.length && '.!?…"“”\')»'.includes(s[j])) j++
      if (j >= s.length) return final ? j : -1
      if (!/\s/.test(s[j])) continue
      if (ch === '.') {
        const before = s.slice(0, i)
        const word = /([\p{L}\p{N}]+)$/u.exec(before)?.[1] ?? ''
        const after = s.slice(j).trimStart()
        const nextLower = /^[\p{Ll}\d]/u.test(after)
        if (/^\d+$/.test(word) && /^\d/.test(after)) continue // 9. 11. 2026
        if (/^\d+$/.test(word) && nextLower) continue // 1. semester
        if (ABBREV.has(word.toLowerCase()) && nextLower) continue
        if (/^\p{Lu}$/u.test(word)) continue // iniciála
      }
      return j
    }
    if (s.length > 240) {
      const cut = Math.max(s.lastIndexOf(', ', 200), s.lastIndexOf('; ', 200))
      if (cut > 60) return cut + 2
      const space = s.lastIndexOf(' ', 220)
      if (space > 60) return space + 1
    }
    return -1
  }

  drain(final) {
    for (;;) {
      const at = this.boundary(final)
      if (at <= 0) return
      const sentence = this.buf.slice(0, at).trim()
      this.buf = this.buf.slice(at)
      if (sentence) this.emit(sentence)
    }
  }
}

// ── poskytovatelia ───────────────────────────────────────────────────────

/** Odhad dĺžky klipu: Edge MP3 je CBR 48 kbps mono. */
const mp3DurMs = (bytes) => Math.round((bytes * 8) / 48)

class EdgeWorker {
  constructor() {
    this.proc = null
    this.ready = null
    this.waiting = new Map()
    this.seq = 0
    this.failures = 0
    this.disabledUntil = 0
  }

  start() {
    if (this.ready) return this.ready
    if (!UV) return (this.ready = Promise.reject(new Error('uv sa nenašiel (Edge TTS)')))
    this.ready = new Promise((resolve, reject) => {
      const proc = spawnBin(UV, ['run', '--quiet', join(ROOT, 'server/tts/edge_worker.py')], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: workerEnv({ PYTHONUNBUFFERED: '1' }),
      })
      this.proc = proc
      // The very first start downloads Python packages, later starts take about a second.
      const timer = setTimeout(() => reject(new Error('Edge worker nenaštartoval do 4 minút')), 240_000)
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.ready) {
          clearTimeout(timer)
          resolve()
          return
        }
        const job = this.waiting.get(msg.id)
        if (!job) return
        this.waiting.delete(msg.id)
        if (msg.ok) job.resolve(msg)
        else job.reject(new Error(msg.error || 'Edge TTS zlyhal'))
      })
      createInterface({ input: proc.stderr }).on('line', (line) => {
        if (!/DeprecationWarning|ws_connect\(/.test(line)) log('tts', `edge: ${line.slice(0, 200)}`)
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Edge worker skončil (${code})`))
        for (const job of this.waiting.values()) job.reject(new Error('Edge worker skončil'))
        this.waiting.clear()
        this.proc = null
        this.ready = null
      })
      proc.on('error', (err) => reject(err))
    })
    this.ready.catch(() => {})
    return this.ready
  }

  warm() {
    this.start()
      .then(() => this.proc?.stdin.write('{"warm":true}\n'))
      .catch(() => {})
  }

  async synth(text, out, voice) {
    await this.start()
    const id = `e${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('Edge TTS neodpovedal do 20 s'))
      }, 20_000)
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      this.proc.stdin.write(JSON.stringify({ id, text, voice: voice.id, rate: voice.rate, pitch: voice.pitch, out }) + '\n')
    })
  }

  stop() {
    this.proc?.kill('SIGTERM')
  }
}

const edge = new EdgeWorker()

/** ElevenLabs key and voice from .env, used only with JARVIS_TTS=elevenlabs. */
function elevenConfig() {
  return {
    key: process.env.ELEVENLABS_API_KEY || '',
    voice: process.env.ELEVENLABS_VOICE_ID || 'onwK4e9ZLuTAKqWW03F9',
    model: process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
  }
}

async function synthEleven(text, out) {
  const cfg = elevenConfig()
  if (!cfg.key) throw new Error('ElevenLabs kľúč chýba')
  const t0 = Date.now()
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.voice}`)
  url.searchParams.set('output_format', 'mp3_44100_128')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: cfg.model,
      language_code: process.env.JARVIS_LANG || 'sk',
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true, speed: 1.1 },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(`${out}.part`, buf)
  await rename(`${out}.part`, out)
  return { ms: Date.now() - t0, bytes: buf.length, durMs: Math.round((buf.length * 8) / 128) }
}

function synthSay(text, out) {
  if (!IS_MAC) return Promise.reject(new Error('say je len na macOS'))
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tmp = `${out}.part.m4a`
    const child = spawn('/usr/bin/say', ['-v', SAY_VOICE, '-r', '200', '-o', tmp, '--file-format=m4af', '--data-format=aac', '--', text], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', async (code) => {
      if (code !== 0) return reject(new Error(`say skončil ${code}`))
      try {
        await rename(tmp, out)
        resolve({ ms: Date.now() - t0, durMs: Math.round(text.length * 62) })
      } catch (err) {
        reject(err)
      }
    })
  })
}

// ── verejné API ──────────────────────────────────────────────────────────

const FALLBACK = IS_MAC ? 'say' : 'browser'
const edgeUsable = () => Boolean(UV) && WANT !== 'say' && WANT !== 'browser' && edge.disabledUntil < Date.now()

export const ttsInfo = () => {
  const provider = WANT === 'off' ? 'off' : WANT === 'elevenlabs' ? 'elevenlabs' : edgeUsable() ? 'edge' : WANT === 'browser' ? 'browser' : FALLBACK
  return { provider, voice: provider === 'edge' ? edgeVoice().id : provider === 'say' ? SAY_VOICE : provider }
}

/** Can the Edge voices be used right now (uv installed, not turned off, the service answering)? */
export const edgeAvailable = () => WANT !== 'off' && edgeUsable()

const keyOf = (provider, voice, edge, text) => createHash('sha1').update(`${provider}|${voice}|${edge.rate}|${edge.pitch}|${text}`).digest('hex')

/** Poradie poskytovateľov pre jednu vetu. ElevenLabs len na výslovné želanie. */
function chain() {
  if (WANT === 'off') return []
  const list = []
  if (WANT === 'elevenlabs') list.push('elevenlabs')
  if (edgeUsable()) list.push('edge')
  if (IS_MAC && WANT !== 'browser') list.push('say')
  list.push('browser')
  return list
}

/**
 * Syntetizuje vetu (z cache, ak je). Vráti { url, file, provider, ms, durMs, cached }.
 * `voice` ({ id, rate?, pitch? }) asks for one Edge voice instead of the current one (a preview in
 * the settings): then only Edge is tried, another provider would answer with a different voice.
 */
export async function synthesize(text, { voice: asked = null } = {}) {
  await mkdir(TTS_DIR, { recursive: true })
  let lastErr = null
  const current = edgeVoice()
  const edgeNow = asked ? { id: asked.id, rate: asked.rate ?? current.rate, pitch: asked.pitch ?? current.pitch } : current
  for (const provider of asked ? ['edge'] : chain()) {
    // No file: the page reads the sentence itself with speechSynthesis.
    if (provider === 'browser') return { url: null, file: null, provider, ms: 0, durMs: Math.round(text.length * 70), cached: false, speak: true }
    const voice = provider === 'edge' ? edgeNow.id : provider === 'say' ? SAY_VOICE : elevenConfig().voice
    const ext = provider === 'say' ? 'm4a' : 'mp3'
    const hash = keyOf(provider, voice, edgeNow, text)
    const file = join(TTS_DIR, `${hash}.${ext}`)
    const url = `/tts/${hash}.${ext}`
    try {
      const info = await stat(file)
      return { url, file, provider, ms: 0, durMs: ext === 'mp3' && provider === 'edge' ? mp3DurMs(info.size) : Math.round(text.length * 62), cached: true }
    } catch {
      // nie je v cache
    }
    try {
      const t0 = Date.now()
      if (provider === 'edge') {
        const r = await edge.synth(text, file, edgeNow)
        edge.failures = 0
        return { url, file, provider, ms: Date.now() - t0, firstMs: r.first_ms, durMs: mp3DurMs(r.bytes), cached: false }
      }
      if (provider === 'elevenlabs') return { url, file, provider, cached: false, ...(await synthEleven(text, file)) }
      return { url, file, provider, cached: false, ...(await synthSay(text, file)) }
    } catch (err) {
      lastErr = err
      log('tts', `${provider} zlyhal: ${errMsg(err)}`)
      if (provider === 'edge' && ++edge.failures >= 3) {
        // Edge dlhšie nejde (sieť): na 2 minúty rovno say, nech každá veta nečaká na timeout.
        edge.disabledUntil = Date.now() + 120_000
        edge.failures = 0
      }
    }
  }
  throw lastErr ?? new Error('žiadny TTS poskytovateľ')
}

/** Vety, ktoré Jarvis hovorí najčastejšie (úvod pred nástrojom). Sú v cache, zaznejú bez čakania. */
export const COMMON_PHRASES = ['Pozriem kalendár.', 'Pozriem úlohy.', 'Pozriem ciele.', 'Pozriem počasie.', 'Pozriem pamäť.', 'Pozriem to.', 'Hneď to bude.', 'Zapíšem si to.', 'Rozumiem.', 'Hotovo.']

/** Pri štarte servera nahrá bežné vety do cache (Edge je zadarmo, ElevenLabs sa tu nevolá nikdy). */
export async function warmCommonPhrases() {
  if (chain()[0] !== 'edge') return
  let made = 0
  const voice = edgeVoice()
  for (const text of COMMON_PHRASES) {
    const hash = keyOf('edge', voice.id, voice, text)
    try {
      await stat(join(TTS_DIR, `${hash}.mp3`))
      continue
    } catch {
      // treba vyrobiť
    }
    try {
      await synthesize(text)
      made++
    } catch {
      return
    }
  }
  if (made) log('tts', `${made} bežných viet nahratých do cache`)
}

/** Otvorí Edge spojenia vopred, volá sa na začiatku turnu, kým Claude ešte myslí. */
export function warmTts() {
  if (chain()[0] === 'edge') edge.warm()
}

export function stopTts() {
  edge.stop()
}

/**
 * Fronta viet jedného turnu. Syntéza beží súbežne, udalosti `tts` odchádzajú presne
 * v poradí seq. `emit(clip)` dostane { seq, url, text, last, ms, durMs }.
 */
export function speechQueue(emit) {
  let nextSeq = 0
  let emitted = 0
  let ended = false
  let cancelled = false
  let closed = false
  const results = new Map()
  const out = (clip) => {
    if (clip.last) closed = true
    emit(clip)
  }

  const pump = () => {
    if (cancelled || closed) return
    while (results.has(emitted)) {
      const r = results.get(emitted)
      results.delete(emitted)
      const isLast = ended && emitted === nextSeq - 1
      if (r) out({ seq: emitted, url: r.url, file: r.file, text: r.text, last: isLast, ms: r.ms, durMs: r.durMs, provider: r.provider, speak: r.speak === true })
      else if (isLast) out({ seq: emitted, url: null, text: '', last: true, durMs: 0 })
      emitted++
    }
    // Posledná veta odišla skôr, než sme vedeli, že je posledná (alebo turn bol bez reči):
    // ukončovací záznam bez zvuku.
    if (ended && emitted === nextSeq && !closed) out({ seq: nextSeq, url: null, text: '', last: true, durMs: 0 })
  }

  return {
    push(text) {
      if (cancelled || ended) return
      const seq = nextSeq++
      synthesize(text)
        .then((r) => results.set(seq, { ...r, text }))
        .catch((err) => {
          log('tts', `veta ${seq} bez zvuku: ${errMsg(err)}`)
          results.set(seq, null)
        })
        .finally(pump)
    },
    end() {
      if (ended) return
      ended = true
      pump()
    },
    cancel() {
      cancelled = true
    },
    get count() {
      return nextSeq
    },
  }
}

/** Upratovanie cache pri štarte: najstaršie súbory nad limit preč. */
export async function pruneTtsCache() {
  try {
    const names = (await readdir(TTS_DIR)).filter((n) => /\.(mp3|m4a)$/.test(n))
    if (names.length <= CACHE_MAX_FILES) return
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(TTS_DIR, n))).atimeMs })))
    withTime.sort((a, b) => a.t - b.t)
    for (const { n } of withTime.slice(0, names.length - CACHE_MAX_FILES)) await unlink(join(TTS_DIR, n)).catch(() => {})
  } catch {
    // priečinok ešte neexistuje
  }
}

export async function ttsFileExists(name) {
  if (!/^[a-f0-9]{40}\.(mp3|m4a)$/.test(name)) return null
  const file = join(TTS_DIR, name)
  try {
    await access(file)
    return file
  } catch {
    return null
  }
}
