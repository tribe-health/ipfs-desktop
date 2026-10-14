// @ts-check
// The two windows of the confirmation: the request window (Approve or Deny) and the
// pairing window (enter the key `ipfs mcp pair` printed). They are not the Web UI window.
//
//   - Their own BrowserWindow, their own in-memory session partition, contextIsolation on,
//     sandbox on, no node integration, devtools off, no webview, no navigation, no new
//     windows, no permission grants, content protection on (no capture by other apps), and
//     a request filter that lets through only the files of src/agent/confirm/ui. The page
//     carries a CSP of its own on top of that.
//   - The Web UI window, the chat island and any page script have no way in: the preload
//     of the Web UI (src/webui/preload.js) does not know these channels, the handlers
//     below exist only while this module runs, and each one answers only the main frame
//     of the window it belongs to, loaded from its own file.
//   - The request window is shown WITHOUT taking focus (no focus steal, never always on
//     top), so a click or key that was aimed at something else cannot land on it. Approve
//     arms only after the window has been in front, focused, for `armMs` (1.5 s), and
//     disarms on blur and whenever the request on screen changes. An approval that arrives
//     while it is not armed is dropped here, in the main process, whatever the page says.
//   - Text shown here comes from the server and, through it, from an agent; the pages set
//     it with textContent only. Every other string comes from i18next (see strings.js).

const { join } = require('path')
const { pathToFileURL } = require('url')
const { CONFIRM_CHANNELS } = require('../consts')
const { normalizePairingKey } = require('./pairing')
const { windowStrings, approveLabel } = require('./strings')

const PARTITION = 'ipfs-desktop-agent-confirm'
const UI_DIR = join(__dirname, 'ui')
const ARM_MS = 1500

/**
 * @typedef {object} ElectronLike
 * @property {typeof import('electron').BrowserWindow} BrowserWindow
 * @property {Pick<import('electron').IpcMain, 'on' | 'handle' | 'removeListener' | 'removeHandler'>} ipcMain
 * @property {Pick<typeof import('electron').session, 'fromPartition'>} session
 */

/**
 * @param {string} url
 * @param {string} uiDir
 */
function isUiFileUrl (url, uiDir) {
  return typeof url === 'string' && url.startsWith(pathToFileURL(uiDir).href + '/')
}

/**
 * Whether an IPC message comes from the main frame of `win`, loaded from `page`.
 *
 * @param {any} event
 * @param {import('electron').BrowserWindow | null} win
 * @param {string} page file name under the ui directory
 * @param {string} uiDir
 */
