/**
 * What the user is looking at: a picture of the screen for the brain ("čo to je", "odpíš na toto")
 * and the timeline of a recording (server/record.mjs).
 *
 *   captureScreen({ prefer, selection, maxSide, file })   → { ok, file, kind, app, title, width, height, selection? }
 *   frontWindow()                                          → the window in front that is not Jarvis, or null
 *   captureCommand({ platform, out, windowId })            → { bin, args } of the capture (pure, tested)
 *   pruneScreens(dir, maxAgeMs)                            → removes old pictures
 *
 * macOS: `screencapture` (needs the permission Screen Recording for the program Jarvis runs in).
 * Prefers the front window that is not Jarvis's own (Jarvis may be the window in front or the desktop
 * under the windows), otherwise the main display. Windows: PowerShell with .NET (PrintWindow of the
 * top window that is not Jarvis, otherwise the primary screen). Pictures stay in data/screen/ on this
 * computer and are cleaned up after a day.
 */
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR, IS_MAC, IS_WIN, WIN_POWERSHELL, errMsg } from './util.mjs'

export const SCREEN_DIR = join(DATA_DIR, 'screen')
/** Longest side of a picture the brain reads: enough to read a mail, small enough to be fast. */
export const LOOK_MAX = 1600
const KEEP_MS = 24 * 3600_000

/** Jarvis's own windows: the desktop app (Jarvis HUD), and a browser or app window whose title is Jarvis. */
const OWN_APP = /^jarvis/i
const OWN_TITLE = /^jarvis$/i
/** System layers that are never what the user means by "toto". */
const SYSTEM_APPS = new Set(['Window Server', 'Dock', 'Control Center', 'Notification Center', 'Spotlight', 'screencaptureui', 'SystemUIServer', 'WindowManager'])

const SETTINGS = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture'
export const SCREEN_PERMISSION = IS_WIN
  ? 'Snímku obrazovky sa nepodarilo spraviť. Skúste to o chvíľu znova; keď to nejde ani potom, pozrite log data/logs/hud-server.log.'
  : 'Snímku obrazovky sa nepodarilo spraviť: chýba povolenie Nahrávanie obrazovky a zvuku. macOS: Nastavenia systému → Súkromie a bezpečnosť → Nahrávanie obrazovky a zvuku, zapnite program, v ktorom Jarvis beží (Jarvis HUD, node alebo Terminál), a Jarvisa reštartujte. Príkaz `node scripts/control.mjs ask` to okno otvorí.'
export const SCREEN_SETTINGS_URL = SETTINGS

/** Runs a program without a shell and collects its output. Never throws. */
function run(bin, args, { timeout = 20_000, input = null, env = process.env } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    } catch (e) {
      return resolve({ code: 1, out: '', err: errMsg(e) })
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', (d) => (out = `${out}${d}`.slice(-400_000)))
    child.stderr.on('data', (d) => (err = `${err}${d}`.slice(-4000)))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 1, out, err: errMsg(e) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out: out.trim(), err: err.trim() })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * The windows on the screen, front to back (macOS). Fixed script, nothing variable goes into it.
 * Window titles need the permission Screen Recording; without it they are empty and the app name decides.
 */
