// @ts-check
// The tray entries for the Desktop confirmation (src/tray.js builds the rest of the menu):
// turn it on and off, pair, remove the pairing. The submenu is always present; where the
// feature cannot run (Windows) it is greyed out rather than hidden, and "off" is a checkbox
// the person can tick again, so there is always a way back.

/**
 * @param {object} deps
 * @param {(key: string) => string} deps.t
 * @param {() => ReturnType<typeof import('./index').createAgentConfirmation> | null} deps.getConfirmation
 */
function buildAgentConfirmSubmenu ({ t, getConfirmation }) {
  const confirmation = getConfirmation()
  const supported = confirmation?.supported === true
  const on = confirmation?.enabled === true
  const paired = confirmation?.paired === true
  return [{
    id: 'agentConfirmSubmenu',
    label: t('agentConfirmTray.title'),
    enabled: supported,
    submenu: [
      {
        id: 'agentConfirm.enable',
        label: t('agentConfirmTray.enable'),
        type: 'checkbox',
        checked: on,
        click: () => { const c = getConfirmation(); c?.setEnabled(!c.enabled) }
      },
      {
        id: 'agentConfirm.status',
        label: paired ? t('agentConfirmTray.paired') : t('agentConfirmTray.notPaired'),
        enabled: false
      },
      { type: 'separator' },
      {
        id: 'agentConfirm.pair',
        label: t('agentConfirmTray.pair'),
        click: () => { getConfirmation()?.openPairing() }
      },
      {
        id: 'agentConfirm.unpair',
        label: t('agentConfirmTray.unpair'),
        enabled: paired,
        click: () => { getConfirmation()?.unpair() }
      }
    ]
  }]
}

module.exports = { buildAgentConfirmSubmenu }
