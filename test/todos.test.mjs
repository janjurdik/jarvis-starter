import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { editTodos, parseTodos, refOf, rewriteContent } from '../hud/server/memory/todo-edit.mjs'
import { MEMORY_DIR, changeTodo, completeTodo, findTodo, todos } from '../hud/server/memory/index.mjs'

const FILE = ['# Úlohy', '', '## Škola', '- [ ] Odovzdať esej (do 2026-12-01)', '- [x] Prečítať kapitolu 3', '  - [ ] Pripraviť prezentáciu do 2026-12-04', '', '## Doma', '- [ ] Kúpiť mlieko', '- [ ] Kúpiť mlieko', '* [ ] Zavolať mame (termín: 2026-12-02) večer', ''].join('\n')
const open = (text) => parseTodos(text).filter((t) => !t.done)
const refFor = (text, label, n = 0) => refOf(open(text).filter((t) => t.text === label)[n])

test('parse: text without the term, groups, done items and the n of identical lines', () => {
  const all = parseTodos(FILE)
  assert.deepEqual(
    all.map((t) => [t.text, t.due, t.group, t.done, t.n]),
    [
      ['Odovzdať esej', '2026-12-01', 'Škola', false, 0],
      ['Prečítať kapitolu 3', null, 'Škola', true, 0],
      ['Pripraviť prezentáciu', '2026-12-04', 'Škola', false, 0],
      ['Kúpiť mlieko', null, 'Doma', false, 0],
      ['Kúpiť mlieko', null, 'Doma', false, 1],
      ['Zavolať mame večer', '2026-12-02', 'Doma', false, 0],
    ],
  )
})

test('delete: only that line goes, the rest stays byte for byte, undo puts it back at its place', () => {
  const { text, result } = editTodos(FILE, { action: 'delete', ref: refFor(FILE, 'Odovzdať esej') })
  assert.equal(text, FILE.replace('- [ ] Odovzdať esej (do 2026-12-01)\n', ''))
  assert.equal(result.item.text, 'Odovzdať esej')
  const back = editTodos(text, { action: 'restore', undo: result.undo })
  assert.equal(back.text, FILE)
  assert.equal(back.result.item.text, 'Odovzdať esej')
})

test('delete: the second of two identical tasks, and undo after the file changed above it', () => {
  const { text, result } = editTodos(FILE, { action: 'delete', ref: refFor(FILE, 'Kúpiť mlieko', 1) })
  assert.equal(text.split('Kúpiť mlieko').length - 1, 1)
  // Meanwhile a line above was deleted too: the task still goes back right under the line it stood under.
  const changed = text.replace('- [x] Prečítať kapitolu 3\n', '')
  const back = editTodos(changed, { action: 'restore', undo: result.undo })
  assert.equal(back.text, FILE.replace('- [x] Prečítať kapitolu 3\n', ''))
})

test('delete: the last line without a line ending, and back', () => {
  const file = '- [ ] a\n- [ ] b'
  const { text, result } = editTodos(file, { action: 'delete', ref: { text: 'b', due: null, n: 0 } })
  assert.equal(text, '- [ ] a\n')
  assert.equal(editTodos(text, { action: 'restore', undo: result.undo }).text, file)
  const first = editTodos(file, { action: 'delete', ref: { text: 'a', due: null, n: 0 } })
  assert.equal(first.text, '- [ ] b')
  assert.equal(editTodos(first.text, { action: 'restore', undo: first.result.undo }).text, file)
})

test('CRLF: line endings of every line stay, also of the edited and the restored one', () => {
  const file = FILE.replace(/\n/g, '\r\n')
  const del = editTodos(file, { action: 'delete', ref: refFor(file, 'Kúpiť mlieko') })
  assert.equal(del.text, file.replace('- [ ] Kúpiť mlieko\r\n', ''))
  assert.equal(editTodos(del.text, { action: 'restore', undo: del.result.undo }).text, file)
  const ed = editTodos(file, { action: 'edit', ref: refFor(file, 'Odovzdať esej'), text: 'Odovzdať esej z filozofie' })
  assert.equal(ed.text, file.replace('Odovzdať esej (do 2026-12-01)', 'Odovzdať esej z filozofie (do 2026-12-01)'))
  assert.ok(!/[^\r]\n/.test(ed.text), 'no bare \\n appeared')
})

