// @ts-check
// The tray entries for Search (src/tray.js builds the rest of the menu): a status line and
// "Search settings...", which opens the Search window. Search itself is turned on and off in
// that window, not here, because turning it on needs the programs and the embedder to be
// chosen first.

/**
 * @param {object} deps
 * @param {(key: string) => string} deps.t
 * @param {{ get: (key: string, fallback?: any) => any }} deps.store
 * @param {() => { getSearchState: () => { state: 'off' | 'on' | 'unavailable', reason?: string } } | null} deps.getSidecar
 * @param {() => { open: () => void } | null} deps.getSearchWindow
 */
function buildSearchItems ({ t, store, getSidecar, getSearchWindow }) {
  const enabled = store.get('search.enabled', false) === true
  // On, but the endpoint has not applied it yet (not running, or not restarted): pending,
  // the same word the window uses. Only a reason from the endpoint means it needs attention.
  const searchState = enabled ? (getSidecar()?.getSearchState() ?? null) : { state: 'off' }
  const status = searchState?.state === 'on'
    ? t('agentSearchTray.statusOn')
    : searchState?.state === 'off'
      ? t('agentSearchTray.statusOff')
      : searchState?.state === 'unavailable' && searchState.reason
        ? t('agentSearchTray.statusUnavailable')
        : t('agentSearchTray.statusPending')
  return [
    { id: 'agentSearch.status', label: status, enabled: false },
    { id: 'agentSearch.open', label: t('agentSearchTray.open'), click: () => { getSearchWindow()?.open() } }
  ]
}

module.exports = { buildSearchItems }
