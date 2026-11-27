/**
 * Jarvis speaks through the computer's own speakers, without the HUD window: the alarm in the
 * morning, and reminders or routine results when no HUD window is open to say them.
 *
 * The voice is the same as in the HUD (Edge neural voice through uv, the Mac's `say` as fallback),
 * the file is played by the system: afplay on macOS, PowerShell on Windows. When no voice file can
 * be made (no uv on Windows), the system speech synthesizer reads the text instead.
 */
import './env.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { speakable, stopTts, synthesize } from './tts.mjs'
import { DATA_DIR, findBin, IS_MAC, IS_WIN, WIN_POWERSHELL } from './util.mjs'

const SAY_VOICE = process.env.JARVIS_SAY_VOICE || (process.env.JARVIS_LANG === 'cs' ? 'Zuzana' : 'Laura')
/** Turned off with JARVIS_LOCAL_VOICE=0: then only the HUD speaks, nothing comes out of the speakers on its own. */
export const localVoiceOn = () => process.env.JARVIS_LOCAL_VOICE !== '0'

/** Runs a program to its end. `stop` (an AbortSignal) ends it early: that is how a ringing alarm is silenced. */
const run = (bin, args, { stop = null, ...opts } = {}) =>
  new Promise((resolve) => {
    let out = ''
    let child
    if (stop?.aborted) return resolve({ code: 1, out: '', stopped: true })
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts })
    } catch (err) {
      return resolve({ code: 1, out: String(err?.message ?? err) })
    }
    const kill = () => child.kill()
    stop?.addEventListener('abort', kill, { once: true })
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', (err) => resolve({ code: 1, out: err.message }))
    child.on('exit', (code) => {
      stop?.removeEventListener('abort', kill)
      resolve({ code: code ?? 1, out: out.trim(), stopped: stop?.aborted === true })
    })
  })

const powershell = (script, env = {}, { stop = null } = {}) => run(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, ...env }, stop })

/** Splits a longer text into pieces the voice service handles quickly (sentences, at most ~220 chars). */
export function chunks(text, max = 220) {
  const sentences = speakable(String(text ?? '')).match(/[^.!?…]+[.!?…]+["“”')»]*|[^.!?…]+$/g) ?? []
  const out = []
  let cur = ''
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (cur && (cur + ' ' + s).length > max) {
      out.push(cur)
      cur = s
    } else cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}

// ── playback ────────────────────────────────────────────────────────────

/** Plays audio files one after another. `items` = [{ file, durMs }]. `stop` ends the playback early. */
async function playFiles(items, { stop = null } = {}) {
  if (!items.length) return true
  if (IS_MAC) {
    for (const { file } of items) {
      const res = await run('/usr/bin/afplay', [file], { stop })
      if (res.stopped) return true
      if (res.code !== 0) return false
    }
    return true
  }
  if (IS_WIN) {
    // One PowerShell for the whole list: starting it costs about a second.
    const script = [
      'Add-Type -AssemblyName PresentationCore',
      "$files = $env:J_FILES -split '\\|'",
      "$durs = $env:J_DURS -split '\\|'",
      'for ($k = 0; $k -lt $files.Count; $k++) {',
      '  $f = $files[$k]',
      "  if ($f -like '*.wav') { (New-Object System.Media.SoundPlayer $f).PlaySync(); continue }",
      '  $p = New-Object System.Windows.Media.MediaPlayer',
      '  $p.Open([Uri]$f)',
      '  $i = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $i -lt 60) { Start-Sleep -Milliseconds 50; $i++ }',
      '  $p.Volume = 1',
      '  $p.Play()',
      '  $ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds } else { [int]$durs[$k] }',
      '  Start-Sleep -Milliseconds ($ms + 250)',
      '  $p.Close()',
      '}',
    ].join('\n')
    const res = await powershell(script, { J_FILES: items.map((i) => i.file).join('|'), J_DURS: items.map((i) => String(i.durMs || 6000)).join('|') }, { stop })
    return res.stopped || res.code === 0
  }
  const player = findBin('paplay') ?? findBin('aplay') ?? findBin('ffplay')
  if (!player) return false
  for (const { file } of items) {
    if ((await run(player, player.endsWith('ffplay') ? ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] : [file], { stop })).stopped) break
  }
  return true
}

/** The system's own speech synthesizer, when no voice file could be made. */
async function systemVoice(text) {
  if (IS_MAC) {
    const res = await run('/usr/bin/say', ['-v', SAY_VOICE, '--', text])
    if (res.code === 0) return true
    return (await run('/usr/bin/say', ['--', text])).code === 0
  }
  if (IS_WIN) {
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -match '^(sk|cs)' } | Select-Object -First 1",
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
      '$s.Speak($env:J_TEXT)',
    ].join('\n')
    return (await powershell(script, { J_TEXT: text })).code === 0
  }
  const espeak = findBin('espeak-ng') ?? findBin('espeak')
  return espeak ? (await run(espeak, ['-v', 'sk', text])).code === 0 : false
}

