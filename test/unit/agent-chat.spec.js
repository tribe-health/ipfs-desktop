const { test, expect } = require('@playwright/test')
const sinon = require('sinon')
const { KEYS, CHANNELS } = require('../../src/agent/consts')
const { validateEndpoint, readAgentChatSettings } = require('../../src/agent/settings')
const { createTokenStore, MAX_TOKEN_LENGTH } = require('../../src/agent/token-store')
const { registerAgentBridge } = require('../../src/agent/bridge')

function memoryStore (initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    set: (key, value) => { data.set(key, value) },
    delete: (key) => { data.delete(key) },
    dump: () => JSON.stringify([...data.entries()])
  }
}

// Reversible stand-in for the OS keystore: the "ciphertext" is not the plaintext.
function fakeSafeStorage ({ available = true, backend } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: backend === undefined ? undefined : () => backend,
    encryptString: (plain) => Buffer.from(plain.split('').reverse().join('') + '|sealed'),
    decryptString: (buf) => {
      const text = buf.toString()
      if (!text.endsWith('|sealed')) throw new Error('bad ciphertext')
      return text.slice(0, -'|sealed'.length).split('').reverse().join('')
    }
  }
}

test.describe('agent chat settings', () => {
  test('is off with no endpoint by default', () => {
    expect(readAgentChatSettings(memoryStore())).toEqual({ enabled: false, endpoint: null, origin: null })
  })

  test('a switch without a valid endpoint stays off, and an endpoint without the switch stays off', () => {
    expect(readAgentChatSettings(memoryStore({ [KEYS.ENABLED]: true })).enabled).toBe(false)
    expect(readAgentChatSettings(memoryStore({ [KEYS.ENABLED]: true, [KEYS.ENDPOINT]: 'http://example.test/agui' })).enabled).toBe(false)
    expect(readAgentChatSettings(memoryStore({ [KEYS.ENDPOINT]: 'http://127.0.0.1:7777/agui' })).enabled).toBe(false)
    expect(readAgentChatSettings(memoryStore({ [KEYS.ENABLED]: 'true', [KEYS.ENDPOINT]: 'http://127.0.0.1:7777/agui' })).enabled).toBe(false)
  })

  test('on with a loopback http endpoint exposes its origin for the CSP', () => {
    expect(readAgentChatSettings(memoryStore({ [KEYS.ENABLED]: true, [KEYS.ENDPOINT]: 'http://127.0.0.1:7777/agui' })))
      .toEqual({ enabled: true, endpoint: 'http://127.0.0.1:7777/agui', origin: 'http://127.0.0.1:7777' })
  })

  test('validateEndpoint applies the island rules', () => {
    expect(validateEndpoint('https://node.example/agui')).toMatchObject({ ok: true, origin: 'https://node.example' })
    expect(validateEndpoint('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateEndpoint('::')).toEqual({ ok: false, reason: 'invalid' })
    expect(validateEndpoint('http://node.example/agui')).toEqual({ ok: false, reason: 'scheme' })
    expect(validateEndpoint('ftp://127.0.0.1/agui')).toEqual({ ok: false, reason: 'scheme' })
    expect(validateEndpoint('https://u:p@node.example/agui')).toEqual({ ok: false, reason: 'extras' })
    expect(validateEndpoint('https://node.example/agui?x=1')).toEqual({ ok: false, reason: 'extras' })
    expect(validateEndpoint('https://node.example/other')).toEqual({ ok: false, reason: 'path' })
    expect(validateEndpoint('https://*.example/agui').ok).toBe(false)
  })
})

test.describe('agent chat token store', () => {
  test('stores ciphertext only and reads the token back', () => {
    const store = memoryStore()
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), store })
    expect(tokens.has()).toBe(false)
    expect(tokens.get()).toBeUndefined()

    tokens.set('tok_abc123XYZ')

    expect(tokens.has()).toBe(true)
    expect(tokens.get()).toBe('tok_abc123XYZ')
    expect(store.dump()).not.toContain('tok_abc123XYZ')
  })

  test('survives a new store instance over the same persisted data (a restart)', () => {
    const store = memoryStore()
    createTokenStore({ safeStorage: fakeSafeStorage(), store }).set('tok_restart')
    const afterRestart = createTokenStore({ safeStorage: fakeSafeStorage(), store })
    expect(afterRestart.get()).toBe('tok_restart')
  })

  test('refuses to store when the OS keystore is unavailable, and writes nothing', () => {
    const store = memoryStore()
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage({ available: false }), store })
    expect(() => tokens.set('tok_x')).toThrow(/secure storage is unavailable/)
    expect(store.dump()).toBe('[]')
  })

  test('on Linux, basic_text and unknown backends count as unavailable', () => {
    for (const backend of ['basic_text', 'unknown']) {
      const tokens = createTokenStore({ safeStorage: fakeSafeStorage({ backend }), store: memoryStore(), platform: 'linux' })
      expect(tokens.isAvailable()).toBe(false)
      expect(() => tokens.set('tok_x')).toThrow()
    }
    for (const backend of ['gnome_libsecret', 'kwallet5', 'kwallet6']) {
      expect(createTokenStore({ safeStorage: fakeSafeStorage({ backend }), store: memoryStore(), platform: 'linux' }).isAvailable()).toBe(true)
    }
  })

  test('rejects tokens of the wrong shape', () => {
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), store: memoryStore() })
    for (const bad of ['', ' ', 'has space', 'new\nline', 'tab\tchar', 'é', 'x'.repeat(MAX_TOKEN_LENGTH + 1), 5, null, undefined, {}]) {
      expect(() => tokens.set(bad)).toThrow(/invalid shape/)
    }
    expect(tokens.has()).toBe(false)
  })

  test('a ciphertext that no longer decrypts reads as no token and logs without the secret', () => {
    const warn = sinon.spy()
    const store = memoryStore({ [KEYS.TOKEN_CIPHERTEXT]: Buffer.from('garbage').toString('base64') })
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), store, logger: { warn } })
    expect(tokens.get()).toBeUndefined()
    expect(warn.calledOnce).toBe(true)
  })

  test('clear removes it', () => {
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), store: memoryStore() })
    tokens.set('tok_gone')
    tokens.clear()
    expect(tokens.has()).toBe(false)
    expect(tokens.get()).toBeUndefined()
  })
})

