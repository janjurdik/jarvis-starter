/**
 * System notifications (macOS notification centre, Windows toast): how Jarvis reaches the user
 * who is looking at something else. The desktop is a wallpaper under the windows, so a toast on
 * it is easy to miss.
 *
 * With the desktop app running, the app shows the notification under its own name and a click on
 * it opens the job. Without it the system's own scripting does it.
 */
import { spawn } from 'node:child_process'
import { desktopCount, send } from './sse.mjs'
import { IS_MAC, IS_WIN, winSys } from './util.mjs'

/** A notification from the scripting tools of the system. Never throws. */
export function osNotify(title, body) {
  const head = String(title).replace(/\s+/g, ' ').slice(0, 80)
  const text = String(body).replace(/\s+/g, ' ').slice(0, 220)
  if (IS_MAC) {
    // The text goes in as arguments, never into the script itself.
    spawn('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', head, text], { stdio: 'ignore' }).on('error', () => {})
  } else if (IS_WIN) {
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      "$x = $t.GetElementsByTagName('text')",
      '$x.Item(0).AppendChild($t.CreateTextNode($env:J_TITLE)) | Out-Null',
      '$x.Item(1).AppendChild($t.CreateTextNode($env:J_TEXT)) | Out-Null',
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
    ].join('; ')
    spawn(winSys('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, J_TITLE: head, J_TEXT: text }, stdio: 'ignore', windowsHide: true }).on('error', () => {})
  }
}

/** { title, body, job?, quiet? }: through the desktop app when it is there, otherwise through the system. */
export function systemNotify({ title, body, job = null, quiet = false }) {
  const n = { title: String(title).slice(0, 80), body: String(body ?? '').replace(/\s+/g, ' ').slice(0, 220), job, quiet: quiet === true }
  if (desktopCount() > 0) send('notify', n)
  else osNotify(n.title, n.body)
}
