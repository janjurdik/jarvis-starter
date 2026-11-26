/**
 * Visibility instead of locks: things the user should see happen on his computer, even when they came
 * from somewhere else (the phone, a background job, another program). One call gives three signals:
 * a system notification (over any window), a LOG line and a card in the conversation.
 *
 *   notice({ title, text, log?, icon?, node?, accent? })
 *
 * Used for the mobile access (new device, new password, tunnel open, login closed for everybody),
 * a recording that did not start with a click on this screen, and watchers created in the background.
 */
import { normalizeCard } from './cards.mjs'
import { standaloneCard } from './chat.mjs'
import { systemNotify } from './notify.mjs'
import { sendHud } from './sse.mjs'
import { clean, errMsg, log } from './util.mjs'

let seq = 0

export function notice({ title, text, log: line = '', icon = 'shield', node = null, accent = 'amber' }) {
  try {
    const head = clean(title, 60) || 'Jarvis'
    const body = clean(text, 400)
    log('notice', head)
    systemNotify({ title: `Jarvis: ${head}`, body })
    sendHud({ type: 'alert', text: clean(line, 140) || head, icon, say: null, heard: null, node, source: 'jarvis' })
    const id = `${++seq}-${Date.now().toString(36)}`
    const card = normalizeCard({ kind: 'text', title: head, icon, node, text: body, accent }, `c-n${id}`)
    if (card.ok) standaloneCard(`notice-${id}`, card.card)
  } catch (err) {
    log('notice', errMsg(err))
  }
}
