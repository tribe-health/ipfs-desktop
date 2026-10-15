// @ts-check
// Changing the Search settings from the Desktop window, in the main process:
//
//   1. validate the request (unknown fields are refused, paths are absolute, the embedder and
//      describer URLs are https or loopback http with no credentials);
//   2. for each non-loopback host that is new, ask the person, naming the host and saying
//      that file content goes to it: Touch ID, else the native dialog, through the same gate
//      as the agent backend (src/agent/host-confirm.js). A refusal changes nothing;
//   3. persist the values and the confirmed hosts (hosts no longer configured, and all of
//      them when Search is turned off, are dropped, which removes their egress entries);
//   4. restart the sidecar once, because embedding settings are not hot-reloaded
//      (ADR-0011 V6). A bulk run in progress comes back `paused`; the result says so.

const { SEARCH_KEYS, readSearchSettings, searchHosts, parseEndpoint } = require('../../daemon/mcp-sidecar-search')
const { ConfirmRefused } = require('../host-confirm')
const { buildSearchView } = require('./view')

const PATH_MAX = 4096
const MODEL_MAX = 256
const DIM_MAX = 8192

/** A refused request or confirmation. The message is user-facing text. */
class SearchFailure extends Error {
  /**
   * @param {string} message
   * @param {string} [field] the form field the refusal is about (surrealBinary, xbergBinary, embedderUrl, embedderModel, embedderDimensions, describerUrl, describerModel), so the window can mark it
   */
  constructor (message, field) {
    super(message)
    this.name = 'SearchFailure'
    this.field = field
  }
}

const isRecord = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} allowed
 * @param {(key: string) => string} t
 */
function onlyKeys (obj, allowed, t) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new SearchFailure(t('agentSearch.errUnknownField'))
  }
}

/**
 * @param {unknown} input
 * @param {(key: string, options?: Record<string, unknown>) => string} t
 * @returns {{ enabled: boolean, surrealBinary: string, xbergBinary: string, embedder: { baseUrl: string, model: string, dimensions: number | null }, describer: { baseUrl: string, model: string } | null }}
 */
function validateSearchInput (input, t) {
  if (!isRecord(input)) throw new SearchFailure(t('agentSearch.errInvalid'))
  onlyKeys(input, ['enabled', 'surrealBinary', 'xbergBinary', 'embedder', 'describer'], t)
  if (typeof input.enabled !== 'boolean') throw new SearchFailure(t('agentSearch.errInvalid'))
  const path = (/** @type {unknown} */ v, /** @type {string} */ field) => {
    if (v === undefined || v === '') return ''
    if (typeof v !== 'string' || v.length > PATH_MAX || v.includes('\0') || !require('path').isAbsolute(v)) throw new SearchFailure(t('agentSearch.errPath'), field)
    return v.trim()
  }
  const embedderIn = input.embedder === undefined ? {} : input.embedder
  if (!isRecord(embedderIn)) throw new SearchFailure(t('agentSearch.errInvalid'))
  onlyKeys(embedderIn, ['baseUrl', 'model', 'dimensions'], t)
  const endpoint = (/** @type {unknown} */ v, /** @type {string} */ field) => {
    if (v === undefined || v === '') return ''
    if (typeof v !== 'string' || parseEndpoint(v.trim()) === null) throw new SearchFailure(t('agentSearch.errUrl'), field)
    return v.trim()
  }
  const model = (/** @type {unknown} */ v, /** @type {string} */ field) => {
    if (v === undefined || v === '') return ''
    if (typeof v !== 'string' || v.length > MODEL_MAX) throw new SearchFailure(t('agentSearch.errModel'), field)
    return v.trim()
  }
  let dimensions = null
  if (embedderIn.dimensions !== undefined && embedderIn.dimensions !== '' && embedderIn.dimensions !== null) {
    const n = typeof embedderIn.dimensions === 'string' ? Number(embedderIn.dimensions) : embedderIn.dimensions
    if (!Number.isInteger(n) || /** @type {number} */(n) < 1 || /** @type {number} */(n) > DIM_MAX) throw new SearchFailure(t('agentSearch.errDimensions'), 'embedderDimensions')
    dimensions = /** @type {number} */(n)
  }
  const out = {
    enabled: input.enabled,
    surrealBinary: path(input.surrealBinary, 'surrealBinary'),
    xbergBinary: path(input.xbergBinary, 'xbergBinary'),
    embedder: { baseUrl: endpoint(embedderIn.baseUrl, 'embedderUrl'), model: model(embedderIn.model, 'embedderModel'), dimensions },
    /** @type {{ baseUrl: string, model: string } | null} */
    describer: null
  }
  if (input.describer !== undefined && input.describer !== null) {
    if (!isRecord(input.describer)) throw new SearchFailure(t('agentSearch.errInvalid'))
    onlyKeys(input.describer, ['baseUrl', 'model'], t)
    const baseUrl = endpoint(input.describer.baseUrl, 'describerUrl')
    const dm = model(input.describer.model, 'describerModel')
    if (baseUrl !== '' || dm !== '') {
      if (baseUrl === '' || dm === '') throw new SearchFailure(t('agentSearch.errDescriber'), baseUrl === '' ? 'describerUrl' : 'describerModel')
      out.describer = { baseUrl, model: dm }
    }
  }
  if (out.enabled) {
    const checks = /** @type {[string, boolean][]} */([
      ['surrealBinary', out.surrealBinary === ''],
      ['xbergBinary', out.xbergBinary === ''],
      ['embedderUrl', out.embedder.baseUrl === ''],
      ['embedderModel', out.embedder.model === ''],
      ['embedderDimensions', out.embedder.dimensions === null]
    ])
    const missing = checks.find(([, empty]) => empty)?.[0] ?? null
    if (missing !== null) throw new SearchFailure(t('agentSearch.errIncomplete'), missing)
  }
  return out
}