const MAC_WINDOWS = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function run() {
  const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const windows = list.map(w => ({ id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || '', pid: w.kCGWindowOwnerPID, layer: w.kCGWindowLayer, title: w.kCGWindowName || '', alpha: w.kCGWindowAlpha, bounds: w.kCGWindowBounds || {} }));
  return JSON.stringify({ front: front ? { app: front.localizedName.js, pid: front.processIdentifier } : null, windows: windows });
}
`

/**
 * The window the user means: the frontmost ordinary window (layer 0) that is not Jarvis and not a
 * piece of the system, big enough to hold something. Pure, so the choice is tested.
 */
export function pickWindow(windows = [], { ownApp = OWN_APP, ownTitle = OWN_TITLE } = {}) {
  for (const w of windows) {
    if (!w || w.layer !== 0 || !(Number(w.alpha ?? 1) > 0)) continue
    if (SYSTEM_APPS.has(w.app) || ownApp.test(String(w.app ?? '')) || ownTitle.test(String(w.title ?? '').trim())) continue
    const width = Number(w.bounds?.Width ?? w.bounds?.width ?? 0)
    const height = Number(w.bounds?.Height ?? w.bounds?.height ?? 0)
    if (width < 200 || height < 120) continue
    return { id: Number(w.id), app: String(w.app ?? ''), pid: Number(w.pid) || null, title: String(w.title ?? ''), width, height }
  }
  return null
}

/** The front window that is not Jarvis (macOS), and which app is in front at all. */
export async function frontWindow() {
  if (!IS_MAC) return null
  const res = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_WINDOWS], { timeout: 8000 })
  if (res.code !== 0) return null
  try {
    const data = JSON.parse(res.out.split('\n').pop())
    const win = pickWindow(data.windows)
    return win ? { ...win, frontApp: data.front?.app ?? null } : { id: null, frontApp: data.front?.app ?? null }
  } catch {
    return null
  }
}

/**
 * Windows: the top visible window that is not Jarvis (PrintWindow draws it even under other windows),
 * otherwise the primary screen. Static script, the output path and the mode come as arguments.
 */
export const WIN_CAPTURE = `
param([string]$Out, [string]$Mode = 'window', [int]$Max = ${LOOK_MAX})
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class JWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[void][JWin]::SetProcessDPIAware()
$pick = $null
if ($Mode -eq 'window') {
  $found = New-Object System.Collections.ArrayList
  $cb = [JWin+EnumProc]{ param($h, $l)
    if (-not [JWin]::IsWindowVisible($h) -or [JWin]::IsIconic($h)) { return $true }
    if (([JWin]::GetWindowLong($h, -20) -band 0x80) -ne 0) { return $true }
    $sb = New-Object System.Text.StringBuilder 512; [void][JWin]::GetWindowText($h, $sb, 512); $t = $sb.ToString()
    if (-not $t -or $t -match '^Jarvis$') { return $true }
    $procId = [uint32]0; [void][JWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -match '^(?i)jarvis|^(explorer|ShellExperienceHost|SearchHost|StartMenuExperienceHost|TextInputHost)$') { return $true }
    $r = New-Object JWin+RECT; [void][JWin]::GetWindowRect($h, [ref]$r)
    if (($r.Right - $r.Left) -lt 200 -or ($r.Bottom - $r.Top) -lt 120) { return $true }
    [void]$found.Add(@{ h = $h; t = $t; app = $p.ProcessName; r = $r }); return $false
  }
  [void][JWin]::EnumWindows($cb, [IntPtr]::Zero)
  if ($found.Count) { $pick = $found[0] }
}
if ($pick) {
  $r = $pick.r; $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  $ok = [JWin]::PrintWindow($pick.h, $dc, 2); $g.ReleaseHdc($dc)
  if (-not $ok) { $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size) }
  $g.Dispose(); $kind = 'window'; $app = $pick.app; $title = $pick.t
} else {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
  $kind = 'display'; $app = ''; $title = ''
}
$scale = [Math]::Min(1.0, $Max / [Math]::Max($bmp.Width, $bmp.Height))
$ow = [int]($bmp.Width * $scale); $oh = [int]($bmp.Height * $scale)
$small = New-Object System.Drawing.Bitmap $ow, $oh
$g2 = [System.Drawing.Graphics]::FromImage($small); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $ow, $oh); $g2.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 72L
$small.Save($Out, $codec, $ep); $small.Dispose(); $bmp.Dispose()
@{ ok = $true; kind = $kind; app = $app; title = $title; width = $ow; height = $oh } | ConvertTo-Json -Compress
`

/**
 * The command that takes the picture. macOS: one window by its id (-l, no shadow) or the main display
 * (-m), silently (-x). Windows: the PowerShell script above from its file.
 */
export function captureCommand({ platform = process.platform, out, windowId = null, script = null, max = LOOK_MAX }) {
  if (platform === 'darwin') {
    const target = Number.isInteger(windowId) && windowId > 0 ? ['-o', `-l${windowId}`] : ['-m']
    return { bin: '/usr/sbin/screencapture', args: ['-x', ...target, '-t', 'jpg', out] }
  }
  if (platform === 'win32') {
    return { bin: WIN_POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out, '-Mode', windowId === 'display' ? 'display' : 'window', '-Max', String(max)] }
  }
  return null
}

/** The command that makes a picture smaller on macOS (sips), JPEG quality about 70. */
export const shrinkCommand = (file, max = LOOK_MAX) => ({ bin: '/usr/bin/sips', args: ['-Z', String(max), '-s', 'formatOptions', '70', file] })

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')

/** Pixel size of a JPEG from its header (no decoder needed). */
export function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return null
}

/**
 * Selected text in the window the user looks at, without touching the clipboard: the accessibility
 * attribute AXSelectedText of the focused element (macOS, needs the permission Accessibility). When
 * the app does not expose it and it is in front, a copy (cmd+c) through the clipboard, whose whole
 * previous content is put back right after.
 */
const MAC_SELECTION = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  let text = '';
  try {
    const se = Application('System Events');
    const p = se.processes.whose({ unixId: pid })[0];
    const f = p.attributes.byName('AXFocusedUIElement').value();
    text = String(f.attributes.byName('AXSelectedText').value() || '');
  } catch (e) { text = ''; }
  if (text.trim() || argv[1] !== 'copy') return JSON.stringify({ text: text, via: 'ax' });
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front || front.processIdentifier !== pid) return JSON.stringify({ text: '', via: 'none' });
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = [];
  const items = pb.pasteboardItems;
  for (let i = 0; i < Number(items.count); i++) {
    const item = items.objectAtIndex(i); const types = item.types; const entry = [];
    for (let k = 0; k < Number(types.count); k++) { const t = types.objectAtIndex(k); const d = item.dataForType(t); if (d && !d.isNil()) entry.push([t, d]); }
    saved.push(entry);
  }
  const before = Number(pb.changeCount);
  for (const down of [true, false]) { const e = $.CGEventCreateKeyboardEvent(null, 8, down); $.CGEventSetFlags(e, $.kCGEventFlagMaskCommand); $.CGEventPost($.kCGHIDEventTap, e); delay(0.02); }
  delay(0.3);
  if (Number(pb.changeCount) === before) return JSON.stringify({ text: '', via: 'copy' });
  const copied = pb.stringForType($.NSPasteboardTypeString);
  text = copied && !copied.isNil() ? copied.js : '';
  pb.clearContents;
  const back = $.NSMutableArray.array;
  for (const entry of saved) { const it = $.NSPasteboardItem.alloc.init; for (const [t, d] of entry) it.setDataForType(d, t); back.addObject(it); }
  if (Number(back.count)) pb.writeObjects(back);
  return JSON.stringify({ text: text, via: 'copy' });
}
`

