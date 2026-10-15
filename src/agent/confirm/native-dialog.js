// @ts-check
// The confirmation for a backend, egress or key-destination decision on a computer without
// Touch ID (Mac mini, Studio, Pro, a clamshell MacBook, no enrolled finger, Windows, Linux).
// It is a native dialog opened by the main process and parented to the Web UI window, so
// neither the page nor a script in it can click it, and it names the host. Cancel is the
// default button and the cancel id: Escape, closing the dialog and Enter all refuse.

/**
 * @param {object} deps
 * @param {{ showMessageBox: (...args: any[]) => Promise<{ response: number }> }} deps.dialog Electron's dialog
 * @param {() => ({ isDestroyed: () => boolean } | null | undefined)} deps.getWindow the Web UI window
 * @param {(key: string, options?: Record<string, unknown>) => string} deps.t
 * @returns {(request: { host: string }) => Promise<boolean>}
 */
function createNativeHostConfirm ({ dialog, getWindow, t }) {
  const CONFIRM = 0
  const CANCEL = 1
  return async function confirm ({ host }) {
    const options = {
      type: 'warning',
      buttons: [t('agentSettings.dialog.confirm'), t('agentSettings.dialog.cancel')],
      defaultId: CANCEL,
      cancelId: CANCEL,
      noLink: true,
      title: t('agentSettings.dialog.title'),
      message: host ? t('agentSettings.dialog.messageHost', { host }) : t('agentSettings.dialog.messageBackend'),
      detail: t('agentSettings.dialog.detail')
    }
    const win = getWindow()
    try {
      const result = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      return result.response === CONFIRM
    } catch (_) {
      return false
    }
  }
}

module.exports = { createNativeHostConfirm }
