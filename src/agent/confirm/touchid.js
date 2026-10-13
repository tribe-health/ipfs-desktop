// @ts-check
// Approval in this app needs the operating system's Touch ID, so a click on a button, real
// or injected, is not enough on its own (operator decision, 2026-10-12). Electron offers
// it on macOS only: `systemPreferences.promptTouchID(reason)` resolves when the person
// authenticated and rejects when they cancel or fail. On any other computer, or a Mac
// without Touch ID, this app cannot approve and says so; it can still deny.

/**
 * @param {{ canPromptTouchID?: () => boolean, promptTouchID?: (reason: string) => Promise<void> } | undefined} systemPreferences
 * @param {string} [platform]
 * @returns {import('./controller').Authenticator}
 */
function createTouchId (systemPreferences, platform = process.platform) {
  return {
    available () {
      return platform === 'darwin' && typeof systemPreferences?.canPromptTouchID === 'function' && systemPreferences.canPromptTouchID() === true
    },
    async prompt (reason) {
      if (!this.available() || typeof systemPreferences?.promptTouchID !== 'function') return false
      try {
        await systemPreferences.promptTouchID(reason)
        return true
      } catch (_) {
        return false
      }
    }
  }
}

module.exports = { createTouchId }
