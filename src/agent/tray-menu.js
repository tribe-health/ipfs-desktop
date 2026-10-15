// @ts-check
// The tray entries for the agent endpoint (src/tray.js builds the rest of the menu): a
// status line from the sidecar supervisor's state, "Agent settings", which opens the Web UI
// at #/settings/agent, and the toggle of the sidecar's off switch, the store key
// `mcpSidecar.enabled`. The toggle writes the key; the daemon module applies it to the
// supervisor (src/daemon/index.js), the same path a hand edit of the store takes.

const SIDECAR_ENABLED_KEY = 'mcpSidecar.enabled'
const SETTINGS_ROUTE = '/settings/agent'
const STATES = ['running', 'starting', 'restarting', 'failing', 'stopped']

/**
 * @param {object} deps
 * @param {(key: string, options?: Record<string, unknown>) => string} deps.t
 * @param {() => { getState: () => string, getPort: () => number } | null} deps.getSidecar
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void, safeSet?: (key: string, value: any) => void }} deps.store
 * @param {(path: string) => unknown} deps.launchWebUI
 */
function buildAgentEndpointItems ({ t, getSidecar, store, launchWebUI }) {
  const sidecar = getSidecar()
  const state = sidecar && STATES.includes(sidecar.getState()) ? sidecar.getState() : 'stopped'
  const enabled = store.get(SIDECAR_ENABLED_KEY, true) !== false
  const status = state === 'running' && sidecar
    ? t('agentSettingsTray.statusRunning', { port: sidecar.getPort() })
    : t(`agentSettingsTray.status.${state}`)
  return [
    { id: 'agentEndpoint.header', label: t('agentSettingsTray.title'), enabled: false },
    { id: 'agentEndpoint.status', label: status, enabled: false },
    {
      id: 'agentEndpoint.settings',
      label: t('agentSettingsTray.open'),
      click: () => { launchWebUI(SETTINGS_ROUTE) }
    },
    {
      id: 'agentEndpoint.enable',
      label: t('agentSettingsTray.enable'),
      type: 'checkbox',
      checked: enabled,
      click: () => {
        const next = store.get(SIDECAR_ENABLED_KEY, true) === false
        if (typeof store.safeSet === 'function') store.safeSet(SIDECAR_ENABLED_KEY, next)
        else store.set(SIDECAR_ENABLED_KEY, next)
      }
    }
  ]
}

module.exports = { buildAgentEndpointItems, SIDECAR_ENABLED_KEY, SETTINGS_ROUTE }
