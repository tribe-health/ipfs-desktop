const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')
const { EventEmitter } = require('events')
const { pathToFileURL } = require('url')
const { test, expect } = require('@playwright/test')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const { SEARCH_KEYS, readSearchSettings, buildSearchConfig, egressAck, BULK_DEFAULTS } = require('../../src/daemon/mcp-sidecar-search')
const { createSearchService, SearchFailure } = require('../../src/agent/search/service')
const { buildSearchView } = require('../../src/agent/search/view')
const { createSearchWindow, captureAllowed } = require('../../src/agent/search/window')
const { createHostConfirm } = require('../../src/agent/host-confirm')
const { SEARCH_CHANNELS } = require('../../src/agent/consts')
const { buildSearchItems } = require('../../src/agent/search/tray-menu')
const en = require('../../assets/locales/en.json')

function tmp () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsearch-'))
}
function program (dir, name, mode = 0o755) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode })
  fs.chmodSync(p, mode)
  return p
}
function memoryStore (initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (k, fallback) => (data.has(k) ? data.get(k) : fallback),
    set: (k, v) => { data.set(k, v) },
    delete: (k) => { data.delete(k) }
  }
}
const t = (key, options = {}) => {
  const value = key.split('.').reduce((o, k) => o?.[k], en)
  const text = typeof value === 'string' ? value : key
  return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ''))
}

function storeFor (dir, extra = {}) {
  return memoryStore({
    [SEARCH_KEYS.ENABLED]: true,
    [SEARCH_KEYS.SURREAL_BINARY]: program(dir, 'surreal'),
    [SEARCH_KEYS.XBERG_BINARY]: program(dir, 'xberg'),
    [SEARCH_KEYS.EMBEDDER_URL]: 'http://127.0.0.1:11434/v1',
    [SEARCH_KEYS.EMBEDDER_MODEL]: 'bge-m3',
    [SEARCH_KEYS.EMBEDDER_DIMENSIONS]: 1024,
    ...extra
  })
}

test.describe('desktop search: config generation (1.2)', () => {
  test('on, with both programs and an embedder, writes the embedded store and extractor', () => {
    const dir = tmp()
    const searchDir = path.join(dir, 'search')
    const store = storeFor(dir)
    const result = buildSearchConfig({ settings: readSearchSettings(store), searchDir })
    expect(result.ok).toBe(true)
    const e = result.embeddings
    expect(e.mode).toEqual('embedded')
    expect(e.embedded).toEqual({ surreal_binary: store.get(SEARCH_KEYS.SURREAL_BINARY), data_dir: path.join(searchDir, 'surreal') })
    expect(e.embedder).toEqual({ base_url: 'http://127.0.0.1:11434/v1', model: 'bge-m3', dimensions: 1024 })
    expect(e.extractor).toMatchObject({ mode: 'embedded', ocr: false, transcribe: false })
    expect(e.extractor.embedded).toEqual({ xberg_binary: store.get(SEARCH_KEYS.XBERG_BINARY), cache_dir: path.join(searchDir, 'xberg-cache'), allow_model_downloads: false })
    expect(e.bulk).toEqual(BULK_DEFAULTS)
    expect(e.search_route).toEqual({ enabled: true })
    expect(e.describer).toBeUndefined()
    expect(e.policy.mime_allowlist).toContain('application/pdf')
    expect(e.policy.mime_allowlist).not.toContain('image/png')
    // The cache belongs to this user and no one else can write it.
    const st = fs.statSync(e.extractor.embedded.cache_dir)
    expect(st.uid).toEqual(process.getuid())
    expect(st.mode & 0o022).toEqual(0)
    expect(result.egressAck).toEqual(['local'])
  })

  test('a configured describer is written for images only, and images join the allowlist', () => {
    const dir = tmp()
    const store = storeFor(dir, { [SEARCH_KEYS.DESCRIBER_URL]: 'http://localhost:11434/v1', [SEARCH_KEYS.DESCRIBER_MODEL]: 'llava' })
    const result = buildSearchConfig({ settings: readSearchSettings(store), searchDir: path.join(dir, 'search') })
    expect(result.ok).toBe(true)
    expect(result.embeddings.describer).toEqual({ base_url: 'http://localhost:11434/v1', model: 'llava', kinds: ['image'] })
    expect(result.embeddings.policy.mime_allowlist).toContain('image/png')
  })

  test('off writes no embeddings block, and says why', () => {
    const dir = tmp()
    const store = storeFor(dir, { [SEARCH_KEYS.ENABLED]: false })
    expect(buildSearchConfig({ settings: readSearchSettings(store), searchDir: path.join(dir, 'search') })).toEqual({ ok: false, reason: 'off' })
    expect(buildSearchConfig({ settings: readSearchSettings(memoryStore()), searchDir: path.join(dir, 'search') })).toEqual({ ok: false, reason: 'off' })
  })

  test('a missing binary, a non-executable one, a relative path and incomplete settings each give a reason and no block', () => {
    const dir = tmp()
    const searchDir = path.join(dir, 'search')
    const run = (extra) => buildSearchConfig({ settings: readSearchSettings(storeFor(dir, extra)), searchDir })
    expect(run({ [SEARCH_KEYS.XBERG_BINARY]: path.join(dir, 'nope') })).toEqual({ ok: false, reason: 'binary_missing', detail: 'xberg' })
    expect(run({ [SEARCH_KEYS.SURREAL_BINARY]: dir })).toEqual({ ok: false, reason: 'binary_missing', detail: 'surreal' })
    expect(run({ [SEARCH_KEYS.SURREAL_BINARY]: program(dir, 'plain', 0o644) })).toEqual({ ok: false, reason: 'binary_not_executable', detail: 'surreal' })
    expect(run({ [SEARCH_KEYS.XBERG_BINARY]: 'xberg' })).toEqual({ ok: false, reason: 'binary_not_absolute', detail: 'xberg' })
    expect(run({ [SEARCH_KEYS.EMBEDDER_MODEL]: '' })).toEqual({ ok: false, reason: 'incomplete' })
    expect(run({ [SEARCH_KEYS.EMBEDDER_URL]: 'ftp://x' })).toEqual({ ok: false, reason: 'embedder_invalid' })
    expect(run({ [SEARCH_KEYS.EMBEDDER_URL]: 'https://user:pw@host.example/v1' })).toEqual({ ok: false, reason: 'embedder_invalid' })
  })

  test('no PATH lookup: a bare name on PATH is not found', () => {
    const dir = tmp()
    const result = buildSearchConfig({ settings: readSearchSettings(storeFor(dir, { [SEARCH_KEYS.SURREAL_BINARY]: 'sh' })), searchDir: path.join(dir, 'search') })
    expect(result).toEqual({ ok: false, reason: 'binary_not_absolute', detail: 'surreal' })
  })

  test('a cache directory that others can write is refused, not repaired', () => {
    const dir = tmp()
    const searchDir = path.join(dir, 'search')
    fs.mkdirSync(path.join(searchDir, 'xberg-cache'), { recursive: true })
    fs.chmodSync(path.join(searchDir, 'xberg-cache'), 0o777)
    const result = buildSearchConfig({ settings: readSearchSettings(storeFor(dir)), searchDir })
    expect(result).toEqual({ ok: false, reason: 'dir_unsafe', detail: path.join(searchDir, 'xberg-cache') })
    expect(fs.statSync(path.join(searchDir, 'xberg-cache')).mode & 0o777).toEqual(0o777)
  })

  test('the generator makes no network call', () => {
    const dir = tmp()
    const originals = { fetch: global.fetch, hreq: http.request, sreq: https.request }
    let calls = 0
    global.fetch = () => { calls++; throw new Error('network') }
    http.request = () => { calls++; throw new Error('network') }
    https.request = () => { calls++; throw new Error('network') }
    try {
      buildSearchConfig({ settings: readSearchSettings(storeFor(dir)), searchDir: path.join(dir, 'search') })
      buildSearchConfig({ settings: readSearchSettings(storeFor(dir, { [SEARCH_KEYS.EMBEDDER_URL]: 'https://embed.example/v1' })), searchDir: path.join(dir, 'search') })
    } finally {
      global.fetch = originals.fetch
      http.request = originals.hreq
      https.request = originals.sreq
    }
    expect(calls).toEqual(0)
  })
})