// ── the alarm sound ─────────────────────────────────────────────────────

/**
 * A soft three-note chime, three times and a little louder each time. Generated as a WAV file,
 * so it sounds the same on every computer and needs no download.
 */
export function chimeFile() {
  const file = join(DATA_DIR, 'alarm', 'chime-v1.wav')
  if (existsSync(file)) return file
  const rate = 22050
  const notes = [659.25, 987.77, 1318.51]
  const ping = 1.5
  const gap = 0.45
  const gains = [0.35, 0.6, 0.9]
  const total = Math.ceil(rate * (gains.length * ping + (gains.length - 1) * gap))
  const pcm = new Float32Array(total)
  gains.forEach((gain, r) => {
    const start = r * (ping + gap)
    notes.forEach((f, n) => {
      const t0 = start + n * 0.16
      for (let i = Math.floor(t0 * rate); i < Math.min(total, Math.floor((start + ping) * rate)); i++) {
        const t = i / rate - t0
        const env = Math.min(1, t / 0.008) * Math.exp(-t / 0.38)
        pcm[i] += gain * env * (Math.sin(2 * Math.PI * f * t) + 0.28 * Math.sin(4 * Math.PI * f * t) + 0.08 * Math.sin(6 * Math.PI * f * t))
      }
    })
  })
  let peak = 0
  for (const v of pcm) peak = Math.max(peak, Math.abs(v))
  const scale = peak > 0 ? 0.85 / peak : 1
  const data = Buffer.alloc(total * 2)
  for (let i = 0; i < total; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i] * scale)) * 32767), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  mkdirSync(join(DATA_DIR, 'alarm'), { recursive: true })
  writeFileSync(file, Buffer.concat([head, data]))
  return file
}

/**
 * The user's own alarm sound (or the default song) instead of the chime: `sound` is
 * { play, seconds, prepared } from alarm-sound.mjs. A prepared clip already fades in and out and
 * has the right length. A raw file is stopped after `seconds`, on Windows with a fade.
 * Returns false when the player could not play it: the caller then rings the chime.
 * `stop` (an AbortSignal) silences it at once; a sound that was stopped counts as played.
 */
export async function playSound(sound, { stop = null } = {}) {
  if (!sound?.play || !existsSync(sound.play)) return false
  const seconds = Math.max(3, Math.min(300, Number(sound.seconds) || 45))
  const ok = (res) => res.stopped === true || res.code === 0
  if (IS_MAC) return ok(await run('/usr/bin/afplay', ['-t', String(seconds), sound.play], { stop }))
  if (IS_WIN) {
    const script = [
      'Add-Type -AssemblyName PresentationCore',
      '$p = New-Object System.Windows.Media.MediaPlayer',
      '$p.Open([Uri]$env:J_FILE)',
      '$i = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $i -lt 100) { Start-Sleep -Milliseconds 50; $i++ }',
      'if (-not $p.NaturalDuration.HasTimeSpan) { $p.Close(); exit 3 }',
      '$total = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds',
      '$max = [int]$env:J_MAX_MS',
      'if ($max -gt 0 -and $total -gt $max) { $total = $max }',
      '$fade = [int]$env:J_FADE_MS',
      '$out = [int]$env:J_OUT_MS',
      'if ($fade -gt 0) { $p.Volume = 0 } else { $p.Volume = 1 }',
      '$p.Play()',
      '$sw = [Diagnostics.Stopwatch]::StartNew()',
      'while ($sw.ElapsedMilliseconds -lt $total) {',
      '  $t = $sw.ElapsedMilliseconds',
      '  $v = 1.0',
      '  if ($fade -gt 0 -and $t -lt $fade) { $v = $t / $fade }',
      '  if ($out -gt 0 -and ($total - $t) -lt $out) { $v = [Math]::Min($v, ($total - $t) / $out) }',
      '  $p.Volume = $v',
      '  Start-Sleep -Milliseconds 60',
      '}',
      '$p.Stop()',
      '$p.Close()',
    ].join('\n')
    const raw = sound.prepared !== true
    const res = await powershell(script, { J_FILE: sound.play, J_MAX_MS: String(seconds * 1000), J_FADE_MS: raw ? String(Math.min(6000, Math.round((seconds * 1000) / 3))) : '0', J_OUT_MS: raw ? '2500' : '0' }, { stop })
    return ok(res)
  }
  const player = findBin('ffplay') ?? findBin('paplay') ?? findBin('aplay')
  if (!player) return false
  const args = player.endsWith('ffplay') ? ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-t', String(seconds), sound.play] : [sound.play]
  return ok(await run(player, args, { timeout: (seconds + 5) * 1000, stop }))
}

