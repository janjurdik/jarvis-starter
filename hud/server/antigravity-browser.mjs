#!/usr/bin/env node
/**
 * Stands in for the browser while Antigravity works for Jarvis (it is what BROWSER points at).
 *
 * When nobody is signed in, Antigravity opens its Google sign-in page on its own, with every run.
 * A routine at night or a check of the computer must not pop that up: Jarvis reports "not signed
 * in" instead and the user signs in once, on purpose (scripts/antigravity.mjs login). So that one
 * page is swallowed here. Every other address goes to the system as usual, a job that wants to
 * show a page still can.
 *
 *   node hud/server/antigravity-browser.mjs <address>
 */
import { spawn } from 'node:child_process'

const target = process.argv[2] ?? ''

/** The sign-in of a local program: Google's consent page that hands the result back to this computer. */
function isSignIn(address) {
  try {
    const url = new URL(address)
    return url.hostname === 'accounts.google.com' && url.pathname.startsWith('/o/oauth2/') && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url.searchParams.get('redirect_uri') ?? '')
  } catch {
    return false
  }
}

if (target && !isSignIn(target)) {
  // Without BROWSER, or the system would hand the address straight back to this script.
  const env = { ...process.env }
  delete env.BROWSER
  const [command, args] =
    process.platform === 'darwin' ? ['/usr/bin/open', [target]] : process.platform === 'win32' ? [`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\rundll32.exe`, ['url.dll,FileProtocolHandler', target]] : ['xdg-open', [target]]
  try {
    const child = spawn(command, args, { env, stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // nothing to open it with
  }
}
