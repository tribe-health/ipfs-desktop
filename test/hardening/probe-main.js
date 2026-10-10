'use strict'

// Electron main process for the hardening probe (docs/agent/HARDENING.md).
//
// It is NOT the IPFS Desktop main process. It loads the bundled Web UI from the same
// `webui://localhost` scheme, with the same window options the real window uses, in an
// isolated user-data directory, and talks to whatever API address the runner passes in.
// PROBE_MODE=baseline reproduces the options the fork shipped before the hardening
// change; PROBE_MODE=hardened uses src/webui/security.js, the module the real window
// uses. Nothing here starts a daemon or touches a default IPFS port.

const { app, BrowserWindow, session, ipcMain, safeStorage } = require('electron')
const { join } = require('path')
const serve = require('electron-serve')

const mode = process.env.PROBE_MODE === 'baseline' ? 'baseline' : 'hardened'
const userData = process.env.PROBE_USER_DATA
if (userData) app.setPath('userData', userData)
// macOS: use Chromium's mock keychain so the probe never touches the login Keychain.
// The ciphertext format, persistence across restarts and the storage audit are real;
// the strength of the Keychain itself is not exercised (see HARDENING.md).
if (process.env.PROBE_MOCK_KEYCHAIN === '1') app.commandLine.appendSwitch('use-mock-keychain')

serve({ scheme: 'webui', directory: join(__dirname, '../../assets/webui') })

const apiOrigin = process.env.PROBE_API_ORIGIN
const gatewayOrigin = process.env.PROBE_GATEWAY_ORIGIN
const preload = join(__dirname, '../../src/webui/preload.js')

app.whenReady().then(async () => {
  // Safety net: the probe must never reach a default IPFS port on this machine, which
  // may host a developer's own node. Anything aimed at one is cancelled and reported.
  const DEFAULT_PORTS = new Set(['4001', '5001', '8080'])
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const u = new URL(details.url)
      if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) && DEFAULT_PORTS.has(u.port)) {
        console.error(`[probe] blocked request to default IPFS port: ${details.url}`)
        return callback({ cancel: true }) // eslint-disable-line
      }
    } catch (_) {}
    callback({}) // eslint-disable-line
  })
  let webPreferences
  let window = null
  // PROBE_AGENT=on|off exercises the agent chat modules (settings, token store, bridge) from
  // src/agent against the real electron-store and the real safeStorage, wired the way
  // src/webui/index.js wires them.
  const agentMode = process.env.PROBE_AGENT
  const store = new (require('electron-store'))({ name: 'probe-store' })
  let agent = { enabled: false, endpoint: null, origin: null }
  if (agentMode) {
    const { KEYS } = require('../../src/agent/consts')
    const { readAgentChatSettings } = require('../../src/agent/settings')
    const { createTokenStore } = require('../../src/agent/token-store')
    const { registerAgentBridge } = require('../../src/agent/bridge')
    const tokens = createTokenStore({ safeStorage, store, logger: { warn: console.error } })
    if (process.env.PROBE_SEED_ENDPOINT) {
      store.set(KEYS.ENABLED, agentMode === 'on')
      store.set(KEYS.ENDPOINT, process.env.PROBE_SEED_ENDPOINT)
    }
    if (process.env.PROBE_SEED_TOKEN) tokens.set(process.env.PROBE_SEED_TOKEN)
    agent = readAgentChatSettings(store)
    registerAgentBridge({
      ipcMain,
      getWebuiContents: () => (window && !window.isDestroyed() ? window.webContents : null),
      settings: agent,
      tokenStore: tokens
    })
    console.log(`[probe] agent chat enabled=${agent.enabled} tokenAvailable=${tokens.isAvailable()} hasToken=${tokens.has()}`)
  }
  const { ARG_AGENT_CHAT } = require('../../src/agent/consts')
  const additionalArguments = ['--ipfs-desktop-version=probe', '--ipfs-desktop-countly-key=probe', ...(agent.enabled ? [ARG_AGENT_CHAT] : [])]
  if (mode === 'baseline') {
    // Verbatim from src/webui/index.js before the change.
    webPreferences = { preload, webSecurity: false, allowRunningInsecureContent: false, nodeIntegration: process.env.NODE_ENV === 'test' }
  } else {
    const security = require('../../src/webui/security')
    security.installCsp(session.defaultSession, () => ({ apiOrigin, gatewayOrigin, mcpOrigin: agent.origin }))
    webPreferences = security.webPreferences({ preload, additionalArguments })
  }

  window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences })
  const url = new URL('/', 'webui://localhost')
  url.hash = '/'
  url.searchParams.set('api', process.env.PROBE_API_MULTIADDR || apiOrigin)
  await window.loadURL(url.toString())
})

app.on('window-all-closed', () => app.quit())
