// @ts-check
// The independent human confirmation that Desktop asks for before it lets a model API key
// or node content go to a host: Touch ID where the computer has it, otherwise a native
// main-process dialog that names the host (confirm/native-dialog.js). Without either, or on
// a decline, nothing proceeds. One gate serves the agent backend settings and the Search
// settings, so a looping page cannot turn either into a stream of prompts: one confirmation
// is open at a time, and a host the person declined is refused without asking again until
// the window that asked is closed or recreated (forgetDeclined(scope)). A request says what
// the confirmation is for (`purpose`), so the native dialog can name what goes to the host
// (the agent's model calls, the text of files, image files) and parent itself to the window
// that asked.

/** A refusal before or instead of a prompt; the message is already user-facing text. */
class ConfirmRefused extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'ConfirmRefused'
  }
}

/**
 * What a confirmation is for. `backend` is the agent backend (model calls); `searchText` and
 * `searchImages` are the Search embedder (file text) and describer (image files).
 *
 * @typedef {'backend' | 'searchText' | 'searchImages'} Purpose
 *
 * @typedef {object} ConfirmOptions
 * @property {Purpose} [purpose] default 'backend'
 * @property {boolean} [keyFollows] a model key that is not Desktop's own (supplied by the server by reference) goes to the new host with the move
 * @property {() => ({ isDestroyed: () => boolean, isVisible?: () => boolean } | null | undefined)} [getParent] the window that asked; the native dialog is parented to it while it is visible
 *
 * @typedef {{ host: string, purpose: Purpose, keyFollows: boolean, getParent?: ConfirmOptions['getParent'] }} NativeRequest
 */

/**
 * @param {object} deps
 * @param {{ available: () => boolean, prompt: (reason: string) => Promise<boolean> }} deps.authenticate Touch ID (confirm/touchid.js)
 * @param {(request: NativeRequest) => Promise<boolean>} [deps.confirmNative] without it nothing that needs a confirmation proceeds when Touch ID is unavailable
 * @param {(key: string, options?: Record<string, unknown>) => string} deps.t
 * @param {{ warn: (m: string) => void }} [deps.logger]
 */
function createHostConfirm ({ authenticate, confirmNative, t, logger }) {
  let confirming = false
  /** Declined hosts, keyed by scope ('backend' or 'search') and host. @type {Set<string>} */
  const declined = new Set()
  const scopeOf = (/** @type {Purpose} */ purpose) => (purpose === 'backend' ? 'backend' : 'search')

  return {
    /**
     * @param {string} host '' when the change names no host
     * @param {string} touchReason what Touch ID shows
     * @param {ConfirmOptions} [options]
     * @returns {Promise<boolean>} true only when the person allowed it
     * @throws {ConfirmRefused} for a host declined earlier, or while another confirmation is open
     */
    async confirm (host, touchReason, options = {}) {
      const purpose = options.purpose ?? 'backend'
      const declinedKey = `${scopeOf(purpose)}:${host}`
      if (declined.has(declinedKey)) throw new ConfirmRefused(t('agentSettings.errDeclinedHost'))
      if (confirming) throw new ConfirmRefused(t('agentSettings.errConfirmPending'))
      confirming = true
      let allowed = false
      try {
        if (authenticate.available()) {
          allowed = await authenticate.prompt(touchReason)
        } else {
          logger?.warn('[agent-settings] Touch ID is unavailable on this computer; asking in a native dialog')
          allowed = confirmNative ? await confirmNative({ host, purpose, keyFollows: options.keyFollows === true, getParent: options.getParent }) : false
        }
      } finally {
        confirming = false
      }
      if (!allowed) declined.add(declinedKey)
      return allowed
    },

    /**
     * A window was closed or recreated: forget the hosts declined in its life. With a scope
     * ('backend' for the Web UI window, 'search' for the Search window) only that window's
     * declines go; without one, all of them.
     *
     * @param {'backend' | 'search'} [scope]
     */
    forgetDeclined (scope) {
      if (scope === undefined) { declined.clear(); return }
      for (const key of [...declined]) if (key.startsWith(`${scope}:`)) declined.delete(key)
    }
  }
}

module.exports = { createHostConfirm, ConfirmRefused }