test('edit: text, term in its own syntax, a new term, clearing it, indentation and bullet kept', () => {
  const ref = refFor(FILE, 'Pripraviť prezentáciu')
  const t1 = editTodos(FILE, { action: 'edit', ref, text: 'Pripraviť slajdy' }).text
  assert.match(t1, /\n {2}- \[ \] Pripraviť slajdy do 2026-12-04\n/)
  const t2 = editTodos(FILE, { action: 'edit', ref, due: '2026-12-10' }).text
  assert.equal(t2, FILE.replace('Pripraviť prezentáciu do 2026-12-04', 'Pripraviť prezentáciu do 2026-12-10'))
  const t3 = editTodos(FILE, { action: 'edit', ref, due: null }).text
  assert.equal(t3, FILE.replace('Pripraviť prezentáciu do 2026-12-04', 'Pripraviť prezentáciu'))
  // A term in the middle of the text: only the date changes, or it goes out and the words close up.
  const mama = refFor(FILE, 'Zavolať mame večer')
  assert.match(editTodos(FILE, { action: 'edit', ref: mama, due: '2026-12-03' }).text, /\n\* \[ \] Zavolať mame \(termín: 2026-12-03\) večer\n/)
  assert.match(editTodos(FILE, { action: 'edit', ref: mama, due: '' }).text, /\n\* \[ \] Zavolať mame večer\n/)
  const milk = refFor(FILE, 'Kúpiť mlieko')
  const t4 = editTodos(FILE, { action: 'edit', ref: milk, text: 'Kúpiť ovsené mlieko', due: '2026-12-05' })
  assert.equal(t4.text, FILE.replace('- [ ] Kúpiť mlieko\n', '- [ ] Kúpiť ovsené mlieko (do 2026-12-05)\n'))
  assert.equal(t4.result.item.due, '2026-12-05')
  // The undo of an edit is the old line again.
  assert.equal(editTodos(t4.text, { action: 'restore', undo: t4.result.undo }).text, FILE)
})

test('edit: nothing changed writes nothing, empty text and a bad date are refused', () => {
  const ref = refFor(FILE, 'Odovzdať esej')
  const same = editTodos(FILE, { action: 'edit', ref, text: '  Odovzdať   esej ', due: '2026-12-01' })
  assert.equal(same.text, FILE)
  assert.equal(same.result.undo, null)
  assert.throws(() => editTodos(FILE, { action: 'edit', ref, text: '   ' }), (e) => e.status === 400)
  assert.throws(() => editTodos(FILE, { action: 'edit', ref, due: '2026-13-40' }), (e) => e.status === 400)
  assert.throws(() => editTodos(FILE, { action: 'edit', ref, due: 'zajtra' }), (e) => e.status === 400)
  assert.throws(() => editTodos(FILE, { action: 'nuke', ref }), (e) => e.status === 400)
  assert.equal(rewriteContent('Text', { text: 'Text\nnový riadok' }), 'Text nový riadok')
})

test('done: only the box is ticked', () => {
  const { text, result } = editTodos(FILE, { action: 'done', ref: refFor(FILE, 'Zavolať mame večer') })
  assert.equal(text, FILE.replace('* [ ] Zavolať mame', '* [x] Zavolať mame'))
  assert.equal(result.item.done, true)
  assert.equal(editTodos(text, { action: 'restore', undo: result.undo }).text, FILE)
})

test('stale ref: a task that is not there any more is refused with 409 and nothing changes', () => {
  assert.throws(() => editTodos(FILE, { action: 'delete', ref: { text: 'Neexistuje', due: null, n: 0 } }), (e) => e.status === 409)
  assert.throws(() => editTodos(FILE, { action: 'delete', ref: { text: 'Kúpiť mlieko', due: null, n: 2 } }), (e) => e.status === 409)
  assert.throws(() => editTodos(FILE, { action: 'delete', ref: { text: 'Odovzdať esej', due: '2026-12-02', n: 0 } }), (e) => e.status === 409)
  // A done task is not open any more.
  assert.throws(() => editTodos(FILE, { action: 'delete', ref: { text: 'Prečítať kapitolu 3', due: null, n: 0 } }), (e) => e.status === 409)
  // Restore only takes a task line, never other text.
  assert.throws(() => editTodos(FILE, { action: 'restore', undo: { kind: 'insert', line: '# Hacked', at: 0 } }), (e) => e.status === 400)
  assert.throws(() => editTodos(FILE, { action: 'restore', undo: { kind: 'insert', line: '- [ ] a\n- [ ] b', at: 0 } }), (e) => e.status === 400)
})

