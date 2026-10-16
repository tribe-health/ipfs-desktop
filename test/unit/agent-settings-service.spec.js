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
  'agentSettings.errDeclinedHost': 'host declined for this window',
  'agentSettings.errConfirmPending': 'a confirmation is already open',
  'agentSettings.errKeystore': 'keystore unavailable',
  'agentSettings.errKeyShape': 'key shape',
  'agentSettings.errRestart': 'did not come back',
  'agentSettings.errUnexpected': 'unexpected'
}
const t = (key, options) => {
  if (key === 'agentSettings.touchReasonHost') return `Send node content to ${options.host} (your stored model key does not follow)`
  if (key === 'agentSettings.touchReasonHostKeyFollows') return `Send node content and the model key your server manages to ${options.host}`
  if (key === 'agentSettings.touchReasonBackendKeyFollows') return 'Change the agent backend (the model key your server manages will be sent to the new host)'
  if (key === 'agentSettings.touchReasonBackend') return 'Change the agent backend (your stored model key does not follow to a new host)'
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

function setup ({ server = fakeServer(), sidecarState = 'running', afterRestartState, touch = { available: true, accept: true }, native = { accept: true }, storedKey, failRestartAt } = {}) {
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
  let restartCount = 0
  const sidecar = {
    getState: () => sidecarState,
    getPort: () => 5050,
    // The persisted off switch must never be touched by a key change.
    setEnabled: async () => { throw new Error('setEnabled must not be called by the settings service') },
    restart: async () => {
      sidecarCalls.push('restart')
      restartCount++
      if (afterRestartState) sidecarState = afterRestartState
      // failRestartAt: the 1-based restarts that do not come back; any other restart is healthy.
      if (failRestartAt) sidecarState = failRestartAt.includes(restartCount) ? 'failing' : 'running'
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
    expect(prompts).toEqual(['Send node content to other.example (your stored model key does not follow)'])
    expect(server.calls.map(c => c[0])).toEqual(['get', 'put'])
    expect(server.calls[1][2]).toEqual({ backend: { base_url: 'https://other.example/v1' }, egress_confirmation: { host: 'other.example' } })
  })

  test('a model-only change is a backend change and asks too', async () => {
    const { service, prompts } = setup({ server: configured() })
    await service.set({ revision: 'r1', backend: { model: 'm-two' } })
    // The prompt names the host the model runs on.
    expect(prompts).toEqual(['Send node content to llm.example (your stored model key does not follow)'])
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
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toMatchObject({ host: 'other.example', purpose: 'backend', keyFollows: false })
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

  test('N1: a host the person declined is refused without a second prompt until the window is reset', async () => {
    const { service, prompts, server } = setup({ server: configured(), touch: { available: true, accept: false } })
    await expect(service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })).rejects.toThrow('Touch ID was not completed')
    expect(prompts.length).toEqual(1)
    for (let i = 0; i < 3; i++) {
      await expect(service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })).rejects.toThrow('host declined for this window')
    }
    expect(prompts.length).toEqual(1)
    // Another host is still asked.
    await expect(service.set({ revision: 'r1', backend: { base_url: 'https://third.example/v1' } })).rejects.toThrow('Touch ID was not completed')
    expect(prompts.length).toEqual(2)
    expect(server.calls.some(c => c[0] === 'put')).toBe(false)
    // Closing or recreating the window forgets the refusal.
    service.forgetDeclined()
    await expect(service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })).rejects.toThrow('Touch ID was not completed')
    expect(prompts.length).toEqual(3)
  })

  test('N1: the same applies to the native dialog', async () => {
    const { service, dialogs } = setup({ server: configured(), touch: { available: false, accept: false }, native: { accept: false } })
    await expect(service.set({ revision: 'r1', backend: { model: 'm-two' } })).rejects.toThrow('Touch ID was not completed')
    await expect(service.set({ revision: 'r1', backend: { model: 'm-two' } })).rejects.toThrow('host declined for this window')
    expect(dialogs.length).toEqual(1)
  })

  test('N1: only one confirmation is open at a time', async () => {
    const server = configured()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    // A prompt that stays open until released.
    const slow = createSettingsService({
      api: server.api,
      getSidecar: () => ({ getState: () => 'running', getPort: () => 5050, restart: async () => {} }),
      secrets: { hasLlmKey: () => false, getLlmKey: () => undefined, setLlmKey () {}, clearLlmKey () {} },
      authenticate: { available: () => true, prompt: async () => { await gate; return true } },
      t,
      sleep: async () => {}
    })
    const first = slow.set({ revision: 'r1', backend: { model: 'm-two' } })
    await new Promise((resolve) => setImmediate(resolve))
    await expect(slow.set({ revision: 'r1', backend: { model: 'm-three' } })).rejects.toThrow('a confirmation is already open')
    release()
    await first
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

  test('refuses what the request schema refuses: unknown fields, a top-level api_key, credentials in the URL, no change', async () => {
    const { service, server } = setup({ server: configured() })
    const bad = [
      { revision: 'r1', surprise: true },
      { revision: 'r1', api_key: KEY },
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

test.describe('agent settings service: the key does not follow a host move (ADR-0012, 1.7)', () => {
  const withKey = () => {
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'environment' }
    return setup({ server, storedKey: KEY })
  }

  test('a move without a new key deletes the Desktop key, restarts without it, then writes, and reports key_not_carried', async () => {
    const { service, server, keyBox, sidecarCalls } = withKey()
    const res = await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' }, egress_confirmation: { host: 'other.example' } })
    expect(keyBox.value).toBeUndefined()
    expect(sidecarCalls).toEqual(['restart'])
    // The write happens after the restart, on the revision the restarted sidecar holds.
    expect(server.calls.map(c => c[0])).toEqual(['get', 'get', 'put'])
    expect(server.calls[2][1]).toEqual('r2')
    expect(res.key_not_carried).toEqual({ reason: 'host_changed', cleared: true })
    expect(res.backend.api_key).toEqual({ set: false })
    expect(JSON.stringify(res)).not.toContain(KEY)
  })

  test('a port or scheme change is a move; a path or model change is not', async () => {
    for (const baseUrl of ['https://llm.example:8443/v1', 'http://llm.example/v1']) {
      const moved = withKey()
      const res = await moved.service.set({ revision: 'r1', backend: { base_url: baseUrl } })
      expect(moved.keyBox.value).toBeUndefined()
      expect(res.key_not_carried).toEqual({ reason: 'host_changed', cleared: true })
    }
    for (const backend of [{ base_url: 'https://llm.example/other/path' }, { model: 'm-two' }]) {
      const stayed = withKey()
      const res = await stayed.service.set({ revision: 'r1', backend })
      expect(stayed.keyBox.value).toEqual(KEY)
      expect(stayed.sidecarCalls).toEqual([])
      expect(res.key_not_carried).toBeUndefined()
    }
  })

  test('the first backend is not a move: a staged key waits and is applied', async () => {
    const { service, keyBox, sidecarCalls } = setup({ storedKey: KEY })
    const res = await service.set({ revision: 'r1', backend: { kind: 'openai', base_url: 'https://llm.example/v1', model: 'm' } })
    expect(keyBox.value).toEqual(KEY)
    expect(sidecarCalls).toEqual(['restart'])
    expect(res.key_not_carried).toBeUndefined()
  })

  test('a declined confirmation deletes nothing', async () => {
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'environment' }
    const { service, keyBox, sidecarCalls } = setup({ server, storedKey: KEY, touch: { available: true, accept: false } })
    await expect(service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })).rejects.toBeInstanceOf(BridgeFailure)
    expect(keyBox.value).toEqual(KEY)
    expect(sidecarCalls).toEqual([])
  })

  test('with no Desktop key a move restarts nothing and a reference key stays the server\'s business', async () => {
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'file' }
    const { service, sidecarCalls } = setup({ server })
    const res = await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })
    expect(sidecarCalls).toEqual([])
    expect(res.key_not_carried).toBeUndefined()
  })

  test('the server key_not_carried passes through with only reason and cleared', async () => {
    const server = configured()
    const put = server.api.put
    server.api.put = async (...args) => ({ ...(await put(...args)), key_not_carried: { reason: 'host_changed', cleared: false, secret: KEY } })
    const { service } = setup({ server })
    const res = await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })
    expect(res.key_not_carried).toEqual({ reason: 'host_changed', cleared: false })
    expect(JSON.stringify(res)).not.toContain(KEY)
  })

  test('a malformed key_not_carried is dropped', async () => {
    for (const bad of [{ reason: 1, cleared: true }, { reason: 'host_changed', cleared: 'yes' }, 'host_changed', null]) {
      const server = configured()
      const put = server.api.put
      server.api.put = async (...args) => ({ ...(await put(...args)), key_not_carried: bad })
      const { service } = setup({ server })
      expect((await service.set({ revision: 'r1', backend: { model: 'm-two' } })).key_not_carried).toBeUndefined()
    }
  })

  test('M2: a refused move (409) puts the key back and restarts, and the old backend is keyed again', async () => {
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'environment' }
    const refused = new SettingsApiError(409, { error: { code: 'egress_confirmation_required', message: 'confirm the host' } }, 'confirm')
    server.api.put = async (revision, write) => { server.calls.push(['put', revision, write]); throw refused }
    const { service, keyBox, sidecarCalls, logs } = setup({ server, storedKey: KEY })
    const err = await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } }).catch((e) => e)
    expect(err).toBeInstanceOf(ContractError)
    expect(err.shape.error.code).toEqual('egress_confirmation_required')
    // Cleared and restarted before the write, restored and restarted after it was refused.
    expect(sidecarCalls).toEqual(['restart', 'restart'])
    expect(keyBox.value).toEqual(KEY)
    expect(server.state.backend.base_url).toEqual('https://llm.example/v1')
    expect(server.state.backend.api_key).toEqual({ set: true, source: 'environment' })
    expect(logs.warn.join(' ')).toContain('restored')
    expect(logs.warn.join(' ')).not.toContain(KEY)
    // The page reads the old backend as keyed, from the Desktop key.
    const read = await service.get()
    expect(read.backend.api_key).toEqual({ set: true, source: 'settings_api' })
  })

  test('M2: any refusal restores it: a bad request, a stale revision, a sidecar that answers 500', async () => {
    for (const status of [400, 412, 500]) {
      const server = configured()
      server.state.backend.api_key = { set: true, source: 'environment' }
      server.api.put = async () => { throw new SettingsApiError(status, null, 'refused') }
      const { service, keyBox, sidecarCalls } = setup({ server, storedKey: KEY })
      await expect(service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })).rejects.toBeInstanceOf(BridgeFailure)
      expect(keyBox.value, String(status)).toEqual(KEY)
      expect(sidecarCalls, String(status)).toEqual(['restart', 'restart'])
    }
  })

  test('M2: a failed restart before the write also restores the key, and the original error is what is thrown', async () => {
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'environment' }
    const { service, keyBox } = setup({ server, storedKey: KEY, afterRestartState: 'failing' })
    const err = await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } }).catch((e) => e)
    expect(err).toBeInstanceOf(BridgeFailure)
    expect(err.message).toEqual('did not come back')
    expect(keyBox.value).toEqual(KEY)
  })

  test('M2: an accepted move still leaves the key deleted, and nothing is restored', async () => {
    const { service, keyBox, sidecarCalls } = withKey()
    await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' }, egress_confirmation: { host: 'other.example' } })
    expect(keyBox.value).toBeUndefined()
    expect(sidecarCalls).toEqual(['restart'])
  })

  test('a key the server supplies by reference follows a move: the prompt and the native dialog say it will be sent', async () => {
    for (const source of ['file', 'environment', 'flag']) {
      const server = configured()
      server.state.backend.api_key = { set: true, source }
      const { service, prompts, sidecarCalls } = setup({ server })
      const res = await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })
      expect(prompts, source).toEqual(['Send node content and the model key your server manages to other.example'])
      expect(prompts[0]).not.toContain('does not follow')
      expect(sidecarCalls).toEqual([])
      expect(res.key_not_carried).toBeUndefined()
    }
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'file' }
    const { service, dialogs } = setup({ server, touch: { available: false } })
    await service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })
    expect(dialogs[0]).toMatchObject({ host: 'other.example', purpose: 'backend', keyFollows: true })
  })

  test('the Desktop key does not claim to follow; no key at all and a no-move change use the plain wording', async () => {
    const desktop = withKey()
    await desktop.service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })
    expect(desktop.prompts).toEqual(['Send node content to other.example (your stored model key does not follow)'])

    const keyless = setup({ server: configured() })
    await keyless.service.set({ revision: 'r1', backend: { base_url: 'https://other.example/v1' } })
    expect(keyless.prompts[0]).toContain('does not follow')

    // A model change on a server-keyed backend is not a move: the key stays with the same host.
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'file' }
    const same = setup({ server, touch: { available: false } })
    await same.service.set({ revision: 'r1', backend: { model: 'm-two' } })
    expect(same.dialogs[0].keyFollows).toBe(false)
  })

  test('the key-follows copy says so in the Touch ID reasons and the native dialog', () => {
    const en = require('../../assets/locales/en.json')
    expect(en.agentSettings.touchReasonHostKeyFollows).toContain('model key your server manages')
    expect(en.agentSettings.touchReasonBackendKeyFollows).toContain('will be sent to the new host')
    expect(en.agentSettings.dialog.detailKeyFollows).toContain('so will the model key your server manages')
    for (const k of ['touchReasonHostKeyFollows', 'touchReasonBackendKeyFollows']) expect(en.agentSettings[k]).not.toContain('does not follow')
    expect(en.agentSettings.dialog.detailKeyFollows).not.toContain('not sent')
  })

  test('the copy says the key does not follow, in the Touch ID reasons and the native dialog', () => {
    const en = require('../../assets/locales/en.json')
    for (const k of ['touchReasonHost', 'touchReasonBackend']) {
      expect(en.agentSettings[k]).toContain('does not follow')
      expect(en.agentSettings[k]).not.toContain('goes with it')
    }
    expect(en.agentSettings.dialog.detail).toContain('not sent to a new host')
    expect(en.agentSettings.dialog.detail).toContain('supply a new key')
  })
})

