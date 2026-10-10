// @ts-check
// Names shared by the main process and tests. The preload (src/webui/preload.js) runs
// in the sandbox and cannot require this file, so it carries copies of CHANNELS and
// ARG_AGENT_CHAT; test/unit/agent-bridge.spec.js fails when the copies drift.

/** Store keys. The token key holds ciphertext only (see token-store.js). */
const KEYS = Object.freeze({
  ENABLED: 'agentChat.enabled',
  ENDPOINT: 'agentChat.endpoint',
  TOKEN_CIPHERTEXT: 'agentChat.tokenCipher'
})

/** IPC channels. Both are `ipcMain.handle`, registered only while the chat is enabled. */
const CHANNELS = Object.freeze({
  GET_ENDPOINT: 'ipfs-desktop:agent-chat:get-endpoint',
  GET_TOKEN: 'ipfs-desktop:agent-chat:get-token'
})

/** Command-line flag the main process sets on the Web UI window when the chat is on. */
const ARG_AGENT_CHAT = '--ipfs-desktop-agent-chat=1'

module.exports = { KEYS, CHANNELS, ARG_AGENT_CHAT }
