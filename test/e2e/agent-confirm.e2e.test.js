/* global fetch, getComputedStyle */
const { _electron: electron } = require('playwright')
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { CONFIRM_CHANNELS } = require('../../src/agent/consts')
const kubo = require('./utils/kubo')

// Desktop agent confirmation (openspec change desktop-agent-chat, tasks 1.4, 1.5, 1.7-1.12).
//
// Part 1 drives a real `ipfs mcp --confirm=desktop` (a throwaway node on OS-assigned
// loopback ports, offline, its own repo and pairing file) as a stdio agent host would, and
// answers its pending writes in the Desktop confirmation window. Authentication is the
// version 2 challenge-response of kubo's MECHANISMS.md; Touch ID is a stand-in (a test
// machine cannot answer the real sheet; the operator confirms it in task 1.6).
// Part 2 is the disabled state, against recording stand-ins for the channel socket.
//
// The Electron main is test/e2e/utils/confirm-main.js: the production confirmation module
// and Web UI window options, without the daemon, tray or splash. Its windows are kept out
// of OS pointer reach, so nothing but this test can click them.

const MODAL = 'Confirm a change to your node'
const PAIRING = 'Pair with ipfs mcp'
const WAITING = 'A change to your node is waiting for you'
const DESTRUCTIVE = 'A destructive change is waiting for you'
const FAKE_KEY = 'k'.repeat(43)
const WINDOWS = process.platform === 'win32'

if (process.env.CI === 'true') test.setTimeout(120000)

async function launchProbe (root, env) {
  const userData = fs.mkdtempSync(path.join(root, 'ud-'))
  const app = await electron.launch({
    args: [path.join(__dirname, 'utils/confirm-main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOME: root,
      PROBE_USER_DATA: userData,
      PROBE_POLL_MS: '200',
      IPFS_MCP_CONFIRM_DIR: path.join(root, 's'),
      ...env
    }
  })
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.__probe)), { timeout: 30000 }).toBe(true)
  return { app, userData }
}

async function closeApp (app) {
  if (!app) return
  try {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10000))])
  } catch (_) {}
  try { app.process().kill('SIGKILL') } catch (_) {}
}

/** The window whose page URL ends with `name` (or starts with it, for the Web UI). */
async function pageOf (app, name, timeout = 15000) {
  const find = () => app.windows().find((p) => p.url().endsWith(name) || p.url().startsWith(name))
  await expect.poll(find, { timeout }).toBeTruthy()
  return find()
}

const visibleTitles = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.getTitle()))
const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const polls = (app) => app.evaluate(() => globalThis.__probe.confirmation.controller?.polls ?? -1)

/** Let the controller poll `n` more times: the wait for "nothing happens" is counted in polls, not seconds. */
async function afterPolls (app, n) {
  const start = await polls(app)
  await expect.poll(() => polls(app), { timeout: 15000 }).toBeGreaterThanOrEqual(start + n)
}

/** The request for `cid` is on screen: window visible, in its waiting state, naming that CID. */
async function awaitRequest (app, modal, cid, title = WAITING) {
  await expect.poll(() => visibleTitles(app)).toContain(MODAL)
  await expect(modal.locator('#title')).toHaveText(title)
  await expect(modal.locator('code.target')).toHaveText([cid])
}

/** Focus the window as the person would, and wait for the arming delay: Approve becomes enabled. */
async function arm (app, modal) {
  // Another application may take focus on a busy machine; focus again only when the window
  // has lost it (focusing a focused window restarts nothing but is not free), then give it
  // the whole delay.
  for (let round = 0; round < 4; round++) {
    const focused = await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().some((w) => w.getTitle() === title && w.isFocused()), MODAL)
    if (!focused) await app.evaluate((_electron, title) => globalThis.__probe.focus(title), MODAL)
    try {
      await expect(modal.locator('#approve')).toBeEnabled({ timeout: 4000 })
      return
    } catch (_) {}
  }
  await expect(modal.locator('#approve')).toBeEnabled({ timeout: 1000 })
}

/** Answer as the window's own page would, from the main process, as an attacker with the right sender could. */
const forgeDecision = (app, payload) => app.evaluate(({ ipcMain, BrowserWindow }, { channel, title, payload }) => {
  const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)
  ipcMain.emit(channel, { sender: win.webContents, senderFrame: win.webContents.mainFrame }, payload)
}, { channel: CONFIRM_CHANNELS.DECIDE, title: MODAL, payload })

