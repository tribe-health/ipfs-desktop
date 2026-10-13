// @ts-check
// The Desktop confirmation: pairing store, request and pairing windows, and the polling
// loop over the `ipfs mcp` confirmation sockets (ADR-0003, desktop-agent-chat 1.4-1.12).
//
// Opt-in, and independent of the agent chat. It is on only when the store key
// `desktopConfirm.enabled` reads as true (the tray's "Confirm agent writes in this app"
// sets it), and never on Windows, where Node cannot reach the server's Unix socket.
// Anything else returns a manager that registers no IPC handler, creates no window,
// starts no timer and reads no socket directory. With it on but no pairing key, the
// pairing window opens and the loop still touches no channel until a key is stored.

const { KEYS } = require('../consts')
const { createPairingStore } = require('./pairing')
const { createConfirmationController } = require('./controller')
const { createConfirmationWindows } = require('./windows')
const { createTouchId } = require('./touchid')
const { touchReason } = require('./strings')
const client = require('./channel-client')

const ON_VALUES = new Set(['true', '1', 'on', 'yes', 'enabled'])

/**
 * The switch as the store may hold it: a boolean, or text typed by hand. Only a clear
 * "on" is on; false, 0, off, no, an empty value, a typo and a missing key all mean off.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function parseSwitch (value) {
  if (value === true || value === 1) return true
  return typeof value === 'string' && ON_VALUES.has(value.trim().toLowerCase())
}

/**
 * @typedef {object} Store
 * @property {(key: string, fallback?: any) => any} get
 * @property {(key: string, value: any) => any} set
 * @property {(key: string) => void} delete
 * @property {(key: string, value: any) => Promise<any>} [safeSet]
 *
 * @typedef {object} ConfirmElectron
 * @property {typeof import('electron').BrowserWindow} BrowserWindow
 * @property {import('./windows').ElectronLike['ipcMain']} ipcMain
 * @property {import('./windows').ElectronLike['session']} session
 * @property {import('../secret-store').SafeStorageLike} safeStorage
 * @property {{ canPromptTouchID?: () => boolean, promptTouchID?: (reason: string) => Promise<void> }} [systemPreferences]
 */

/**
 * @param {object} deps
 * @param {ConfirmElectron} deps.electron
 * @param {Store} deps.store
 * @param {import('./strings').Translator} deps.i18n
 * @param {{ info: (m: string) => void, warn: (m: string) => void }} [deps.logger]
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {string} [deps.platform]
 * @param {number} [deps.pollMs]
 * @param {number} [deps.resultMs]
 * @param {number} [deps.armMs]
 * @param {import('./controller').Authenticator} [deps.authenticate] replaces Touch ID (tests)
 */
function createAgentConfirmation ({ electron, store, i18n, logger, env = process.env, platform = process.platform, pollMs, resultMs, armMs, authenticate }) {
  const supported = platform !== 'win32'
  const pairing = createPairingStore({ safeStorage: electron.safeStorage, store, logger })
  const touch = authenticate ?? createTouchId(electron.systemPreferences, platform)
  /** @type {Set<() => void>} */
  const listeners = new Set()
  /** @type {{ controller: ReturnType<typeof createConfirmationController>, windows: ReturnType<typeof createConfirmationWindows> } | null} */
  let active = null
  let disposed = false

  /** @param {string} key @param {unknown} value */
  function persist (key, value) {
    if (typeof store.safeSet === 'function') store.safeSet(key, value)
    else store.set(key, value)
  }

  function changed () {
    for (const fn of [...listeners]) {
      try { fn() } catch (err) { logger?.warn(`[agent-confirm] change listener failed: ${/** @type {Error} */(err).message}`) }
    }
  }

  function start () {
    if (active || disposed || !supported) return
    const windows = createConfirmationWindows({
      electron,
      i18n,
      logger,
      armMs,
      onDecide: (ref, approve, meta) => { active?.controller.decide(ref, approve, meta) },
      onSurfaceClosed: () => { active?.controller.surfaceClosed() },
      onPairSubmit: (key) => {
        try {
          pairing.set(key)
        } catch (err) {
          const message = /** @type {Error} */(err).message
          return { ok: false, reason: message.includes('invalid shape') ? 'shape' : message.includes('unavailable') ? 'unavailable' : 'failed' }
        }
        active?.controller.keyChanged()
        logger?.info('[agent-confirm] pairing key stored')
        changed()
        return { ok: true }
      },
      // From a window's own handler: let that handler return before the window goes away.
      onTurnOff: () => { setImmediate(() => setEnabled(false)) }
    })
    const controller = createConfirmationController({
      pairing,
      getDirectory: () => client.socketDirectory({ env }),
      client,
      presenter: windows.presenter,
      authenticate: touch,
      touchReason: (item) => touchReason(i18n, item),
      hooks: { onPairingRejected: () => windows.openPairing({ reason: 'rejected' }) },
      logger,
      pollMs,
      resultMs
    })
    active = { controller, windows }
    controller.start()
    if (!pairing.get()) windows.openPairing({ reason: 'first' })
  }

  function stop () {
    if (!active) return
    const { controller, windows } = active
    active = null
    controller.dispose()
    windows.dispose()
  }

  /** @param {boolean} on */
  function setEnabled (on) {
    if (disposed || !supported) return
    if (on === Boolean(active)) { if (!on) persist(KEYS.CONFIRM_ENABLED, false); return }
    persist(KEYS.CONFIRM_ENABLED, on)
    if (on) start()
    else {
      stop()
      logger?.info('[agent-confirm] turned off; no channel will be contacted. Turn it on again from the tray menu.')
    }
    changed()
  }

  if (supported && parseSwitch(store.get(KEYS.CONFIRM_ENABLED, false))) start()
  else if (!supported) logger?.info('[agent-confirm] not available on Windows: Node cannot reach the server\'s Unix socket')

  return {
    supported,
    get enabled () { return Boolean(active) },
    get paired () { return pairing.has() },
    /** @returns {ReturnType<typeof createConfirmationController> | undefined} */
    get controller () { return active?.controller },
    setEnabled,
    /** Open the pairing window; turns the confirmation on first, because the person asked. */
    openPairing () {
      if (disposed || !supported) return
      if (!active) setEnabled(true)
      active?.windows.openPairing({ reason: 'first', userInitiated: true })
    },
    /** Forget the pairing key. The confirmation stays on and reads nothing until a key is stored again. */
    unpair () {
      pairing.clear()
      active?.controller.keyChanged()
      logger?.info('[agent-confirm] pairing key removed')
      changed()
    },
    /** @param {() => void} fn @returns {() => void} */
    onChange (fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    dispose () {
      disposed = true
      stop()
      listeners.clear()
    }
  }
}

module.exports = { createAgentConfirmation, parseSwitch }
