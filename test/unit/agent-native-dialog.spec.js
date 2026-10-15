const { test, expect } = require('@playwright/test')
const { createNativeHostConfirm } = require('../../src/agent/confirm/native-dialog')

const t = (key, options) => (options?.host ? `${key}:${options.host}` : key)

function setup ({ response = 0, win = { isDestroyed: () => false }, fail = false } = {}) {
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
    const win = { isDestroyed: () => false }
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

  test('with no host the generic message is used; the locale has every key', async () => {
    const { shown, confirm } = setup()
    await confirm({ host: '' })
    expect(shown[0][1].message).toEqual('agentSettings.dialog.messageBackend')
    const en = require('../../assets/locales/en.json')
    for (const k of ['title', 'messageHost', 'messageBackend', 'detail', 'confirm', 'cancel']) expect(en.agentSettings.dialog[k]).toBeTruthy()
    expect(en.agentSettings.touchReasonKeyHost).toContain('{{host}}')
  })
})
