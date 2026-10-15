// @ts-check
// The agent features ship on (kubo AGENTS.md, "User Agency": the local `ipfs mcp` endpoint,
// the Web UI agent chat and the Desktop confirmation window), each with a documented off
// switch. This runs once at app start and writes `true` only for a key the store does not
// hold. A stored value of any kind, `false` above all, is the operator's decision and is
// never rewritten, so an opt-out made on an earlier version survives every upgrade.

const { KEYS } = require('./consts')

const SIDECAR_ENABLED_KEY = 'mcpSidecar.enabled'

/**
 * The switch keys that default to on, for this platform. The confirmation window needs the
 * server's Unix socket, so it is never switched on for Windows.
 *
 * @param {string} platform
 * @returns {string[]}
 */
function defaultOnKeys (platform) {
  const keys = [KEYS.ENABLED, SIDECAR_ENABLED_KEY]
  if (platform !== 'win32') keys.push(KEYS.CONFIRM_ENABLED)
  return keys
}

/**
 * @param {object} deps
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => any }} deps.store
 * @param {string} [deps.platform]
 * @param {{ info: (m: string) => void }} [deps.logger]
 * @returns {string[]} the keys this call wrote
 */
function applyAgentDefaults ({ store, platform = process.platform, logger }) {
  const written = []
  for (const key of defaultOnKeys(platform)) {
    if (store.get(key) !== undefined) continue
    store.set(key, true)
    written.push(key)
  }
  if (written.length > 0) logger?.info(`[agent-defaults] switched on by default: ${written.join(', ')}. Each can be turned off in the tray menu or by setting it to false in the Desktop store.`)
  return written
}

module.exports = { applyAgentDefaults, defaultOnKeys, SIDECAR_ENABLED_KEY }
