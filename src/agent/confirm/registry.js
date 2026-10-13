// @ts-check
// The one confirmation manager of the app, for the tray menu (src/tray.js) to read and
// drive. src/webui/index.js sets it; nothing here starts anything.

/** @type {ReturnType<typeof import('./index').createAgentConfirmation> | null} */
let manager = null

/** @param {ReturnType<typeof import('./index').createAgentConfirmation> | null} next */
function setConfirmation (next) {
  manager = next
}

function getConfirmation () {
  return manager
}

module.exports = { setConfirmation, getConfirmation }
