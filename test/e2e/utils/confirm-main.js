'use strict'

// Electron main for the agent confirmation e2e (test/e2e/agent-confirm.e2e.test.js).
//
// It is NOT the IPFS Desktop main process: no daemon, no tray, no splash. It builds the
// Web UI window with the production options (src/webui/security.js) from the bundled
// `webui://localhost` assets, and wires the confirmation with the production module
// (src/agent/confirm) the same way src/webui/index.js does, with real i18next (ICU) over
// assets/locales/en.json. Isolated user data, the mock keychain, and no request to a
// default IPFS port.
//
// Environment:
//   PROBE_USER_DATA          user-data directory (required)
//   PROBE_AGENT              'on' | 'off'     the agent chat switch (independent of the confirmation)
//   PROBE_CONFIRM            'on' | 'off' | 'false' | ...  stores desktopConfirm.enabled as given; unset: not stored
//   PROBE_SEED_PAIRING       a pairing key to store before wiring (optional)
//   PROBE_TOUCHID            'allow' (default) | 'deny' | 'unavailable': a stand-in for the Touch ID prompt
//   PROBE_FAKE_SAFESTORAGE   '1' to use a reversible stand-in for safeStorage (always on Linux CI,
//                            where no keyring runs); the store's isAvailable rules are not relaxed
//   PROBE_ARM_MS             arming delay, default the production 1500
//   PROBE_VISIBLE            '1' to leave the windows on screen
//   IPFS_MCP_CONFIRM_DIR     socket directory the client looks in
//   PROBE_POLL_MS            poll interval, default 200

const { app, BrowserWindow, session, ipcMain, safeStorage } = require('electron')
const { join } = require('path')
const serve = require('electron-serve')

app.setPath('userData', process.env.PROBE_USER_DATA)
app.commandLine.appendSwitch('use-mock-keychain')

// The windows of this probe are kept out of reach of the operating system's pointer:
// off-screen, transparent, and deaf to OS mouse events. Playwright drives them over the
// DevTools protocol, which needs none of that. A real Approve button is a target for any
// same-user process that can click (including the computer-use agents that may be running
// on the machine that runs this test), and a test must not be approved by a stray click.
app.on('browser-window-created', (_event, win) => {
  if (process.env.PROBE_VISIBLE === '1') return
  win.setPosition(-30000, -30000)
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
})

// What src/webui/open-external.js does for every window, without handing URLs to the
// system browser: a page cannot open a window of its own.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

serve({ scheme: 'webui', directory: join(__dirname, '../../../assets/webui') })

// Ports of the node on this machine and of the other services the operator runs (kubo's
// design port rule): a request to any of them from this probe is cancelled.
const FORBIDDEN_PORTS = new Set(['4000', '4001', '4545', '4546', '5001', '5173', '5432', '6379', '8080', '8081', '8181', '11434', '23001', '28000', '50051', '1906', '1907', '1908'])

/** A reversible stand-in for the OS keystore. */
function fakeSafeStorage () {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain.split('').reverse().join('') + '|sealed'),
    decryptString: (buf) => buf.toString().slice(0, -'|sealed'.length).split('').reverse().join('')
  }
}

app.whenReady().then(async () => {
  const Store = require('electron-store')
  const i18n = require('i18next')
  const ICU = require('i18next-icu')
  const store = new Store({ name: 'confirm-probe-store' })
  const { KEYS, ARG_AGENT_CHAT } = require('../../../src/agent/consts')
  const { readAgentChatSettings } = require('../../../src/agent/settings')
  const { createPairingStore } = require('../../../src/agent/confirm/pairing')
  const { createAgentConfirmation } = require('../../../src/agent/confirm')
  const { createTokenStore } = require('../../../src/agent/token-store')
  const { registerAgentBridge } = require('../../../src/agent/bridge')
  const security = require('../../../src/webui/security')

  await i18n.use(ICU).init({ lng: 'en', resources: { en: { translation: require('../../../assets/locales/en.json') } } })

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const u = new URL(details.url)
      if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) && FORBIDDEN_PORTS.has(u.port)) return callback({ cancel: true }) // eslint-disable-line
    } catch (_) {}
    callback({}) // eslint-disable-line
  })

  const keystore = process.env.PROBE_FAKE_SAFESTORAGE === '1' || process.platform === 'linux' ? fakeSafeStorage() : safeStorage

  store.set(KEYS.ENABLED, process.env.PROBE_AGENT === 'on')
  store.set(KEYS.ENDPOINT, 'http://127.0.0.1:1/agui') // valid shape, never contacted
  if (process.env.PROBE_CONFIRM !== undefined) {
    const v = process.env.PROBE_CONFIRM
    store.set(KEYS.CONFIRM_ENABLED, v === 'on' ? true : v === 'off' ? false : v)
  }
  if (process.env.PROBE_SEED_PAIRING) createPairingStore({ safeStorage: keystore, store }).set(process.env.PROBE_SEED_PAIRING)

  const chat = readAgentChatSettings(store)
  let window = null
  registerAgentBridge({
    ipcMain,
    getWebuiContents: () => (window && !window.isDestroyed() ? window.webContents : null),
    settings: chat,
    tokenStore: createTokenStore({ safeStorage: keystore, store })
  })

  // A stand-in for the Touch ID prompt, which a test machine cannot answer.
  const touch = { mode: process.env.PROBE_TOUCHID || 'allow', reasons: [] }
  const authenticate = {
    available: () => touch.mode !== 'unavailable',
    prompt: async (reason) => { touch.reasons.push(reason); return touch.mode === 'allow' }
  }

  const logger = { info: (m) => console.log(m), warn: (m) => console.log(m) }
  const confirmation = createAgentConfirmation({
    electron: { BrowserWindow, ipcMain, session, safeStorage: keystore },
    store,
    i18n: { t: (key, options) => i18n.t(key, options), exists: (key) => i18n.exists(key) },
    logger,
    pollMs: Number(process.env.PROBE_POLL_MS || 200),
    resultMs: 600,
    armMs: process.env.PROBE_ARM_MS ? Number(process.env.PROBE_ARM_MS) : undefined,
    authenticate
  })
  // Test hooks, read through app.evaluate; production exposes none of this.
  globalThis.__probe = {
    confirmation,
    touch,
    store,
    getWebuiContents: () => window.webContents,
    // Bring a window forward and focus it, as the person would by clicking it.
    focus: (title) => {
      app.focus({ steal: true })
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)
      if (win) win.focus()
      return Boolean(win)
    }
  }

  window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: security.webPreferences({
      preload: join(__dirname, '../../../src/webui/preload.js'),
      additionalArguments: ['--ipfs-desktop-version=probe', '--ipfs-desktop-countly-key=probe', ...(chat.enabled ? [ARG_AGENT_CHAT] : [])]
    })
  })
  security.installCsp(session.defaultSession, () => ({ mcpOrigin: chat.origin }))
  await window.loadURL('webui://localhost/#/blank')
  console.log('[probe] ready')
})

// The confirmation windows hide instead of closing; the probe ends when the test closes the app.
app.on('window-all-closed', () => {})
