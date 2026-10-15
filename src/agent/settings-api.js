// @ts-check
/* global AbortSignal */
// The main process's HTTP client for the settings route of the supervised `ipfs mcp`
// sidecar (mcp/server settings.go): GET and PUT /agent/settings, POST .../test-connection,
// GET .../models and the change stream .../events. Every call carries the sidecar's
// desktop-admin bearer, read from the safeStorage-backed token store at call time and
// never kept, logged or returned. The target is always http://127.0.0.1:<port> for the
// port the sidecar reported; nothing the renderer sends can change it.

const ROUTE = '/agent/settings'
const ROUTE_TEST = `${ROUTE}/test-connection`
const ROUTE_MODELS = `${ROUTE}/models`
const ROUTE_EVENTS = `${ROUTE}/events`
const REQUEST_TIMEOUT_MS = 20000
// A response above this is not a settings answer; refuse it instead of buffering it.
const MAX_BODY_BYTES = 4 * 1024 * 1024
// The `details` of a contract error: these two fields, as short strings, nothing else.
const DETAIL_KEYS = Object.freeze(['current_revision', 'host'])
const DETAIL_MAX = 260

/** The closed code set of mcp/contract/settings/settings-error.schema.json. */
const SETTINGS_ERROR_CODES = Object.freeze([
  'backend_not_configured',
  'revision_conflict',
  'egress_confirmation_required',
  'secrets_not_accepted'
])

/**
 * A non-2xx answer. `shape` is the contract error body when the server sent one (a
 * `{error: {code, message, details?}}` document with a code from the closed set); it is
 * null for HTTP-level failures (400, 401, 404, 5xx), which carry only a status and a short
 * text. Neither ever holds key material.
 */
class SettingsApiError extends Error {
  /**
   * @param {number} status
   * @param {{ error: { code: string, message: string, details?: object } } | null} shape
   * @param {string} text
   */
  constructor (status, shape, text) {
    super(shape ? shape.error.message : text)
    this.name = 'SettingsApiError'
    this.status = status
    this.shape = shape
  }
}

/**
 * @param {unknown} body
 * @returns {{ error: { code: string, message: string, details?: object } } | null}
 */
function asSettingsError (body) {
  if (typeof body !== 'object' || body === null) return null
  const error = /** @type {any} */(body).error
  if (typeof error !== 'object' || error === null) return null
  if (!SETTINGS_ERROR_CODES.includes(error.code) || typeof error.message !== 'string' || error.message === '') return null
  /** @type {{ error: { code: string, message: string, details?: object } }} */
  const out = { error: { code: error.code, message: error.message.slice(0, 2000) } }
  // Only the two detail fields the contract names, and only as bounded strings: whatever
  // else the sidecar put in `details` stays here.
  if (typeof error.details === 'object' && error.details !== null && !Array.isArray(error.details)) {
    /** @type {Record<string, string>} */
    const details = {}
    for (const key of DETAIL_KEYS) {
      const value = error.details[key]
      if (typeof value === 'string' && value.length > 0 && value.length <= DETAIL_MAX) details[key] = value
    }
    if (Object.keys(details).length > 0) out.error.details = details
  }
  return out
}

/**
 * Read the body up to MAX_BODY_BYTES. The cap is enforced while reading, so an answer
 * that never ends is cut off at the cap instead of being buffered first.
 *
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function readText (res) {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) throw new Error('the agent service answered with an oversized body')
  if (res.body === null || res.body === undefined || typeof res.body.getReader !== 'function') {
    const text = await res.text()
    if (text.length > MAX_BODY_BYTES) throw new Error('the agent service answered with an oversized body')
    return text
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) throw new Error('the agent service answered with an oversized body')
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    try { await reader.cancel() } catch (_) {}
  }
}

/**
 * @param {object} deps
 * @param {() => string | null} deps.getBaseUrl `http://127.0.0.1:<port>` while the sidecar runs, else null
 * @param {() => string | undefined} deps.getAdminToken
 * @param {typeof fetch} [deps.fetchFn]
 * @param {number} [deps.timeoutMs]
 */