export async function selectedText(pid, { copy = true } = {}) {
  if (!IS_MAC || !pid) return null
  const res = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SELECTION, String(pid), copy ? 'copy' : 'ax'], { timeout: 8000 })
  if (res.code !== 0) return null
  try {
    const text = String(JSON.parse(res.out.split('\n').pop()).text ?? '').trim()
    return text ? text.slice(0, 8000) : null
  } catch {
    return null
  }
}

let winScript = null
async function windowsScript() {
  if (winScript) return winScript
  await mkdir(SCREEN_DIR, { recursive: true, mode: 0o700 })
  winScript = join(SCREEN_DIR, 'capture.ps1')
  await writeFile(winScript, WIN_CAPTURE, { mode: 0o600 })
  return winScript
}

/**
 * One picture of what the user is looking at.
 *   prefer   'window' (the front window that is not Jarvis, the default) or 'display' (the whole main screen)
 *   selection  also the selected text in that window (macOS)
 *   file     where to write it (default data/screen/<time>.jpg)
 */
export async function captureScreen({ prefer = 'window', selection = false, maxSide = LOOK_MAX, file = null, dir = SCREEN_DIR } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const out = file ?? join(dir, `${stamp()}-${Math.random().toString(36).slice(2, 6)}.jpg`)
  if (IS_MAC) {
    const win = prefer === 'window' ? await frontWindow() : null
    let kind = win?.id ? 'window' : 'display'
    let cmd = captureCommand({ out, windowId: win?.id ?? null })
    let res = await run(cmd.bin, cmd.args, { timeout: 15_000 })
    // A window that closed in between, or one the system will not give: the whole screen then.
    if ((res.code !== 0 || !(await sizeOf(out))) && kind === 'window') {
      kind = 'display'
      cmd = captureCommand({ out, windowId: null })
      res = await run(cmd.bin, cmd.args, { timeout: 15_000 })
    }
    if (res.code !== 0 || !(await sizeOf(out))) return { ok: false, error: SCREEN_PERMISSION, permission: 'screen' }
    const shrink = shrinkCommand(out, maxSide)
    await run(shrink.bin, shrink.args, { timeout: 15_000 })
    await chmod(out, 0o600).catch(() => {})
    const dims = await readDims(out)
    const sel = selection && win?.pid ? await selectedText(win.pid) : null
    return { ok: true, file: out, kind, app: kind === 'window' ? win.app : null, title: kind === 'window' ? win.title || null : null, frontApp: win?.frontApp ?? null, ...dims, ...(sel ? { selection: sel } : {}) }
  }
  if (IS_WIN) {
    const cmd = captureCommand({ platform: 'win32', out, script: await windowsScript(), windowId: prefer === 'display' ? 'display' : null, max: maxSide })
    const res = await run(cmd.bin, cmd.args, { timeout: 25_000 })
    let info = {}
    try {
      info = JSON.parse(res.out.split('\n').pop())
    } catch {
      info = {}
    }
    if (res.code !== 0 || !info.ok || !(await sizeOf(out))) return { ok: false, error: SCREEN_PERMISSION, detail: res.err.slice(0, 300) }
    await chmod(out, 0o600).catch(() => {})
    return { ok: true, file: out, kind: info.kind, app: info.app || null, title: info.title || null, width: info.width, height: info.height }
  }
  return { ok: false, error: 'Snímky obrazovky viem zatiaľ len na macOS a Windows.' }
}

async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

async function readDims(file) {
  try {
    return jpegSize(await readFile(file)) ?? {}
  } catch {
    return {}
  }
}

/** Pictures older than a day go away (the folder holds only what the brain looked at recently). */
export async function pruneScreens(dir = SCREEN_DIR, maxAgeMs = KEEP_MS, now = Date.now()) {
  let removed = 0
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!/\.(jpe?g|png)$/i.test(name)) continue
    const file = join(dir, name)
    try {
      if (now - (await stat(file)).mtimeMs > maxAgeMs) {
        await rm(file, { force: true })
        removed++
      }
    } catch {
      // gone already
    }
  }
  return removed
}