const shownRef = (app) => app.evaluate(() => globalThis.__probe.confirmation.controller.shownRef)
const touchReasons = (app) => app.evaluate(() => globalThis.__probe.touch.reasons.slice())

function filesContaining (dir, needle) {
  const hits = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && fs.readFileSync(full).includes(needle)) hits.push(full)
    }
  }
  walk(dir)
  return hits
}

/** One HTTP request to a channel socket with arbitrary headers. */
function channelRequest (sock, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request({ socketPath: sock, method, path: route, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * A runtime audit of a window's page for WCAG 2.2 AA basics: text contrast against the
 * effective background, accessible names, a language, a title and one heading, live regions,
 * and a visible focus ring. (axe-core is not a dependency of this fork.)
 */
async function audit (page) {
  return page.evaluate(() => {
    const issues = []
    const nums = (c) => (c.match(/[\d.]+/g) || []).map(Number)
    const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    const background = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = nums(getComputedStyle(e).backgroundColor)
        if (c.length >= 3 && (c.length === 3 || c[3] > 0.99)) return c
      }
      return [255, 255, 255]
    }
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    for (const el of document.body.querySelectorAll('*')) {
      if (!visible(el) || el.disabled) continue
      const ownText = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim() !== '').length > 0
      if (!ownText) continue
      const style = getComputedStyle(el)
      const fg = nums(style.color)
      const bg = background(el)
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
      const ratio = (hi + 0.05) / (lo + 0.05)
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700)
      if (ratio < (large ? 3 : 4.5)) issues.push(`contrast ${ratio.toFixed(2)} on <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> "${el.textContent.trim().slice(0, 30)}"`)
    }
    for (const el of document.querySelectorAll('button, input, a[href]')) {
      if (!visible(el)) continue
      const named = (el.textContent || '').trim() !== '' || el.getAttribute('aria-label') || (el.labels && el.labels.length > 0)
      if (!named) issues.push(`no accessible name: <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>`)
    }
    if (!document.documentElement.lang) issues.push('no lang')
    if (!document.title) issues.push('no title')
    if (document.querySelectorAll('h1').length !== 1) issues.push('needs exactly one h1')
    if (document.querySelectorAll('[role=status]').length === 0) issues.push('no live region')
    return issues
  })
}

/** Tab once from the focused control and check where it lands shows a 2px focus ring. */
async function focusRing (page) {
  await page.keyboard.press('Tab')
  return page.evaluate(() => {
    const s = getComputedStyle(document.activeElement)
    return { tag: document.activeElement.id, style: s.outlineStyle, width: s.outlineWidth }
  })
}

const bin = kubo.kuboBinary()