test.describe('agent chat bridge', () => {
  const webuiFrame = { url: 'webui://localhost/#/files' }
  const contents = { mainFrame: webuiFrame }
  const tokenStore = { get: () => 'tok_secret' }
  const settings = { enabled: true, endpoint: 'http://127.0.0.1:7777/agui' }

  function setup (overrides = {}) {
    const handlers = new Map()
    const ipcMain = {
      handle: sinon.spy((channel, fn) => { handlers.set(channel, fn) }),
      removeHandler: sinon.spy((channel) => { handlers.delete(channel) })
    }
    const bridge = registerAgentBridge({ ipcMain, getWebuiContents: () => contents, settings, tokenStore, ...overrides })
    return { handlers, ipcMain, bridge }
  }

  test('disabled state: registers no channel at all', () => {
    const { handlers, ipcMain, bridge } = setup({ settings: { enabled: false, endpoint: null } })
    expect(bridge.enabled).toBe(false)
    expect(ipcMain.handle.called).toBe(false)
    expect(handlers.size).toBe(0)
  })

  test('enabled: exactly two read-only channels', () => {
    const { handlers, bridge } = setup()
    expect(bridge.enabled).toBe(true)
    expect([...handlers.keys()].sort()).toEqual([CHANNELS.GET_ENDPOINT, CHANNELS.GET_TOKEN].sort())
  })

  test('answers the Web UI main frame', async () => {
    const { handlers } = setup()
    const event = { sender: contents, senderFrame: webuiFrame }
    expect(await handlers.get(CHANNELS.GET_TOKEN)(event)).toBe('tok_secret')
    expect(await handlers.get(CHANNELS.GET_ENDPOINT)(event)).toBe(settings.endpoint)
  })

  test('refuses a sender that is not the Web UI window', async () => {
    const { handlers } = setup()
    const event = { sender: { mainFrame: webuiFrame }, senderFrame: webuiFrame }
    expect(await handlers.get(CHANNELS.GET_TOKEN)(event)).toBeUndefined()
    expect(await handlers.get(CHANNELS.GET_ENDPOINT)(event)).toBeNull()
  })

  test('refuses a sub-frame of the Web UI window', async () => {
    const { handlers } = setup()
    const event = { sender: contents, senderFrame: { url: 'webui://localhost/' } }
    expect(await handlers.get(CHANNELS.GET_TOKEN)(event)).toBeUndefined()
  })

  test('refuses the Web UI window once it has navigated to another origin', async () => {
    const elsewhere = { url: 'https://evil.example/' }
    const { handlers } = setup({ getWebuiContents: () => ({ mainFrame: elsewhere }) })
    const event = { sender: { mainFrame: elsewhere }, senderFrame: elsewhere }
    expect(await handlers.get(CHANNELS.GET_TOKEN)(event)).toBeUndefined()
  })

  test('refuses everything when the window is gone', async () => {
    const { handlers } = setup({ getWebuiContents: () => null })
    expect(await handlers.get(CHANNELS.GET_TOKEN)({ sender: contents, senderFrame: webuiFrame })).toBeUndefined()
  })

  test('dispose removes both channels', () => {
    const { handlers, bridge } = setup()
    bridge.dispose()
    expect(handlers.size).toBe(0)
  })
})