// The sidecar around it: the same supervisor the rest of the app uses, a fake spawn.
function fakeChild (pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stderr = new EventEmitter()
  child.stdout = new EventEmitter()
  child.kill = () => { setTimeout(() => child.emit('exit', 0, 'SIGTERM'), 1); return true }
  return child
}
function sidecarWith (store, extra = {}) {
  const spawns = []
  const files = new Map()
  const warns = []
  const { createMcpSidecar } = proxyquire('../../src/daemon/mcp-sidecar', {
    electron: { app: { getPath: () => '/userdata' } },
    '../common/logger': { info () {}, warn () {}, error () {} },
    '../custom-ipfs-binary': { getCustomBinary: () => null }
  })
  const sidecar = createMcpSidecar({
    binPath: '/bin/ipfs',
    port: 5050,
    spawnFn: (bin, args, options) => { const child = fakeChild(2000 + spawns.length); spawns.push({ bin, args, options, child }); return child },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) },
    store,
    fsImpl: { mkdirSync () {}, writeFileSync: (p, c) => files.set(p, c) },
    log: { info () {}, warn: (m) => warns.push(m), error () {} },
    settingsDir: '/userdata/mcp',
    ...extra
  })
  const config = () => JSON.parse(files.get('/userdata/mcp/sidecar-config.json'))
  return { sidecar, spawns, config, warns }
}

test.describe('desktop search: the sidecar config and the disabled state (1.2, 1.6)', () => {
  test('a fresh profile: Search is off, the config has no embeddings section, only ipfs is spawned', async () => {
    const { sidecar, spawns, config } = sidecarWith(memoryStore())
    await sidecar.start('/repo')
    expect(sidecar.getSearchState()).toEqual({ state: 'off' })
    expect(config().embeddings).toBeUndefined()
    // Nothing else is configured either: loopback only for content.
    expect(config().principals.find((p) => p.name === 'desktop-ui').egress_ack).toEqual(['local'])
    // Only the ipfs binary is started; no surreal and no xberg process exists. (With no
    // embeddings section, `ipfs mcp` does not mount /index/*, so /index/status answers 404 and
    // the Web UI hides its search entry: routes/index.json mount conditions.)
    expect(spawns.map((s) => s.bin)).toEqual(['/bin/ipfs'])
    expect(JSON.stringify(spawns[0].args)).not.toMatch(/surreal|xberg/)
    await sidecar.stop()
  })

  test('on and valid: the embeddings block is in the file the child is told to read', async () => {
    const dir = tmp()
    const { sidecar, spawns, config } = sidecarWith(storeFor(dir), { searchDir: path.join(dir, 'search') })
    await sidecar.start('/repo')
    expect(sidecar.getSearchState()).toEqual({ state: 'on' })
    expect(config().embeddings.mode).toEqual('embedded')
    expect(config().embeddings.extractor.embedded.xberg_binary).toContain('xberg')
    expect(spawns.map((s) => s.bin)).toEqual(['/bin/ipfs'])
    // The block carries no secret and no URL with credentials.
    expect(JSON.stringify(config().embeddings)).not.toMatch(/api_key|password|token/i)
    await sidecar.stop()
  })

  test('on but a program is missing: no block, the reason is kept and logged, the endpoint still starts', async () => {
    const dir = tmp()
    const { sidecar, spawns, config, warns } = sidecarWith(storeFor(dir, { [SEARCH_KEYS.XBERG_BINARY]: path.join(dir, 'gone') }), { searchDir: path.join(dir, 'search') })
    await sidecar.start('/repo')
    expect(config().embeddings).toBeUndefined()
    expect(sidecar.getSearchState()).toEqual({ state: 'unavailable', reason: 'binary_missing', detail: 'xberg' })
    expect(warns.some((m) => m.includes('binary_missing'))).toBe(true)
    expect(spawns.length).toEqual(1)
    await sidecar.stop()
  })

  test('on but not executable: same', async () => {
    const dir = tmp()
    const { sidecar, config } = sidecarWith(storeFor(dir, { [SEARCH_KEYS.SURREAL_BINARY]: program(dir, 'surreal-ro', 0o644) }), { searchDir: path.join(dir, 'search') })
    await sidecar.start('/repo')
    expect(config().embeddings).toBeUndefined()
    expect(sidecar.getSearchState().reason).toEqual('binary_not_executable')
    await sidecar.stop()
  })
})

