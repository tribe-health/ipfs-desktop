// @ts-check
/* global AbortSignal, fetch */
// Reads the node's bulk indexing run state from the sidecar's `GET /index/status`, so the
// Search window can say "paused" after a restart ended a run. The request carries the
// Desktop `ui` principal's bearer (the `admin` principal is refused on /index/*), goes only
// to the loopback port the sidecar reported, and returns nothing but the run's state word.

const STATES = ['running', 'paused', 'completed', 'cancelled', 'failed']
const TIMEOUT_MS = 5000

/**
 * @param {object} deps
 * @param {() => string | null} deps.getBaseUrl http://127.0.0.1:<port> of a running sidecar, else null
 * @param {() => string | undefined} deps.getUiToken
 * @param {typeof fetch} [deps.fetchFn]
 * @returns {() => Promise<string | null>}
 */
function createBulkRunState ({ getBaseUrl, getUiToken, fetchFn = fetch }) {
  return async function bulkRunState () {
    const base = getBaseUrl()
    const token = getUiToken()
    if (!base || !token) return null
    const res = await fetchFn(`${base}/index/status`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) return null
    const body = /** @type {any} */(await res.json())
    const state = body?.bulk_run?.state
    return typeof state === 'string' && STATES.includes(state) ? state : null
  }
}

module.exports = { createBulkRunState }