function createSettingsApi ({ getBaseUrl, getAdminToken, fetchFn = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  /**
   * @param {string} path
   * @param {{ method?: string, headers?: Record<string, string>, body?: unknown, signal?: AbortSignal, timeout?: boolean }} [opts]
   * @returns {Promise<{ status: number, headers: Headers, body: any }>}
   */
  async function call (path, { method = 'GET', headers = {}, body, signal, timeout = true } = {}) {
    const base = getBaseUrl()
    if (base === null) throw new SettingsApiError(0, null, 'the agent service is not running')
    const token = getAdminToken()
    if (token === undefined) throw new SettingsApiError(0, null, 'the Desktop admin token is not available')
    const signals = []
    if (signal) signals.push(signal)
    if (timeout) signals.push(AbortSignal.timeout(timeoutMs))
    let res
    try {
      res = await fetchFn(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: signals.length === 0 ? undefined : (signals.length === 1 ? signals[0] : AbortSignal.any(signals))
      })
    } catch (err) {
      const name = /** @type {Error} */(err)?.name
      if (name === 'TimeoutError' || name === 'AbortError') throw new SettingsApiError(0, null, 'the agent service did not answer in time')
      throw new SettingsApiError(0, null, 'the agent service could not be reached')
    }
    const text = await readText(res)
    /** @type {any} */
    let parsed = null
    if (text !== '') {
      try { parsed = JSON.parse(text) } catch (_) { parsed = null }
    }
    if (!res.ok) {
      throw new SettingsApiError(res.status, asSettingsError(parsed), text.trim().slice(0, 200) || `HTTP ${res.status}`)
    }
    return { status: res.status, headers: res.headers, body: parsed }
  }

  return {
    /** @returns {Promise<any>} the read shape (settings-read.schema.json) */
    async get () {
      return (await call(ROUTE)).body
    },

    /**
     * @param {string} revision
     * @param {object} write settings-write.schema.json body
     * @returns {Promise<any>} the read shape with the new revision
     */
    async put (revision, write) {
      return (await call(ROUTE, { method: 'PUT', headers: { 'If-Match': `"${revision}"` }, body: write })).body
    },

    /** @param {{ base_url: string, kind?: string }} req */
    async testConnection (req) {
      return (await call(ROUTE_TEST, { method: 'POST', body: req })).body
    },

    /**
     * @param {string} baseUrl
     * @param {string} [kind]
     */
    async listModels (baseUrl, kind) {
      const query = new URLSearchParams({ base_url: baseUrl })
      if (kind) query.set('kind', kind)
      return (await call(`${ROUTE_MODELS}?${query.toString()}`)).body
    },

    /**
     * Open the change stream and call `onRevision` for each `settings_changed` event until
     * `signal` aborts or the stream ends. Resolves when the stream ends; rejects when it
     * cannot be opened. Anything that is not a well-formed event is dropped.
     *
     * @param {(revision: string) => void} onRevision
     * @param {AbortSignal} signal
     */
    async streamEvents (onRevision, signal) {
      const base = getBaseUrl()
      const token = getAdminToken()
      if (base === null || token === undefined) throw new SettingsApiError(0, null, 'the agent service is not running')
      let res
      try {
        res = await fetchFn(base + ROUTE_EVENTS, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          redirect: 'error',
          signal
        })
      } catch (_) {
        throw new SettingsApiError(0, null, 'the agent service could not be reached')
      }
      if (!res.ok || res.body === null) throw new SettingsApiError(res.status, null, `HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          if (buffer.length > 64 * 1024) throw new Error('the settings event stream sent an oversized event')
          let end
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const revision = parseEventRevision(block)
            if (revision !== null) onRevision(revision)
          }
        }
      } finally {
        try { await reader.cancel() } catch (_) {}
      }
    }
  }
}

/**
 * The revision of one SSE block, or null when it is a comment, another kind of event or
 * not the contract's `{type: 'settings_changed', revision}` payload.
 *
 * @param {string} block
 * @returns {string | null}
 */
function parseEventRevision (block) {
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
  if (data === '') return null
  try {
    const event = JSON.parse(data)
    if (event && event.type === 'settings_changed' && typeof event.revision === 'string' && event.revision.length > 0 && event.revision.length <= 256) return event.revision
  } catch (_) {}
  return null
}

module.exports = { createSettingsApi, SettingsApiError, asSettingsError, parseEventRevision, SETTINGS_ERROR_CODES, ROUTE, ROUTE_TEST, ROUTE_MODELS, ROUTE_EVENTS }
