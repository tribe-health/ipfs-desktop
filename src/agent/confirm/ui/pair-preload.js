// @ts-check
// Preload of the pairing window. Renderer sandbox: only `electron` can be required; the
// channel names are copies of CONFIRM_CHANNELS in src/agent/consts.js. The page receives
// its strings, can hand the typed key to the main process, close itself, or turn the
// feature off. It cannot read the stored key: nothing returns it.
const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  STRINGS: 'ipfs-desktop:confirm:strings',
  PAIR_SUBMIT: 'ipfs-desktop:confirm:pair-submit',
  PAIR_DISMISS: 'ipfs-desktop:confirm:pair-dismiss',
  PAIR_TURN_OFF: 'ipfs-desktop:confirm:pair-turn-off'
})

contextBridge.exposeInMainWorld('pairApi', Object.freeze({
  onStrings: (/** @type {(payload: any) => void} */ cb) => { ipcRenderer.on(CHANNELS.STRINGS, (_event, payload) => cb(payload)) },
  submit: (/** @type {string} */ key) => ipcRenderer.invoke(CHANNELS.PAIR_SUBMIT, String(key)),
  dismiss: () => { ipcRenderer.send(CHANNELS.PAIR_DISMISS) },
  turnOff: () => { ipcRenderer.send(CHANNELS.PAIR_TURN_OFF) }
}))
