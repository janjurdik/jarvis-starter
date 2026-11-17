/**
 * Conversation log: every finished turn is appended to data/chat/YYYY-MM-DD.jsonl.
 * The evening routine reads it to write the day into memory, and the HUD counts it
 * as "messages with Jarvis". Stays on this computer, never committed.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR, isoDay } from './util.mjs'

export const CHAT_DIR = join(DATA_DIR, 'chat')

let cache = { at: 0, value: null }

export async function logTurn({ user, jarvis, via, tools = [], at = new Date() }) {
  if (!user && !jarvis) return
  await mkdir(CHAT_DIR, { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ at: at.toISOString(), via, user, jarvis, tools })
  await appendFile(join(CHAT_DIR, `${isoDay(at)}.jsonl`), line + '\n', { mode: 0o600 })
  cache.at = 0
}

export async function readDay(day) {
  // The day comes from a URL (inner worlds): only a real date may become a file name.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return []
  try {
    const text = await readFile(join(CHAT_DIR, `${day}.jsonl`), 'utf8')
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

export async function chatDays() {
  try {
    return (await readdir(CHAT_DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort()
  } catch {
    return []
  }
}

/** { messages, days, perDay: [{ day, turns }] }, cached for a minute. */
export async function chatStats() {
  if (cache.value && Date.now() - cache.at < 60_000) return cache.value
  const days = await chatDays()
  const perDay = []
  let messages = 0
  for (const day of days) {
    const turns = (await readDay(day)).length
    perDay.push({ day, turns })
    messages += turns * 2
  }
  cache = { at: Date.now(), value: { messages, days: days.length, perDay } }
  return cache.value
}
