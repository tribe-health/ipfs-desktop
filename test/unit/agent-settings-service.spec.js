/* global structuredClone */
const { test, expect } = require('@playwright/test')
const { createSettingsService, ContractError, BridgeFailure } = require('../../src/agent/settings-service')
const { SettingsApiError } = require('../../src/agent/settings-api')

const KEY = 'sk-test-key-0123456789'

const messages = {
  'agentSettings.errNotRunning': 'not running',
  'agentSettings.errToken': 'token refused',
  'agentSettings.errRouteAbsent': 'route absent',
  'agentSettings.errStale': 'stale revision',
  'agentSettings.errTouchId': 'Touch ID was not completed',
  'agentSettings.errKeystore': 'keystore unavailable',
  'agentSettings.errKeyShape': 'key shape',
  'agentSettings.errRestart': 'did not come back',
  'agentSettings.errUnexpected': 'unexpected'
}
const t = (key, options) => {
  if (key === 'agentSettings.touchReasonHost') return `Send node content to ${options.host}`
  if (key === 'agentSettings.touchReasonKeyHost') return `Test the connection to ${options.host}`
  if (key === 'agentSettings.touchReasonBackend') return 'Change the agent backend'
  if (key === 'agentSettings.errRejected') return `rejected ${options.status}: ${options.detail}`
  return messages[key] ?? key
}

// A stand-in for the sidecar's settings route: revision-guarded, key never returned.
function fakeServer (initial = {}) {
  const state = {
    revision: 'r1',
    backend: null,
    system_prompt: { safety_prefix: 'SAFETY', custom: '' },
    ...initial
  }
  const calls = []
  const bump = () => { state.revision = 'r' + (Number(state.revision.slice(1)) + 1) }
  const api = {
    calls,
    async get () {
      calls.push(['get'])
      return structuredClone({ ...state, leaked: 'must-not-reach-the-page' })
    },
    async put (revision, write) {
      calls.push(['put', revision, structuredClone(write)])
      if (revision !== state.revision) throw new SettingsApiError(412, { error: { code: 'revision_conflict', message: 'stale', details: { current_revision: state.revision } } }, 'stale')
      if (write.backend) {
        state.backend = { api_key: { set: false }, ...(state.backend ?? {}), ...write.backend, kind: write.backend.kind ?? state.backend?.kind ?? 'openai' }
      }
      if (write.system_prompt !== undefined) state.system_prompt = { ...state.system_prompt, custom: write.system_prompt }
      bump()
      return structuredClone(state)
    },
    async testConnection (req) {
      calls.push(['testConnection', req])
      return req.base_url.includes('down') ? { ok: false, detail: `cannot reach, key ${KEY} rejected` } : { ok: true }
    },
    async listModels (url, kind) {
      calls.push(['listModels', url, kind])
      return { models: [{ id: 'm-one' }, { id: 'm-two', extra: 1 }, { id: '' }] }
    }
  }
  return { state, api, calls, bump }
}

function setup ({ server = fakeServer(), sidecarState = 'running', afterRestartState, touch = { available: true, accept: true }, native = { accept: true }, storedKey } = {}) {
  const keyBox = { value: storedKey }
  const secrets = {
    hasLlmKey: () => keyBox.value !== undefined,
    getLlmKey: () => keyBox.value,
    setLlmKey: (k) => {
      if (k.includes(' ')) throw new Error('LLM API key has an invalid shape')
      if (setup.keystoreDown) throw new Error('secure storage is unavailable; the LLM API key is not stored')
      keyBox.value = k
    },
    clearLlmKey: () => { keyBox.value = undefined }
  }
  const sidecarCalls = []
  const sidecar = {
    getState: () => sidecarState,
    getPort: () => 5050,
    // The persisted off switch must never be touched by a key change.
    setEnabled: async () => { throw new Error('setEnabled must not be called by the settings service') },
    restart: async () => {
      sidecarCalls.push('restart')
      if (afterRestartState) sidecarState = afterRestartState
      // The restarted child reads the stored key; the route then reports it as coming from the environment.
      server.state.backend = server.state.backend && { ...server.state.backend, api_key: keyBox.value ? { set: true, source: 'environment' } : { set: false } }
      server.bump()
    }
  }
  const prompts = []
  const authenticate = {
    available: () => touch.available,
    prompt: async (reason) => { prompts.push(reason); return touch.accept }
  }
  const dialogs = []
  const confirmNative = native === null ? undefined : async (request) => { dialogs.push(request); return native.accept }
  const logs = { info: [], warn: [] }
  const service = createSettingsService({
    api: server.api,
    getSidecar: () => sidecar,
    secrets,
    authenticate,
    confirmNative,
    t,
    logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    now: () => new Date('2026-10-14T12:00:00Z'),
    sleep: async () => {},
    restartWaitMs: 50
  })
  return { service, server, secrets, keyBox, sidecarCalls, prompts, dialogs, logs, setSidecarState: (s) => { sidecarState = s } }
}
setup.keystoreDown = false

