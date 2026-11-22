import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeSurface, resolveSurface, surfacesFor } from '../hud/server/surface.mjs'

test('surface: names, the old "web" and nonsense', () => {
  assert.equal(normalizeSurface('desktop'), 'desktop')
  assert.equal(normalizeSurface(' App '), 'app')
  assert.equal(normalizeSurface('browser'), 'browser')
  assert.equal(normalizeSurface('web'), 'app')
  assert.equal(normalizeSurface('tv'), null)
  assert.equal(normalizeSurface(undefined), null)
})

test('surface: the desktop exists only on a Mac', () => {
  assert.deepEqual(surfacesFor('darwin'), ['desktop', 'app', 'browser'])
  assert.deepEqual(surfacesFor('win32'), ['app', 'browser'])
})

test('surface: config wins over setup, defaults by platform, raw value is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-surface-'))
  assert.deepEqual(resolveSurface({ dataDir: dir, config: null, platform: 'darwin' }), { surface: 'desktop', raw: null })
  assert.deepEqual(resolveSurface({ dataDir: dir, config: null, platform: 'win32' }), { surface: 'app', raw: null })
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ surface: 'browser' }))
  assert.deepEqual(resolveSurface({ dataDir: dir, config: null, platform: 'darwin' }), { surface: 'browser', raw: 'browser' })
  assert.deepEqual(resolveSurface({ dataDir: dir, config: 'app', platform: 'darwin' }), { surface: 'app', raw: 'app' })
  // A window from 1.8.0 stays a window and is told apart from a chosen app (no icon is made for it).
  assert.deepEqual(resolveSurface({ dataDir: dir, config: 'web', platform: 'win32' }), { surface: 'app', raw: 'web' })
  // The desktop asked for on Windows falls back to the app.
  assert.deepEqual(resolveSurface({ dataDir: dir, config: 'desktop', platform: 'win32' }), { surface: 'app', raw: 'desktop' })
  const cfg = join(dir, 'jarvis.json')
  writeFileSync(cfg, JSON.stringify({ surface: 'desktop' }))
  assert.deepEqual(resolveSurface({ dataDir: dir, configFile: cfg, platform: 'darwin' }), { surface: 'desktop', raw: 'desktop' })
})
