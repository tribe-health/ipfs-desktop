// @ts-check
// This script runs in the renderer sandbox (webPreferences.sandbox, see security.js).
// A sandboxed preload can require only `electron` and a few Node built-ins, never a
// relative file, so everything it needs is here. Values the main process owns arrive as
// command-line arguments (additionalArguments); event and channel names are copies that
// test/unit/agent-settings-bridge.spec.js checks against src/common/ipc-main-events.js and
// src/agent/consts.js.
const { ipcRenderer, contextBridge } = require('electron')

const ipcMainEvents = Object.freeze({
  COUNTLY_ADD_CONSENT: 'countly.addConsent',
  COUNTLY_REMOVE_CONSENT: 'countly.removeConsent',
  LANG_UPDATED: 'languageUpdated',
  ONLINE_STATUS_CHANGED: 'online-status-changed',
  WEBUI_VISIBILITY_CHANGED: 'webui-visibility-changed'
})
const AGENT_CHAT_CHANNELS = Object.freeze({
  GET_ENDPOINT: 'ipfs-desktop:agent-chat:get-endpoint',
  GET_TOKEN: 'ipfs-desktop:agent-chat:get-token'
})
const ARG_AGENT_CHAT = '--ipfs-desktop-agent-chat=1'
const AGENT_SETTINGS_CHANNELS = Object.freeze({
  GET: 'ipfsDesktop.agentSettings.get',
  SET: 'ipfsDesktop.agentSettings.set',
  TEST_CONNECTION: 'ipfsDesktop.agentSettings.testConnection',
  SET_API_KEY: 'ipfsDesktop.agentSettings.setApiKey',
  CLEAR_API_KEY: 'ipfsDesktop.agentSettings.clearApiKey',
  STATUS: 'ipfsDesktop.agentSettings.status',
  ON_CHANGE: 'ipfsDesktop.agentSettings.onChange'
})
const ARG_AGENT_SETTINGS = '--ipfs-desktop-agent-settings=1'

/** @param {string} name */
const argValue = (name) => {
  const prefix = `--${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found === undefined ? '' : found.slice(prefix.length)
}
const VERSION = argValue('ipfs-desktop-version')
const COUNTLY_KEY = argValue('ipfs-desktop-countly-key')

// Report online/offline to the main process (was connection-status.js).
const reportOnlineStatus = () => {
  ipcRenderer.send(ipcMainEvents.ONLINE_STATUS_CHANGED, navigator.onLine)
}
window.addEventListener('online', reportOnlineStatus)
window.addEventListener('offline', reportOnlineStatus)
reportOnlineStatus()

const urlParams = new URLSearchParams(window.location.search)

let previousHash = null

// While the window is not visible, navigate the HashRouter to `#/blank` so the
// React app unmounts. This avoids re-rendering the bandwidth graph on Status
// and the peer list on Peers while the user cannot see them. Restore the
// previous route when visible again.
//
// Two signal sources, both calling the idempotent updater:
//
//   1. WEBUI_VISIBILITY_CHANGED IPC from the main process: deterministic when
//      the app calls `window.show()` / `window.hide()` programmatically (e.g.
//      tray-driven navigation), where Chromium's `visibilitychange` is not
//      reliably observed in time and the renderer would miss the un-blank.
//
//   2. `document.visibilitychange`: covers cases the main process never sees,
//      such as full occlusion by another window, macOS app-hide (Cmd+H) and
//      Mission Control / Spaces. Without this, those screens keep
//      re-rendering while the user is not looking at them.
function updateVisibility (isVisible) {
  if (!isVisible) {
    if (window.location.hash === '#/blank') return // skip, already blank
    previousHash = window.location.hash
    window.location.hash = '/blank'
    return
  }

  if (!previousHash || window.location.hash !== '#/blank') return // skip
  window.location.hash = previousHash
}

ipcRenderer.on(ipcMainEvents.WEBUI_VISIBILITY_CHANGED, (_event, isVisible) => {
  updateVisibility(Boolean(isVisible))
})

document.addEventListener('visibilitychange', () => {
  updateVisibility(!document.hidden)
})

// track hash changes, so updateVisibility always has the right previousHash
document.addEventListener('hashchange', () => {
  if (window.location.hash === '#/blank') return // skip
  previousHash = window.location.hash
})

// The agent chat bridge exists only when the main process created this window with the
// chat flag, which it does only while the chat is switched on and has a valid endpoint.
// Two read-only calls, both answered for the Web UI's main frame alone. The token is
// returned to the caller and to nobody else; there is no setter, no storage and no event.
const makeAgentChatBridge = () => Object.freeze({
  getEndpoint: () => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.GET_ENDPOINT),
  getToken: () => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.GET_TOKEN)
})
const agentChat = process.argv.includes(ARG_AGENT_CHAT) ? makeAgentChatBridge() : undefined

