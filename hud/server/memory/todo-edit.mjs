/**
 * One line of ulohy.md at a time: delete, rewrite, tick, and put a deleted line back where it was.
 *
 * Pure string functions, no files: changeTodo() in memory/index.mjs reads and writes the file,
 * and both the HUD (POST /api/todos) and the brain's todo tools (mcp/memory.mjs) go through it.
 * Every other byte of the file stays as it was: line endings, other lines, headings, indentation.
 *
 * A task is found by its ref { text, due, n }: the text as the HUD shows it (without the term),
 * the term and which of the open tasks with that same text and term it is (0 = the first one).
 * When the file changed meanwhile and the task is not there any more, the change is refused
 * with status 409 and nothing is written.
 */

/** A term in the text of a task: "(do 2026-12-01)", "do 2026-12-01", "termín: …", "due …", "📅 …". */
export const DUE = /(?:\(?\s*(?:do|termín|due|📅)\s*:?\s*(\d{4}-\d{2}-\d{2})\s*\)?)/i
const TASK = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.+)$/
const HEAD = /^#{1,6}\s+(.*)$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_TEXT = 500

const fail = (status, message) => Object.assign(new Error(message), { status })
export const STALE = 'Táto úloha sa medzitým zmenila. Zoznam som načítal znova.'

/** The text of a task as the HUD shows it: the term is taken out, spaces are folded. */
export const todoText = (content) => String(content).replace(DUE, '').replace(/\s+/g, ' ').trim()
const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** The file as lines that keep their own line ending ('\n', '\r\n' or '' on the last line). */
export function splitLines(text) {
  return (String(text).match(/[^\n]*\n|[^\n]+$/g) ?? []).map((part) => {
    const eol = part.endsWith('\r\n') ? '\r\n' : part.endsWith('\n') ? '\n' : ''
    return { body: part.slice(0, part.length - eol.length), eol }
  })
}
const joinLines = (lines) => lines.map((l) => l.body + l.eol).join('')

/**
 * Every task of the file in its order: { at (line), done, text, due, group, n }.
 * n counts the tasks before it with the same state, text and term, so two identical lines stay two.
 */
export function parseTodos(text) {
  const lines = splitLines(text)
  const out = []
  const seen = new Map()
  let group = null
  lines.forEach((line, at) => {
    const h = HEAD.exec(line.body)
    if (h) {
      group = h[1].trim()
      return
    }
    const m = TASK.exec(line.body)
    if (!m) return
    const done = m[2] !== ' '
    const content = m[4]
    const due = DUE.exec(content)?.[1] ?? null
    const t = todoText(content)
    const key = `${done ? 'x' : ' '}|${t}|${due ?? ''}`
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    out.push({ at, done, text: t, due, group, n })
  })
  return out
}

/** The ref the HUD sends back to point at one open task. */
export const refOf = (t) => ({ text: t.text, due: t.due ?? null, n: t.n ?? 0 })

function locate(lines, ref) {
  if (!ref || typeof ref !== 'object') throw fail(400, 'Chýba, ktorá úloha to je.')
  const text = cleanText(ref.text)
  const due = ref.due ? String(ref.due) : null
  const n = Number.isInteger(ref.n) && ref.n >= 0 ? ref.n : 0
  const hit = parseTodos(joinLines(lines)).filter((t) => !t.done && t.text === text && t.due === due)[n]
  if (!hit) throw fail(409, STALE)
  return hit
}

