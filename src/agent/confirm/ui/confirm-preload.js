// @ts-check
// Preload of the confirmation window. It runs in the renderer sandbox, so it can require
// only `electron`; the channel names are copies of CONFIRM_CHANNELS in src/agent/consts.js
// (test/unit/agent-confirm.spec.js fails when they drift). Listeners for what to show and
// say, and two senders: the person's answer, and "turn this off".
const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  STRINGS: 'ipfs-desktop:confirm:strings',
  SHOW: 'ipfs-desktop:confirm:show',
  ARM: 'ipfs-desktop:confirm:arm',
  RESULT: 'ipfs-desktop:confirm:result',
  ERROR: 'ipfs-desktop:confirm:error',
  DECIDE: 'ipfs-desktop:confirm:decide',
  TURN_OFF: 'ipfs-desktop:confirm:turn-off'
})

/**
 * @param {string} channel
 * @param {(payload: any) => void} callback
 */
const listen = (channel, callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload))
}

contextBridge.exposeInMainWorld('confirmApi', Object.freeze({
  onStrings: (/** @type {(payload: any) => void} */ cb) => listen(CHANNELS.STRINGS, cb),
  onShow: (/** @type {(payload: any) => void} */ cb) => listen(CHANNELS.SHOW, cb),
  onArm: (/** @type {(payload: any) => void} */ cb) => listen(CHANNELS.ARM, cb),
  onResult: (/** @type {(payload: any) => void} */ cb) => listen(CHANNELS.RESULT, cb),
  onError: (/** @type {(payload: any) => void} */ cb) => listen(CHANNELS.ERROR, cb),
  decide: (/** @type {string} */ ref, /** @type {boolean} */ approve) => {
    ipcRenderer.send(CHANNELS.DECIDE, { ref: String(ref), approve: approve === true })
  },
  turnOff: () => { ipcRenderer.send(CHANNELS.TURN_OFF) }
}))
