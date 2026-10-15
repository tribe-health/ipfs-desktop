const fs = require('fs')
const path = require('path')
const { test, expect } = require('@playwright/test')
const { applyAgentDefaults } = require('../../src/agent/defaults')
const { readAgentChatSettings } = require('../../src/agent/settings')
const { createAgentConfirmation, parseSwitch } = require('../../src/agent/confirm')
const { KEYS } = require('../../src/agent/consts')

const SIDECAR = 'mcpSidecar.enabled'

function memoryStore (initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (k, fallback) => (data.has(k) ? data.get(k) : fallback),
    set: (k, v) => { data.set(k, v) },
    delete: (k) => { data.delete(k) }
  }
}

test.describe('agent features default on (agent-features-default-on 1.2)', () => {
  test('an empty store gets all three switches on', () => {
    const store = memoryStore()
    const written = applyAgentDefaults({ store, platform: 'darwin' })
    expect(written.sort()).toEqual([KEYS.CONFIRM_ENABLED, KEYS.ENABLED, SIDECAR].sort())
    for (const key of written) expect(store.get(key)).toBe(true)
  })

  test('never switches the confirmation window on for win32', () => {
    const store = memoryStore()
    applyAgentDefaults({ store, platform: 'win32' })
    expect(store.data.has(KEYS.CONFIRM_ENABLED)).toBe(false)
    expect(store.get(KEYS.ENABLED)).toBe(true)
    expect(store.get(SIDECAR)).toBe(true)
  })

  test('a stored false survives app start, for each switch', () => {
    for (const key of [KEYS.ENABLED, KEYS.CONFIRM_ENABLED, SIDECAR]) {
      const store = memoryStore({ [key]: false })
      applyAgentDefaults({ store, platform: 'darwin' })
      expect(store.get(key), key).toBe(false)
    }
  })

  test('any stored value survives, including text typed by hand, and a second start changes nothing', () => {
    const store = memoryStore({ [KEYS.CONFIRM_ENABLED]: 'off', [KEYS.ENABLED]: 0 })
    applyAgentDefaults({ store, platform: 'darwin' })
    expect(store.get(KEYS.CONFIRM_ENABLED)).toBe('off')
    expect(store.get(KEYS.ENABLED)).toBe(0)
    expect(applyAgentDefaults({ store, platform: 'darwin' })).toEqual([])
  })

  test('the logged line says how to turn them off', () => {
    const lines = []
    applyAgentDefaults({ store: memoryStore(), platform: 'darwin', logger: { info: (m) => lines.push(m) } })
    expect(lines.join('\n')).toContain('tray menu')
  })

  test('disabled state: chat reads off with a stored false even when an endpoint is set', () => {
    const store = memoryStore({ [KEYS.ENABLED]: false, [KEYS.ENDPOINT]: 'http://127.0.0.1:7777/agui' })
    applyAgentDefaults({ store, platform: 'darwin' })
    expect(readAgentChatSettings(store).enabled).toBe(false)
  })

  test('on by default, the chat is still inert without a valid endpoint', () => {
    const store = memoryStore()
    applyAgentDefaults({ store, platform: 'darwin' })
    expect(readAgentChatSettings(store)).toEqual({ enabled: false, endpoint: null, origin: null })
    store.set(KEYS.ENDPOINT, 'http://127.0.0.1:7777/agui')
    expect(readAgentChatSettings(store).enabled).toBe(true)
  })

  test('disabled state: a stored false keeps the confirmation window off after the defaults ran', () => {
    const store = memoryStore({ [KEYS.CONFIRM_ENABLED]: false })
    applyAgentDefaults({ store, platform: 'darwin' })
    expect(parseSwitch(store.get(KEYS.CONFIRM_ENABLED))).toBe(false)
    const manager = createAgentConfirmation({
      electron: { BrowserWindow: class {}, ipcMain: { handle () {}, on () {}, removeHandler () {}, removeListener () {} }, session: {}, safeStorage: { isEncryptionAvailable: () => false } },
      store,
      i18n: { t: (k) => k, exists: () => true },
      platform: 'darwin'
    })
    expect(manager.enabled).toBe(false)
    manager.dispose()
  })

  test('the window init applies the defaults before it reads the chat settings', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/webui/index.js'), 'utf8')
    const applied = source.indexOf('applyAgentDefaults({ store')
    const read = source.indexOf('readAgentChatSettings(store)')
    expect(applied).toBeGreaterThan(-1)
    expect(applied).toBeLessThan(read)
  })
})
