'use strict'
/* global fetch, location, caches, indexedDB */

// Agent chat bridge probe (docs/agent/HARDENING.md, G11-4). Usage:
//
//   node test/hardening/run-agent-probe.js [--json]
//
// Three launches of the probe Electron main over ONE user-data directory:
//   A  chat on, token seeded   -> bridge shape, token round trip, storage audit, CSP
//   B  restart, nothing seeded -> the token survived
//   C  chat off                -> no bridge, no IPC channel, no mcp origin in the CSP
// plus D, chat on with no endpoint (half configured), which must behave like off.
// No daemon is started. The "ipfs mcp" and a second, unlisted origin are throwaway
// loopback HTTP servers on OS-assigned ports. Electron uses Chromium's mock keychain, so
// the login Keychain is not touched.

const { _electron: electron } = require('playwright')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const json = process.argv.includes('--json')
const results = []
const record = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail })

function listen (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function walk (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function filesContaining (dir, needle) {
  const hits = []
  for (const file of walk(dir)) {
    try {
      if (fs.readFileSync(file).includes(needle)) hits.push(path.relative(dir, file))
    } catch (_) {}
  }
  return hits
}

async function launch (root, env) {
  const app = await electron.launch({
    args: [path.join(__dirname, 'probe-main.js')],
    env: { ...process.env, HOME: root, PROBE_MODE: 'hardened', PROBE_USER_DATA: path.join(root, 'user-data'), PROBE_MOCK_KEYCHAIN: '1', ...env }
  })
  const page = await app.firstWindow()
  await page.addInitScript((ma) => {
    if (location.protocol === 'webui:') window.localStorage.setItem('ipfsApi', ma)
    window.__csp = []
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  }, env.PROBE_API_MULTIADDR)
  await page.reload()
  await page.waitForLoadState('load')
  await page.waitForTimeout(1500)
  return { app, page }
}

async function close (app) {
  try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 8000))]) } catch (_) {}
  try { app.process().kill('SIGKILL') } catch (_) {}
}

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-desktop-agent-probe-'))
  const token = 'probe-' + crypto.randomBytes(18).toString('hex')
  const seen = { mcp: [], other: [] }
  const mcp = await listen((req, res) => {
    seen.mcp.push({ method: req.method, auth: req.headers.authorization || null, origin: req.headers.origin || null })
    res.setHeader('Access-Control-Allow-Origin', 'webui://localhost')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
    res.setHeader('Content-Type', 'application/json')
    res.end('{"ok":true}')
  })
  const other = await listen((req, res) => { seen.other.push(req.method); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('x') })
  const apiPort = (await listen((req, res) => res.end('{}'))).port // an unused-by-chat "API"; never a default port
  const mcpOrigin = `http://127.0.0.1:${mcp.port}`
  const otherOrigin = `http://127.0.0.1:${other.port}`
  const baseEnv = {
    PROBE_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    PROBE_API_MULTIADDR: `/ip4/127.0.0.1/tcp/${apiPort}`,
    PROBE_GATEWAY_ORIGIN: `http://127.0.0.1:${apiPort}`
  }
  const inPage = async (page) => page.evaluate(async ({ token, mcpOrigin, otherOrigin }) => {
    const out = {}
    out.cspMeta = (await fetch(location.href)).headers.get('content-security-policy')
    const ad = window.ipfsDesktop
    out.bridge = ad && ad.agentChat ? Object.keys(ad.agentChat).sort() : null
    out.desktopKeys = ad ? Object.keys(ad).sort() : null
    out.endpoint = ad && ad.agentChat ? await ad.agentChat.getEndpoint() : null
    out.token = ad && ad.agentChat ? await ad.agentChat.getToken() : null
    out.tokenIsString = typeof out.token === 'string'
    // storage audit
    const dump = { ls: { ...window.localStorage }, ss: { ...window.sessionStorage }, cookie: document.cookie, caches: await caches.keys(), idb: [] }
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      for (const store of db.objectStoreNames) {
        const rows = await new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
        dump.idb.push({ name, store, rows })
      }
      db.close()
    }
    const serial = JSON.stringify(dump)
    out.storageHasToken = token ? serial.includes(token) : false
    out.storageBytes = serial.length
    out.bridgeWritable = (() => { try { ad.agentChat = {}; return ad.agentChat !== undefined && Object.keys(ad.agentChat).length === 0 } catch (_) { return false } })()
    // network
    window.__csp.length = 0
    const call = async (origin, headers) => {
      try { const r = await fetch(`${origin}/agui`, { method: 'POST', headers, body: '{}' }); return r.status } catch (e) { return 'blocked' }
    }
    out.mcpFetch = await call(mcpOrigin, { Authorization: `Bearer ${out.token || 'none'}`, 'Content-Type': 'application/json' })
    out.otherFetch = await call(otherOrigin, { 'Content-Type': 'application/json' })
    await new Promise(resolve => setTimeout(resolve, 300))
    out.violations = window.__csp.slice()
    return out
  }, { token, mcpOrigin, otherOrigin })

  let a, b, c, d
  try {
    // A: chat on, token seeded
    let run = await launch(root, { ...baseEnv, PROBE_AGENT: 'on', PROBE_SEED_ENDPOINT: `${mcpOrigin}/agui`, PROBE_SEED_TOKEN: token })
    a = await inPage(run.page)
    const diskA = filesContaining(path.join(root, 'user-data'), token)
    await close(run.app)

    record('A: bridge exposes exactly getEndpoint and getToken', JSON.stringify(a.bridge) === JSON.stringify(['getEndpoint', 'getToken']), JSON.stringify(a.bridge))
    record('A: endpoint round trip', a.endpoint === `${mcpOrigin}/agui`, String(a.endpoint))
    record('A: token round trip (page gets what main stored)', a.token === token, a.tokenIsString ? 'string, matches' : String(a.token))
    record('A: token is in no renderer storage (localStorage, sessionStorage, cookies, IndexedDB, CacheStorage)', !a.storageHasToken, `audited ${a.storageBytes} bytes`)
    record('A: token is in no file under the user-data dir (plaintext)', diskA.length === 0, diskA.join(', ') || 'none')
    record('A: the exposed bridge object cannot be replaced from page script', !a.bridgeWritable, `writable=${a.bridgeWritable}`)
    record('A: CSP connect-src names the mcp origin and no wildcard', a.cspMeta.includes(`connect-src 'self' http://127.0.0.1:${apiPort} ${mcpOrigin}`) && !a.cspMeta.includes('*'), (/connect-src[^;]*/.exec(a.cspMeta) || [''])[0])
    record('A: fetch to the mcp origin with the bearer succeeds', a.mcpFetch === 200 && seen.mcp.some(r => r.method === 'POST' && r.auth === `Bearer ${token}`), `status ${a.mcpFetch}; server saw ${seen.mcp.length} request(s)`)
    record('A: fetch to another loopback origin is blocked by CSP and never reaches it', a.otherFetch === 'blocked' && a.violations.some(v => v.startsWith('connect-src')) && seen.other.length === 0, `${a.otherFetch}; ${a.violations.join(' | ')}; server saw ${seen.other.length}`)

    // B: restart
    run = await launch(root, { ...baseEnv, PROBE_AGENT: 'on' })
    b = await inPage(run.page)
    await close(run.app)
    record('B: after restart the token is still returned', b.token === token, b.tokenIsString ? 'string, matches' : String(b.token))
    record('B: after restart the endpoint is still returned', b.endpoint === `${mcpOrigin}/agui`, String(b.endpoint))
    record('B: still no token in renderer storage', !b.storageHasToken, `audited ${b.storageBytes} bytes`)

    // C: chat off, token still on disk
    run = await launch(root, { ...baseEnv, PROBE_AGENT: 'off', PROBE_SEED_ENDPOINT: `${mcpOrigin}/agui` })
    c = await inPage(run.page)
    const handlerState = await run.app.evaluate(({ ipcMain }) => ({
      token: ipcMain._invokeHandlers.has('ipfs-desktop:agent-chat:get-token'),
      endpoint: ipcMain._invokeHandlers.has('ipfs-desktop:agent-chat:get-endpoint')
    }))
    await close(run.app)
    record('C (disabled): window.ipfsDesktop has no agentChat', c.bridge === null && !(c.desktopKeys || []).includes('agentChat'), `keys: ${(c.desktopKeys || []).join(',')}`)
    record('C (disabled): no IPC channel is registered in main', !handlerState.token && !handlerState.endpoint, JSON.stringify(handlerState))
    record('C (disabled): CSP does not mention the mcp origin', !c.cspMeta.includes(mcpOrigin), (/connect-src[^;]*/.exec(c.cspMeta) || [''])[0])
    record('C (disabled): a fetch to the mcp origin is blocked by CSP', c.mcpFetch === 'blocked' && c.violations.some(v => v.startsWith('connect-src')), `${c.mcpFetch}; ${c.violations.join(' | ')}`)

    // D: switch on but no endpoint: behaves like off
    fs.rmSync(path.join(root, 'user-data', 'probe-store.json'), { force: true })
    run = await launch(root, { ...baseEnv, PROBE_AGENT: 'on' })
    d = await inPage(run.page)
    await close(run.app)
    record('D (on, no endpoint): behaves as disabled, no bridge', d.bridge === null, JSON.stringify(d.bridge))
  } finally {
    mcp.server.close()
    other.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().then(() => {
  const failed = results.filter(r => !r.pass)
  if (json) console.log(JSON.stringify({ results }, null, 2))
  else for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`)
  console.log(`\nagent probe: ${results.length - failed.length}/${results.length} pass`)
  process.exit(failed.length ? 1 : 0)
}).catch((err) => { console.error('agent probe error:', err.stack || err); process.exit(2) })