test.describe('desktop search: egress (1.3)', () => {
  test('every host on this computer: only local', () => {
    const dir = tmp()
    const settings = readSearchSettings(storeFor(dir, { [SEARCH_KEYS.DESCRIBER_URL]: 'http://[::1]:8080/v1', [SEARCH_KEYS.DESCRIBER_MODEL]: 'v' }))
    expect(egressAck(settings)).toEqual(['local'])
  })

  test('a non-loopback host that was not confirmed keeps Search unavailable and is not acknowledged', () => {
    const dir = tmp()
    const settings = readSearchSettings(storeFor(dir, { [SEARCH_KEYS.EMBEDDER_URL]: 'https://embed.example/v1' }))
    expect(egressAck(settings)).toEqual(['local'])
    expect(buildSearchConfig({ settings, searchDir: path.join(dir, 'search') })).toEqual({ ok: false, reason: 'host_not_confirmed', detail: 'embed.example' })
  })

  test('a confirmed host is acknowledged, exactly that host, and nothing else is', () => {
    const dir = tmp()
    const settings = readSearchSettings(storeFor(dir, { [SEARCH_KEYS.EMBEDDER_URL]: 'https://embed.example:8443/v1', [SEARCH_KEYS.CONFIRMED_HOSTS]: ['embed.example:8443', 'other.example'] }))
    expect(egressAck(settings)).toEqual(['local', 'embed.example:8443'])
    const built = buildSearchConfig({ settings, searchDir: path.join(dir, 'search') })
    expect(built.ok).toBe(true)
    expect(built.egressAck).toEqual(['local', 'embed.example:8443'])
  })

  test('the sidecar writes the acknowledgement into desktop-ui only', async () => {
    const dir = tmp()
    const { sidecar, config } = sidecarWith(storeFor(dir, { [SEARCH_KEYS.EMBEDDER_URL]: 'https://embed.example/v1', [SEARCH_KEYS.CONFIRMED_HOSTS]: ['embed.example'] }), { searchDir: path.join(dir, 'search') })
    await sidecar.start('/repo')
    const acks = Object.fromEntries(config().principals.map((p) => [p.name, p.egress_ack]))
    expect(acks['desktop-ui']).toEqual(['local', 'embed.example'])
    expect(acks['desktop-admin']).toBeUndefined()
    await sidecar.stop()
  })

  test('turning Search off drops the entry', () => {
    const dir = tmp()
    const settings = readSearchSettings(storeFor(dir, { [SEARCH_KEYS.ENABLED]: false, [SEARCH_KEYS.EMBEDDER_URL]: 'https://embed.example/v1', [SEARCH_KEYS.CONFIRMED_HOSTS]: ['embed.example'] }))
    expect(egressAck(settings)).toEqual(['local'])
  })
})

function serviceWith (store, { touch = { available: true, accept: true }, sidecar, bulk = null, parent } = {}) {
  const prompts = []
  const requests = []
  const hostConfirm = createHostConfirm({
    authenticate: { available: () => touch.available, prompt: async (reason) => { prompts.push(reason); return touch.accept } },
    confirmNative: async (request) => { requests.push(request); prompts.push(`native:${request.host}`); return touch.accept },
    t
  })
  const restarts = []
  const side = sidecar ?? {
    restart: async () => { restarts.push('restart') },
    getState: () => 'running',
    getSearchState: () => ({ state: 'on' })
  }
  const service = createSearchService({ store, getSidecar: () => side, hostConfirm, getParentWindow: parent, bulkRunState: async () => bulk, t })
  return { service, prompts, requests, restarts, hostConfirm }
}

const input = (dir, over = {}) => ({
  enabled: true,
  surrealBinary: program(dir, 'surreal'),
  xbergBinary: program(dir, 'xberg'),
  embedder: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', dimensions: '1024' },
  describer: { baseUrl: '', model: '' },
  ...over
})

test.describe('desktop search: confirmation of a non-loopback host (1.3)', () => {
  test('loopback hosts are never asked about', async () => {
    const dir = tmp()
    const { service, prompts } = serviceWith(memoryStore())
    await service.apply(input(dir))
    expect(prompts).toEqual([])
  })

  test('a refused confirmation writes nothing and restarts nothing', async () => {
    const dir = tmp()
    const store = memoryStore()
    const { service, prompts, restarts } = serviceWith(store, { touch: { available: true, accept: false } })
    await expect(service.apply(input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 } }))).rejects.toBeInstanceOf(SearchFailure)
    expect(prompts).toEqual(['Send the text of your files to embed.example'])
    expect([...store.data.keys()]).toEqual([])
    expect(restarts).toEqual([])
  })

  test('an accepted one adds exactly that host, and a later change keeps it without asking again', async () => {
    const dir = tmp()
    const store = memoryStore()
    const { service, prompts, restarts } = serviceWith(store)
    await service.apply(input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 } }))
    expect(store.get(SEARCH_KEYS.CONFIRMED_HOSTS)).toEqual(['embed.example'])
    expect(prompts.length).toEqual(1)
    await service.apply(input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm2', dimensions: 8 } }))
    expect(prompts.length).toEqual(1)
    expect(restarts.length).toEqual(2)
    expect(egressAck(readSearchSettings(store))).toEqual(['local', 'embed.example'])
  })

  test('a describer on another host is asked about by name and says image files go there', async () => {
    const dir = tmp()
    const store = memoryStore()
    const { service, prompts } = serviceWith(store)
    await service.apply(input(dir, { describer: { baseUrl: 'https://vision.example/v1', model: 'v' } }))
    expect(prompts).toEqual(['Send your image files to vision.example'])
    expect(store.get(SEARCH_KEYS.CONFIRMED_HOSTS)).toEqual(['vision.example'])
  })

  test('without Touch ID the native dialog decides, through the same gate', async () => {
    const dir = tmp()
    const { service, prompts } = serviceWith(memoryStore(), { touch: { available: false, accept: true } })
    await service.apply(input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 } }))
    expect(prompts).toEqual(['native:embed.example'])
  })

  test('removing the host or turning Search off removes the entry', async () => {
    const dir = tmp()
    const store = memoryStore()
    const { service } = serviceWith(store)
    await service.apply(input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 } }))
    await service.apply(input(dir))
    expect(store.get(SEARCH_KEYS.CONFIRMED_HOSTS)).toEqual([])
    await service.apply(input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 } }))
    await service.apply(input(dir, { enabled: false }))
    expect(store.get(SEARCH_KEYS.CONFIRMED_HOSTS)).toEqual([])
    expect(egressAck(readSearchSettings(store))).toEqual(['local'])
  })

  test('a host declined once is not asked again until the gate is reset', async () => {
    const dir = tmp()
    const { service, prompts, hostConfirm } = serviceWith(memoryStore(), { touch: { available: true, accept: false } })
    const remote = input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 } })
    await expect(service.apply(remote)).rejects.toThrow('Not confirmed')
    await expect(service.apply(remote)).rejects.toThrow('declined this host')
    expect(prompts.length).toEqual(1)
    hostConfirm.forgetDeclined()
    await expect(service.apply(remote)).rejects.toThrow('Not confirmed')
    expect(prompts.length).toEqual(2)
  })
})

