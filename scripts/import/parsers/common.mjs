/**
 * Helpers shared by the chat parsers.
 */
import { join } from 'node:path'
import { REPO } from '../../../hud/server/util.mjs'
import { fold, nameTokens, normName, readJson } from '../util.mjs'

let configName
/** First name from config/jarvis.json (filled in during onboarding), lower case without diacritics. */
export async function configFirstName() {
  if (configName === undefined) {
    const cfg = await readJson(join(REPO, 'config', 'jarvis.json'), null)
    configName = fold(String(cfg?.name ?? '').trim().split(/\s+/)[0] ?? '') || null
  }
  return configName
}

/**
 * Which of the participants is the user. Exports of a single conversation (WhatsApp, one
 * Telegram chat, DiscordChatExporter) do not say it, so this goes from the surest signal down:
 * the name given on the command line, names known from earlier imports, the title of a private
 * chat (it is named after the other person) and finally the first name from the config.
 */
export async function guessSelf(names, { override = null, known = [], title = null } = {}) {
  const list = [...new Set(names.filter(Boolean))]
  if (!list.length) return null
  const same = (a, b) => normName(a) === normName(b) && normName(a) !== ''
  if (override) {
    const hit = list.find((n) => same(n, override)) ?? list.find((n) => nameTokens(override).every((t) => nameTokens(n).includes(t)) && nameTokens(override).length)
    return hit ?? null
  }
  for (const k of known) {
    const hit = list.find((n) => same(n, k))
    if (hit) return hit
  }
  if (title && list.length === 2) {
    const other = list.find((n) => same(n, title)) ?? list.find((n) => normName(title).includes(normName(n)) && normName(n).length > 2)
    if (other) return list.find((n) => n !== other)
  }
  const first = await configFirstName()
  if (first) {
    const hits = list.filter((n) => nameTokens(n)[0] === first)
    if (hits.length === 1) return hits[0]
  }
  return null
}

export const ME_HINT = 'Neviem určiť, ktoré správy sú tvoje. Spusti import znova s voľbou --me "Tvoje meno" (presne tak, ako je meno napísané v konverzácii).'
