const { test, expect } = require('@playwright/test')
const { readFileSync } = require('fs')
const { join } = require('path')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const { buildAgentEndpointItems, SIDECAR_ENABLED_KEY, SETTINGS_ROUTE } = require('../../src/agent/tray-menu')

const strings = {
  'agentSettingsTray.title': 'Agent endpoint',
  'agentSettingsTray.open': 'Agent settings...',
  'agentSettingsTray.enable': 'Run the local agent endpoint',
  'agentSettingsTray.statusRunning': 'Running on 127.0.0.1:{port}',
  'agentSettingsTray.status.running': 'Running',
  'agentSettingsTray.status.starting': 'Starting...',
  'agentSettingsTray.status.restarting': 'Restarting...',
  'agentSettingsTray.status.failing': 'Failing to start',
  'agentSettingsTray.status.stopped': 'Stopped'
}
const t = (key, options) => (strings[key] ?? key).replace('{port}', options?.port)

function fakeStore (initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (k, fallback) => (data.has(k) ? data.get(k) : fallback),
    set: (k, v) => { data.set(k, v) }
  }
}

const sidecarIn = (state, port = 5050) => ({ getState: () => state, getPort: () => port })

function build ({ state = 'running', store = fakeStore(), sidecar, launched = [] } = {}) {
  return buildAgentEndpointItems({
    t,
    getSidecar: () => (sidecar === undefined ? sidecarIn(state) : sidecar),
    store,
    launchWebUI: (path) => { launched.push(path) }
  })
}
const byId = (items, id) => items.find((i) => i.id === id)

test.describe('tray entries for the agent endpoint (W9)', () => {
  test('the template has a status line, an "Agent settings" item and a sidecar toggle', () => {
    const items = build()
    expect(items.map(i => i.id)).toEqual(['agentEndpoint.header', 'agentEndpoint.status', 'agentEndpoint.settings', 'agentEndpoint.enable'])
    expect(byId(items, 'agentEndpoint.status')).toMatchObject({ label: 'Running on 127.0.0.1:5050', enabled: false })
    expect(byId(items, 'agentEndpoint.settings').label).toEqual('Agent settings...')
    expect(byId(items, 'agentEndpoint.enable')).toMatchObject({ type: 'checkbox', label: 'Run the local agent endpoint' })
  })

  test('the status line follows getState(): running, restarting, failing, stopped', () => {
    const labels = {}
    for (const state of ['running', 'restarting', 'failing', 'stopped']) {
      labels[state] = byId(build({ state }), 'agentEndpoint.status').label
    }
    expect(labels).toEqual({
      running: 'Running on 127.0.0.1:5050',
      restarting: 'Restarting...',
      failing: 'Failing to start',
      stopped: 'Stopped'
    })
  })

  test('a spawned child that has not bound yet reads as Starting, not Running', () => {
    expect(byId(build({ state: 'starting' }), 'agentEndpoint.status').label).toEqual('Starting...')
    const en = JSON.parse(readFileSync(join(__dirname, '../../assets/locales/en.json'), 'utf8'))
    expect(en.agentSettingsTray.status.starting).toBeTruthy()
  })

  test('a status line shows the port of the running sidecar, and no sidecar yet reads as stopped', () => {
    expect(byId(build({ sidecar: sidecarIn('running', 41999) }), 'agentEndpoint.status').label).toEqual('Running on 127.0.0.1:41999')
    expect(byId(build({ sidecar: null }), 'agentEndpoint.status').label).toEqual('Stopped')
    expect(byId(build({ sidecar: sidecarIn('mystery') }), 'agentEndpoint.status').label).toEqual('Stopped')
  })

  test('clicking "Agent settings" sends navigation to #/settings/agent', () => {
    const launched = []
    byId(build({ launched }), 'agentEndpoint.settings').click()
    expect(launched).toEqual(['/settings/agent'])
    expect(SETTINGS_ROUTE).toEqual('/settings/agent')
    // launchWebUI turns the path into the hash route (src/webui/index.js sets url.hash = path).
    expect(new URL('webui://localhost/#' + launched[0]).hash).toEqual('#/settings/agent')
  })

  test('the toggle is bound to mcpSidecar.enabled: checked by default, writes the store key both ways', () => {
    expect(SIDECAR_ENABLED_KEY).toEqual('mcpSidecar.enabled')
    const store = fakeStore()
    let toggle = byId(build({ store }), 'agentEndpoint.enable')
    expect(toggle.checked).toBe(true)
    toggle.click()
    expect(store.data.get('mcpSidecar.enabled')).toBe(false)
    toggle = byId(build({ store }), 'agentEndpoint.enable')
    expect(toggle.checked).toBe(false)
    toggle.click()
    expect(store.data.get('mcpSidecar.enabled')).toBe(true)
  })

  test('the toggle prefers the store safeSet when there is one', () => {
    const writes = []
    const store = { ...fakeStore({ 'mcpSidecar.enabled': true }), safeSet: (k, v) => writes.push([k, v]) }
    byId(build({ store }), 'agentEndpoint.enable').click()
    expect(writes).toEqual([['mcpSidecar.enabled', false]])
  })

  test('the store key is the one the sidecar supervisor reads', () => {
    const { MCP_SIDECAR_ENABLED_KEY } = proxyquire('../../src/daemon/mcp-sidecar', {
      electron: { app: { getPath: () => '/userdata' } },
      '../common/logger': { info () {}, warn () {}, error () {} },
      '../common/store': {},
      '../custom-ipfs-binary': { getCustomBinary: () => null },
      '../agent/secret-store': { createSecretStore: () => ({}) }
    })
    expect(SIDECAR_ENABLED_KEY).toEqual(MCP_SIDECAR_ENABLED_KEY)
  })

  test('src/tray.js builds the entries from the shared template and keeps the branding', () => {
    const tray = readFileSync(join(__dirname, '../../src/tray.js'), 'utf8')
    expect(tray).toContain("require('./agent/tray-menu')")
    expect(tray).toContain('...buildAgentEndpointItems({')
    expect(tray).toMatch(/launchWebUI\s*\n\s*\}\)/)
    expect(tray).toMatch(/setToolTip\(DISPLAY_NAME\)/)
  })
})