/**
 * @param {object} deps
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void, delete: (key: string) => void, safeSet?: (key: string, value: any) => void }} deps.store
 * @param {() => ({ restart: () => Promise<void>, getState: () => string, getSearchState: () => { state: 'off' | 'on' | 'unavailable', reason?: string, detail?: string } } | null)} deps.getSidecar
 * @param {{ confirm: (host: string, touchReason: string) => Promise<boolean> }} deps.hostConfirm
 * @param {() => ({ isDestroyed: () => boolean, isVisible?: () => boolean } | null | undefined)} [deps.getParentWindow] the Search window, which the native dialog is parented to while it is visible
 * @param {() => Promise<string | null>} [deps.bulkRunState] the state of the node's bulk run ('running', 'paused', ...), null when there is none or it cannot be read
 * @param {(key: string, options?: Record<string, unknown>) => string} deps.t
 * @param {{ info: (m: string) => void, warn: (m: string) => void }} [deps.logger]
 */
function createSearchService ({ store, getSidecar, hostConfirm, getParentWindow, bulkRunState = async () => null, t, logger }) {
  let bulkPaused = false

  const persist = (/** @type {string} */ key, /** @type {unknown} */ value) => {
    if (typeof store.safeSet === 'function') store.safeSet(key, value)
    else store.set(key, value)
  }

  const view = () => buildSearchView({ store, searchState: getSidecar()?.getSearchState() ?? null, bulkPaused, t })

  return {
    get: view,

    /**
     * The warnings for what is typed in the form, before anything is saved: an address that
     * is not on this computer says where the text or the files would go. Nothing is stored
     * or confirmed, and a value that is not an address yet simply has no warning.
     *
     * @param {unknown} input
     * @returns {{ id: string, text: string }[]}
     */
    preview (input) {
      if (!isRecord(input)) return []
      const urlOf = (/** @type {unknown} */ v) => (isRecord(v) && typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '')
      /** @type {{ id: string, text: string }[]} */
      const out = []
      const embedder = parseEndpoint(urlOf(input.embedder))
      if (embedder && !embedder.loopback) out.push({ id: 'embedderRemote', text: t('agentSearch.warn.embedderRemote', { host: embedder.host }) })
      const describer = parseEndpoint(urlOf(input.describer))
      if (describer && !describer.loopback) out.push({ id: 'describerRemote', text: t('agentSearch.warn.describerRemote', { host: describer.host }) })
      if (urlOf(input.describer) !== '') out.push({ id: 'videoHosted', text: t('agentSearch.warn.videoHosted') })
      return out
    },

    /** @param {unknown} input */
    async apply (input) {
      const next = validateSearchInput(input, t)
      const before = readSearchSettings(store)
      const hosts = searchHosts({ ...before, enabled: true, embedder: { ...next.embedder }, describer: next.describer })

      // Only a host that is going to be used, that is not on this computer, and that the
      // person has not already confirmed is asked about.
      /** @type {string[]} */
      let confirmed = []
      if (next.enabled) {
        const remote = hosts.filter((h) => !h.loopback)
        confirmed = before.confirmedHosts.filter((h) => remote.some((r) => r.host === h))
        for (const { host, role } of remote) {
          if (confirmed.includes(host)) continue
          let allowed
          try {
            allowed = await hostConfirm.confirm(host, t(role === 'embedder' ? 'agentSearch.touchReasonEmbedder' : 'agentSearch.touchReasonDescriber', { host }), {
              purpose: role === 'embedder' ? 'searchText' : 'searchImages',
              getParent: getParentWindow
            })
          } catch (err) {
            if (err instanceof ConfirmRefused) throw new SearchFailure(err.message, role === 'embedder' ? 'embedderUrl' : 'describerUrl')
            throw err
          }
          if (!allowed) throw new SearchFailure(t('agentSearch.errNotConfirmed', { host }), role === 'embedder' ? 'embedderUrl' : 'describerUrl')
          confirmed = [...confirmed, host]
        }
      }

      const changed = before.enabled !== next.enabled ||
        before.surrealBinary !== next.surrealBinary || before.xbergBinary !== next.xbergBinary ||
        before.embedder.baseUrl !== next.embedder.baseUrl || before.embedder.model !== next.embedder.model || before.embedder.dimensions !== next.embedder.dimensions ||
        (before.describer?.baseUrl ?? '') !== (next.describer?.baseUrl ?? '') || (before.describer?.model ?? '') !== (next.describer?.model ?? '') ||
        before.confirmedHosts.length !== confirmed.length || before.confirmedHosts.some((h, i) => h !== confirmed[i])
      if (!changed) return { view: view(), restarted: false, bulkPaused }

      // Learn about a running bulk run before the restart ends it.
      let runWasRunning = false
      const sidecar = getSidecar()
      if (sidecar && sidecar.getState() === 'running') {
        try { runWasRunning = (await bulkRunState()) === 'running' } catch (_) {}
      }

      persist(SEARCH_KEYS.ENABLED, next.enabled)
      persist(SEARCH_KEYS.SURREAL_BINARY, next.surrealBinary)
      persist(SEARCH_KEYS.XBERG_BINARY, next.xbergBinary)
      persist(SEARCH_KEYS.EMBEDDER_URL, next.embedder.baseUrl)
      persist(SEARCH_KEYS.EMBEDDER_MODEL, next.embedder.model)
      persist(SEARCH_KEYS.EMBEDDER_DIMENSIONS, next.embedder.dimensions)
      persist(SEARCH_KEYS.DESCRIBER_URL, next.describer?.baseUrl ?? '')
      persist(SEARCH_KEYS.DESCRIBER_MODEL, next.describer?.model ?? '')
      persist(SEARCH_KEYS.CONFIRMED_HOSTS, confirmed)
      logger?.info(`[agent-search] settings changed (Search ${next.enabled ? 'on' : 'off'}); restarting the agent endpoint`)

      // One restart for the whole change. restart() is a no-op while the sidecar has no
      // repo (no daemon) and starts nothing when the endpoint was switched off.
      let restarted = false
      if (sidecar) {
        await sidecar.restart()
        restarted = true
      }
      bulkPaused = restarted && runWasRunning
      return { view: view(), restarted, bulkPaused }
    }
  }
}

module.exports = { createSearchService, validateSearchInput, SearchFailure }