test.describe('desktop search: settings changes restart the sidecar (1.4)', () => {
  test('a change restarts once, and a run that was going comes back paused and the view says so', async () => {
    const dir = tmp()
    const { service, restarts } = serviceWith(memoryStore(), { bulk: 'running' })
    const result = await service.apply(input(dir))
    expect(restarts).toEqual(['restart'])
    expect(result.restarted).toBe(true)
    expect(result.bulkPaused).toBe(true)
    expect(result.view.bulkPaused).toBe(true)
  })

  test('with no run in progress nothing is reported paused', async () => {
    const dir = tmp()
    const { service } = serviceWith(memoryStore(), { bulk: 'completed' })
    expect((await service.apply(input(dir))).bulkPaused).toBe(false)
  })

  test('saving the same values again restarts nothing', async () => {
    const dir = tmp()
    const { service, restarts } = serviceWith(memoryStore())
    const same = input(dir)
    await service.apply(same)
    await service.apply(same)
    expect(restarts.length).toEqual(1)
  })

  test('each setting is a change: model, dimensions, a path, the describer', async () => {
    const dir = tmp()
    const { service, restarts } = serviceWith(memoryStore())
    await service.apply(input(dir))
    await service.apply(input(dir, { embedder: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'other', dimensions: '1024' } }))
    await service.apply(input(dir, { embedder: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'other', dimensions: '768' } }))
    await service.apply(input(dir, { embedder: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'other', dimensions: '768' }, describer: { baseUrl: 'http://127.0.0.1:11435/v1', model: 'v' } }))
    expect(restarts.length).toEqual(4)
  })

  test('the restart is the supervisor restart(), never the off switch', async () => {
    const dir = tmp()
    const calls = []
    const sidecar = { restart: async () => calls.push('restart'), setEnabled: async () => calls.push('setEnabled'), getState: () => 'running', getSearchState: () => ({ state: 'on' }) }
    const { service } = serviceWith(memoryStore(), { sidecar })
    await service.apply(input(dir))
    expect(calls).toEqual(['restart'])
  })

  test('requests with unknown fields, relative paths, bad URLs or missing pieces are refused before anything is stored', async () => {
    const dir = tmp()
    const store = memoryStore()
    const { service, restarts } = serviceWith(store)
    const bad = [
      { ...input(dir), surprise: 1 },
      input(dir, { surrealBinary: 'surreal' }),
      input(dir, { embedder: { baseUrl: 'ftp://x', model: 'm', dimensions: 8 } }),
      input(dir, { embedder: { baseUrl: 'https://u:p@x.example', model: 'm', dimensions: 8 } }),
      input(dir, { embedder: { baseUrl: 'http://x.example/v1', model: 'm', dimensions: 8 } }),
      input(dir, { embedder: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', dimensions: 0 } }),
      input(dir, { embedder: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', dimensions: 99999 } }),
      input(dir, { embedder: { baseUrl: '', model: '', dimensions: '' } }),
      input(dir, { describer: { baseUrl: 'http://127.0.0.1:1/v1', model: '' } }),
      { enabled: 'yes' },
      null
    ]
    for (const req of bad) await expect(service.apply(req), JSON.stringify(req)).rejects.toBeInstanceOf(SearchFailure)
    expect(store.data.size).toEqual(0)
    expect(restarts).toEqual([])
  })
})

test.describe('desktop search: the settings section (1.5)', () => {
  const view = (store, searchState = null, bulkPaused = false) => buildSearchView({ store, searchState, bulkPaused, t })

  test('off on a fresh profile, empty, with the cost note and no warning about a host', () => {
    const v = view(memoryStore())
    expect(v.enabled).toBe(false)
    expect(v.status).toEqual({ state: 'off', message: 'Search is off.' })
    expect(Object.values(v.fields).every((x) => x === '')).toBe(true)
    expect(v.warnings).toEqual([])
    expect(v.notes.map((n) => n.id)).toEqual(['resources', 'binaries', 'offline'])
    expect(v.notes[0].text).toMatch(/CPU and disk/)
  })

  test('a describer on another host warns that file bytes are sent to that host, and that video needs a hosted model', () => {
    const dir = tmp()
    const v = view(storeFor(dir, { [SEARCH_KEYS.DESCRIBER_URL]: 'https://vision.example/v1', [SEARCH_KEYS.DESCRIBER_MODEL]: 'v' }))
    expect(v.warnings.find((w) => w.id === 'describerRemote').text).toEqual('File bytes are sent to vision.example.')
    expect(v.warnings.find((w) => w.id === 'videoHosted').text).toMatch(/needs a hosted model/)
  })

  test('a local describer has no host warning but the video note stays', () => {
    const dir = tmp()
    const v = view(storeFor(dir, { [SEARCH_KEYS.DESCRIBER_URL]: 'http://127.0.0.1:11434/v1', [SEARCH_KEYS.DESCRIBER_MODEL]: 'v' }))
    expect(v.warnings.map((w) => w.id)).toEqual(['videoHosted'])
  })

  test('a remote embedder warns that file text is sent to it', () => {
    const dir = tmp()
    const v = view(storeFor(dir, { [SEARCH_KEYS.EMBEDDER_URL]: 'https://embed.example:8443/v1' }))
    expect(v.warnings).toEqual([{ id: 'embedderRemote', text: 'The text of your files is sent to embed.example:8443.' }])
  })

  test('the status follows what the sidecar did, with the reason in words', () => {
    const dir = tmp()
    const store = storeFor(dir)
    expect(view(store, { state: 'on' }).status.state).toEqual('on')
    expect(view(store, null).status.message).toMatch(/will start with the agent endpoint/)
    const u = view(store, { state: 'unavailable', reason: 'binary_missing', detail: 'xberg' }).status
    expect(u.state).toEqual('unavailable')
    expect(u.message).toEqual('The xberg program was not found at the path you gave.')
    expect(view(store, { state: 'unavailable', reason: 'host_not_confirmed', detail: 'embed.example' }).status.message).toMatch(/embed\.example has not been confirmed/)
  })

  test('every string the window asks for, every reason and every refusal exists in the locale', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/agent/search/window.js'), 'utf8')
    const ids = /const STRING_IDS = \[([\s\S]*?)\]/.exec(src)[1].match(/'([A-Za-z]+)'/g).map((s) => s.slice(1, -1))
    for (const id of ids) expect(en.agentSearch[id], id).toBeTruthy()
    for (const reason of ['off', 'incomplete', 'binary_not_absolute', 'binary_missing', 'binary_not_executable', 'binary_unsafe', 'embedder_invalid', 'describer_invalid', 'host_not_confirmed', 'dir_unsafe', 'dir_failed']) {
      expect(en.agentSearch.reason[reason], reason).toBeTruthy()
    }
    for (const id of ['dialog', 'offHint']) expect(en.agentSearch[id], id).toBeTruthy()
    for (const k of ['title', 'messageText', 'messageImages', 'detailText', 'detailImages']) expect(en.agentSearch.dialog[k], k).toBeTruthy()
    for (const id of ['errUnknownField', 'errInvalid', 'errPath', 'errUrl', 'errModel', 'errDimensions', 'errDescriber', 'errIncomplete', 'errNotConfirmed', 'touchReasonEmbedder', 'touchReasonDescriber']) expect(en.agentSearch[id], id).toBeTruthy()
    for (const k of ['statusOff', 'statusOn', 'statusPending', 'statusUnavailable', 'open']) expect(en.agentSearchTray[k]).toBeTruthy()
  })

  test('the preload carries the same channel names as consts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/agent/search/ui/search-preload.js'), 'utf8')
    for (const [name, value] of Object.entries(SEARCH_CHANNELS)) expect(src).toContain(`${name}: '${value}'`)
  })

  test('the page holds no user-facing text of its own', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/agent/search/ui/search.html'), 'utf8')
    const body = html.slice(html.indexOf('<body>'))
    const text = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim()
    expect(text).toEqual('')
  })
})

