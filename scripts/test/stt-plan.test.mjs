/**
 * The speech-to-text plan on representative computers: node --test scripts/test/*.test.mjs
 * Only the pure decision is tested here, nothing is probed or downloaded.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODELS, modelSizeMb, normalizeChoice, parseModelOverride, planStt } from '../../hud/server/stt-plan.mjs'

const GB = 1000
const mac = (ramGb, extra = {}) => ({ platform: 'darwin', arch: 'arm64', ramGb, cores: 8, freeDiskMb: 200 * GB, gpu: { vendor: 'apple' }, uv: true, ...extra })
const intelMac = (extra = {}) => ({ platform: 'darwin', arch: 'x64', ramGb: 8, cores: 4, freeDiskMb: 100 * GB, gpu: { vendor: null }, uv: true, ...extra })
const win = (extra = {}) => ({ platform: 'win32', arch: 'x64', ramGb: 7.9, cores: 4, freeDiskMb: 120 * GB, gpu: { vendor: null }, uv: true, ...extra })

test('M3 with 36 GB gets the best model on MLX', () => {
  const p = planStt(mac(36))
  assert.equal(p.engine, 'mlx')
  assert.equal(p.model, 'large-v3-turbo')
  assert.equal(p.device, 'metal')
  assert.equal(p.sizeMb, 1614)
  assert.match(p.reason, /Apple Silicon/)
})

test('M1 with 8 GB gets the small model', () => {
  const p = planStt(mac(8))
  assert.equal(p.engine, 'mlx')
  assert.equal(p.model, 'small')
  assert.equal(p.sizeMb, 481)
})

test('Intel Mac with 8 GB runs faster-whisper small on the CPU', () => {
  const p = planStt(intelMac())
  assert.equal(p.engine, 'faster')
  assert.equal(p.model, 'small')
  assert.equal(p.device, 'cpu')
  assert.equal(p.compute, 'int8')
})

test('Windows, 4 cores, 8 GB, no GPU: small on the CPU', () => {
  const p = planStt(win())
  assert.equal(p.engine, 'faster')
  assert.equal(p.model, 'small')
  assert.equal(p.device, 'cpu')
})

test('a strong CPU without a GPU still gets the small model: the big one is too slow there', () => {
  const p = planStt(win({ cores: 16, ramGb: 31.9 }))
  assert.equal(p.model, 'small')
  assert.equal(p.device, 'cpu')
  // Asking for it by name still works.
  assert.equal(planStt(win({ cores: 16, ramGb: 31.9, modelOverride: 'large-v3-turbo' })).model, 'large-v3-turbo')
})

test('Windows with an NVIDIA card runs the big model on it', () => {
  const p = planStt(win({ ramGb: 15.9, cores: 6, gpu: { vendor: 'nvidia', name: 'RTX 3060', vramMb: 12288 } }))
  assert.equal(p.engine, 'faster')
  assert.equal(p.model, 'large-v3-turbo')
  assert.equal(p.device, 'cuda')
  assert.equal(p.compute, 'float16')
  // The GPU libraries are a large download: they count towards the disk space needed.
  assert.ok(p.needMb > 4000)
})

test('an NVIDIA card with too little memory is not used', () => {
  const p = planStt(win({ gpu: { vendor: 'nvidia', vramMb: 2048 } }))
  assert.equal(p.device, 'cpu')
  assert.equal(p.model, 'small')
})

test('a plan can be kept off the GPU', () => {
  const p = planStt(win({ ramGb: 15.9, cores: 6, gpu: { vendor: 'nvidia', vramMb: 8192 }, device: 'cpu' }))
  assert.equal(p.device, 'cpu')
  assert.equal(p.model, 'small')
})

test('a weak computer falls back to the browser', () => {
  const p = planStt(win({ cores: 2, ramGb: 3.9 }))
  assert.equal(p.engine, 'browser')
  assert.equal(p.cause, 'weak')
  assert.equal(p.model, null)
})

test('2 GB of free disk: the browser, with the space that is needed', () => {
  const p = planStt(mac(36, { freeDiskMb: 2 * GB }))
  assert.equal(p.engine, 'browser')
  assert.equal(p.cause, 'disk')
  assert.ok(p.needMb > 2 * GB)
  assert.match(p.reason, /2,0 GB/)
})

test('a tight disk steps down to the small model before giving up', () => {
  const p = planStt(mac(36, { freeDiskMb: 3.5 * GB }))
  assert.equal(p.engine, 'mlx')
  assert.equal(p.model, 'small')
  assert.ok(p.notes.length > 0)
})

test('a model that is already on the disk needs no space', () => {
  const p = planStt(mac(36, { freeDiskMb: 300, cached: ['mlx/large-v3-turbo'], envReady: true }))
  assert.equal(p.model, 'large-v3-turbo')
  assert.equal(p.needMb, 0)
})

test('an unknown amount of free disk does not block the plan', () => {
  assert.equal(planStt(mac(16, { freeDiskMb: null })).model, 'large-v3-turbo')
})

test('no uv: the browser, whatever was asked for', () => {
  for (const choice of ['auto', 'whisper', 'mlx', 'faster']) {
    const p = planStt(mac(36, { uv: false, choice }))
    assert.equal(p.engine, 'browser')
    assert.equal(p.cause, 'uv')
  }
})

test('an explicit choice wins', () => {
  assert.equal(planStt(mac(36, { choice: 'browser' })).engine, 'browser')
  assert.equal(planStt(mac(36, { choice: 'off' })).engine, 'off')
  assert.equal(planStt(mac(36, { choice: 'faster' })).engine, 'faster')
  // MLX does not exist outside Apple Silicon: the request still ends in a local Whisper.
  const p = planStt(win({ choice: 'mlx' }))
  assert.equal(p.engine, 'faster')
  assert.ok(p.notes.length > 0)
})

test('whisper insists on a local model even on a weak computer', () => {
  const p = planStt(win({ cores: 2, ramGb: 3.9, choice: 'whisper' }))
  assert.equal(p.engine, 'faster')
  assert.equal(p.model, 'small')
})

test('a model override wins over the hardware tiers', () => {
  assert.equal(planStt(mac(36, { modelOverride: 'small' })).model, 'small')
  assert.equal(planStt(mac(8, { modelOverride: 'turbo' })).model, 'large-v3-turbo')
  assert.equal(planStt(win({ modelOverride: 'base' })).model, 'base')
  const custom = planStt(mac(36, { modelOverride: 'mlx-community/whisper-large-v3-mlx' }))
  assert.equal(custom.custom, true)
  assert.equal(custom.repo, 'mlx-community/whisper-large-v3-mlx')
  assert.equal(planStt(mac(36, { modelOverride: 'tiny' })).repo, 'mlx-community/whisper-tiny-mlx')
})

test('English-only models are refused', () => {
  for (const name of ['small.en', 'base.en', 'distil-large-v3', 'mlx-community/whisper-small.en-mlx', 'Systran/faster-whisper-medium.en']) {
    assert.ok(parseModelOverride(name).rejected, name)
    const p = planStt(mac(36, { modelOverride: name }))
    assert.equal(p.model, 'large-v3-turbo')
    assert.ok(p.notes.some((n) => n.includes(name)))
  }
})

test('Windows on ARM has no local engine yet', () => {
  const p = planStt(win({ arch: 'arm64', cores: 12, ramGb: 31.9, choice: 'whisper' }))
  assert.equal(p.engine, 'browser')
  assert.equal(p.cause, 'unsupported')
})

test('a model that proved too slow is skipped', () => {
  assert.equal(planStt(mac(36, { exclude: ['large-v3-turbo'] })).model, 'small')
  assert.equal(planStt(mac(36, { exclude: ['large-v3-turbo', 'small'] })).engine, 'browser')
})

test('the model table holds only multilingual models with checksums', () => {
  for (const [engine, models] of Object.entries(MODELS)) {
    for (const [name, m] of Object.entries(models)) {
      assert.doesNotMatch(`${name} ${m.repo}`, /\.en\b|distil/, `${engine}/${name}`)
      assert.match(m.rev, /^[0-9a-f]{40}$/)
      for (const f of m.files) {
        assert.match(f.sha256, /^[0-9a-f]{64}$/)
        assert.doesNotMatch(f.path, /[\\/]|\.\./)
        assert.ok(f.size > 0)
      }
      assert.ok(modelSizeMb(engine, name) > 100)
    }
  }
})

test('choices are normalised', () => {
  assert.equal(normalizeChoice('MLX'), 'mlx')
  assert.equal(normalizeChoice('nonsense'), 'auto')
  assert.equal(normalizeChoice(undefined), 'auto')
})
