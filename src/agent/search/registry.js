// @ts-check
// The one Search settings window of the app, for the tray menu (src/tray.js) to open.
// src/webui/index.js sets it; nothing here creates anything.

/** @type {{ open: () => void, dispose: () => void } | null} */
let searchWindow = null

/** @param {{ open: () => void, dispose: () => void } | null} next */
function setSearchWindow (next) {
  searchWindow = next
}

function getSearchWindow () {
  return searchWindow
}

module.exports = { setSearchWindow, getSearchWindow }
