// @ts-check
// Preload of the Search settings window. Renderer sandbox: only `electron` can be required;
// the channel names are copies of SEARCH_CHANNELS in src/agent/consts.js. The page gets its
// strings and the current view, can ask which warnings its draft values earn, ask for a program to be chosen, save, or close. It
// cannot reach any other channel, and a save is answered only for this window's main frame.
const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  STRINGS: 'ipfs-desktop:search:strings',
  GET: 'ipfs-desktop:search:get',
  APPLY: 'ipfs-desktop:search:apply',
  PREVIEW: 'ipfs-desktop:search:preview',
  PICK: 'ipfs-desktop:search:pick',
  CLOSE: 'ipfs-desktop:search:close'
})

contextBridge.exposeInMainWorld('searchApi', Object.freeze({
  onStrings: (/** @type {(payload: any) => void} */ cb) => { ipcRenderer.on(CHANNELS.STRINGS, (_event, payload) => cb(payload)) },
  get: () => ipcRenderer.invoke(CHANNELS.GET),
  apply: (/** @type {unknown} */ input) => ipcRenderer.invoke(CHANNELS.APPLY, input),
  preview: (/** @type {unknown} */ input) => ipcRenderer.invoke(CHANNELS.PREVIEW, input),
  pick: (/** @type {'surreal' | 'xberg'} */ which) => ipcRenderer.invoke(CHANNELS.PICK, String(which)),
  close: () => { ipcRenderer.send(CHANNELS.CLOSE) }
}))