// ── volume (macOS) ──────────────────────────────────────────────────────

/**
 * An alarm nobody hears is no alarm: on macOS a muted or very quiet output is turned up for the
 * alarm (JARVIS_ALARM_VOLUME, default 50 %, 0 = never touch it) and put back afterwards.
 */
async function raiseVolume() {
  const want = Number(process.env.JARVIS_ALARM_VOLUME ?? 50)
  if (!IS_MAC || !(want > 0)) return null
  const res = await run('/usr/bin/osascript', ['-e', 'set s to get volume settings', '-e', 'return ((output volume of s) as text) & "," & ((output muted of s) as text)'])
  const m = /^(\d+|missing value),(true|false)/.exec(res.out)
  if (!m || m[1] === 'missing value') return null
  const before = { volume: Number(m[1]), muted: m[2] === 'true' }
  if (!before.muted && before.volume >= want) return null
  await run('/usr/bin/osascript', ['-e', `set volume output volume ${Math.min(100, Math.round(want))} without output muted`])
  return before
}

async function restoreVolume(before) {
  if (!before) return
  await run('/usr/bin/osascript', ['-e', `set volume output volume ${before.volume}${before.muted ? ' with output muted' : ''}`])
}

// ── public ──────────────────────────────────────────────────────────────

/**
 * Says `text` through the speakers. Options:
 *   chime   the alarm sound first (and the volume raised on macOS for the duration)
 *   sound   with chime: the user's own sound or the default song instead of the built-in chime
 *           ({ kind, play, seconds, prepared } from alarm-sound.mjs). When it cannot be played, the chime rings.
 *   force   speak even when the voice is turned off (JARVIS_TTS=off): the alarm must be heard
 *   stop    with chime: an AbortSignal that silences the alarm sound at once (the user stopped the
 *           alarm on the screen). The brief is still said, right away.
 *   onChimeEnd  with chime: called once when the alarm sound is over (played out or stopped), before the voice
 * Returns { ok, via, rang } where via is edge, say, elevenlabs, system or none and rang says which
 * alarm sound played (custom, default, song, builtin, or null without chime).
 */
export async function speakLocal(text, { chime = false, force = false, sound = null, stop = null, onChimeEnd = null } = {}) {
  const parts = chunks(text)
  const wanted = chime ? (sound?.play && existsSync(sound.play) ? sound.kind ?? 'custom' : 'builtin') : null
  // JARVIS_AUDIO=off: everything is prepared (voice files, chime) but nothing is played. For tests.
  if (process.env.JARVIS_AUDIO === 'off') {
    chimeFile()
    // Tests: the "sound" lasts JARVIS_AUDIO_FAKE_MS, so stopping the alarm from the screen can be tried without a speaker.
    const fake = chime ? Math.min(60_000, Math.max(0, Number(process.env.JARVIS_AUDIO_FAKE_MS) || 0)) : 0
    if (fake) await new Promise((done) => {
      const t = setTimeout(done, fake)
      stop?.addEventListener('abort', () => (clearTimeout(t), done()), { once: true })
    })
    if (chime) onChimeEnd?.()
    const made = await Promise.all(parts.map((p) => synthesize(p).catch(() => null))).finally(() => stopTts())
    return { ok: true, via: `muted:${made.find(Boolean)?.provider ?? 'none'}`, rang: wanted }
  }
  let rang = wanted
  const volume = chime ? await raiseVolume() : null
  // The voice is made while the chime plays. A voice service that hangs (first start, bad network)
  // must not leave the user with silence: after 30 s the system voice takes over.
  const making = Promise.race([Promise.all(parts.map((p) => synthesize(p))), new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), 30_000).unref())])
  making.catch(() => {})
  try {
    if (chime) {
      // A sound file that is missing, broken or refused by the player must never leave the alarm silent.
      const own = wanted !== 'builtin' && (await playSound(sound, { stop }))
      if (!own) {
        rang = 'builtin'
        await playFiles([{ file: chimeFile(), durMs: 6000 }], { stop })
      }
      try {
        onChimeEnd?.()
      } catch {
        // the caller's own bookkeeping must never cost the user the brief
      }
    }
    if (!parts.length) return { ok: chime, via: 'none', rang }
    let made = []
    try {
      made = await making
    } catch {
      made = []
    }
    if (made.length && made.every((m) => m.file)) {
      if (await playFiles(made.map((m) => ({ file: m.file, durMs: m.durMs })))) return { ok: true, via: made[0].provider, rang }
    }
    if (process.env.JARVIS_TTS === 'off' && !force) return { ok: false, via: 'none', rang }
    return { ok: await systemVoice(parts.join(' ')), via: 'system', rang }
  } finally {
    stopTts()
    await restoreVolume(volume)
  }
}
