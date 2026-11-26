#!/usr/bin/env node
/**
 * Hands and eyes for the agent: sees the screen and works the mouse and the keyboard of this
 * computer, in any application. Used from a background job (AGENTS.md, Ovládanie počítača):
 *
 *   node scripts/control.mjs status                  what is allowed and how big the screen is
 *   node scripts/control.mjs shot                    a picture of the screen → prints its file (read it), size and scale
 *   node scripts/control.mjs click X Y [--right] [--double]
 *   node scripts/control.mjs move X Y
 *   node scripts/control.mjs type "text"             types into whatever has the keyboard
 *   node scripts/control.mjs key cmd+t               one key or a combination (return, esc, tab, space, delete, arrows…)
 *   node scripts/control.mjs scroll down|up [steps] [--at X Y]
 *   node scripts/control.mjs say "what I am doing"   only the label on the screen
 *   node scripts/control.mjs done                    takes the frame off the screen
 *
 * X and Y are pixels of the last picture from `shot`. While it works, the desktop shows a frame
 * around the screen and a reticle where the pointer acts (hud/public/js/control.js and the desktop app).
 *
 * macOS for now. It needs two permissions the user gives once, to the program Jarvis runs in:
 * Accessibility (mouse and keyboard) and Screen Recording (pictures of other applications).
 */
import './lib.mjs'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, IS_MAC, parseArgs, postHud } from './lib.mjs'

const DIR = join(DATA_DIR, 'control')
const STATE = join(DIR, 'state.json')
const SHOT = join(DIR, 'shot.jpg')
/** Longest side of the picture the agent reads. Enough to read text, small enough to look at often. */
const SHOT_MAX = 1440

const { flags, rest } = parseArgs()
const [command, ...args] = rest
const print = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const fail = (error, extra = {}) => {
  print({ ok: false, error, ...extra })
  process.exit(1)
}

/**
 * The part that touches the system: JavaScript for Automation, which can call the same system
 * functions an application would. The script is fixed, everything variable goes in as arguments.
 */
const JXA = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit'); ObjC.import('ApplicationServices');
const KEYS = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  pagedown: 121, pageup: 116, home: 115, end: 119, forwarddelete: 117, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f11: 103, f12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23,
  '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47 };
