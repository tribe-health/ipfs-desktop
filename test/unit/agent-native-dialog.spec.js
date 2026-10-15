const { test, expect } = require('@playwright/test')
const { createNativeHostConfirm } = require('../../src/agent/confirm/native-dialog')

const t = (key, options) => (options?.host ? `${key}:${options.host}` : key)

function setup ({ response = 0, win = { isDestroyed: () => false, isVisible: () => true }, fail = false } = {}) {
  const shown = []
  const dialog = {
    showMessageBox: async (...args) => {
      shown.push(args)
      if (fail) throw new Error('no display')
      return { response }
    }
  }
  return { shown, confirm: createNativeHostConfirm({ dialog, getWindow: () => win, t }) }
}

test.describe('native host confirmation (no Touch ID)', () => {
  test('is parented to the window, names the host, and defaults and cancels to Cancel', async () => {
    const win = { isDestroyed: () => false, isVisible: () => true }
    const { shown, confirm } = setup({ response: 1, win })
    expect(await confirm({ host: 'llm.example' })).toBe(false)
    const [parent, options] = shown[0]
    expect(parent).toBe(win)
    expect(options.message).toContain('llm.example')
    expect(options.buttons).toEqual(['agentSettings.dialog.confirm', 'agentSettings.dialog.cancel'])
    expect(options.defaultId).toEqual(1)
    expect(options.cancelId).toEqual(1)
    expect(options.type).toEqual('warning')
  })

  test('only the Allow button confirms', async () => {
    expect(await setup({ response: 0 }).confirm({ host: 'h.example' })).toBe(true)
    expect(await setup({ response: 1 }).confirm({ host: 'h.example' })).toBe(false)
  })

  test('a destroyed or missing window still asks (unparented); a failing dialog refuses', async () => {
    const gone = setup({ win: { isDestroyed: () => true } })
    expect(await gone.confirm({ host: 'h.example' })).toBe(true)
    expect(gone.shown[0].length).toEqual(1)
    const none = setup({ win: null })
    await none.confirm({ host: 'h.example' })
    expect(none.shown[0].length).toEqual(1)
    expect(await setup({ fail: true }).confirm({ host: 'h.example' })).toBe(false)
  })

  test('N5: a hidden window is not used as the parent; the dialog opens unparented', async () => {
    const hidden = setup({ win: { isDestroyed: () => false, isVisible: () => false } })
    expect(await hidden.confirm({ host: 'h.example' })).toBe(true)
    expect(hidden.shown[0].length).toEqual(1)
    const unknown = setup({ win: { isDestroyed: () => false } })
    await unknown.confirm({ host: 'h.example' })
    expect(unknown.shown[0].length).toEqual(1)
  })

  test('the key-follows detail is used for a move that carries a server-managed key; the plain detail otherwise', async () => {
    const follows = setup()
    await follows.confirm({ host: 'h.example', purpose: 'backend', keyFollows: true })
    expect(follows.shown[0][1].detail).toEqual('agentSettings.dialog.detailKeyFollows')
    const plain = setup()
    await plain.confirm({ host: 'h.example', purpose: 'backend', keyFollows: false })
    expect(plain.shown[0][1].detail).toEqual('agentSettings.dialog.detail')
  })

  test('a request that names its window is parented to that one, not the Web UI window', async () => {
    const webui = { isDestroyed: () => false, isVisible: () => true }
    const requester = { isDestroyed: () => false, isVisible: () => true }
    const { shown, confirm } = setup({ win: webui })
    await confirm({ host: 'h.example', purpose: 'searchText', getParent: () => requester })
    expect(shown[0][0]).toBe(requester)
    await confirm({ host: 'h.example', purpose: 'searchText', getParent: () => null })
    expect(shown[1].length).toEqual(1)
  })

  test('with no host the generic message is used; the locale has every key', async () => {
    const { shown, confirm } = setup()
    await confirm({ host: '' })
    expect(shown[0][1].message).toEqual('agentSettings.dialog.messageBackend')
    const en = require('../../assets/locales/en.json')
    for (const k of ['title', 'messageHost', 'messageBackend', 'detail', 'confirm', 'cancel']) expect(en.agentSettings.dialog[k]).toBeTruthy()
    expect(en.agentSettings.touchReasonHost).toContain('stored model key does not follow')
    expect(en.agentSettings.touchReasonBackend).toContain('stored model key does not follow')
    expect(en.agentSettings.dialog.detail).toContain('not sent to a new host')
    expect(en.agentSettings.errDeclinedHost).toBeTruthy()
    expect(en.agentSettings.errConfirmPending).toBeTruthy()
  })
})