// The agent settings bridge (the SettingsClient contract, mcp/contract/settings/client),
// present only when the main process created this window with the settings flag. Every
// call goes to the main process, which answers the Web UI's main frame alone and runs the
// setters itself. The key is passed in and never handed back: no method returns it and no
// event carries it. A rejection is either the contract's `{error: {code, message}}` object
// or an Error with a plain message.
const unwrapSettings = async (/** @type {Promise<any>} */ pending) => {
  const res = await pending
  if (res === null || res === undefined) throw new Error('The agent settings are not available here.')
  if (res.ok === true) return res.value
  if (res.error) throw res.error
  throw new Error(typeof res.message === 'string' ? res.message : 'The change could not be applied.')
}
const makeAgentSettingsBridge = () => Object.freeze({
  get: () => unwrapSettings(ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.GET)),
  set: (req) => unwrapSettings(ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.SET, req)),
  testConnection: (req) => unwrapSettings(ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.TEST_CONNECTION, req)),
  setApiKey: (req) => unwrapSettings(ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.SET_API_KEY, req)),
  clearApiKey: (req) => unwrapSettings(ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.CLEAR_API_KEY, req)),
  status: () => unwrapSettings(ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.STATUS)),
  onChange: (onEvent) => {
    if (typeof onEvent !== 'function') throw new TypeError('onChange needs a function')
    const listener = (_event, payload) => {
      // Only the contract's event reaches the page, and only its two fields.
      if (payload && payload.type === 'settings_changed' && typeof payload.revision === 'string') {
        onEvent({ type: 'settings_changed', revision: payload.revision })
      }
    }
    ipcRenderer.on(AGENT_SETTINGS_CHANNELS.ON_CHANGE, listener)
    return () => { ipcRenderer.removeListener(AGENT_SETTINGS_CHANNELS.ON_CHANGE, listener) }
  }
})
const agentSettings = process.argv.includes(ARG_AGENT_SETTINGS) ? makeAgentSettingsBridge() : undefined

contextBridge.exposeInMainWorld('ipfsDesktop', {
  ...(agentChat === undefined ? {} : { agentChat }),
  ...(agentSettings === undefined ? {} : { agentSettings }),

  countlyAppKey: COUNTLY_KEY,

  countlyDeviceId: urlParams.get('deviceId'),

  countlyActions: [
    'ADD_VIA_DESKTOP',
    'DAEMON_START',
    'DAEMON_STOP',
    'DOWNLOAD_HASH',
    'MOVE_REPOSITORY',
    'SCREENSHOT_TAKEN'
  ],

  version: VERSION,

  /**
   *
   * @param {import('countly-sdk-nodejs').ConsentFeatures} consent
   */
  removeConsent: (consent) => {
    ipcRenderer.send(ipcMainEvents.COUNTLY_REMOVE_CONSENT, consent)
  },

  /**
   *
   * @param {import('countly-sdk-nodejs').ConsentFeatures} consent
   */
  addConsent: (consent) => {
    ipcRenderer.send(ipcMainEvents.COUNTLY_ADD_CONSENT, consent)
  },

  updateLanguage: (language) => {
    ipcRenderer.send(ipcMainEvents.LANG_UPDATED, language)
  }
})

// Inject api address
const apiAddress = urlParams.get('api')
if (apiAddress != null) {
  window.localStorage.setItem('ipfsApi', apiAddress)
}