test.describe.serial('pairing and the confirmation window against a real ipfs mcp', () => {
  test.skip(!bin, 'the kubo binary was not found: build it (make build in the kubo checkout) or set IPFS_KUBO_BIN')
  test.skip(WINDOWS, 'Desktop confirmation is inert on win32 (see the win32 case below)')

  let root, node, mcp, app, userData, key
  let cidA, cidB, cidC, cidD, cidE

  const startServer = async () => {
    mcp = new kubo.McpClient(bin, root, ['--confirm=desktop', '--tools=node,content,pin,destructive'])
    await mcp.initialize()
  }

  test.beforeAll(async () => {
    root = kubo.shortTempDir()
    node = await kubo.startNode(bin, root)
    ;[cidA, cidB, cidC, cidD, cidE] = ['A', 'B', 'C', 'D', 'E'].map((x) => kubo.addContent(bin, root, `desktop confirm ${x} ${Date.now()}`))
    // ipfs mcp pair needs a terminal and refuses while a server runs, so it goes first.
    key = kubo.pairWithTerminal(bin, root)
    await startServer()
    ;({ app, userData } = await launchProbe(root, { PROBE_AGENT: 'on', PROBE_CONFIRM: 'on' }))
  })

  test.afterAll(async () => {
    await closeApp(app)
    if (mcp) await mcp.stop()
    if (node) await node.stop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  test('an unpaired instance cannot list or resolve: the pending write waits, no confirmation window opens', async () => {
    await pageOf(app, 'pair.html')
    await expect.poll(() => visibleTitles(app)).toContain(PAIRING)

    const first = await mcp.pinAdd(cidA)
    expect(first).toMatchObject({ ok: false, code: 'confirmation_required' })
    expect(first.id).not.toBe('')

    // The channel itself (version 2): no credentials, a version 1 bearer, and a forged signature can neither list nor resolve.
    const socks = fs.readdirSync(path.join(root, 's')).filter((n) => n.endsWith('.sock'))
    expect(socks).toHaveLength(1)
    const sock = path.join(root, 's', socks[0])
    const forged = { 'X-IPFS-MCP-Auth-Version': '2', 'X-IPFS-MCP-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-IPFS-MCP-Nonce': 'AAECAwQFBgcICQoLDA0ODw', 'X-IPFS-MCP-Signature': 'A'.repeat(43) }
    expect(await channelRequest(sock, 'GET', '/v1/pending', {})).toBe(401)
    expect(await channelRequest(sock, 'POST', '/v1/resolve', {}, { id: first.id, approve: true })).toBe(401)
    expect(await channelRequest(sock, 'GET', '/v1/pending', { Authorization: 'Bearer ' + key })).toBe(401)
    expect(await channelRequest(sock, 'GET', '/v1/pending', forged)).toBe(403)
    expect(await channelRequest(sock, 'POST', '/v1/resolve', forged, { id: first.id, approve: true })).toBe(403)

    // Desktop, unpaired, polls nothing: through several of its poll intervals no
    // confirmation window opens and the write stays pending and unrun.
    await afterPolls(app, 6)
    expect(await visibleTitles(app)).not.toContain(MODAL)
    expect(await mcp.pinAdd(cidA)).toMatchObject({ ok: false, code: 'confirmation_pending', id: first.id })
    expect(kubo.isPinned(bin, root, cidA)).toBe(false)
  })

  test('entering the key from ipfs mcp pair pairs the instance; the request appears with its targets, Approve not yet armed', async ({ browserName }, testInfo) => {
    const pairing = await pageOf(app, 'pair.html')
    await expect(pairing.locator('#why')).toBeHidden() // first pairing: no "rejected" notice

    // A mistyped key is refused before anything is stored.
    await pairing.locator('#key').fill('not-a-key')
    await pairing.locator('#store').click()
    await expect(pairing.locator('#notice')).toContainText('not a pairing key')
    await expect(pairing.locator('#badge')).toHaveText('Not paired')

    await pairing.locator('#key').fill(key)
    await pairing.locator('#store').click()
    await expect(pairing.locator('#badge')).toHaveText('Paired')
    await expect(pairing.locator('#later')).toBeFocused() // focus moved to the way out
    fs.mkdirSync('test-results/agent-confirm', { recursive: true })
    fs.writeFileSync('test-results/agent-confirm/pairing-window.png', await pairing.screenshot())
    // The key is in the keystore ciphertext only: not in the user-data directory in the clear.
    expect(filesContaining(userData, key)).toEqual([])
    await pairing.locator('#later').click()

    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidA)
    await expect(modal.locator('#summary')).toContainText(cidA)
    await expect(modal.locator('#tool')).toHaveText('pin_add')
    await expect(modal.locator('#class')).toHaveText('Write')
    await expect(modal.locator('.facts dt').nth(0)).toHaveText('Tool')
    await expect(modal.locator('#targets li .label').first()).toHaveText('CID')
    await expect(modal.locator('#badge')).toHaveText('Awaiting a person')
    await expect(modal.locator('#approve')).toHaveText('Approve pin content')
    await expect(modal.locator('#deny')).toBeFocused() // the safe action is under the cursor first
    // Shown without taking focus: nothing has armed Approve, and it says how it will.
    await expect(modal.locator('#approve')).toBeDisabled()
    await expect(modal.locator('#arm')).toContainText('Click this window')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isFocused() && w.getTitle() === 'Confirm a change to your node'))).toBe(false)

    for (const scheme of ['dark', 'light']) {
      await modal.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' }) // no color transition in the capture
      const shot = await modal.screenshot()
      await testInfo.attach(`confirmation-window-${scheme}`, { body: shot, contentType: 'image/png' })
      fs.writeFileSync(`test-results/agent-confirm/confirmation-window-${scheme}.png`, shot)
      // 1.11: an accessibility audit of the window and of the pairing window in both themes.
      expect(await audit(modal), `request window, ${scheme}`).toEqual([])
      expect(await modal.evaluate(() => getComputedStyle(document.getElementById('deny')).transitionDuration)).toBe('0s') // reduced motion
    }
    await modal.emulateMedia({ colorScheme: null, reducedMotion: null })
  })

  test('an approval inside the arming delay, or without focus, is ignored and the request stays pending', async () => {
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidA)
    const ref = await shownRef(app)
    // A well-formed message from the window's own page, but the window is not armed.
    await forgeDecision(app, { ref, approve: true })
    expect(await touchReasons(app)).toEqual([]) // not even a Touch ID prompt
    expect(await mcp.pinAdd(cidA)).toMatchObject({ ok: false, code: 'confirmation_pending' })
    expect(kubo.isPinned(bin, root, cidA)).toBe(false)

    // Focus starts the clock; inside the delay it is still ignored.
    await app.evaluate((_electron, title) => globalThis.__probe.focus(title), MODAL)
    await forgeDecision(app, { ref, approve: true })
    expect(await touchReasons(app)).toEqual([])
    await expect(modal.locator('#approve')).toBeDisabled()

    // Losing focus disarms again, with a notice.
    await arm(app, modal)
    await modal.locator('#deny').focus()
    expect(await focusRing(modal)).toMatchObject({ style: 'solid', width: '2px' }) // keyboard focus is visible
    await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title).blur(), MODAL)
    await expect(modal.locator('#approve')).toBeDisabled()
    await expect(modal.locator('#arm')).toContainText('lost focus')
    await forgeDecision(app, { ref, approve: true })
    expect(await touchReasons(app)).toEqual([])
    expect(await mcp.pinAdd(cidA)).toMatchObject({ ok: false, code: 'confirmation_pending' })
    expect(kubo.isPinned(bin, root, cidA)).toBe(false)
  })

  test('approve runs the write once, after Touch ID', async () => {
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidA)
    expect(kubo.isPinned(bin, root, cidA)).toBe(false) // nothing runs before the person decides
    await arm(app, modal)
    await modal.locator('#approve').click()
    await expect(modal.locator('#title')).toHaveText('Approved. The call runs once.')
    await expect(modal.locator('#title')).toBeFocused() // focus follows the news
    await expect.poll(() => visibleTitles(app)).not.toContain(MODAL)
    const reasons = await touchReasons(app)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toBe(`Approve pin content on ${cidA.slice(0, 48)}...`)

    const ran = await mcp.pinAdd(cidA)
    expect(ran.ok).toBe(true)
    expect(kubo.isPinned(bin, root, cidA)).toBe(true)

    // The approval was spent: the next call asks again, with a new request.
    const again = await mcp.pinAdd(cidA)
    expect(again).toMatchObject({ ok: false, code: 'confirmation_required' })
    await awaitRequest(app, modal, cidA)
    await modal.locator('#deny').click() // leave nothing pending
    await expect(modal.locator('#title')).toHaveText('Denied. Nothing was changed.')
    await expect.poll(() => visibleTitles(app)).not.toContain(MODAL)
  })

  test('a Touch ID that is not given sends nothing and leaves the request pending', async () => {
    const asked = await mcp.pinAdd(cidE)
    expect(asked).toMatchObject({ ok: false, code: 'confirmation_required' })
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidE)
    await app.evaluate(() => { globalThis.__probe.touch.mode = 'deny' })
    await arm(app, modal)
    await modal.locator('#approve').click()
    await expect(modal.locator('#notice')).toContainText('Touch ID was not given')
    expect(kubo.isPinned(bin, root, cidE)).toBe(false)
    expect(await mcp.pinAdd(cidE)).toMatchObject({ ok: false, code: 'confirmation_pending', id: asked.id })
    await expect(modal.locator('#approve')).toBeDisabled() // re-arm after the sheet took focus
    await app.evaluate(() => { globalThis.__probe.touch.mode = 'allow' })
    await modal.locator('#deny').click()
    await expect(modal.locator('#title')).toHaveText('Denied. Nothing was changed.')
    expect(await mcp.pinAdd(cidE)).toMatchObject({ ok: false, code: 'confirmation_declined' })
  })

  test('deny does not run the write', async () => {
    const asked = await mcp.pinAdd(cidB)
    expect(asked).toMatchObject({ ok: false, code: 'confirmation_required' })
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidB)
    await modal.locator('#deny').click()
    await expect(modal.locator('#title')).toHaveText('Denied. Nothing was changed.')
    expect(await mcp.pinAdd(cidB)).toMatchObject({ ok: false, code: 'confirmation_declined' })
    expect(kubo.isPinned(bin, root, cidB)).toBe(false)
    await expect.poll(() => visibleTitles(app)).not.toContain(MODAL)
  })

  test('Deny in Desktop: pin_rm denied, the pin remains', async () => {
    expect(kubo.isPinned(bin, root, cidA)).toBe(true)
    const asked = await mcp.pinRm(cidA)
    expect(asked).toMatchObject({ ok: false, code: 'confirmation_required' })
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidA, DESTRUCTIVE)
    await expect(modal.locator('#class')).toHaveText('Destructive')
    await expect(modal.locator('#approve')).toHaveText('Remove pin') // the button names the object
    await modal.locator('#deny').click()
    await expect(modal.locator('#title')).toHaveText('Denied. Nothing was changed.')
    expect(await mcp.pinRm(cidA)).toMatchObject({ ok: false, code: 'confirmation_declined' })
    expect(kubo.isPinned(bin, root, cidA)).toBe(true)
  })

  test('closing the window denies the request', async () => {
    const asked = await mcp.pinAdd(cidB)
    expect(asked).toMatchObject({ ok: false, code: 'confirmation_required' })
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidB)
    // The window's own close button (here: close()) is an answer, and the answer is Deny.
    await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title).close(), MODAL)
    await expect.poll(() => visibleTitles(app)).not.toContain(MODAL)
    await expect.poll(async () => (await mcp.pinAdd(cidB)).code).toBe('confirmation_declined')
    expect(kubo.isPinned(bin, root, cidB)).toBe(false)
  })

  test('a scripted renderer cannot reach the confirmation window or the channel', async () => {
    const asked = await mcp.pinAdd(cidC)
    expect(asked).toMatchObject({ ok: false, code: 'confirmation_required' })
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidC)

    // Page script in the Web UI window: no Node, no ipcRenderer, none of the confirmation
    // APIs, no new window, no file or socket access.
    const webui = await pageOf(app, 'webui://localhost')
    const before = await windowCount(app)
    const seen = await webui.evaluate(async () => ({
      require: typeof require,
      process: typeof process,
      ipcRenderer: typeof ipcRenderer,
      desktopKeys: Object.keys(window.ipfsDesktop || {}).sort(),
      agentChatKeys: Object.keys((window.ipfsDesktop || {}).agentChat || {}).sort(),
      confirmApi: typeof window.confirmApi,
      pairApi: typeof window.pairApi,
      openReturnsNull: window.open('about:blank') === null,
      fileFetch: await fetch('file:///etc/hosts').then(() => 'reached', () => 'blocked')
    }))
    expect(seen).toMatchObject({ require: 'undefined', process: 'undefined', ipcRenderer: 'undefined', confirmApi: 'undefined', pairApi: 'undefined', openReturnsNull: true, fileFetch: 'blocked' })
    expect(seen.desktopKeys.filter((k) => /confirm|pair/i.test(k))).toEqual([])
    expect(seen.agentChatKeys).toEqual(['getEndpoint', 'getToken'])
    expect(await windowCount(app)).toBe(before)

    // The main-process handler, given a message that claims to answer the request but
    // comes from the Web UI window (right handle, approve true): it ignores it, armed or not.
    await arm(app, modal)
    const promptsBefore = (await touchReasons(app)).length
    await app.evaluate(({ ipcMain }, channel) => {
      const probe = globalThis.__probe
      const contents = probe.getWebuiContents()
      ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, { ref: probe.confirmation.controller.shownRef, approve: true })
    }, CONFIRM_CHANNELS.DECIDE)
    await afterPolls(app, 3)
    expect(await touchReasons(app)).toHaveLength(promptsBefore) // the forged message asked for no Touch ID, so it went nowhere
    expect(kubo.isPinned(bin, root, cidC)).toBe(false)
    expect(await mcp.pinAdd(cidC)).toMatchObject({ ok: false, code: 'confirmation_pending', id: asked.id })
    await expect(modal.locator('#title')).toHaveText(WAITING)

    // Positive control: the real window still answers.
    await modal.locator('#deny').click()
    await expect(modal.locator('#title')).toHaveText('Denied. Nothing was changed.')
    expect(await mcp.pinAdd(cidC)).toMatchObject({ ok: false, code: 'confirmation_declined' })
  })

  test('after the key is replaced on the server, Desktop says why the pairing window returned, and pairs again', async () => {
    await expect.poll(() => visibleTitles(app)).not.toContain(MODAL)
    // Re-pairing needs the server stopped: wait until the process has exited.
    await mcp.stop()
    const fresh = kubo.pairWithTerminal(bin, root)
    expect(fresh).not.toBe(key)
    await startServer()
    const asked = await mcp.pinAdd(cidC)
    expect(asked).toMatchObject({ ok: false, code: 'confirmation_required' })
    // The stored key no longer matches the server's verifier: the pairing window returns,
    // with the reason; no confirmation window opens, and the write stays unrun.
    await expect.poll(() => visibleTitles(app), { timeout: 15000 }).toContain(PAIRING)
    expect(await visibleTitles(app)).not.toContain(MODAL)
    expect(kubo.isPinned(bin, root, cidC)).toBe(false)
    const pairing = await pageOf(app, 'pair.html')
    await expect(pairing.locator('#why')).toContainText('rejected the stored key')
    for (const scheme of ['dark', 'light']) {
      await pairing.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      expect(await audit(pairing), `pairing window, ${scheme}`).toEqual([])
    }
    await pairing.emulateMedia({ colorScheme: null, reducedMotion: null })
    await pairing.locator('#key').fill(fresh)
    await pairing.locator('#store').click()
    await expect(pairing.locator('#badge')).toHaveText('Paired')
    await pairing.locator('#later').click()
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidC)
    await arm(app, modal)
    await modal.locator('#approve').click()
    await expect(modal.locator('#title')).toHaveText('Approved. The call runs once.')
    await expect.poll(async () => (await mcp.pinAdd(cidC)).ok, { timeout: 15000 }).toBe(true)
    expect(kubo.isPinned(bin, root, cidC)).toBe(true)
  })

  test('"Turn off Desktop confirmations" in the window ends the feature and stops all contact', async () => {
    const asked = await mcp.pinAdd(cidD)
    expect(asked).toMatchObject({ ok: false, code: 'confirmation_required' })
    const modal = await pageOf(app, 'confirm.html')
    await awaitRequest(app, modal, cidD)
    await modal.locator('#off').click()
    await expect.poll(() => app.evaluate(() => globalThis.__probe.confirmation.enabled)).toBe(false)
    expect(await app.evaluate(() => globalThis.__probe.store.get('desktopConfirm.enabled'))).toBe(false)
    await expect.poll(() => visibleTitles(app)).not.toContain(MODAL)
    expect(await windowCount(app)).toBe(1) // the Web UI window alone
    expect(kubo.isPinned(bin, root, cidD)).toBe(false)
    // The way back is the tray's "Confirm agent writes in this app" (unit-tested); the manager turns on again.
    await app.evaluate(() => globalThis.__probe.confirmation.setEnabled(true))
    await expect.poll(() => app.evaluate(() => globalThis.__probe.confirmation.enabled)).toBe(true)
    await pageOf(app, 'confirm.html')
    await expect.poll(() => visibleTitles(app)).toContain(MODAL)
  })
})

