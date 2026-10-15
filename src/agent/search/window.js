// @ts-check
// The Search settings window: its own BrowserWindow, in its own in-memory session
// partition, contextIsolation and sandbox on, no node integration, devtools off, no
// navigation, no new windows, no permission grants, and a request filter that lets through
// only this directory's files and the shared stylesheet and fonts of the confirmation
// windows. Every IPC handler answers only the main frame of this window, loaded from its own
// file, so the Web UI, the chat island and any page script have no way in. Text the page
// shows comes from i18next in this process; the values it sends are validated and
// confirmed in service.js before anything is stored.

const { join } = require('path')
const { SEARCH_CHANNELS } = require('../consts')
const { isFromWindow, isUiFileUrl } = require('../confirm/windows')
const { SearchFailure } = require('./service')

/**
 * Development only: let a screen capture see this window. Honoured only by an unpackaged
 * build (a packaged app ignores the variable), so a shipped Desktop always sets content
 * protection. Used to capture the window for design review.
 */
const DEV_ALLOW_CAPTURE_ENV = 'IPFS_DESKTOP_DEV_ALLOW_CAPTURE'

/** @param {{ env?: Record<string, string | undefined>, isPackaged: boolean }} args */
function captureAllowed ({ env = process.env, isPackaged }) {
  return isPackaged === false && env[DEV_ALLOW_CAPTURE_ENV] === '1'
}

const PARTITION = 'ipfs-desktop-agent-search'
const UI_DIR = join(__dirname, 'ui')
const SHARED_UI_DIR = join(__dirname, '..', 'confirm', 'ui')
const PAGE = 'search.html'

const STRING_IDS = [
  'windowTitle', 'title', 'intro', 'enable', 'sectionBinaries', 'surrealLabel', 'xbergLabel', 'pathPlaceholder', 'browse',
  'sectionEmbedder', 'embedderUrlLabel', 'embedderUrlPlaceholder', 'embedderModelLabel', 'embedderDimensionsLabel',
  'sectionDescriber', 'describerHint', 'describerUrlLabel', 'describerModelLabel', 'save', 'close',
  'saved', 'savedNoRestart', 'bulkPaused', 'errFailed', 'offHint'
]
const FIELD_IDS = ['surrealBinary', 'xbergBinary', 'embedderUrl', 'embedderModel', 'embedderDimensions', 'describerUrl', 'describerModel']

/**
 * @param {object} deps
 * @param {{ BrowserWindow: typeof import('electron').BrowserWindow, ipcMain: Pick<import('electron').IpcMain, 'on' | 'handle' | 'removeListener' | 'removeHandler'>, session: Pick<typeof import('electron').session, 'fromPartition'>, dialog: Pick<import('electron').Dialog, 'showOpenDialog'> }} deps.electron
 * @param {ReturnType<typeof import('./service').createSearchService>} deps.service
 * @param {{ t: (key: string, options?: Record<string, unknown>) => string }} deps.i18n
 * @param {{ info: (m: string) => void, warn: (m: string) => void }} [deps.logger]
 * @param {boolean} [deps.allowCapture] development only (see captureAllowed): do not set content protection
 * @param {() => void} [deps.onClosed] called when the window has closed (Desktop forgets the hosts declined in its life)
 * @param {string} [deps.uiDir]
 * @param {string} [deps.sharedUiDir]
 */
