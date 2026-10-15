// @ts-check
// The one `ipfs mcp` sidecar of the app, for the Web UI bridge and the tray to read and
// drive. src/daemon/index.js sets it when it creates the supervisor; nothing here starts
// anything.

/** @type {ReturnType<typeof import('../daemon/mcp-sidecar').createMcpSidecar> | null} */
let sidecar = null

/** @param {ReturnType<typeof import('../daemon/mcp-sidecar').createMcpSidecar> | null} next */
function setMcpSidecar (next) {
  sidecar = next
}

function getMcpSidecar () {
  return sidecar
}

/**
 * The loopback origin the main process may talk to, or null. Only a sidecar that is
 * 'running' qualifies, and 'running' means its child printed its own bound address: while
 * it is 'starting' the port is only a request, and a different process may hold it.
 *
 * @param {{ getState: () => string, getPort: () => number } | null} candidate
 * @param {boolean} [enabled] the bridge's own off switch
 * @returns {string | null}
 */
function sidecarBaseUrl (candidate, enabled = true) {
  return enabled && candidate && candidate.getState() === 'running' ? `http://127.0.0.1:${candidate.getPort()}` : null
}

module.exports = { setMcpSidecar, getMcpSidecar, sidecarBaseUrl }
