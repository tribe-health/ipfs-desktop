// @ts-check
// Main-process side of `ipfsDesktop.agentSettings.*`. With the bridge off nothing is
// registered: the channels do not exist and the preload (which only exposes its API when
// the window was created with the settings flag) has nothing to call. With it on, every
// channel answers through the same trust check as the agent chat channels (bridge.js
// createIsTrusted: the Web UI window's own main frame at webui://localhost) and answers
// anything else with null, the same as a channel that does not exist. Results travel in an
// envelope the preload unwraps: { ok: true, value } | { ok: false, error } for a contract
// error | { ok: false, message } for any other refusal.

const { SETTINGS_CHANNELS } = require('./consts')
const { createIsTrusted } = require('./bridge')
const { isWebUiUrl } = require('../webui/security')
const { ContractError, BridgeFailure } = require('./settings-service')

const METHODS = Object.freeze({
  [SETTINGS_CHANNELS.GET]: 'get',
  [SETTINGS_CHANNELS.SET]: 'set',
  [SETTINGS_CHANNELS.TEST_CONNECTION]: 'testConnection',
  [SETTINGS_CHANNELS.SET_API_KEY]: 'setApiKey',
  [SETTINGS_CHANNELS.CLEAR_API_KEY]: 'clearApiKey',
  [SETTINGS_CHANNELS.STATUS]: 'status'
})

/**
 * @param {object} deps
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} deps.ipcMain
 * @param {() => import('electron').WebContents | null | undefined} deps.getWebuiContents
 * @param {boolean} deps.enabled the KEYS.SETTINGS_ENABLED switch
 * @param {ReturnType<typeof import('./settings-service').createSettingsService>} deps.service
 * @param {{ warn: (m: string) => void }} [deps.logger]
 * @returns {{ enabled: boolean, pushChange: (revision: string) => boolean, dispose: () => void }}
 */
function registerAgentSettingsBridge ({ ipcMain, getWebuiContents, enabled, service, logger }) {
  if (!enabled) return { enabled: false, pushChange: () => false, dispose: () => {} }

  const isTrusted = createIsTrusted(getWebuiContents)

  /** @param {string} channel @param {string} method */
  const handler = (channel, method) => async (/** @type {any} */ event, /** @type {unknown} */ payload) => {
    if (!isTrusted(event)) return null
    try {
      const value = await /** @type {any} */(service)[method](payload)
      return { ok: true, value }
    } catch (err) {
      if (err instanceof ContractError) return { ok: false, error: err.shape }
      if (err instanceof BridgeFailure) return { ok: false, message: err.message }
      // Anything else is a bug here, not something to describe to the page.
      logger?.warn(`[agent-settings] ${channel} failed unexpectedly: ${/** @type {Error} */(err)?.name}`)
      return { ok: false, message: 'The change could not be applied.' }
    }
  }

  for (const [channel, method] of Object.entries(METHODS)) {
    ipcMain.handle(channel, handler(channel, method))
  }

  return {
    enabled: true,
    /**
     * Tell the Web UI window that settings changed. Only the revision travels, and only to
     * the main frame while it is the Web UI origin; a window showing anything else gets
     * nothing.
     *
     * @param {string} revision
     */
    pushChange (revision) {
      const contents = getWebuiContents()
      if (!contents || contents.isDestroyed()) return false
      const frame = contents.mainFrame
      if (!frame || !isWebUiUrl(frame.url)) return false
      service.observeRevision(revision)
      frame.send(SETTINGS_CHANNELS.ON_CHANGE, { type: 'settings_changed', revision })
      return true
    },
    dispose () {
      for (const channel of Object.keys(METHODS)) ipcMain.removeHandler(channel)
    }
  }
}

module.exports = { registerAgentSettingsBridge }
