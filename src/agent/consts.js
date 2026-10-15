// @ts-check
// Names shared by the main process and tests. The preload (src/webui/preload.js) runs
// in the sandbox and cannot require this file, so it carries copies of CHANNELS,
// SETTINGS_CHANNELS, ARG_AGENT_CHAT and ARG_AGENT_SETTINGS; test/unit/agent-bridge.spec.js fails when the copies drift.

/** Store keys. The token and pairing keys hold ciphertext only (see secret-store.js). */
const KEYS = Object.freeze({
  ENABLED: 'agentChat.enabled',
  ENDPOINT: 'agentChat.endpoint',
  TOKEN_CIPHERTEXT: 'agentChat.tokenCipher',
  /**
   * The Desktop confirmation window. Opt-in and independent of the agent chat: it is on
   * only when this reads as true (see parseSwitch in confirm/index.js). The tray turns it
   * on and off; to turn it off by hand set it to false, or delete it, in the Desktop store.
   */
  CONFIRM_ENABLED: 'desktopConfirm.enabled',
  /** The `ipfs mcp pair` key, as safeStorage ciphertext. */
  PAIRING_CIPHERTEXT: 'desktopConfirm.pairingCipher',
  /**
   * The agent settings bridge (`ipfsDesktop.agentSettings.*`). On unless this reads as
   * false, like `mcpSidecar.enabled`; false means no preload API, no IPC handler and no
   * settings event stream. It moves nothing by itself: without a running sidecar every
   * call reports that the service is not running.
   */
  SETTINGS_ENABLED: 'agentSettings.enabled'
})

/** IPC channels. Both are `ipcMain.handle`, registered only while the chat is enabled. */
const CHANNELS = Object.freeze({
  GET_ENDPOINT: 'ipfs-desktop:agent-chat:get-endpoint',
  GET_TOKEN: 'ipfs-desktop:agent-chat:get-token'
})

/**
 * IPC channels of the agent settings bridge: the method name of the SettingsClient contract
 * (mcp/contract/settings/client) prefixed with `ipfsDesktop.agentSettings.`. The first six
 * are `ipcMain.handle`; ON_CHANGE is pushed by the main process to the trusted main frame.
 * They are registered only while the bridge is on (KEYS.SETTINGS_ENABLED).
 */
const SETTINGS_CHANNELS = Object.freeze({
  GET: 'ipfsDesktop.agentSettings.get',
  SET: 'ipfsDesktop.agentSettings.set',
  TEST_CONNECTION: 'ipfsDesktop.agentSettings.testConnection',
  SET_API_KEY: 'ipfsDesktop.agentSettings.setApiKey',
  CLEAR_API_KEY: 'ipfsDesktop.agentSettings.clearApiKey',
  STATUS: 'ipfsDesktop.agentSettings.status',
  ON_CHANGE: 'ipfsDesktop.agentSettings.onChange'
})

/**
 * IPC channels of the confirmation and pairing windows. They are registered only while
 * the confirmation is on, and the Web UI preload does not know them: the only renderers
 * that can send them are the two windows this module creates, and the handlers check the
 * sender against those windows (src/agent/confirm/windows.js). The copies in the preloads
 * under src/agent/confirm/ui/ are checked by test/unit/agent-confirm.spec.js.
 */
const CONFIRM_CHANNELS = Object.freeze({
  STRINGS: 'ipfs-desktop:confirm:strings',
  SHOW: 'ipfs-desktop:confirm:show',
  ARM: 'ipfs-desktop:confirm:arm',
  RESULT: 'ipfs-desktop:confirm:result',
  ERROR: 'ipfs-desktop:confirm:error',
  DECIDE: 'ipfs-desktop:confirm:decide',
  TURN_OFF: 'ipfs-desktop:confirm:turn-off',
  PAIR_SUBMIT: 'ipfs-desktop:confirm:pair-submit',
  PAIR_DISMISS: 'ipfs-desktop:confirm:pair-dismiss',
  PAIR_TURN_OFF: 'ipfs-desktop:confirm:pair-turn-off'
})

/** Command-line flag the main process sets on the Web UI window when the chat is on. */
const ARG_AGENT_CHAT = '--ipfs-desktop-agent-chat=1'

/** Command-line flag the main process sets on the Web UI window when the settings bridge is on. */
const ARG_AGENT_SETTINGS = '--ipfs-desktop-agent-settings=1'

/** Environment variable that locates the channel sockets, same name and meaning as `ipfs mcp`. */
const ENV_SOCKET_DIR = 'IPFS_MCP_CONFIRM_DIR'

module.exports = { KEYS, CHANNELS, SETTINGS_CHANNELS, CONFIRM_CHANNELS, ARG_AGENT_CHAT, ARG_AGENT_SETTINGS, ENV_SOCKET_DIR }