test('changeTodo and the brain helpers: the file on disk, quick changes in a row, findTodo', async () => {
  const file = join(MEMORY_DIR, 'ulohy.md')
  writeFileSync(file, FILE)
  const list = (await todos()).filter((t) => !t.done)
  // Two deletes sent at once: each reads the file the other one wrote.
  const [a, b] = await Promise.all([changeTodo({ action: 'delete', ref: refOf(list[0]) }), changeTodo({ action: 'delete', ref: refOf(list[3]) })])
  assert.equal(readFileSync(file, 'utf8'), FILE.replace('- [ ] Odovzdať esej (do 2026-12-01)\n', '').replace('- [ ] Kúpiť mlieko\n- [ ] Kúpiť mlieko\n', '- [ ] Kúpiť mlieko\n'))
  // After a delete the board loads fresh refs: the old ref of the other identical task is stale now.
  await assert.rejects(changeTodo({ action: 'delete', ref: refOf(list[3]) }), (e) => e.status === 409)
  await changeTodo({ action: 'restore', undo: b.undo })
  await changeTodo({ action: 'restore', undo: a.undo })
  assert.equal(readFileSync(file, 'utf8'), FILE)
  await assert.rejects(changeTodo({ action: 'delete', ref: { text: 'nie je', due: null, n: 0 } }), (e) => e.status === 409)
  assert.equal(readFileSync(file, 'utf8'), FILE)

  assert.equal((await findTodo('esej')).ref.text, 'Odovzdať esej')
  // Two identical tasks are one meaning: the first one.
  assert.deepEqual((await findTodo('kúpiť mlieko')).ref, { text: 'Kúpiť mlieko', due: null, n: 0 })
  assert.equal((await findTodo('mame')).item.text, 'Zavolať mame večer')
  assert.equal((await findTodo('p')).candidates?.length > 1, true)
  assert.deepEqual(await findTodo('nič také'), {})
  assert.equal(await completeTodo('esej'), 'Odovzdať esej')
  assert.match(readFileSync(file, 'utf8'), /- \[x\] Odovzdať esej \(do 2026-12-01\)/)
})

// ── the endpoint on a real server: this computer yes, a foreign page or the network without a login no ──

function freePort() {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => done(port))
    })
  })
}

function raw(port, path, headers, body) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => done({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', fail)
    req.end(JSON.stringify(body))
  })
}

test('POST /api/todos: local page and scripts yes, foreign origin and outside without a login no', { skip: process.platform === 'win32' }, async (t) => {
  const dir = join(TMP, 'todos-server')
  mkdirSync(join(dir, 'data'), { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'jarvis.json'), JSON.stringify({ name: 'Test' }))
  writeFileSync(join(dir, 'memory', 'ulohy.md'), FILE)
  const port = await freePort()
  const HUD_TOKEN = 'c'.repeat(48)
  const child = spawn(process.execPath, ['hud/server.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), JARVIS_SECONDARY: '1', JARVIS_MOCK: '1', JARVIS_BRAIN_AUTOSTART: '0', JARVIS_NO_WATCH: '1', JARVIS_STT: 'browser', JARVIS_DATA_DIR: join(dir, 'data'), JARVIS_MEMORY_DIR: join(dir, 'memory'), JARVIS_CONFIG: join(dir, 'jarvis.json'), JARVIS_HUD_TOKEN: HUD_TOKEN, JARVIS_ALLOWED_HOSTS: 'jarvis.lan' },
    stdio: 'ignore',
  })
  t.after(() => child.kill())
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const file = join(dir, 'memory', 'ulohy.md')
  const ref = { text: 'Kúpiť mlieko', due: null, n: 1 }

  assert.equal((await raw(port, '/api/todos', { origin: 'https://evil.example' }, { action: 'delete', ref })).status, 403, 'a foreign page')
  assert.equal((await raw(port, '/api/todos', { 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-proto': 'https' }, { action: 'delete', ref })).status, 401, 'outside without a login')
  assert.equal((await raw(port, '/api/todos', { host: 'jarvis.lan' }, { action: 'delete', ref })).status, 401, 'the network without the token')
  assert.equal(readFileSync(file, 'utf8'), FILE)

  // The board on this computer (the page sends its own Origin).
  const del = await raw(port, '/api/todos', { origin: base }, { action: 'delete', ref })
  assert.equal(del.status, 200)
  assert.equal(readFileSync(file, 'utf8').split('Kúpiť mlieko').length - 1, 1)
  assert.equal((await raw(port, '/api/todos', { origin: base }, { action: 'delete', ref })).status, 409, 'the same click twice')
  assert.equal((await raw(port, '/api/todos', {}, { action: 'restore', undo: del.body.undo })).status, 200, 'a script on this computer')
  assert.equal(readFileSync(file, 'utf8'), FILE)
  // A network the user opened on purpose, with the token.
  const ed = await raw(port, '/api/todos', { host: 'jarvis.lan', 'x-hud-token': HUD_TOKEN }, { action: 'edit', ref: { text: 'Odovzdať esej', due: '2026-12-01', n: 0 }, due: null })
  assert.equal(ed.status, 200)
  assert.match(readFileSync(file, 'utf8'), /\n- \[ \] Odovzdať esej\n/)
  const bad = await raw(port, '/api/todos', { origin: base }, { action: 'edit', ref: { text: 'Odovzdať esej', due: null, n: 0 }, text: '' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'Úloha nemôže byť prázdna.')
})