function isFromWindow (event, win, page, uiDir) {
  if (!win || win.isDestroyed()) return false
  const contents = win.webContents
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return false
  const url = String(event.senderFrame.url).split(/[?#]/)[0]
  return url === pathToFileURL(join(uiDir, page)).href
}

/**
 * @param {object} deps
 * @param {ElectronLike} deps.electron
 * @param {import('./strings').Translator} deps.i18n
 * @param {(ref: string, approve: boolean, meta: import('./controller').DecideMeta) => void} deps.onDecide
 * @param {(key: string) => { ok: true } | { ok: false, reason: 'shape' | 'unavailable' | 'failed' }} deps.onPairSubmit
 * @param {() => void} deps.onTurnOff
 * @param {() => void} [deps.onSurfaceClosed] the person closed the request window
 * @param {{ info: (m: string) => void, warn: (m: string) => void }} [deps.logger]
 * @param {string} [deps.uiDir]
 * @param {number} [deps.armMs]
 * @param {() => number} [deps.now]
 */
function createConfirmationWindows ({ electron, i18n, onDecide, onPairSubmit, onTurnOff, onSurfaceClosed, logger, uiDir = UI_DIR, armMs = ARM_MS, now = Date.now }) {
  const { BrowserWindow, ipcMain, session } = electron

  const ses = session.fromPartition(PARTITION)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false) // eslint-disable-line
  })
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isUiFileUrl(details.url, uiDir) }) // eslint-disable-line
  })

  /** @type {import('electron').BrowserWindow | null} */
  let requestWindow = null
  /** @type {Promise<void> | null} */
  let requestLoaded = null
  /** @type {import('electron').BrowserWindow | null} */
  let pairWindow = null
  let disposed = false
  /** The request on screen, so closing the window can deny exactly it. */
  let shownRef = ''
  let resultOnScreen = false

  // Arming of Approve.
  let armed = false
  let armedAt = 0
  /** @type {'unfocused' | 'waiting' | 'blur' | 'changed' | 'ready'} */
  let armReason = 'unfocused'
  /** @type {ReturnType<typeof setTimeout> | null} */
  let armTimer = null

  /**
   * @param {object} options
   * @param {string} options.page
   * @param {string} options.preload
   * @param {string} options.title
   * @param {number} options.width
   * @param {number} options.height
   */
  function secureWindow ({ page, preload, title, width, height }) {
    const win = new BrowserWindow({
      title,
      width,
      height,
      minWidth: 380,
      minHeight: 360,
      show: false,
      autoHideMenuBar: true,
      fullscreenable: false,
      minimizable: false,
      webPreferences: {
        preload: join(uiDir, preload),
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        devTools: false,
        navigateOnDragDrop: false
      }
    })
    win.setMenuBarVisibility(false)
    // Other applications cannot capture or record these windows.
    win.setContentProtection(true)
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('render-process-gone', (_event, details) => {
      logger?.warn(`[agent-confirm] ${page} renderer gone: ${details.reason}`)
    })
    const loaded = new Promise((resolve) => contents.once('did-finish-load', () => resolve(undefined)))
    win.loadFile(join(uiDir, page))
    return { win, loaded: /** @type {Promise<void>} */(loaded) }
  }

  /** @param {string} channel @param {unknown} payload */
  function sendToRequest (channel, payload) {
    if (requestWindow && !requestWindow.isDestroyed()) requestWindow.webContents.send(channel, payload)
  }

  function sendArm () {
    sendToRequest(CONFIRM_CHANNELS.ARM, { armed, reason: armReason })
  }

  /** @param {'unfocused' | 'blur' | 'changed'} reason */
  function disarm (reason) {
    if (armTimer) clearTimeout(armTimer)
    armTimer = null
    armed = false
    armReason = reason
    sendArm()
  }

  /** Start the clock when the window is in front and focused, and only then. */
  function tryArm () {
    if (disposed || armed || armTimer || !shownRef || resultOnScreen) return
    const win = requestWindow
    if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) return
    if (armReason === 'unfocused') {
      armReason = 'waiting'
      sendArm()
    }
    armTimer = setTimeout(() => {
      armTimer = null
      const w = requestWindow
      if (disposed || !shownRef || !w || w.isDestroyed() || !w.isVisible() || !w.isFocused()) return
      armed = true
      armedAt = now()
      armReason = 'ready'
      sendArm()
    }, armMs)
  }

  function ensureRequestWindow () {
    if (requestWindow && !requestWindow.isDestroyed() && requestLoaded) return { win: requestWindow, loaded: requestLoaded }
    const created = secureWindow({ page: 'confirm.html', preload: 'confirm-preload.js', title: i18n.t('agentConfirm.windowTitle'), width: 520, height: 640 })
    const win = created.win
    requestWindow = win
    requestLoaded = created.loaded
    win.on('focus', tryArm)
    win.on('blur', () => disarm('blur'))
    win.on('hide', () => disarm('unfocused'))
    // Closing the window is an answer: Deny. Expiry would say the same, later.
    win.on('close', (event) => {
      if (disposed) return
      event.preventDefault()
      const ref = shownRef
      shownRef = ''
      if (ref && !resultOnScreen) onDecide(ref, false, {})
      if (!win.isDestroyed()) win.hide()
      onSurfaceClosed?.()
    })
    win.on('closed', () => { requestWindow = null; requestLoaded = null })
    return created
  }

  /** @type {import('./controller').Presenter} */
  const presenter = {
    show (view) {
      if (disposed) return
      const { win, loaded } = ensureRequestWindow()
      const changed = view.ref !== shownRef
      shownRef = view.ref
      resultOnScreen = false
      if (changed) disarm(win.isVisible() ? 'changed' : 'unfocused')
      const payload = { ...view, approveLabel: approveLabel(i18n, view.tool) }
      loaded.then(() => {
        if (disposed || win.isDestroyed()) return
        win.webContents.send(CONFIRM_CHANNELS.STRINGS, { strings: windowStrings(i18n, armMs), armMs })
        win.webContents.send(CONFIRM_CHANNELS.SHOW, payload)
        sendArm()
        // In front but not focused: nothing here takes focus from what the person is doing.
        if (!win.isVisible()) win.showInactive()
        tryArm()
      })
    },
    showResult (result) {
      if (disposed || !requestWindow || requestWindow.isDestroyed()) return
      resultOnScreen = true
      shownRef = ''
      disarm('unfocused')
      sendToRequest(CONFIRM_CHANNELS.RESULT, { kind: result.kind })
    },
    showError (_ref, kind) {
      sendToRequest(CONFIRM_CHANNELS.ERROR, { kind })
    },
    showBusy () {
      sendToRequest(CONFIRM_CHANNELS.ERROR, { kind: 'busy' })
    },
    hide () {
      shownRef = ''
      resultOnScreen = false
      disarm('unfocused')
      if (requestWindow && !requestWindow.isDestroyed() && requestWindow.isVisible()) requestWindow.hide()
    }
  }

  /**
   * @param {{ reason?: 'first' | 'rejected', userInitiated?: boolean }} [options] userInitiated:
   * the person asked for it (the tray), so it may take focus; otherwise it opens in the back.
   */
  function openPairing ({ reason = 'first', userInitiated = false } = {}) {
    if (disposed) return
    /** @param {import('electron').BrowserWindow} win */
    const bring = (win) => {
      if (userInitiated) { win.show(); win.focus() } else if (!win.isVisible()) win.showInactive()
    }
    if (pairWindow && !pairWindow.isDestroyed()) { bring(pairWindow); return }
    const created = secureWindow({ page: 'pair.html', preload: 'pair-preload.js', title: i18n.t('agentConfirm.pairWindowTitle'), width: 560, height: 720 })
    const win = created.win
    pairWindow = win
    win.on('closed', () => { pairWindow = null })
    created.loaded.then(() => {
      if (disposed || win.isDestroyed()) return
      win.webContents.send(CONFIRM_CHANNELS.STRINGS, { strings: windowStrings(i18n, armMs), reason })
      bring(win)
    })
  }

  function closePairing () {
    if (pairWindow && !pairWindow.isDestroyed()) pairWindow.destroy()
    pairWindow = null
  }

  /** @param {any} event @param {any} payload */
  const onDecideMessage = (event, payload) => {
    if (!isFromWindow(event, requestWindow, 'confirm.html', uiDir)) return
    if (!payload || typeof payload.ref !== 'string' || typeof payload.approve !== 'boolean') return
    if (payload.ref !== shownRef) return
    if (!payload.approve) {
      onDecide(payload.ref, false, {})
      return
    }
    // Approve only counts once it is armed: the window has been in front and focused long
    // enough that the person has seen what is on it.
    if (!armed) {
      logger?.info(`[agent-confirm] approve ignored: not armed (${armReason})`)
      sendArm()
      return
    }
    const meta = { armedForMs: now() - armedAt, focused: Boolean(requestWindow?.isFocused()) }
    disarm('blur') // one approval attempt per arming
    onDecide(payload.ref, true, meta)
  }
  /** @param {any} event @param {unknown} key */
  const onPairSubmitMessage = (event, key) => {
    if (!isFromWindow(event, pairWindow, 'pair.html', uiDir)) return { ok: false, reason: 'failed' }
    return onPairSubmit(normalizePairingKey(key))
  }
  /** @param {any} event */
  const onPairDismiss = (event) => {
    if (isFromWindow(event, pairWindow, 'pair.html', uiDir)) closePairing()
  }
  /** @param {any} event */
  const onPairTurnOff = (event) => {
    if (!isFromWindow(event, pairWindow, 'pair.html', uiDir)) return
    closePairing()
    onTurnOff()
  }
  /** @param {any} event */
  const onRequestTurnOff = (event) => {
    if (!isFromWindow(event, requestWindow, 'confirm.html', uiDir)) return
    onTurnOff()
  }

  ipcMain.on(CONFIRM_CHANNELS.DECIDE, onDecideMessage)
  ipcMain.on(CONFIRM_CHANNELS.TURN_OFF, onRequestTurnOff)
  ipcMain.handle(CONFIRM_CHANNELS.PAIR_SUBMIT, onPairSubmitMessage)
  ipcMain.on(CONFIRM_CHANNELS.PAIR_DISMISS, onPairDismiss)
  ipcMain.on(CONFIRM_CHANNELS.PAIR_TURN_OFF, onPairTurnOff)

  function dispose () {
    disposed = true
    if (armTimer) clearTimeout(armTimer)
    armTimer = null
    ipcMain.removeListener(CONFIRM_CHANNELS.DECIDE, onDecideMessage)
    ipcMain.removeListener(CONFIRM_CHANNELS.TURN_OFF, onRequestTurnOff)
    ipcMain.removeHandler(CONFIRM_CHANNELS.PAIR_SUBMIT)
    ipcMain.removeListener(CONFIRM_CHANNELS.PAIR_DISMISS, onPairDismiss)
    ipcMain.removeListener(CONFIRM_CHANNELS.PAIR_TURN_OFF, onPairTurnOff)
    for (const win of [requestWindow, pairWindow]) {
      if (win && !win.isDestroyed()) win.destroy()
    }
    requestWindow = null
    pairWindow = null
  }

  return {
    presenter,
    openPairing,
    closePairing,
    dispose,
    /** @returns {{ armed: boolean, reason: string }} */
    arming: () => ({ armed, reason: armReason }),
    isFromWindow: (/** @type {any} */ event, /** @type {string} */ which) => isFromWindow(event, which === 'pair' ? pairWindow : requestWindow, which === 'pair' ? 'pair.html' : 'confirm.html', uiDir)
  }
}

module.exports = { createConfirmationWindows, isFromWindow, isUiFileUrl, PARTITION, UI_DIR, ARM_MS }