const configured = () => fakeServer({ backend: { kind: 'openai', base_url: 'https://llm.example/v1', model: 'm-one', api_key: { set: false } } })

test.describe('agent settings service: reads', () => {
  test('get returns the contract fields and nothing else', async () => {
    const { service } = setup({ server: configured() })
    const got = await service.get()
    expect(Object.keys(got).sort()).toEqual(['backend', 'revision', 'system_prompt'])
    expect(got.backend).toEqual({ kind: 'openai', base_url: 'https://llm.example/v1', model: 'm-one', api_key: { set: false } })
    expect(JSON.stringify(got)).not.toContain('must-not-reach-the-page')
  })

  test('get reports a key only as {set, source}; the sidecar environment source reads as settings_api for a Desktop key', async () => {
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'environment' }
    const withDesktopKey = setup({ server, storedKey: KEY })
    const got = await withDesktopKey.service.get()
    expect(got.backend.api_key).toEqual({ set: true, source: 'settings_api' })
    expect(JSON.stringify(got)).not.toContain(KEY)

    const noDesktopKey = setup({ server })
    expect((await noDesktopKey.service.get()).backend.api_key).toEqual({ set: true, source: 'environment' })
  })

  test('get with no backend configured answers backend null', async () => {
    const { service } = setup()
    expect((await service.get()).backend).toBeNull()
  })

  test('with the sidecar not running every call says so and reaches no route', async () => {
    const { service, server } = setup({ sidecarState: 'restarting' })
    await expect(service.get()).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.set({ revision: 'r1', system_prompt: 'x' })).rejects.toThrow('not running')
    expect(server.calls).toEqual([])
  })

  test('a malformed answer from the sidecar is refused, not passed on', async () => {
    const { service, server } = setup()
    server.api.get = async () => ({ revision: '', backend: {} })
    await expect(service.get()).rejects.toThrow('unexpected shape')
  })
})

test.describe('agent settings service: status', () => {
  test('reports the managed transport, the loopback endpoint and port while running', async () => {
    const { service } = setup()
    expect(await service.status()).toEqual({
      transport: 'desktop-bridge',
      managed_by_desktop: true,
      endpoint: 'http://127.0.0.1:5050/agui',
      sidecar: { running: true, port: 5050 }
    })
  })

  test('reports no endpoint and no port when the sidecar is not running', async () => {
    for (const state of ['stopped', 'restarting', 'failing']) {
      const { service } = setup({ sidecarState: state })
      const status = await service.status()
      expect(status.sidecar).toEqual({ running: false })
      expect(status.endpoint).toBeUndefined()
    }
  })

  test('tracks the last revision and the last apply (success and failure)', async () => {
    const { service } = setup({ server: configured() })
    const first = await service.get()
    expect((await service.status()).revision).toEqual(first.revision)
    expect((await service.status()).applied).toBeUndefined()

    await service.set({ revision: first.revision, system_prompt: 'be brief' })
    let status = await service.status()
    expect(status.applied).toEqual({ at: '2026-10-14T12:00:00.000Z', ok: true })

    await expect(service.set({ revision: first.revision, system_prompt: 'again' })).rejects.toBeInstanceOf(ContractError)
    status = await service.status()
    expect(status.applied.ok).toBe(false)
    expect(status.applied.error).toContain('stale')
  })
})