function createSearchWindow ({ electron, service, i18n, logger, allowCapture = false, onClosed, uiDir = UI_DIR, sharedUiDir = SHARED_UI_DIR }) {
  const { BrowserWindow, ipcMain, session, dialog } = electron
  const ses = session.fromPartition(PARTITION)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false) // eslint-disable-line
  })
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(isUiFileUrl(details.url, uiDir) || isUiFileUrl(details.url, sharedUiDir)) }) // eslint-disable-line
  })

  /** @type {import('electron').BrowserWindow | null} */
  let win = null
  let disposed = false

  const strings = () => {
    /** @type {Record<string, string>} */
    const out = {}
    for (const id of STRING_IDS) out[id] = i18n.t(`agentSearch.${id}`)
    return out
  }

  function open () {
    if (disposed) return
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return }
    const created = new BrowserWindow({
      title: i18n.t('agentSearch.windowTitle'),
      width: 640,
      height: 820,
      minWidth: 420,
      minHeight: 480,
      show: false,
      autoHideMenuBar: true,
      fullscreenable: false,
      minimizable: false,
      webPreferences: {
        preload: join(uiDir, 'search-preload.js'),
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
    win = created
    created.setMenuBarVisibility(false)
    // Other applications cannot capture or record this window (it shows paths and hosts).
    // The one exception is a development build asked to allow it (captureAllowed).
    if (allowCapture) logger?.warn('[agent-search] screen capture of the Search window is allowed (development build)')
    else created.setContentProtection(true)
    const contents = created.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('render-process-gone', (_event, details) => {
      logger?.warn(`[agent-search] renderer gone: ${details.reason}`)
    })
    created.on('closed', () => {
      win = null
      try { onClosed?.() } catch (_) {}
    })
    contents.once('did-finish-load', () => {
      if (disposed || created.isDestroyed()) return
      contents.send(SEARCH_CHANNELS.STRINGS, { strings: strings() })
      created.show()
    })
    created.loadFile(join(uiDir, PAGE))
  }

  const fromThisWindow = (/** @type {any} */ event) => isFromWindow(event, win, PAGE, uiDir)

  const onGet = (/** @type {any} */ event) => (fromThisWindow(event) ? service.get() : null)

  const onApply = async (/** @type {any} */ event, /** @type {unknown} */ input) => {
    if (!fromThisWindow(event)) return { ok: false, message: i18n.t('agentSearch.errFailed') }
    try {
      const result = await service.apply(input)
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof SearchFailure) {
        return { ok: false, message: err.message, ...(typeof err.field === 'string' && FIELD_IDS.includes(err.field) ? { field: err.field } : {}) }
      }
      logger?.warn(`[agent-search] a change could not be applied: ${/** @type {Error} */(err).message}`)
      return { ok: false, message: i18n.t('agentSearch.errFailed') }
    }
  }

  const onPreview = (/** @type {any} */ event, /** @type {unknown} */ input) => (fromThisWindow(event) ? service.preview(input) : [])

  const onPick = async (/** @type {any} */ event, /** @type {unknown} */ which) => {
    if (!fromThisWindow(event) || (which !== 'surreal' && which !== 'xberg') || !win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, {
      title: i18n.t(which === 'surreal' ? 'agentSearch.surrealLabel' : 'agentSearch.xbergLabel'),
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0]
  }

  const onClose = (/** @type {any} */ event) => {
    if (fromThisWindow(event) && win && !win.isDestroyed()) win.close()
  }

  ipcMain.handle(SEARCH_CHANNELS.GET, onGet)
  ipcMain.handle(SEARCH_CHANNELS.APPLY, onApply)
  ipcMain.handle(SEARCH_CHANNELS.PREVIEW, onPreview)
  ipcMain.handle(SEARCH_CHANNELS.PICK, onPick)
  ipcMain.on(SEARCH_CHANNELS.CLOSE, onClose)

  return {
    open,
    isOpen: () => Boolean(win && !win.isDestroyed()),
    /** The BrowserWindow while it is open, else null: the native confirmation is parented to it. */
    getWindow: () => (win && !win.isDestroyed() ? win : null),
    dispose () {
      disposed = true
      ipcMain.removeHandler(SEARCH_CHANNELS.GET)
      ipcMain.removeHandler(SEARCH_CHANNELS.APPLY)
      ipcMain.removeHandler(SEARCH_CHANNELS.PREVIEW)
      ipcMain.removeHandler(SEARCH_CHANNELS.PICK)
      ipcMain.removeListener(SEARCH_CHANNELS.CLOSE, onClose)
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    },
    // For tests: the handlers, so they can be driven with a fake event.
    handlers: { onGet, onApply, onPreview, onPick, onClose }
  }
}

module.exports = { createSearchWindow, captureAllowed, DEV_ALLOW_CAPTURE_ENV, PARTITION, UI_DIR }