test.describe('desktop search: the window answers only its own page (1.5)', () => {
  function fakeElectron () {
    const created = []
    const handlers = new Map()
    class FakeWindow {
      constructor (options) {
        this.options = options
        this.webContents = new EventEmitter()
        this.webContents.mainFrame = { url: '' }
        this.webContents.setWindowOpenHandler = () => {}
        this.webContents.send = () => {}
        this.destroyed = false
        this.handlers = {}
        created.push(this)
      }

      setMenuBarVisibility () {}
      setContentProtection () {}
      on (name, fn) { this.handlers[name] = fn }
      loadFile (file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
      isDestroyed () { return this.destroyed }
      show () {}
      focus () {}
      destroy () { this.destroyed = true }
      close () { this.destroyed = true }
    }
    const electron = {
      BrowserWindow: FakeWindow,
      ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => handlers.set(c, fn), removeHandler () {}, removeListener () {} },
      session: { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {}, webRequest: { onBeforeRequest () {} } }) },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/opt/bin/xberg'] }) }
    }
    return { electron, created, handlers }
  }

  test('opens a sandboxed, isolated window and ignores messages from anything else', async () => {
    const { electron, created, handlers } = fakeElectron()
    const applied = []
    const service = { get: () => ({ view: true }), apply: async (x) => { applied.push(x); return { view: { ok: 1 }, restarted: true, bulkPaused: false } } }
    const w = createSearchWindow({ electron, service, i18n: { t } })
    w.open()
    const win = created[0]
    expect(win.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false, webviewTag: false })
    const own = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    const other = { sender: new EventEmitter(), senderFrame: { url: win.webContents.mainFrame.url } }
    const wrongFrame = { sender: win.webContents, senderFrame: { url: win.webContents.mainFrame.url } }

    expect(await handlers.get(SEARCH_CHANNELS.GET)(own)).toEqual({ view: true })
    expect(await handlers.get(SEARCH_CHANNELS.GET)(other)).toBeNull()
    expect(await handlers.get(SEARCH_CHANNELS.GET)(wrongFrame)).toBeNull()
    expect((await handlers.get(SEARCH_CHANNELS.APPLY)(other, { enabled: false })).ok).toBe(false)
    expect(applied).toEqual([])
    expect((await handlers.get(SEARCH_CHANNELS.APPLY)(own, { enabled: false })).ok).toBe(true)
    expect(applied.length).toEqual(1)
    expect(await handlers.get(SEARCH_CHANNELS.PICK)(own, 'xberg')).toEqual('/opt/bin/xberg')
    expect(await handlers.get(SEARCH_CHANNELS.PICK)(own, '../../etc')).toBeNull()
    expect(await handlers.get(SEARCH_CHANNELS.PICK)(other, 'xberg')).toBeNull()
  })

  test('a refused change reaches the page as a message, not an exception', async () => {
    const { electron, created, handlers } = fakeElectron()
    const service = { get: () => ({}), apply: async () => { throw new SearchFailure('Not confirmed for h. Nothing was changed.') } }
    createSearchWindow({ electron, service, i18n: { t } }).open()
    const win = created[0]
    const own = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    expect(await handlers.get(SEARCH_CHANNELS.APPLY)(own, {})).toEqual({ ok: false, message: 'Not confirmed for h. Nothing was changed.' })
  })
})