test.describe('agent settings service: set and Touch ID (1.4)', () => {
  test('a backend change calls the Touch ID helper before the write', async () => {
    const { service, prompts, server } = setup({ server: configured() })
    await service.set({
      revision: 'r1',
      backend: { base_url: 'https://other.example/v1' },
      egress_confirmation: { host: 'other.example' }
    })
    expect(prompts).toEqual(['Send node content to other.example'])
    expect(server.calls.map(c => c[0])).toEqual(['get', 'put'])
    expect(server.calls[1][2]).toEqual({ backend: { base_url: 'https://other.example/v1' }, egress_confirmation: { host: 'other.example' } })
  })

  test('a model-only change is a backend change and asks too', async () => {
    const { service, prompts } = setup({ server: configured() })
    await service.set({ revision: 'r1', backend: { model: 'm-two' } })
    // The prompt names the host the model runs on.
    expect(prompts).toEqual(['Send node content to llm.example'])
  })

  test('the first backend (none configured) asks', async () => {
    const { service, prompts } = setup()
    await service.set({ revision: 'r1', backend: { kind: 'openai', base_url: 'https://llm.example/v1', model: 'm' } })
    expect(prompts.length).toEqual(1)
  })

  test('an egress confirmation alone asks', async () => {
    const { service, prompts } = setup({ server: configured() })
    await service.set({ revision: 'r1', egress_confirmation: { host: 'llm.example' } })
    expect(prompts.length).toEqual(1)
  })

  test('a system prompt change and a no-op backend write do not ask', async () => {
    const { service, prompts } = setup({ server: configured() })
    await service.set({ revision: 'r1', system_prompt: 'be brief' })
    await service.set({ revision: 'r2', backend: { model: 'm-one' } })
    expect(prompts).toEqual([])
  })

  test('a declined Touch ID applies nothing and says so', async () => {
    const { service, server } = setup({ server: configured(), touch: { available: true, accept: false } })
    await expect(service.set({ revision: 'r1', backend: { model: 'm-two' } })).rejects.toThrow('Touch ID was not completed')
    expect(server.calls.some(c => c[0] === 'put')).toBe(false)
    expect((await service.status()).applied.ok).toBe(false)
  })

  test('a stale revision is refused before any prompt', async () => {
    const { service, prompts } = setup({ server: configured() })
    const err = await service.set({ revision: 'r0', backend: { model: 'm-two' } }).catch(e => e)
    expect(err).toBeInstanceOf(ContractError)
    expect(err.shape.error.code).toEqual('revision_conflict')
    expect(prompts).toEqual([])
  })

  test('without Touch ID a native dialog naming the host is asked, and Allow applies the change', async () => {
    const { service, prompts, dialogs, logs, server } = setup({ server: configured(), touch: { available: false, accept: false } })
    await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })
    expect(prompts).toEqual([])
    expect(dialogs).toEqual([{ host: 'other.example' }])
    expect(server.calls.some(c => c[0] === 'put')).toBe(true)
    expect(logs.warn.some(m => m.includes('Touch ID is unavailable'))).toBe(true)
  })

  test('without Touch ID, Cancel in the native dialog refuses and nothing is written', async () => {
    const { service, dialogs, server } = setup({ server: configured(), touch: { available: false, accept: false }, native: { accept: false } })
    await expect(service.set({ revision: 'r1', backend: { model: 'm-two' } })).rejects.toThrow('Touch ID was not completed')
    expect(dialogs.length).toEqual(1)
    expect(server.calls.some(c => c[0] === 'put')).toBe(false)
  })

  test('without Touch ID and without a dialog the change fails closed', async () => {
    const { service, server } = setup({ server: configured(), touch: { available: false, accept: false }, native: null })
    await expect(service.set({ revision: 'r1', egress_confirmation: { host: 'llm.example' } })).rejects.toThrow('Touch ID was not completed')
    expect(server.calls.some(c => c[0] === 'put')).toBe(false)
  })

  test('the server contract errors pass through with their code', async () => {
    const { service, server } = setup({ server: configured() })
    server.api.put = async () => {
      throw new SettingsApiError(409, { error: { code: 'egress_confirmation_required', message: 'confirm the host', details: { host: 'x.example' } } }, '')
    }
    const err = await service.set({ revision: 'r1', backend: { base_url: 'https://x.example/v1' } }).catch(e => e)
    expect(err).toBeInstanceOf(ContractError)
    expect(err.shape.error).toMatchObject({ code: 'egress_confirmation_required', details: { host: 'x.example' } })
  })

  test('refuses what the request schema refuses: unknown fields, an api_key, credentials in the URL, no change', async () => {
    const { service, server } = setup({ server: configured() })
    const bad = [
      { revision: 'r1', surprise: true },
      { revision: 'r1', backend: { api_key: KEY } },
      { revision: 'r1', backend: { base_url: 'https://user:pw@llm.example/v1' } },
      { revision: 'r1', backend: { base_url: 'ftp://llm.example' } },
      { revision: 'r1', backend: { kind: 'other' } },
      { revision: 'r1', backend: {} },
      { revision: 'r1' },
      { backend: { model: 'x' } },
      { revision: 'r1', system_prompt: 'x'.repeat(32769) },
      { revision: 'r1', egress_confirmation: { host: 'UPPER.example' } },
      null,
      'text'
    ]
    for (const req of bad) {
      await expect(service.set(req), JSON.stringify(req)).rejects.toBeInstanceOf(BridgeFailure)
    }
    expect(server.calls).toEqual([])
  })
})