test.describe('agent settings service: test connection', () => {
  test('a good probe lists models and measures latency', async () => {
    const { service, server } = setup({ server: configured() })
    const res = await service.testConnection({ base_url: 'https://llm.example/v1', kind: 'openai' })
    expect(res.ok).toBe(true)
    expect(res.models).toEqual(['m-one', 'm-two'])
    expect(Number.isInteger(res.latency_ms)).toBe(true)
    expect(server.calls.map(c => c[0])).toEqual(['testConnection', 'listModels'])
  })

  test('a probe never prompts: the server withholds the stored key from an unconfirmed host', async () => {
    const { service, server, prompts, dialogs } = setup({ server: configured() })
    server.api.testConnection = async (req) => { server.calls.push(['testConnection', req]); return { ok: true, key_sent: false } }
    const res = await service.testConnection({ base_url: 'https://lookalike.example/v1', kind: 'openai' })
    expect(prompts).toEqual([])
    expect(dialogs).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.key_sent).toBe(false)
    expect(server.calls.map(c => c[0])).toEqual(['testConnection', 'listModels'])
  })

  test('with no backend configured a probe still does not prompt', async () => {
    const { service, prompts } = setup({ touch: { available: false, accept: false }, native: null })
    await service.testConnection({ base_url: 'https://llm.example/v1' })
    expect(prompts).toEqual([])
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
    expect(server.calls.map(c => c[0])).toEqual(['testConnection'])
  })

  test('accepts loopback http, refuses remote http, credentials and a key in the request', async () => {
    const { service } = setup({ server: configured() })
    await expect(service.testConnection({ base_url: 'http://127.0.0.1:11434/v1' })).resolves.toMatchObject({ ok: true })
    await expect(service.testConnection({ base_url: 'http://llm.example/v1' })).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.testConnection({ base_url: 'https://u:p@llm.example/v1' })).rejects.toBeInstanceOf(BridgeFailure)
    await expect(service.testConnection({ base_url: 'https://llm.example/v1', apiKey: KEY })).rejects.toBeInstanceOf(BridgeFailure)
  })
})

