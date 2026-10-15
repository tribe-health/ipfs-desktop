const { test, expect } = require('@playwright/test')
const { readFileSync } = require('fs')
const { join } = require('path')
const { KEYS, SETTINGS_CHANNELS, ARG_AGENT_SETTINGS } = require('../../src/agent/consts')
const { registerAgentSettingsBridge } = require('../../src/agent/settings-bridge')
const { ContractError, BridgeFailure } = require('../../src/agent/settings-service')
const { buildCsp, toLoopbackOrigin, webPreferences } = require('../../src/webui/security')

const root = join(__dirname, '../..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const METHODS = {
  [SETTINGS_CHANNELS.GET]: 'get',
  [SETTINGS_CHANNELS.SET]: 'set',
  [SETTINGS_CHANNELS.TEST_CONNECTION]: 'testConnection',
  [SETTINGS_CHANNELS.SET_API_KEY]: 'setApiKey',
  [SETTINGS_CHANNELS.CLEAR_API_KEY]: 'clearApiKey',
  [SETTINGS_CHANNELS.STATUS]: 'status'
}

function fakeIpc () {
  const handlers = new Map()
  return {
    handlers,
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error('handler already registered for ' + channel)
      handlers.set(channel, fn)
    },
    removeHandler: (channel) => { handlers.delete(channel) }
  }
}

function fakeWebContents (url = 'webui://localhost/#/settings/agent') {
  const sent = []
  const mainFrame = { url, send: (channel, payload) => sent.push([channel, payload]) }
  return { contents: { mainFrame, isDestroyed: () => false }, mainFrame, sent }
}

function fakeService (over = {}) {
  const calls = []
  const service = { observeRevision: (r) => calls.push(['observeRevision', r]) }
  for (const method of Object.values(METHODS)) {
    service[method] = async (payload) => { calls.push([method, payload]); return { method } }
  }
  return { service: Object.assign(service, over), calls }
}

function setup ({ enabled = true, service = fakeService().service, url } = {}) {
  const ipc = fakeIpc()
  const web = fakeWebContents(url)
  const bridge = registerAgentSettingsBridge({
    ipcMain: ipc,
    getWebuiContents: () => web.contents,
    enabled,
    service,
    logger: { warn () {} }
  })
  const trusted = { sender: web.contents, senderFrame: web.mainFrame }
  return { ipc, web, bridge, trusted }
}