test.describe('agent settings service: key is write-only (1.2)', () => {
  test('setApiKey stores the key, restarts the sidecar, and answers without it', async () => {
    const { service, keyBox, sidecarCalls } = setup({ server: configured() })
    const res = await service.setApiKey({ revision: 'r1', api_key: KEY })
    expect(keyBox.value).toEqual(KEY)
    expect(sidecarCalls).toEqual(['restart'])
    expect(Object.keys(res).sort()).toEqual(['api_key', 'revision'])
    expect(res.api_key).toEqual({ set: true, source: 'settings_api' })
    expect(JSON.stringify(res)).not.toContain(KEY)
    // The revision is the one after the restart.
    expect(res.revision).toEqual('r2')

    const got = await service.get()
    expect(got.backend.api_key).toEqual({ set: true, source: 'settings_api' })
    expect(JSON.stringify(got)).not.toContain(KEY)
    expect(JSON.stringify(await service.status())).not.toContain(KEY)
  })

  test('a key staged before any backend exists waits for the first backend write', async () => {
    const { service, keyBox, sidecarCalls } = setup()
    const staged = await service.setApiKey({ revision: 'r1', api_key: KEY, kind: 'openai' })
    expect(keyBox.value).toEqual(KEY)
    expect(sidecarCalls).toEqual([])
    expect(staged).toEqual({ revision: 'r1', api_key: { set: true, source: 'settings_api' } })

    const set = await service.set({ revision: 'r1', backend: { kind: 'openai', base_url: 'https://llm.example/v1', model: 'm' } })
    expect(sidecarCalls).toEqual(['restart'])
    expect(set.backend.api_key).toEqual({ set: true, source: 'settings_api' })
  })

  test('clearApiKey removes it and restarts the sidecar', async () => {
    const { service, keyBox, sidecarCalls } = setup({ server: configured(), storedKey: KEY })
    const res = await service.clearApiKey({ revision: 'r1' })
    expect(keyBox.value).toBeUndefined()
    expect(sidecarCalls).toEqual(['restart'])
    expect(res.api_key).toEqual({ set: false })
  })

  test('clearApiKey with no stored key restarts nothing', async () => {
    const { service, sidecarCalls } = setup({ server: configured() })
    await service.clearApiKey({ revision: 'r1' })
    expect(sidecarCalls).toEqual([])
  })

  test('a key with a bad shape or an unavailable keystore is refused without echoing it', async () => {
    const shape = setup({ server: configured() })
    const err = await shape.service.setApiKey({ revision: 'r1', api_key: 'has space' }).catch(e => e)
    expect(err.message).toEqual('key shape')
    expect(err.message).not.toContain('has space')

    setup.keystoreDown = true
    try {
      const down = setup({ server: configured() })
      const e2 = await down.service.setApiKey({ revision: 'r1', api_key: KEY }).catch(e => e)
      expect(e2.message).toEqual('keystore unavailable')
      expect(down.keyBox.value).toBeUndefined()
    } finally {
      setup.keystoreDown = false
    }
  })

  test('a stale revision refuses a key change and stores nothing', async () => {
    const { service, keyBox } = setup({ server: configured() })
    await expect(service.setApiKey({ revision: 'r0', api_key: KEY })).rejects.toBeInstanceOf(ContractError)
    expect(keyBox.value).toBeUndefined()
  })

  test('a sidecar that does not come back after a key change is reported', async () => {
    const { service, keyBox } = setup({ server: configured(), afterRestartState: 'failing' })
    const err = await service.setApiKey({ revision: 'r1', api_key: KEY }).catch(e => e)
    expect(err).toBeInstanceOf(BridgeFailure)
    expect(err.message).toEqual('did not come back')
    expect(err.message).not.toContain(KEY)
    expect(keyBox.value).toEqual(KEY)
    expect((await service.status()).applied.ok).toBe(false)
  })

  test('error text from the sidecar never carries the stored key', async () => {
    const { service, server } = setup({ server: configured(), storedKey: KEY })
    server.api.get = async () => { throw new SettingsApiError(500, null, `boom with ${KEY} inside`) }
    const err = await service.get().catch(e => e)
    expect(err.message).toContain('[redacted]')
    expect(err.message).not.toContain(KEY)
  })

  test('refuses an unknown field and a bad key length on the key channels', async () => {
    const { service } = setup({ server: configured() })
    await expect(service.setApiKey({ revision: 'r1', api_key: KEY, extra: 1 })).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.setApiKey({ revision: 'r1', api_key: '' })).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.setApiKey({ revision: 'r1', api_key: 'k'.repeat(513) })).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.clearApiKey({ revision: 'r1', api_key: null })).rejects.toBeInstanceOf(BridgeFailure)
  })
})

