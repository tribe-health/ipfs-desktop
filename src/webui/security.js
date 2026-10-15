// @ts-check
// Security posture of the Web UI window: its webPreferences and the Content Security
// Policy served with every `webui://localhost` response. See docs/agent/HARDENING.md.
//
// Nothing in here reads the network or a default endpoint. The only origins a policy can
// name are the node's own API and gateway (known from the running daemon) and the
// operator-configured `ipfs mcp` origin, which is absent unless the agent chat is on.

const WEBUI_ORIGIN = 'webui://localhost'

/**
 * Whether a URL belongs to the Web UI's own origin. Node reports `origin` as "null" for a
 * non-special scheme such as webui:, so compare scheme and host instead.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isWebUiUrl (value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}` === WEBUI_ORIGIN
  } catch (_) {
    return false
  }
}

/**
 * Reduce a URL to an http(s) origin, or null. Wildcards, credentials, paths that carry
 * meaning, other schemes and unparsable input are all refused, so a bad config value
 * can only ever narrow the policy, never widen it.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function toHttpOrigin (value) {
  if (typeof value !== 'string' || value.includes('*')) return null
  let url
  try {
    url = new URL(value)
  } catch (_) {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  return url.origin
}

/**
 * The http origin a multiaddr of the form /ip4|ip6|dns|dns4|dns6/<host>/tcp/<port>
 * (optionally followed by /http, /https or /tls/http) is reachable on from this machine.
 * A wildcard bind address maps to loopback. Anything else, including a multiaddr with no
 * tcp part, yields null, which leaves that origin out of the policy.
 *
 * @param {{ toString: () => string } | string | null | undefined} addr
 * @returns {string | null}
 */
function originFromMultiaddr (addr) {
  if (addr === null || addr === undefined) return null
  const match = /^\/(ip4|ip6|dns|dns4|dns6)\/([^/]+)\/tcp\/(\d{1,5})((?:\/tls)?\/https?)?$/.exec(String(addr))
  if (match === null) return null
  const [, family, rawHost, port, suffix] = match
  let host = rawHost
  if (host === '0.0.0.0') host = '127.0.0.1'
  else if (host === '::') host = '::1'
  if (family === 'ip6') host = `[${host}]`
  const scheme = suffix !== undefined && (suffix.includes('https') || suffix.includes('tls')) ? 'https' : 'http'
  return toHttpOrigin(`${scheme}://${host}:${port}`)
}

/**
 * @typedef {object} CspSources
 * @property {string | null | undefined} [apiOrigin] the node's RPC origin
 * @property {string | null | undefined} [gatewayOrigin] the node's gateway origin
 * @property {string | null | undefined} [mcpOrigin] the `ipfs mcp` origin; only when the agent chat is on
 * @property {string | null | undefined} [sidecarOrigin] the supervised `ipfs mcp` sidecar's loopback origin; only while the agent settings bridge is on and the sidecar runs
 */

const LOOPBACK_HTTP_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/

/**
 * Like toHttpOrigin, but only for a plain-http loopback origin with a port: the one shape
 * the Desktop-supervised sidecar can have. Anything else, a remote host or https included,
 * yields null, so no value can widen the policy beyond this computer.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function toLoopbackOrigin (value) {
  const origin = toHttpOrigin(value)
  return origin !== null && LOOPBACK_HTTP_ORIGIN.test(origin) ? origin : null
}

/**
 * The policy for `webui://localhost`. `script-src 'self'` with no `unsafe-eval` and no
 * `unsafe-inline` (`wasm-unsafe-eval` only lets WebAssembly compile, the Web UI loads
 * WASM modules; it does not allow `eval` or `new Function`); `connect-src` names the RPC origin, the gateway origin and, when the
 * agent chat is on, the one `ipfs mcp` origin. No wildcard, no remote asset origin.
 *
 * @param {CspSources} sources
 * @returns {string}
 */
function buildCsp ({ apiOrigin, gatewayOrigin, mcpOrigin, sidecarOrigin } = {}) {
  const api = toHttpOrigin(apiOrigin)
  const gateway = toHttpOrigin(gatewayOrigin)
  const mcp = toHttpOrigin(mcpOrigin)
  const sidecar = toLoopbackOrigin(sidecarOrigin)
  const list = (/** @type {Array<string | null>} */ ...origins) => [...new Set(origins.filter(Boolean))].join(' ')

  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${list("'self'", 'data:', 'blob:', gateway)}`,
    `media-src ${list("'self'", 'blob:', gateway)}`,
    "font-src 'self' data:",
    `connect-src ${list("'self'", api, gateway, mcp, sidecar)}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

/**
 * Serve the policy with every `webui://localhost` response. The sources are read per
 * response, so a restarted daemon on a new port or a changed agent-chat setting takes
 * effect on the next load without re-registering the hook.
 *
 * @param {import('electron').Session} ses
 * @param {() => CspSources} getSources
 */
function installCsp (ses, getSources) {
  ses.webRequest.onHeadersReceived({ urls: [`${WEBUI_ORIGIN}/*`] }, (details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) }
    for (const name of Object.keys(responseHeaders)) {
      if (name.toLowerCase() === 'content-security-policy') delete responseHeaders[name]
    }
    responseHeaders['Content-Security-Policy'] = [buildCsp(getSources())]
    callback({ responseHeaders }) // eslint-disable-line
  })
}

/**
 * Window options for the Web UI. `webSecurity` stays on: the renderer is held to the
 * same-origin policy and CORS like any page, which is why the node's API must list
 * `webui://localhost` as an allowed origin (see daemon/config.js). The preload runs in
 * the sandbox with context isolation and exposes only what `contextBridge` hands over.
 *
 * @param {object} options
 * @param {string} options.preload absolute path to the preload script
 * @param {string[]} [options.additionalArguments] flags the preload reads from process.argv
 * @param {boolean} [options.allowNodeIntegration] test runs only; never set in production
 * @returns {import('electron').WebPreferences}
 */
function webPreferences ({ preload, additionalArguments = [], allowNodeIntegration = false }) {
  return {
    preload,
    additionalArguments,
    webSecurity: true,
    allowRunningInsecureContent: false,
    contextIsolation: true,
    sandbox: !allowNodeIntegration,
    nodeIntegration: allowNodeIntegration,
    webviewTag: false,
    // Spellchecker and other optional network features are not needed by the Web UI.
    spellcheck: false
  }
}

module.exports = { WEBUI_ORIGIN, isWebUiUrl, toHttpOrigin, toLoopbackOrigin, originFromMultiaddr, buildCsp, installCsp, webPreferences }