test.describe('agent settings bridge: off switch', () => {
  test('with the switch off no channel exists and nothing is pushed', () => {
    const { ipc, bridge, web } = setup({ enabled: false })
    expect(bridge.enabled).toBe(false)
    expect(ipc.handlers.size).toEqual(0)
    expect(bridge.pushChange('r2')).toBe(false)
    expect(web.sent).toEqual([])
  })

  test('with the switch on the six channels exist, and dispose removes them', () => {
    const { ipc, bridge } = setup()
    expect([...ipc.handlers.keys()].sort()).toEqual(Object.keys(METHODS).sort())
    bridge.dispose()
    expect(ipc.handlers.size).toEqual(0)
  })

  test('the store key defaults to on and reads false as off, like the sidecar switch', () => {
    expect(KEYS.SETTINGS_ENABLED).toEqual('agentSettings.enabled')
    const index = read('src/webui/index.js')
    expect(index).toContain('store.get(AGENT_KEYS.SETTINGS_ENABLED, true) !== false')
    // Off: no flag on the window, so the preload exposes nothing; no pump; handlers not registered.
    expect(index).toMatch(/\.\.\.\(agentSettings \? \[ARG_AGENT_SETTINGS\] : \[\]\)/)
    expect(index).toMatch(/if \(agentSettingsOn\) \{\s+if \(snapshot\.state === 'running'\) eventPump\.start\(\)/)
  })
})

test.describe('agent settings bridge: only the trusted main frame is answered (1.1)', () => {
  test('every channel reuses isTrusted: a sub-frame, another window, another origin and a missing frame get null and reach no setter', async () => {
    const fake = fakeService()
    const { ipc, web, trusted } = setup({ service: fake.service })
    const otherFrame = { url: web.mainFrame.url }
    const untrusted = [
      { sender: web.contents, senderFrame: otherFrame }, // same-origin sub-frame
      { sender: {}, senderFrame: web.mainFrame }, // another window's webContents
      { sender: web.contents, senderFrame: undefined },
      { sender: web.contents, senderFrame: { ...web.mainFrame, url: 'https://evil.example/' } } // wrong frame object and origin
    ]
    for (const channel of Object.keys(METHODS)) {
      const handler = ipc.handlers.get(channel)
      for (const event of untrusted) {
        expect(await handler(event, { revision: 'r1', system_prompt: 'x' }), channel).toBeNull()
      }
      // The window navigated away from the Web UI origin: refused even from its main frame.
      web.mainFrame.url = 'https://evil.example/'
      expect(await handler(trusted, {}), channel).toBeNull()
      web.mainFrame.url = 'webui://localhost/#/settings/agent'
    }
    expect(fake.calls.filter(c => c[0] !== 'observeRevision')).toEqual([])
  })

  test('the trusted main frame is answered through the service with an ok envelope', async () => {
    const fake = fakeService()
    const { ipc, trusted } = setup({ service: fake.service })
    for (const [channel, method] of Object.entries(METHODS)) {
      const res = await ipc.handlers.get(channel)(trusted, { probe: channel })
      expect(res).toEqual({ ok: true, value: { method } })
    }
    expect(fake.calls.map(c => c[0])).toEqual(Object.values(METHODS))
    expect(fake.calls[0][1]).toEqual({ probe: SETTINGS_CHANNELS.GET })
  })

  test('failures travel as a contract error shape, a plain message, or a generic text; never a stack or a key', async () => {
    const shape = { error: { code: 'revision_conflict', message: 'stale', details: { current_revision: 'r9' } } }
    const secretish = 'sk-live-secret-value'
    const { ipc, trusted } = setup({
      service: fakeService({
        get: async () => { throw new ContractError(shape) },
        set: async () => { throw new BridgeFailure('Touch ID was not completed. Nothing was changed.') },
        status: async () => { throw new TypeError(`internal detail with ${secretish}`) }
      }).service
    })
    expect(await ipc.handlers.get(SETTINGS_CHANNELS.GET)(trusted)).toEqual({ ok: false, error: shape })
    expect(await ipc.handlers.get(SETTINGS_CHANNELS.SET)(trusted, {})).toEqual({ ok: false, message: 'Touch ID was not completed. Nothing was changed.' })
    const unexpected = await ipc.handlers.get(SETTINGS_CHANNELS.STATUS)(trusted)
    expect(unexpected).toEqual({ ok: false, message: 'The change could not be applied.' })
    expect(JSON.stringify(unexpected)).not.toContain(secretish)
  })

  test('change events go to the trusted main frame only, carrying the revision and nothing else', () => {
    const fake = fakeService()
    const { bridge, web } = setup({ service: fake.service })
    expect(bridge.pushChange('r5')).toBe(true)
    expect(web.sent).toEqual([[SETTINGS_CHANNELS.ON_CHANGE, { type: 'settings_changed', revision: 'r5' }]])
    expect(fake.calls).toContainEqual(['observeRevision', 'r5'])

    web.mainFrame.url = 'https://evil.example/page'
    expect(bridge.pushChange('r6')).toBe(false)
    expect(web.sent.length).toEqual(1)
  })
})

test.describe('hardening: the renderer cannot widen the CSP (1.5)', () => {
  const directive = (csp, name) => csp.split('; ').find(d => d.startsWith(name + ' '))

  test('the sidecar origin is loopback http with a port or it is not in the policy', () => {
    for (const bad of [
      'https://127.0.0.1:5050', 'http://evil.example:5050', 'http://127.0.0.1', 'http://*.example:5050',
      'http://user:pw@127.0.0.1:5050', 'ws://127.0.0.1:5050', 'http://127.0.0.1.evil.example:5050', '', null, undefined, 42
    ]) {
      expect(toLoopbackOrigin(bad), String(bad)).toBeNull()
      expect(directive(buildCsp({ sidecarOrigin: bad }), 'connect-src'), String(bad)).toEqual("connect-src 'self'")
    }
    expect(directive(buildCsp({ sidecarOrigin: 'http://127.0.0.1:5050' }), 'connect-src')).toEqual("connect-src 'self' http://127.0.0.1:5050")
    expect(directive(buildCsp({ sidecarOrigin: 'http://localhost:41999/mcp' }), 'connect-src')).toEqual("connect-src 'self' http://localhost:41999")
  })

  test('nothing but connect-src changes with the sidecar origin; script-src and the rest stay fixed', () => {
    const withSidecar = buildCsp({ sidecarOrigin: 'http://127.0.0.1:5050' }).split('; ').filter(d => !d.startsWith('connect-src'))
    const without = buildCsp({}).split('; ').filter(d => !d.startsWith('connect-src'))
    expect(withSidecar).toEqual(without)
  })

  test('no settings request field is an input to the policy: the policy sources are read in main from the supervisor alone', () => {
    const index = read('src/webui/index.js')
    // The CSP callback names exactly these sources.
    const callback = index.slice(index.indexOf('installCsp('), index.indexOf('}))', index.indexOf('installCsp(')))
    expect(callback).toContain('originFromMultiaddr(apiAddress)')
    expect(callback).toContain('sidecarOrigin: sidecarBaseUrl()')
    expect(callback).not.toMatch(/payload|request|event|invoke/)
    // sidecarBaseUrl reads the supervisor's state and port, nothing from the renderer.
    const fn = index.slice(index.indexOf('const sidecarBaseUrl'), index.indexOf('installCsp('))
    expect(fn).toContain('loopbackBaseUrl(getMcpSidecar(), agentSettingsOn)')
    const registry = read('src/agent/sidecar-registry.js')
    expect(registry).toContain("candidate.getState() === 'running'")
    expect(registry).toContain('getPort()')
  })

  test('the window keeps sandbox, context isolation and web security with the settings flag', () => {
    const prefs = webPreferences({ preload: '/p.js', additionalArguments: [ARG_AGENT_SETTINGS] })
    expect(prefs).toMatchObject({ webSecurity: true, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false })
    expect(prefs.additionalArguments).toContain(ARG_AGENT_SETTINGS)
  })
})

test.describe('the preload copies match the main process names', () => {
  const preload = read('src/webui/preload.js')

  test('settings channel names and the flag are the same strings', () => {
    for (const channel of Object.values(SETTINGS_CHANNELS)) expect(preload).toContain(`'${channel}'`)
    expect(preload).toContain(`'${ARG_AGENT_SETTINGS}'`)
    // And only those: every ipcRenderer channel literal of the settings block is a known one.
    const block = preload.slice(preload.indexOf('AGENT_SETTINGS_CHANNELS = '), preload.indexOf('const ARG_AGENT_SETTINGS'))
    const names = [...block.matchAll(/'(ipfsDesktop\.agentSettings\.[A-Za-z]+)'/g)].map(m => m[1]).sort()
    expect(names).toEqual(Object.values(SETTINGS_CHANNELS).sort())
  })

  test('the API exists only with the flag, is frozen, and has no way to read a key', () => {
    expect(preload).toContain('process.argv.includes(ARG_AGENT_SETTINGS) ? makeAgentSettingsBridge() : undefined')
    expect(preload).toContain('...(agentSettings === undefined ? {} : { agentSettings })')
    const block = preload.slice(preload.indexOf('const makeAgentSettingsBridge'), preload.indexOf('const agentSettings ='))
    expect(block).toContain('Object.freeze')
    expect(block).not.toMatch(/localStorage|sessionStorage|getApiKey|readKey/)
    expect(Object.keys(METHODS).length + 1).toEqual(Object.keys(SETTINGS_CHANNELS).length)
  })

  test('the settings bridge is registered through the shared trust check', () => {
    expect(read('src/agent/settings-bridge.js')).toContain("createIsTrusted } = require('./bridge')")
    expect(read('src/agent/bridge.js')).toContain('const isTrusted = createIsTrusted(getWebuiContents)')
  })
})

test.describe('window recreation (L4)', () => {
  const index = read('src/webui/index.js')

  test('createWindow registers no app listener; one before-quit listener serves whichever window is current', () => {
    const create = index.slice(index.indexOf('const createWindow'), index.indexOf('module.exports'))
    expect(create).not.toContain("app.on('before-quit'")
    expect(index.split("app.on('before-quit', () => {\n    logger.info('[web ui] app-quit requested')").length - 1).toEqual(1)
  })

  test('a recreated window replaces the context webui prop', () => {
    const recreate = index.slice(index.indexOf('const recreateWindow'), index.indexOf('sidecarWatcher.start()'))
    expect(recreate).toContain("ctx.replaceProp('webui', window)")
  })
})