const MODS = { cmd: $.kCGEventFlagMaskCommand, command: $.kCGEventFlagMaskCommand, shift: $.kCGEventFlagMaskShift, alt: $.kCGEventFlagMaskAlternate, option: $.kCGEventFlagMaskAlternate, ctrl: $.kCGEventFlagMaskControl, control: $.kCGEventFlagMaskControl };
function mouse(type, x, y, button, clicks) {
  const e = $.CGEventCreateMouseEvent(null, type, { x: x, y: y }, button);
  if (clicks) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, clicks);
  $.CGEventPost($.kCGHIDEventTap, e);
}
function key(code, flags) {
  for (const down of [true, false]) {
    const e = $.CGEventCreateKeyboardEvent(null, code, down);
    $.CGEventSetFlags(e, flags || 0);
    $.CGEventPost($.kCGHIDEventTap, e);
    delay(0.02);
  }
}
function run(argv) {
  const cmd = argv[0];
  const frame = $.NSScreen.mainScreen.frame;
  const out = { ok: true, screen: [frame.size.width, frame.size.height], control: $.AXIsProcessTrusted() };
  if (cmd === 'status') return JSON.stringify(out);
  if (cmd === 'ask') {
    // macOS shows its own windows where the user allows it. Nothing is changed here.
    if (!out.control) $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
    return JSON.stringify(out);
  }
  if (!out.control && argv[argv.length - 1] !== 'dry') { out.ok = false; out.error = 'accessibility'; return JSON.stringify(out); }
  const x = Number(argv[1]), y = Number(argv[2]);
  if (cmd === 'move') mouse($.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft, 0);
  else if (cmd === 'click') {
    const right = argv[3] === 'right', n = argv[4] === 'double' ? 2 : 1;
    mouse($.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft, 0);
    delay(0.06);
    for (let i = 1; i <= n; i++) {
      mouse(right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown, x, y, right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft, i);
      mouse(right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp, x, y, right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft, i);
      delay(0.05);
    }
  } else if (cmd === 'scroll') {
    if (argv[3] !== '') mouse($.kCGEventMouseMoved, Number(argv[3]), Number(argv[4]), $.kCGMouseButtonLeft, 0);
    const steps = Number(argv[2]);
    for (let i = 0; i < Math.abs(steps); i++) {
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateScrollWheelEvent2(null, $.kCGScrollEventUnitLine, 1, steps > 0 ? -3 : 3, 0, 0));
      delay(0.03);
    }
  } else if (cmd === 'key') {
    const parts = String(argv[1]).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
    const name = parts.pop();
    if (!(name in KEYS)) { out.ok = false; out.error = 'unknown key ' + name; return JSON.stringify(out); }
    let flags = 0;
    for (const m of parts) { if (!(m in MODS)) { out.ok = false; out.error = 'unknown modifier ' + m; return JSON.stringify(out); } flags |= MODS[m]; }
    key(KEYS[name], flags);
  } else if (cmd === 'type') {
    // Any language and any keyboard layout: the text goes through the clipboard, which gets its old content back.
    const pb = $.NSPasteboard.generalPasteboard;
    const old = pb.stringForType($.NSPasteboardTypeString);
    pb.clearContents;
    pb.setStringForType($(argv[1]), $.NSPasteboardTypeString);
    delay(0.05);
    key(KEYS.v, MODS.cmd);
    delay(0.25);
    pb.clearContents;
    if (old && old.js !== undefined) pb.setStringForType(old, $.NSPasteboardTypeString);
  } else { out.ok = false; out.error = 'unknown command'; }
  const p = $.CGEventGetLocation($.CGEventCreate(null));
  out.pointer = [Math.round(p.x), Math.round(p.y)];
  return JSON.stringify(out);
}
`

function jxa(...argv) {
  const res = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA, ...argv.map(String)], { encoding: 'utf8', timeout: 20_000 })
  try {
    return JSON.parse(res.stdout.trim().split('\n').pop())
  } catch {
    return { ok: false, error: (res.stderr || res.error?.message || 'osascript zlyhal').trim().slice(0, 300) }
  }
}

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

const SETTINGS = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'
const PERMISSION = {
  screen: 'Snímku obrazovky sa nepodarilo spraviť: chýba povolenie Nahrávanie obrazovky a zvuku. macOS: Nastavenia systému → Súkromie a bezpečnosť → Nahrávanie obrazovky a zvuku, zapni program, v ktorom Jarvis beží (node, Terminál alebo appku Jarvis). Príkaz `node scripts/control.mjs ask` to okno otvorí.',
  accessibility: 'Chýba povolenie ovládať počítač. macOS: Nastavenia systému → Súkromie a bezpečnosť → Prístupnosť, zapni program, v ktorom Jarvis beží (node, Terminál alebo appku Jarvis). Príkaz `node scripts/control.mjs ask` to okno otvorí.',
}

/** The frame and the reticle on the user's screen. Never stops the work when the desktop is not running. */
const show = (body) => postHud('/api/control', body)

/** Pixels of the last picture → points of the screen. */
function point(xs, ys) {
  const x = Number(xs)
  const y = Number(ys)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) fail('X a Y sú čísla z poslednej snímky (node scripts/control.mjs shot).')
  const scale = readState()?.scale ?? 1
  return [Math.round(x * scale), Math.round(y * scale)]
}

async function main() {
  if (!IS_MAC) fail('Ovládanie myši a klávesnice je zatiaľ len na macOS. Na Windowse použi PowerShell a ovládanie prehliadača.')
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const dry = flags.has('dry') ? ['dry'] : []
  switch (command) {
    case 'status':
    case 'ask': {
      const s = jxa(command)
      // The picture needs a permission of its own. Trying once makes macOS list the program, and `ask` opens the right page.
      const probe = spawnSync('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', join(DIR, 'probe.jpg')], { timeout: 15_000 })
      s.see = probe.status === 0
      if (command === 'ask') {
        if (!s.see) spawnSync('/usr/bin/open', [`${SETTINGS}?Privacy_ScreenCapture`])
        else if (s.control === false) spawnSync('/usr/bin/open', [`${SETTINGS}?Privacy_Accessibility`])
      }
      return print({ ...s, hint: s.control === false ? PERMISSION.accessibility : undefined, seeHint: s.see ? undefined : PERMISSION.screen })
    }
    case 'shot': {
      const cap = spawnSync('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', SHOT], { timeout: 15_000 })
      if (cap.status !== 0) fail(PERMISSION.screen)
      spawnSync('/usr/bin/sips', ['-Z', String(SHOT_MAX), '-s', 'formatOptions', '72', SHOT], { timeout: 15_000 })
      const dims = spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', SHOT], { encoding: 'utf8' }).stdout
      const width = Number(/pixelWidth: (\d+)/.exec(dims)?.[1])
      const height = Number(/pixelHeight: (\d+)/.exec(dims)?.[1])
      const s = jxa('status')
      if (!width || !s.screen) fail('Snímku sa nepodarilo prečítať.')
      const scale = s.screen[0] / width
      writeFileSync(STATE, JSON.stringify({ width, height, scale, screen: s.screen, at: new Date().toISOString() }), { mode: 0o600 })
      await show({ on: true, label: 'Pozerám sa na obrazovku' })
      return print({ ok: true, file: SHOT, width, height, note: 'Prečítaj súbor ako obrázok. Súradnice pre click, move a scroll sú pixely tejto snímky.', control: s.control })
    }
    case 'click':
    case 'move': {
      const [x, y] = point(args[0], args[1])
      await show({ on: true, label: command === 'click' ? 'Klikám' : 'Hýbem kurzorom', x, y, click: command === 'click' })
      const r = command === 'click' ? jxa('click', x, y, flags.has('right') ? 'right' : 'left', flags.has('double') ? 'double' : 'single', ...dry) : jxa('move', x, y, ...dry)
      if (!r.ok) fail(PERMISSION[r.error] ?? r.error)
      return print({ ok: true, at: [Number(args[0]), Number(args[1])] })
    }
    case 'scroll': {
      const dir = String(args[0] ?? '').toLowerCase()
      if (!['up', 'down'].includes(dir)) fail('scroll up alebo down')
      const steps = Math.min(40, Math.max(1, Math.round(Number(args[1]) || 5)))
      const at = flags.has('at') ? point(args[2], args[3]) : ['', '']
      await show({ on: true, label: 'Posúvam stránku', ...(at[0] !== '' ? { x: at[0], y: at[1] } : {}) })
      const r = jxa('scroll', '0', dir === 'down' ? steps : -steps, at[0], at[1], ...dry)
      if (!r.ok) fail(PERMISSION[r.error] ?? r.error)
      return print({ ok: true })
    }
    case 'type': {
      const text = args.join(' ')
      if (!text) fail('Chýba text.')
      await show({ on: true, label: 'Píšem' })
      const r = jxa('type', text, ...dry)
      if (!r.ok) fail(PERMISSION[r.error] ?? r.error)
      return print({ ok: true, typed: text.length })
    }
    case 'key': {
      if (!args[0]) fail('Chýba kláves, napríklad return alebo cmd+t.')
      await show({ on: true, label: `Kláves ${args[0]}` })
      const r = jxa('key', args[0], ...dry)
      if (!r.ok) fail(PERMISSION[r.error] ?? r.error)
      return print({ ok: true })
    }
    case 'say':
      await show({ on: true, label: args.join(' ').slice(0, 60) || 'Pracujem' })
      return print({ ok: true })
    case 'done':
      await show({ on: false })
      return print({ ok: true })
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, '').trim())
  }
}

await main()