function checkDay(due) {
  if (due === undefined) return undefined
  if (due === null || due === '' || due === false) return null
  const d = String(due).trim().slice(0, 10)
  if (!DAY.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`)) || new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) !== d) throw fail(400, 'Termín musí byť dátum v tvare RRRR-MM-DD.')
  return d
}

/**
 * The new content of a task (what follows "- [ ] "). text and due: undefined keeps them, due null
 * clears the term. A term the line already has keeps its own syntax and only its date changes; a
 * new one is written as "(do YYYY-MM-DD)". When only the term changes, the rest stays byte for byte.
 */
export function rewriteContent(content, { text, due } = {}) {
  const m = DUE.exec(content)
  const oldText = todoText(content)
  const oldDue = m?.[1] ?? null
  const nextText = text === undefined ? oldText : cleanText(text)
  const nextDue = checkDay(due) === undefined ? oldDue : checkDay(due)
  if (!nextText) throw fail(400, 'Úloha nemôže byť prázdna.')
  if (nextText.length > MAX_TEXT) throw fail(400, `Úloha môže mať najviac ${MAX_TEXT} znakov.`)
  if (nextText === oldText) {
    if (nextDue === oldDue) return content
    if (m && nextDue) return content.slice(0, m.index) + m[0].replace(oldDue, nextDue) + content.slice(m.index + m[0].length)
    if (m) {
      const left = content.slice(0, m.index).replace(/[ \t]+$/, '')
      const right = content.slice(m.index + m[0].length).replace(/^[ \t]+/, '')
      return left && right ? `${left} ${right}` : left || right || nextText
    }
    return `${content.replace(/\s+$/, '')} (do ${nextDue})`
  }
  if (!nextDue) return nextText
  return `${nextText} ${m ? m[0].trim().replace(oldDue, nextDue) : `(do ${nextDue})`}`
}

/** The line ending the file uses (for a line put back at its end). */
const eolOf = (lines) => lines.find((l) => l.eol)?.eol ?? '\n'

/** Of the lines whose text is `body`, the one closest to line `at`. */
function nearest(lines, body, at) {
  let best = -1
  lines.forEach((l, i) => {
    if (l.body === body && (best < 0 || Math.abs(i - at) < Math.abs(best - at))) best = i
  })
  return best
}

function restore(lines, undo) {
  if (!undo || typeof undo !== 'object') throw fail(400, 'Chýba, čo vrátiť.')
  const line = String(undo.line ?? '')
  if (/[\r\n]/.test(line) || !TASK.test(line)) throw fail(400, 'Vrátiť sa dá len riadok úlohy.')
  const at = Number.isInteger(undo.at) && undo.at >= 0 ? undo.at : lines.length
  if (undo.kind === 'replace') {
    const i = nearest(lines, String(undo.now ?? ''), at)
    if (i < 0) throw fail(409, STALE)
    lines[i] = { ...lines[i], body: line }
    return i
  }
  // A deleted line goes back under the line it stood under; when that one moved, next to where it is now.
  let pos = Math.min(at, lines.length)
  const prev = typeof undo.prev === 'string' ? undo.prev : null
  if (pos > 0 && prev !== null && lines[pos - 1]?.body !== prev) {
    const j = nearest(lines, prev, at - 1)
    if (j >= 0) pos = j + 1
  }
  // At the very end the line keeps the ending it had there (none, when the file ended without one).
  const atEnd = pos === lines.length
  if (atEnd && pos > 0 && !lines[pos - 1].eol) lines[pos - 1] = { ...lines[pos - 1], eol: eolOf(lines) }
  const eol = atEnd && undo.eol === '' ? '' : undo.eol === '\r\n' || undo.eol === '\n' ? undo.eol : eolOf(lines)
  lines.splice(pos, 0, { body: line, eol })
  return pos
}

/**
 * One change to the text of ulohy.md. op: { action: 'delete' | 'edit' | 'done' | 'restore', ref, text, due, undo }.
 * Returns { text: the new file, result: { action, item, undo } }; `undo` is what action 'restore' needs to take it back.
 */
export function editTodos(fileText, op = {}) {
  const lines = splitLines(fileText)
  const action = String(op.action ?? '')
  if (action === 'restore') {
    const at = restore(lines, op.undo)
    const text = joinLines(lines)
    const item = parseTodos(text).find((t) => t.at === at) ?? null
    return { text, result: { action, item: item && { ...refOf(item), group: item.group } } }
  }
  if (!['delete', 'edit', 'done'].includes(action)) throw fail(400, 'Neznáma akcia: delete, edit, done alebo restore.')
  const hit = locate(lines, op.ref)
  const old = lines[hit.at]
  let undo
  if (action === 'delete') {
    lines.splice(hit.at, 1)
    undo = { kind: 'insert', line: old.body, eol: old.eol, at: hit.at, prev: hit.at > 0 ? lines[hit.at - 1].body : null }
    return { text: joinLines(lines), result: { action, item: { ...refOf(hit), group: hit.group }, undo } }
  }
  const m = TASK.exec(old.body)
  const body = action === 'done' ? `${m[1]}x${m[3]}${m[4]}` : `${m[1]}${m[2]}${m[3]}${rewriteContent(m[4], { text: op.text, due: op.due })}`
  lines[hit.at] = { ...old, body }
  const text = joinLines(lines)
  const now = parseTodos(text).find((t) => t.at === hit.at)
  undo = body === old.body ? null : { kind: 'replace', line: old.body, now: body, at: hit.at }
  return { text, result: { action, item: { ...refOf(now), done: now.done, group: now.group }, undo } }
}
