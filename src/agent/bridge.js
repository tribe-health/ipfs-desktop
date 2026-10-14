// @ts-check
// Main-process side of the agent chat bridge. With the chat off, nothing is registered:
// the channels do not exist, so a renderer cannot ask for a token or an endpoint, and the
// preload (which only exposes its API when the window was created with the chat flag)
// has nothing to call. With it on, the two handlers answer only the Web UI's own main
// frame, loaded from `webui://localhost` in the Web UI window.

const { CHANNELS } = require('./consts')
const { isWebUiUrl } = require('../webui/security')

/**
 * @param {object} deps
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} deps.ipcMain
 * @param {() => import('electron').WebContents | null | undefined} deps.getWebuiContents
 * @param {{ enabled: boolean, endpoint: string | null }} deps.settings
 * @param {{ get: () => string | undefined }} deps.tokenStore
 * @returns {{ enabled: boolean, dispose: () => void }}
 */
function registerAgentBridge ({ ipcMain, getWebuiContents, settings, tokenStore }) {
  if (!settings.enabled) return { enabled: false, dispose: () => {} }

  /** @param {any} event */
  function isTrusted (event) {
    const contents = getWebuiContents()
    if (!contents || event.sender !== contents) return false
    // Main frame only: a sub-frame, even a same-origin one, is refused.
    if (event.senderFrame !== contents.mainFrame) return false
    return isWebUiUrl(event.senderFrame.url)
  }

  ipcMain.handle(CHANNELS.GET_ENDPOINT, (event) => (isTrusted(event) ? settings.endpoint : null))
  ipcMain.handle(CHANNELS.GET_TOKEN, (event) => (isTrusted(event) ? tokenStore.get() : undefined))

  return {
    enabled: true,
    dispose: () => {
      ipcMain.removeHandler(CHANNELS.GET_ENDPOINT)
      ipcMain.removeHandler(CHANNELS.GET_TOKEN)
    }
  }
}

module.exports = { registerAgentBridge }