test.describe('agent settings service: test connection', () => {
  test('a good probe lists models and measures latency', async () => {
    const { service, server } = setup({ server: configured() })
    const res = await service.testConnection({ base_url: 'https://llm.example/v1', kind: 'openai' })
    expect(res.ok).toBe(true)
    expect(res.models).toEqual(['m-one', 'm-two'])
    expect(Number.isInteger(res.latency_ms)).toBe(true)
    expect(server.calls.map(c => c[0])).toEqual(['get', 'testConnection', 'listModels'])
  })

  test('a candidate host that is not the current backend asks first, naming the host, before anything is sent', async () => {
    const { service, server, prompts } = setup({ server: configured() })
    const res = await service.testConnection({ base_url: 'https://lookalike.example/v1', kind: 'openai' })
    expect(prompts).toEqual(['Test the connection to lookalike.example'])
    expect(res.ok).toBe(true)
    expect(server.calls.map(c => c[0])).toEqual(['get', 'testConnection', 'listModels'])
  })

  test('the current backend host is not asked about again, in any letter case', async () => {
    const { service, prompts } = setup({ server: configured() })
    await service.testConnection({ base_url: 'https://LLM.example/other/path' })
    expect(prompts).toEqual([])
  })

  test('a declined confirmation sends nothing to the candidate', async () => {
    const { service, server } = setup({ server: configured(), touch: { available: true, accept: false } })
    await expect(service.testConnection({ base_url: 'https://attacker.example/v1' })).rejects.toThrow('Touch ID was not completed')
    expect(server.calls.map(c => c[0])).toEqual(['get'])
  })

  test('with no backend configured every candidate host asks', async () => {
    const { service, prompts } = setup()
    await service.testConnection({ base_url: 'https://llm.example/v1' })
    expect(prompts).toEqual(['Test the connection to llm.example'])
  })

  test('without Touch ID the native dialog decides, and Cancel sends nothing', async () => {
    const accepted = setup({ server: configured(), touch: { available: false, accept: false } })
    await accepted.service.testConnection({ base_url: 'https://other.example/v1' })
    expect(accepted.dialogs).toEqual([{ host: 'other.example' }])

    const refused = setup({ server: configured(), touch: { available: false, accept: false }, native: { accept: false } })
    await expect(refused.service.testConnection({ base_url: 'https://other.example/v1' })).rejects.toThrow('Touch ID was not completed')
    expect(refused.server.calls.map(c => c[0])).toEqual(['get'])
  })

  test('key_sent passes through as a boolean and nothing else is invented', async () => {
    const { service, server } = setup({ server: configured() })
    server.api.testConnection = async () => ({ ok: true, key_sent: false, secret: 'x' })
    const res = await service.testConnection({ base_url: 'https://llm.example/v1' })
    expect(res.key_sent).toBe(false)
    expect(Object.keys(res).sort()).toEqual(['key_sent', 'latency_ms', 'models', 'ok'])
    server.api.testConnection = async () => ({ ok: true, key_sent: 'yes' })
    expect((await service.testConnection({ base_url: 'https://llm.example/v1' })).key_sent).toBeUndefined()
  })

  test('a reachable-but-key-not-sent answer is an ordinary result', async () => {
    const { service, server } = setup({ server: configured() })
    server.api.testConnection = async () => ({ ok: false, detail: 'reachable; the stored key is not sent to an unconfirmed host' })
    const res = await service.testConnection({ base_url: 'https://llm.example/v1' })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('not sent')
  })

  test('a failed probe returns the detail, redacted, and lists nothing', async () => {
    const { service, server } = setup({ server: configured(), storedKey: KEY })
    const res = await service.testConnection({ base_url: 'https://down.example/v1' })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('[redacted]')
    expect(res.detail).not.toContain(KEY)
    expect(res.models).toBeUndefined()
    expect(server.calls.map(c => c[0])).toEqual(['get', 'testConnection'])
  })

  test('accepts loopback http, refuses remote http, credentials and a key in the request', async () => {
    const { service } = setup({ server: configured() })
    await expect(service.testConnection({ base_url: 'http://127.0.0.1:11434/v1' })).resolves.toMatchObject({ ok: true })
    await expect(service.testConnection({ base_url: 'http://llm.example/v1' })).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.testConnection({ base_url: 'https://u:p@llm.example/v1' })).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.testConnection({ base_url: 'https://llm.example/v1', apiKey: KEY })).rejects.toBeInstanceOf(BridgeFailure)
  })
})
