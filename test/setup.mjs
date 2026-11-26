/**
 * Test setup: every test runs against its own temporary data, memory and config, never against
 * the real ones of the person who runs the tests. Import this file first in every test file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TMP = mkdtempSync(join(tmpdir(), 'jarvis-test-'))
// the folder this run created is removed again when the tests end
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))
process.env.TZ = 'Europe/Bratislava'
process.env.JARVIS_DATA_DIR = join(TMP, 'data')
process.env.JARVIS_MEMORY_DIR = join(TMP, 'memory')
process.env.JARVIS_CONFIG = join(TMP, 'jarvis.json')
delete process.env.JARVIS_ACTIVITY
// No system notifications from tests (hud/server/notify.mjs, scripts/lib.mjs), also in the servers and scripts they start.
process.env.JARVIS_NO_NOTIFY = '1'
mkdirSync(process.env.JARVIS_DATA_DIR, { recursive: true })
mkdirSync(process.env.JARVIS_MEMORY_DIR, { recursive: true })
writeFileSync(process.env.JARVIS_CONFIG, JSON.stringify({ name: 'Test', activity: { ignore: ['Secret Diary'] } }))