test.describe('desktop search: the tray entries', () => {
  test('off by default: a status line and the way to the window', () => {
    let opened = 0
    const items = buildSearchItems({ t: (k) => t(k).replace(/^agentSearchTray\./, ''), store: memoryStore(), getSidecar: () => null, getSearchWindow: () => ({ open: () => { opened++ } }) })
    expect(items.map((i) => i.id)).toEqual(['agentSearch.status', 'agentSearch.open'])
    expect(items[0]).toMatchObject({ label: 'Search: off', enabled: false })
    items[1].click()
    expect(opened).toEqual(1)
  })

  test('L6: on but not applied yet reads as waiting, the window\'s word; a reason from the endpoint needs attention', () => {
    const pending = buildSearchItems({ t, store: memoryStore({ [SEARCH_KEYS.ENABLED]: true }), getSidecar: () => ({ getSearchState: () => ({ state: 'unavailable' }) }), getSearchWindow: () => null })
    expect(pending[0].label).toEqual('Search: waiting for the agent endpoint')
    const none = buildSearchItems({ t, store: memoryStore({ [SEARCH_KEYS.ENABLED]: true }), getSidecar: () => null, getSearchWindow: () => null })
    expect(none[0].label).toEqual('Search: waiting for the agent endpoint')
    const items = buildSearchItems({ t, store: memoryStore({ [SEARCH_KEYS.ENABLED]: true }), getSidecar: () => ({ getSearchState: () => ({ state: 'unavailable', reason: 'binary_missing', detail: 'xberg' }) }), getSearchWindow: () => null })
    expect(items[0].label).toEqual('Search: needs attention')
    const ok = buildSearchItems({ t, store: memoryStore({ [SEARCH_KEYS.ENABLED]: true }), getSidecar: () => ({ getSearchState: () => ({ state: 'on' }) }), getSearchWindow: () => null })
    expect(ok[0].label).toEqual('Search: on')
  })
})

function lightElectron () {
  const created = []
  const handlers = new Map()
  class FakeWindow {
    constructor (options) {
      this.options = options
      this.protection = null
      this.webContents = new EventEmitter()
      this.webContents.mainFrame = { url: '' }
      this.webContents.setWindowOpenHandler = () => {}
      this.webContents.send = () => {}
      this.destroyed = false
      this.handlers = {}
      created.push(this)
    }

    setMenuBarVisibility () {}
    setContentProtection (on) { this.protection = on }
    on (name, fn) { this.handlers[name] = fn }
    loadFile (file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed () { return this.destroyed }
    show () {}
    focus () {}
    destroy () { this.destroyed = true }
    close () { this.destroyed = true; this.handlers.closed?.() }
  }
  const electron = {
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => handlers.set(c, fn), removeHandler () {}, removeListener () {} },
    session: { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {}, webRequest: { onBeforeRequest () {} } }) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  }
  return { electron, created, handlers }
}

