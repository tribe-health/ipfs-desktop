// @ts-check
// The confirmation for a backend, egress or key-destination decision on a computer without
// Touch ID (Mac mini, Studio, Pro, a clamshell MacBook, no enrolled finger, Windows, Linux).
// It is a native dialog opened by the main process and parented to the window that asked
// (the Web UI window for the agent backend, the Search window for Search; the request names
// it), so neither a page nor a script in it can click it, and it names the host and what
// goes there: the agent's model calls, the text of files, or image files. It is parented
// only to a visible window; otherwise it is an ordinary unparented dialog. Cancel is the
// default button and the cancel id: Escape, closing the dialog and Enter all refuse.

/**
 * @param {object} deps
 * @param {{ showMessageBox: (...args: any[]) => Promise<{ response: number }> }} deps.dialog Electron's dialog
 * @param {() => ({ isDestroyed: () => boolean, isVisible?: () => boolean } | null | undefined)} deps.getWindow the Web UI window; the dialog is parented to it only while it is visible (a sheet on a hidden window may never show on macOS), otherwise it opens unparented
 * @param {(key: string, options?: Record<string, unknown>) => string} deps.t
 * @returns {(request: { host: string, purpose?: 'backend' | 'searchText' | 'searchImages', keyFollows?: boolean, getParent?: () => ({ isDestroyed: () => boolean, isVisible?: () => boolean } | null | undefined) }) => Promise<boolean>}
 */
function createNativeHostConfirm ({ dialog, getWindow, t }) {
  const CONFIRM = 0
  const CANCEL = 1
  /** The title, message and detail for what the confirmation is for. */
  function copy (/** @type {string} */ host, /** @type {string | undefined} */ purpose, /** @type {boolean | undefined} */ keyFollows) {
    if (purpose === 'searchText' || purpose === 'searchImages') {
      const kind = purpose === 'searchText' ? 'Text' : 'Images'
      return {
        title: t('agentSearch.dialog.title'),
        message: t(`agentSearch.dialog.message${kind}`, { host }),
        detail: t(`agentSearch.dialog.detail${kind}`, { host })
      }
    }
    return {
      title: t('agentSettings.dialog.title'),
      message: host ? t('agentSettings.dialog.messageHost', { host }) : t('agentSettings.dialog.messageBackend'),
      detail: t(keyFollows ? 'agentSettings.dialog.detailKeyFollows' : 'agentSettings.dialog.detail')
    }
  }

  return async function confirm ({ host, purpose, keyFollows, getParent }) {
    const options = {
      type: 'warning',
      buttons: [t('agentSettings.dialog.confirm'), t('agentSettings.dialog.cancel')],
      defaultId: CANCEL,
      cancelId: CANCEL,
      noLink: true,
      ...copy(host, purpose, keyFollows)
    }
    // The window that asked, when the request names one; the Web UI window otherwise.
    const win = typeof getParent === 'function' ? getParent() : getWindow()
    try {
      const result = win && !win.isDestroyed() && typeof win.isVisible === 'function' && win.isVisible()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      return result.response === CONFIRM
    } catch (_) {
      return false
    }
  }
}

module.exports = { createNativeHostConfirm }