test.describe('agent settings service: a key goes with Apply on a backend move (ADR-0012, U1/U2)', () => {
  const NEW_KEY = 'sk-new-key-9876543210'
  const withKey = (opts = {}) => {
    const server = configured()
    server.state.backend.api_key = { set: true, source: 'environment' }
    return setup({ server, storedKey: KEY, ...opts })
  }
  const kindChange = (extra = {}) => ({
    revision: 'r1',
    backend: { kind: 'uar', base_url: 'https://uar.example/v1', model: 'agent', ...extra },
    egress_confirmation: { host: 'uar.example' }
  })
  const everything = (ctx, res) => JSON.stringify([res, ctx.logs, ctx.server.calls, ctx.prompts, ctx.dialogs])

  test('set with api_key on a kind change: confirmed, stored, applied after the backend, and the old key is not carried', async () => {
    const ctx = withKey()
    const keyAtPut = []
    const put = ctx.server.api.put
    ctx.server.api.put = async (...args) => { keyAtPut.push(ctx.keyBox.value); return put(...args) }
    const res = await ctx.service.set(kindChange({ api_key: NEW_KEY }))
    // One confirmation, then: old key dropped + restart, backend written with no key, new key stored + restart.
    expect(ctx.prompts).toEqual(['Send node content to uar.example (your stored model key does not follow)'])
    expect(ctx.sidecarCalls).toEqual(['restart', 'restart'])
    expect(keyAtPut).toEqual([undefined])
    expect(ctx.keyBox.value).toEqual(NEW_KEY)
    const putCall = ctx.server.calls.find(c => c[0] === 'put')
    expect(putCall[2]).toEqual({ backend: { kind: 'uar', base_url: 'https://uar.example/v1', model: 'agent' }, egress_confirmation: { host: 'uar.example' } })
    expect(res.backend.kind).toEqual('uar')
    expect(res.backend.api_key).toEqual({ set: true, source: 'settings_api' })
    expect(res.key_not_carried).toBeUndefined()
    expect(everything(ctx, res)).not.toContain(NEW_KEY)
    expect(everything(ctx, res)).not.toContain(KEY)
  })

  test('a kind change with the host unchanged still asks, and a decline changes nothing', async () => {
    const asked = withKey()
    await asked.service.set({ revision: 'r1', backend: { kind: 'uar' } })
    expect(asked.prompts).toHaveLength(1)

    const native = withKey({ touch: { available: false, accept: false } })
    await native.service.set({ revision: 'r1', backend: { kind: 'uar' } })
    expect(native.dialogs[0]).toMatchObject({ host: 'llm.example', purpose: 'backend' })

    const declined = withKey({ touch: { available: true, accept: false } })
    await expect(declined.service.set({ revision: 'r1', backend: { kind: 'uar', api_key: NEW_KEY } })).rejects.toBeInstanceOf(BridgeFailure)
    expect(declined.keyBox.value).toEqual(KEY)
    expect(declined.sidecarCalls).toEqual([])
    expect(declined.server.calls.some(c => c[0] === 'put')).toBe(false)
  })

  test('set with a kind change and no key clears the old key and reports key_not_carried', async () => {
    const ctx = withKey()
    const res = await ctx.service.set({ revision: 'r1', backend: { kind: 'uar' } })
    expect(ctx.keyBox.value).toBeUndefined()
    expect(ctx.sidecarCalls).toEqual(['restart'])
    expect(res.key_not_carried).toEqual({ reason: 'host_changed', cleared: true })
    expect(res.backend.api_key).toEqual({ set: false })
    expect(everything(ctx, res)).not.toContain(KEY)
  })

  test('a same-kind change keeps the key, and a key supplied on a model change replaces it', async () => {
    const same = withKey()
    await same.service.set({ revision: 'r1', backend: { kind: 'openai', model: 'm-two' } })
    expect(same.keyBox.value).toEqual(KEY)
    expect(same.sidecarCalls).toEqual([])

    const replaced = withKey()
    const res = await replaced.service.set({ revision: 'r1', backend: { model: 'm-two', api_key: NEW_KEY } })
    expect(replaced.keyBox.value).toEqual(NEW_KEY)
    expect(replaced.sidecarCalls).toEqual(['restart'])
    expect(res.key_not_carried).toBeUndefined()
    expect(everything(replaced, res)).not.toContain(NEW_KEY)
  })

  test('set with api_key: null clears the key and restarts, without a put or a prompt', async () => {
    const ctx = withKey()
    const res = await ctx.service.set({ revision: 'r1', backend: { api_key: null } })
    expect(ctx.keyBox.value).toBeUndefined()
    expect(ctx.sidecarCalls).toEqual(['restart'])
    expect(ctx.server.calls.some(c => c[0] === 'put')).toBe(false)
    expect(ctx.prompts).toEqual([])
    expect(res.backend.api_key).toEqual({ set: false })
    expect(res.key_not_carried).toBeUndefined()

    const none = setup({ server: configured() })
    await none.service.set({ revision: 'r1', backend: { api_key: null } })
    expect(none.sidecarCalls).toEqual([])
  })

  test('api_key alone applies the key to the current backend', async () => {
    const ctx = setup({ server: configured() })
    const res = await ctx.service.set({ revision: 'r1', backend: { api_key: NEW_KEY } })
    expect(ctx.keyBox.value).toEqual(NEW_KEY)
    expect(ctx.sidecarCalls).toEqual(['restart'])
    expect(ctx.server.calls.some(c => c[0] === 'put')).toBe(false)
    expect(ctx.prompts).toEqual([])
    expect(res.backend.api_key).toEqual({ set: true, source: 'settings_api' })
  })

  test('a refused apply restores the previous key and backend', async () => {
    // The sidecar refuses the write: the new key was never stored, the old one is back.
    const refused = withKey()
    refused.server.api.put = async () => { throw new SettingsApiError(500, null, 'refused') }
    await expect(refused.service.set(kindChange({ api_key: NEW_KEY }))).rejects.toBeInstanceOf(BridgeFailure)
    expect(refused.keyBox.value).toEqual(KEY)
    expect(refused.sidecarCalls).toEqual(['restart', 'restart'])
    expect(refused.server.state.backend.kind).toEqual('openai')

    // The write lands, then the restart that applies the new key does not come back.
    const late = withKey({ failRestartAt: [2] })
    const err = await late.service.set(kindChange({ api_key: NEW_KEY })).catch(e => e)
    expect(err).toBeInstanceOf(BridgeFailure)
    expect(err.message).toEqual('did not come back')
    expect(late.keyBox.value).toEqual(KEY)
    expect(late.server.state.backend).toMatchObject({ kind: 'openai', base_url: 'https://llm.example/v1', model: 'm-one' })
    expect(late.logs.warn.join(' ')).toContain('restored')
    expect(everything(late, err.message)).not.toContain(NEW_KEY)
    expect(everything(late, err.message)).not.toContain(KEY)
    expect((await late.service.status()).applied.ok).toBe(false)
  })

  test('a key the keystore refuses after the backend write rolls the backend and the old key back', async () => {
    const ctx = withKey()
    const err = await ctx.service.set(kindChange({ api_key: 'has space' })).catch(e => e)
    expect(err.message).toEqual('key shape')
    expect(ctx.keyBox.value).toEqual(KEY)
    expect(ctx.server.state.backend.kind).toEqual('openai')
    expect(err.message).not.toContain('has space')
  })

  test('the backend api_key is validated like setApiKey and an unknown field is still refused', async () => {
    const ctx = withKey()
    for (const bad of ['', 5, 'k'.repeat(513), {}, true]) {
      await expect(ctx.service.set({ revision: 'r1', backend: { api_key: bad } }), JSON.stringify(bad)).rejects.toBeInstanceOf(BridgeFailure)
    }
    await expect(ctx.service.set({ revision: 'r1', backend: { api_key: NEW_KEY, extra: 1 } })).rejects.toBeInstanceOf(BridgeFailure)
    expect(ctx.server.calls).toEqual([])
    expect(ctx.keyBox.value).toEqual(KEY)
  })

  test('setApiKey and clearApiKey ignore kind and work on the current backend only', async () => {
    const set = withKey()
    const res = await set.service.setApiKey({ revision: 'r1', api_key: NEW_KEY, kind: 'uar' })
    expect(set.keyBox.value).toEqual(NEW_KEY)
    expect(set.server.calls.some(c => c[0] === 'put')).toBe(false)
    expect(set.server.state.backend.kind).toEqual('openai')
    expect(set.prompts).toEqual([])
    expect(JSON.stringify(res)).not.toContain(NEW_KEY)

    const clear = withKey()
    await clear.service.clearApiKey({ revision: 'r1', kind: 'uar' })
    expect(clear.keyBox.value).toBeUndefined()
    expect(clear.server.calls.some(c => c[0] === 'put')).toBe(false)
    expect(clear.server.state.backend.kind).toEqual('openai')
  })
})
