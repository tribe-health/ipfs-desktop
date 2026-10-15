// @ts-check
// What the Search section shows, as data: the saved values, the state of the sidecar's
// Search, and the warnings and notes that go with them. The window renders this and nothing
// else, so a test reads the same thing the person sees. Off on a fresh profile.

const { readSearchSettings, searchHosts } = require('../../daemon/mcp-sidecar-search')

/**
 * @typedef {object} SearchView
 * @property {boolean} enabled
 * @property {{ surrealBinary: string, xbergBinary: string, embedderUrl: string, embedderModel: string, embedderDimensions: string, describerUrl: string, describerModel: string }} fields
 * @property {{ state: 'off' | 'on' | 'unavailable', message: string }} status
 * @property {{ id: string, text: string }[]} warnings shown beside the field they belong to
 * @property {{ id: string, text: string }[]} notes always-visible facts (cost, limits)
 * @property {boolean} bulkPaused a bulk run was running when the settings last changed and is now paused
 */

/**
 * @param {object} args
 * @param {{ get: (key: string, fallback?: any) => any }} args.store
 * @param {{ state: 'off' | 'on' | 'unavailable', reason?: string, detail?: string } | null} args.searchState from the sidecar (getSearchState), null when none exists
 * @param {boolean} [args.bulkPaused]
 * @param {(key: string, options?: Record<string, unknown>) => string} args.t
 * @returns {SearchView}
 */
function buildSearchView ({ store, searchState, bulkPaused = false, t }) {
  const settings = readSearchSettings(store)
  const hosts = searchHosts(settings)
  /** @type {{ id: string, text: string }[]} */
  const warnings = []
  for (const h of hosts) {
    if (h.loopback) continue
    warnings.push(h.role === 'embedder'
      ? { id: 'embedderRemote', text: t('agentSearch.warn.embedderRemote', { host: h.host }) }
      : { id: 'describerRemote', text: t('agentSearch.warn.describerRemote', { host: h.host }) })
  }
  // Present whenever a describer is set up: video is never sent, and why.
  if (settings.describer) warnings.push({ id: 'videoHosted', text: t('agentSearch.warn.videoHosted') })

  /** @type {SearchView['status']} */
  let status
  if (!settings.enabled) {
    status = { state: 'off', message: t('agentSearch.status.off') }
  } else if (searchState?.state === 'unavailable') {
    status = { state: 'unavailable', message: t(`agentSearch.reason.${searchState.reason ?? 'incomplete'}`, { detail: searchState.detail ?? '' }) }
  } else if (searchState?.state === 'on') {
    status = { state: 'on', message: t('agentSearch.status.on') }
  } else {
    // Switched on, and the sidecar has not applied it yet (not running, or not restarted).
    status = { state: 'unavailable', message: t('agentSearch.status.pending') }
  }

  return {
    enabled: settings.enabled,
    fields: {
      surrealBinary: settings.surrealBinary,
      xbergBinary: settings.xbergBinary,
      embedderUrl: settings.embedder.baseUrl,
      embedderModel: settings.embedder.model,
      embedderDimensions: settings.embedder.dimensions === null ? '' : String(settings.embedder.dimensions),
      describerUrl: settings.describer?.baseUrl ?? '',
      describerModel: settings.describer?.model ?? ''
    },
    status,
    warnings,
    notes: [
      { id: 'resources', text: t('agentSearch.note.resources') },
      { id: 'binaries', text: t('agentSearch.note.binaries') },
      { id: 'offline', text: t('agentSearch.note.offline') }
    ],
    bulkPaused
  }
}

module.exports = { buildSearchView }
