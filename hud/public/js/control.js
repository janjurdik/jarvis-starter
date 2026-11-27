// Jarvis at work on the computer: while he moves the mouse, types or clicks in the browser
// (scripts/control.mjs, background jobs), the user sees who is doing it and where.
//
//   desktop app   a frame around the whole screen and a reticle at the pointer, above every window
//                 (drawn by the app itself: hud/desktop/main.swift, ControlOverlay)
//   browser       a frame and a label inside the Jarvis window
//
// The server sends `control` events: { on, label, x, y, click }, x and y in points of the screen.

export function initControl({ on }) {
  const frame = document.createElement('div')
  frame.className = 'ctl'
  frame.hidden = true
  frame.innerHTML = '<i class="ctl-k k1"></i><i class="ctl-k k2"></i><i class="ctl-k k3"></i><i class="ctl-k k4"></i><div class="ctl-pill"></div>'
  document.body.append(frame)
  const pill = frame.querySelector('.ctl-pill')
  let timer = 0
  const hide = () => {
    clearTimeout(timer)
    frame.hidden = true
  }
  on('control', (c) => {
    // In the Mac app the app draws the frame and the label over the whole screen, so the window
    // must not draw them a second time.
    const desk = window.__jarvisDesktop
    if (desk?.native && typeof desk.post === 'function') {
      desk.post({ type: 'control', on: c?.on !== false, label: c?.label ?? null, x: c?.x ?? null, y: c?.y ?? null, click: c?.click === true })
      return hide()
    }
    if (c?.on === false) return hide()
    pill.textContent = c?.label ? `Jarvis · ${c.label}` : 'Jarvis ovláda počítač'
    frame.hidden = false
    clearTimeout(timer)
    timer = setTimeout(hide, 8000)
  })
}