test.describe('round 6 correction: the Search window (H2, M4, M6, L7, I1)', () => {
  test('M4: content protection is set unless an unpackaged build asks to allow capture', () => {
    expect(captureAllowed({ env: { IPFS_DESKTOP_DEV_ALLOW_CAPTURE: '1' }, isPackaged: true })).toBe(false)
    expect(captureAllowed({ env: { IPFS_DESKTOP_DEV_ALLOW_CAPTURE: '1' }, isPackaged: false })).toBe(true)
    expect(captureAllowed({ env: {}, isPackaged: false })).toBe(false)
    expect(captureAllowed({ env: { IPFS_DESKTOP_DEV_ALLOW_CAPTURE: 'true' }, isPackaged: false })).toBe(false)

    const service = { get: () => ({}), apply: async () => ({}), preview: () => [] }
    const protectedWin = lightElectron()
    createSearchWindow({ electron: protectedWin.electron, service, i18n: { t } }).open()
    expect(protectedWin.created[0].protection).toBe(true)

    const warns = []
    const open = lightElectron()
    createSearchWindow({ electron: open.electron, service, i18n: { t }, allowCapture: true, logger: { info () {}, warn: (m) => warns.push(m) } }).open()
    expect(open.created[0].protection).toBeNull()
    expect(warns.join(' ')).toContain('development build')
  })

  test('I1: closing the window runs onClosed, which forgets the hosts declined in its life', async () => {
    const dir = tmp()
    const { service, hostConfirm, prompts } = serviceWith(memoryStore(), { touch: { available: true, accept: false } })
    const remote = input(dir, { embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 } })
    await expect(service.apply(remote)).rejects.toThrow('Not confirmed')
    await expect(service.apply(remote)).rejects.toThrow('declined this host')

    const { electron, created } = lightElectron()
    const w = createSearchWindow({ electron, service, i18n: { t }, onClosed: () => hostConfirm.forgetDeclined('search') })
    w.open()
    created[0].close()
    await expect(service.apply(remote)).rejects.toThrow('Not confirmed')
    expect(prompts.length).toEqual(2)
  })

  test('I1: a Search close does not forget a host declined for the agent backend, and the reverse', async () => {
    const hostConfirm = createHostConfirm({ authenticate: { available: () => true, prompt: async () => false }, t })
    expect(await hostConfirm.confirm('llm.example', 'r', { purpose: 'backend' })).toBe(false)
    expect(await hostConfirm.confirm('embed.example', 'r', { purpose: 'searchText' })).toBe(false)
    hostConfirm.forgetDeclined('search')
    await expect(hostConfirm.confirm('llm.example', 'r', { purpose: 'backend' })).rejects.toThrow('declined this host')
    expect(await hostConfirm.confirm('embed.example', 'r', { purpose: 'searchText' })).toBe(false)
    hostConfirm.forgetDeclined('backend')
    expect(await hostConfirm.confirm('llm.example', 'r', { purpose: 'backend' })).toBe(false)
  })

  test('M6: the window answers a preview of the typed values, only for its own page, and stores nothing', async () => {
    const dir = tmp()
    const store = memoryStore()
    const { service } = serviceWith(store)
    const { electron, created, handlers } = lightElectron()
    createSearchWindow({ electron, service, i18n: { t } }).open()
    const win = created[0]
    const own = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    const other = { sender: new EventEmitter(), senderFrame: { url: win.webContents.mainFrame.url } }
    const typed = { embedder: { baseUrl: 'https://embed.example/v1' }, describer: { baseUrl: 'http://127.0.0.1:11434/v1' }, enabled: true, surrealBinary: dir }
    const warnings = await handlers.get(SEARCH_CHANNELS.PREVIEW)(own, typed)
    expect(warnings.map((w) => w.id)).toEqual(['embedderRemote', 'videoHosted'])
    expect(warnings[0].text).toContain('embed.example')
    expect(await handlers.get(SEARCH_CHANNELS.PREVIEW)(other, typed)).toEqual([])
    expect([...store.data.keys()]).toEqual([])
  })

  test('M6: a loopback address, a half-typed one and nonsense have no host warning', () => {
    const { service } = serviceWith(memoryStore())
    expect(service.preview({ embedder: { baseUrl: 'http://127.0.0.1:11434/v1' } })).toEqual([])
    expect(service.preview({ embedder: { baseUrl: 'https://emb' } }).map((w) => w.id)).toEqual(['embedderRemote'])
    // A describer address that is not usable has no host warning; the video note stays, as in the saved view.
    expect(service.preview({ embedder: { baseUrl: 'ftp://x' }, describer: { baseUrl: 'http://evil.example' } }).map((w) => w.id)).toEqual(['videoHosted'])
    expect(service.preview('nonsense')).toEqual([])
    expect(service.preview(null)).toEqual([])
    expect(service.preview({ describer: { baseUrl: 'https://vision.example/v1' } }).map((w) => w.id)).toEqual(['describerRemote', 'videoHosted'])
  })

  test('L7: a refusal names its field, and only a known field', async () => {
    const dir = tmp()
    const { service } = serviceWith(memoryStore())
    const cases = [
      [{ surrealBinary: 'relative/path' }, 'surrealBinary'],
      [{ xbergBinary: 'relative/path' }, 'xbergBinary'],
      [{ embedder: { baseUrl: 'ftp://x', model: 'm', dimensions: 8 } }, 'embedderUrl'],
      [{ embedder: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', dimensions: 0 } }, 'embedderDimensions'],
      [{ embedder: { baseUrl: 'http://127.0.0.1:1/v1', model: '', dimensions: 8 } }, 'embedderModel'],
      [{ embedder: { baseUrl: '', model: 'm', dimensions: 8 } }, 'embedderUrl'],
      [{ describer: { baseUrl: 'https://v.example/v1', model: '' } }, 'describerModel'],
      [{ describer: { baseUrl: '', model: 'v' } }, 'describerUrl']
    ]
    for (const [over, field] of cases) {
      const err = await service.apply(input(dir, over)).catch((e) => e)
      expect(err, field).toBeInstanceOf(SearchFailure)
      expect(err.field, field).toEqual(field)
    }
    const { electron, created, handlers } = lightElectron()
    const throwing = { get: () => ({}), apply: async () => { throw Object.assign(new SearchFailure('x', 'surrealBinary'), { field: '__proto__x' }) }, preview: () => [] }
    createSearchWindow({ electron, service: throwing, i18n: { t } }).open()
    const own = { sender: created[0].webContents, senderFrame: created[0].webContents.mainFrame }
    expect(await handlers.get(SEARCH_CHANNELS.APPLY)(own, {})).toEqual({ ok: false, message: 'x' })
  })

  test('L7: the page ties the refusal to the field and moves focus there', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../src/agent/search/ui/search.js'), 'utf8')
    expect(js).toContain("setAttribute('aria-invalid', 'true')")
    expect(js).toContain('input.focus()')
    expect(js).toContain('result.field')
    const html = fs.readFileSync(path.join(__dirname, '../../src/agent/search/ui/search.html'), 'utf8')
    for (const id of ['surreal', 'xberg', 'embedder-model', 'embedder-dims', 'describer-model']) {
      expect(new RegExp(`id="${id}"[^>]*aria-describedby="notice"`).test(html), id).toBe(true)
    }
  })

  test('H2: no opacity dimming, a D7 edge on every text input and on the checkbox, in the window stylesheet', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/agent/search/ui/search.css'), 'utf8')
    expect(css).not.toMatch(/opacity/)
    expect(css).toMatch(/\.field input\[type='text'\]\s*\{\s*box-shadow:\s*inset 0 0 0 1px var\(--text-muted\)/)
    expect(css).toMatch(/\.check input\[type='checkbox'\][^}]*box-shadow:\s*inset 0 0 0 1px var\(--text-muted\)/)
    // Sizes come from the named steps, not stray literals.
    expect(css.replace(/:root\s*\{[^}]*\}/, '')).not.toMatch(/font-size:\s*\d+px/)
    const html = fs.readFileSync(path.join(__dirname, '../../src/agent/search/ui/search.html'), 'utf8')
    expect(html).toContain('id="off-hint"')
    expect(en.agentSearch.offHint).toMatch(/off/i)
  })

  test('H2: every text input is styled by the D7 selector (type text)', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/agent/search/ui/search.html'), 'utf8')
    const inputs = [...html.matchAll(/<input id="([a-z-]+)" type="(\w+)"/g)]
    expect(inputs.length).toEqual(8)
    for (const [, id, type] of inputs) expect(['text', 'checkbox'], id).toContain(type)
  })
})