test.describe('disabled state exposes no bridge call and no confirmation channel', () => {
  test.skip(WINDOWS, 'socket stand-ins need Unix sockets; the win32 case is below')

  let root, channel, requests

  // A stand-in for the server's channel socket that records every request it receives. It
  // lives in a live process's name (this test process), so the client considers it.
  test.beforeEach(async () => {
    root = kubo.shortTempDir()
    const dir = path.join(root, 's')
    fs.mkdirSync(dir, { mode: 0o700 })
    requests = []
    channel = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers })
      res.setHeader('Content-Type', 'application/json')
      // No server proof, on purpose: this is a socket that does not hold the verifier.
      res.end(JSON.stringify({ pending: [{ id: 'rogue', summary: 'Pin something', tool: 'pin_add', class: 'write', expires_at: new Date(Date.now() + 60000).toISOString(), targets: [] }] }) + '\n')
    })
    await new Promise((resolve) => channel.listen(path.join(dir, `${process.pid}-1.sock`), resolve))
  })

  test.afterEach(async () => {
    channel.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const listeners = (app) => app.evaluate(({ ipcMain }, names) => names.map((n) => ipcMain.listenerCount(n) + (ipcMain._invokeHandlers && ipcMain._invokeHandlers.has(n) ? 1 : 0)), Object.values(CONFIRM_CHANNELS))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1500)) // seven poll intervals of silence

  for (const [name, env] of [
    ['the default (opt-in, nothing stored), chat on, a key stored', { PROBE_AGENT: 'on', PROBE_SEED_PAIRING: FAKE_KEY }],
    ['switched off with "false", a key stored', { PROBE_AGENT: 'on', PROBE_CONFIRM: 'false', PROBE_SEED_PAIRING: FAKE_KEY }],
    ['switched off with "off", chat off, a key stored', { PROBE_AGENT: 'off', PROBE_CONFIRM: 'off', PROBE_SEED_PAIRING: FAKE_KEY }],
    ['switched off with "0", a key stored', { PROBE_AGENT: 'off', PROBE_CONFIRM: '0', PROBE_SEED_PAIRING: FAKE_KEY }]
  ]) {
    test(`${name}: no channel request, no handler, no window`, async () => {
      const { app } = await launchProbe(root, env)
      try {
        await settle()
        expect(requests).toEqual([])
        expect(await listeners(app)).toEqual(Object.values(CONFIRM_CHANNELS).map(() => 0))
        expect(await app.evaluate(() => globalThis.__probe.confirmation.enabled)).toBe(false)
        expect(await windowCount(app)).toBe(1) // the Web UI window alone
        const webui = await pageOf(app, 'webui://localhost')
        const keys = await webui.evaluate(() => Object.keys(window.ipfsDesktop || {}).filter((k) => /agentChat|confirm|pair/i.test(k)))
        // the chat bridge of 1.3 follows the chat switch alone; no confirmation API beside it
        expect(keys).toEqual(env.PROBE_AGENT === 'on' ? ['agentChat'] : [])
      } finally {
        await closeApp(app)
      }
    })
  }

  test('on but unpaired: the pairing window opens, no channel request is made', async () => {
    const { app } = await launchProbe(root, { PROBE_AGENT: 'off', PROBE_CONFIRM: 'on' })
    try {
      await pageOf(app, 'pair.html')
      await afterPolls(app, 6)
      expect(requests).toEqual([])
      expect(await visibleTitles(app)).not.toContain(MODAL)
    } finally {
      await closeApp(app)
    }
  })

  test('a socket that cannot prove it holds the verifier is ignored: nothing shown, no resolve, the key never sent', async () => {
    const { app } = await launchProbe(root, { PROBE_AGENT: 'off', PROBE_CONFIRM: 'on', PROBE_SEED_PAIRING: FAKE_KEY })
    try {
      await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThan(0)
      await afterPolls(app, 8)
      expect(await visibleTitles(app)).not.toContain(MODAL)
      expect(requests.every((r) => r.method === 'GET' && r.url === '/v1/pending')).toBe(true)
      for (const r of requests) {
        expect(r.headers['x-ipfs-mcp-auth-version']).toBe('2')
        expect(r.headers.authorization).toBeUndefined()
        expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
      }
      expect(requests).toHaveLength(1) // asked once; ignored for the session
    } finally {
      await closeApp(app)
    }
  })

  test('chat off and the switch on: the confirmation runs on its own (paired, it lists over the socket)', async () => {
    const { app } = await launchProbe(root, { PROBE_AGENT: 'off', PROBE_CONFIRM: 'on', PROBE_SEED_PAIRING: FAKE_KEY })
    try {
      await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThan(0)
      expect(await app.evaluate(() => globalThis.__probe.confirmation.enabled)).toBe(true)
    } finally {
      await closeApp(app)
    }
  })
})

test.describe('win32', () => {
  test.skip(!WINDOWS, 'runs on Windows only')

  test('the confirmation is inert: no window, no handler, no channel, the switch is not rewritten', async () => {
    const root = kubo.shortTempDir()
    const { app } = await launchProbe(root, { PROBE_AGENT: 'on', PROBE_CONFIRM: 'on', PROBE_SEED_PAIRING: FAKE_KEY })
    try {
      expect(await app.evaluate(() => globalThis.__probe.confirmation.supported)).toBe(false)
      expect(await app.evaluate(() => globalThis.__probe.confirmation.enabled)).toBe(false)
      expect(await windowCount(app)).toBe(1)
    } finally {
      await closeApp(app)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
