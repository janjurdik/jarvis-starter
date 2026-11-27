// The frame "Jarvis is working the computer" is drawn once: by the page in a browser, by the Mac app
// over the whole screen when the page runs inside it.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

let frame = null
let handler = null

beforeEach(async () => {
  const pill = { textContent: '' }
  frame = { hidden: false, className: '', innerHTML: '', querySelector: () => pill, pill }
  globalThis.document = { createElement: () => frame, body: { append: () => {} } }
  globalThis.window = {}
  const { initControl } = await import('../hud/public/js/control.js')
  initControl({ on: (name, fn) => name === 'control' && (handler = fn) })
})

afterEach(() => {
  handler({ on: false })
  delete globalThis.document
  delete globalThis.window
})

test('a browser draws the frame and the label itself', () => {
  assert.equal(frame.hidden, true)
  handler({ on: true, label: 'Pracujem v prehliadači' })
  assert.equal(frame.hidden, false)
  assert.equal(frame.pill.textContent, 'Jarvis · Pracujem v prehliadači')
  handler({ on: false })
  assert.equal(frame.hidden, true)
})

test('inside the Mac app the page hands the frame to the app and draws nothing', () => {
  const posted = []
  globalThis.window.__jarvisDesktop = { native: true, post: (msg) => posted.push(msg) }
  handler({ on: true, label: 'Pracujem v prehliadači', x: 300, y: 200, click: true })
  assert.equal(frame.hidden, true)
  assert.deepEqual(posted, [{ type: 'control', on: true, label: 'Pracujem v prehliadači', x: 300, y: 200, click: true }])
  handler({ on: false })
  assert.equal(posted[1].on, false)
  assert.equal(frame.hidden, true)
})