test.describe('round 6 correction: confirmation for Search content (L2)', () => {
  test('the text embedder is asked as searchText and the describer as searchImages, parented to the Search window', async () => {
    const dir = tmp()
    const searchWin = { isDestroyed: () => false, isVisible: () => true }
    const { service, requests } = serviceWith(memoryStore(), { touch: { available: false, accept: true }, parent: () => searchWin })
    await service.apply(input(dir, {
      embedder: { baseUrl: 'https://embed.example/v1', model: 'm', dimensions: 8 },
      describer: { baseUrl: 'https://vision.example/v1', model: 'v' }
    }))
    expect(requests.map((r) => [r.host, r.purpose, r.keyFollows])).toEqual([['embed.example', 'searchText', false], ['vision.example', 'searchImages', false]])
    for (const r of requests) expect(r.getParent()).toBe(searchWin)
  })

  test('the native dialog names file text or image files, never the model key, and is parented to the requester', async () => {
    const { createNativeHostConfirm } = require('../../src/agent/confirm/native-dialog')
    const shown = []
    const dialog = { showMessageBox: async (...args) => { shown.push(args); return { response: 0 } } }
    const webui = { isDestroyed: () => false, isVisible: () => true }
    const searchWin = { isDestroyed: () => false, isVisible: () => true }
    const confirm = createNativeHostConfirm({ dialog, getWindow: () => webui, t })
    await confirm({ host: 'embed.example', purpose: 'searchText', keyFollows: false, getParent: () => searchWin })
    await confirm({ host: 'vision.example', purpose: 'searchImages', getParent: () => searchWin })
    expect(shown[0][0]).toBe(searchWin)
    expect(shown[0][1].message).toEqual('Send the text of your files to embed.example?')
    expect(shown[0][1].detail).toContain('sends their text to embed.example')
    expect(shown[0][1].title).toEqual(en.agentSearch.dialog.title)
    expect(shown[1][1].message).toEqual('Send your image files to vision.example?')
    expect(shown[1][1].detail).toContain('image files')
    for (const [, o] of shown) {
      expect(JSON.stringify(o)).not.toMatch(/model key|stored key/i)
      expect(o.defaultId).toEqual(1)
      expect(o.cancelId).toEqual(1)
    }
  })
})

test.describe('round 6 correction: programs must be private to their owner (security L4)', () => {
  const settingsFor = (dir) => readSearchSettings(storeFor(dir))

  test('a program that is group- or other-writable is refused with a reason naming it', () => {
    for (const mode of [0o775, 0o757, 0o777]) {
      const dir = tmp()
      const settings = settingsFor(dir)
      fs.chmodSync(settings.xbergBinary, mode)
      const result = buildSearchConfig({ settings, searchDir: path.join(dir, 'search') })
      expect(result, mode.toString(8)).toMatchObject({ ok: false, reason: 'binary_unsafe', detail: 'xberg' })
    }
  })

  test('a program in a folder that others can write is refused, and a private one is accepted', () => {
    const dir = tmp()
    const settings = settingsFor(dir)
    fs.chmodSync(dir, 0o775)
    expect(buildSearchConfig({ settings, searchDir: path.join(dir, 'search') })).toMatchObject({ ok: false, reason: 'binary_unsafe' })
    fs.chmodSync(dir, 0o755)
    expect(buildSearchConfig({ settings, searchDir: path.join(dir, 'search') }).ok).toBe(true)
  })

  test('a program owned by someone else is refused; root is allowed', () => {
    const dir = tmp()
    const settings = settingsFor(dir)
    const me = process.getuid()
    expect(buildSearchConfig({ settings, searchDir: path.join(dir, 'search'), uid: me + 1 })).toMatchObject({ ok: false, reason: 'binary_unsafe' })
    const real = fs.statSync
    const asRoot = { ...fs, statSync: (p, ...rest) => { const st = real.call(fs, p, ...rest); return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), uid: 0, mode: st.mode } } }
    expect(buildSearchConfig({ settings, searchDir: path.join(dir, 'search'), uid: me + 1, fs: { ...asRoot, mkdirSync: fs.mkdirSync, accessSync: fs.accessSync } }).reason).not.toEqual('binary_unsafe')
  })

  test('Windows has no mode bits to read: the check is skipped there', () => {
    const dir = tmp()
    const settings = settingsFor(dir)
    fs.chmodSync(settings.xbergBinary, 0o777)
    expect(buildSearchConfig({ settings, searchDir: path.join(dir, 'search'), platform: 'win32' }).ok).toBe(true)
  })

  test('the reason reaches the window in words', () => {
    const dir = tmp()
    const settings = settingsFor(dir)
    fs.chmodSync(settings.surrealBinary, 0o777)
    const result = buildSearchConfig({ settings, searchDir: path.join(dir, 'search') })
    expect(result.reason).toEqual('binary_unsafe')
    expect(t(`agentSearch.reason.${result.reason}`, { detail: result.detail })).toContain('surreal program')
  })
})

test.describe('round 6 correction: the generated embeddings block against the config schema', () => {
  test('validates with the contract schema when it and a validator are available', () => {
    const schemaPath = process.env.IPFS_MCP_CONFIG_SCHEMA || path.join(__dirname, '../../../kubo/mcp/contract/config/ipfs-mcp-config.schema.json')
    let Ajv
    try { Ajv = require('ajv') } catch (_) { return }
    if (!fs.existsSync(schemaPath)) return
    // ajv 6 (the copy in node_modules) validates draft-07; the contract's 2020-12 marker is
    // the only thing it cannot read, and the keywords the schema uses are all draft-07 ones.
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
    delete schema.$schema
    const validate = new Ajv({ allErrors: true }).compile(schema)
    for (const withDescriber of [false, true]) {
      const dir = tmp()
      const store = storeFor(dir, withDescriber
        ? { [SEARCH_KEYS.DESCRIBER_URL]: 'https://vision.example/v1', [SEARCH_KEYS.DESCRIBER_MODEL]: 'v', [SEARCH_KEYS.CONFIRMED_HOSTS]: ['vision.example'] }
        : {})
      const result = buildSearchConfig({ settings: readSearchSettings(store), searchDir: path.join(dir, 'search') })
      expect(result.ok).toBe(true)
      expect(validate({ embeddings: result.embeddings }), JSON.stringify(validate.errors)).toBe(true)
      expect(validate({ embeddings: { ...result.embeddings, unknown_key: 1 } })).toBe(false)
    }
  })
})
