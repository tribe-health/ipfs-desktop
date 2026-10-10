'use strict'
/* global fetch, location, FormData, Blob */

// Hardening probe runner (docs/agent/HARDENING.md). Usage:
//
//   node test/hardening/run-probe.js --mode=baseline|hardened [--ipfs=/path/to/ipfs]
//        [--acao-webui] [--json]
//
// Starts an isolated Kubo daemon (own IPFS_PATH, API/Gateway/Swarm on OS-assigned
// ports, no bootstrap peers, no discovery) and an Electron instance with an isolated
// user-data dir and HOME, then runs the smoke items from the Web UI window. It refuses
// to run against a default IPFS port (4001, 5001, 8080). Exit status is non-zero when
// any item fails.

const { _electron: electron } = require('playwright')
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v === undefined ? true : v]
}))
const mode = args.mode === 'baseline' ? 'baseline' : 'hardened'
const ipfsBin = args.ipfs || process.env.IPFS_BIN || path.resolve(__dirname, '../../../kubo/cmd/ipfs/ipfs')
const FORBIDDEN_PORTS = new Set([4001, 5001, 8080])

const results = []
const record = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail })

function portOf (multiaddr) { return Number(multiaddr.split('/tcp/')[1].split('/')[0]) }

async function startDaemon (root) {
  const repo = path.join(root, 'ipfs-repo')
  const env = { ...process.env, IPFS_PATH: repo, IPFS_TELEMETRY: 'off', HOME: root }
  execFileSync(ipfsBin, ['init', '--profile=test'], { env, stdio: 'ignore' })
  const cfgPath = path.join(repo, 'config')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  // Same shape Desktop writes: strict CORS plus the Web UI origins its migration adds.
  cfg.API = { HTTPHeaders: { 'Access-Control-Allow-Origin': ['https://webui.ipfs.io'] } }
  cfg.Addresses.API = '/ip4/127.0.0.1/tcp/0'
  cfg.Addresses.Gateway = '/ip4/127.0.0.1/tcp/0'
  cfg.Addresses.Swarm = ['/ip4/127.0.0.1/tcp/0']
  cfg.Bootstrap = []
  cfg.Discovery = { MDNS: { Enabled: false } }
  cfg.Swarm = { ...(cfg.Swarm || {}), DisableNatPortMap: true }
  cfg.AutoTLS = { Enabled: false }
  if (args['acao-webui']) cfg.API.HTTPHeaders['Access-Control-Allow-Origin'].push('webui://localhost')
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

  const child = spawn(ipfsBin, ['daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('daemon did not become ready in 60s:\n' + out)), 60000)
    const onData = (d) => {
      out += d.toString()
      if (out.includes('Daemon is ready')) { clearTimeout(t); resolve() }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (c) => reject(new Error('daemon exited early ' + c + '\n' + out)))
  })
  await ready
  const apiMa = (/API server listening on (\S+)/.exec(out) || [])[1]
  const gwMa = (/Gateway server listening on (\S+)/.exec(out) || [])[1]
  return { child, apiMa, gwMa, repo }
}

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-desktop-probe-'))
  let daemon = null
  let app = null
  try {
    daemon = await startDaemon(root)
    const apiPort = portOf(daemon.apiMa)
    const gwPort = portOf(daemon.gwMa)
    if (FORBIDDEN_PORTS.has(apiPort) || FORBIDDEN_PORTS.has(gwPort)) throw new Error('refusing to run on a default IPFS port')
    const apiOrigin = `http://127.0.0.1:${apiPort}`
    const gatewayOrigin = `http://127.0.0.1:${gwPort}`
    if (!args['acao-webui']) {
      // Desktop also adds the gateway-subdomain origin; irrelevant to webui:// but kept for parity.
    }

    app = await electron.launch({
      args: [path.join(__dirname, 'probe-main.js')],
      env: {
        ...process.env,
        HOME: root,
        PROBE_MODE: mode,
        PROBE_USER_DATA: path.join(root, 'user-data'),
        PROBE_API_ORIGIN: apiOrigin,
        PROBE_API_MULTIADDR: daemon.apiMa,
        PROBE_GATEWAY_ORIGIN: gatewayOrigin
      }
    })
    const page = await app.firstWindow()
    const outbound = new Set()
    const apiFailures = []
    const consoleErrors = []
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
    page.on('request', r => {
      const u = new URL(r.url())
      if (u.origin !== 'webui://localhost' && u.origin !== apiOrigin && !/^(data|blob):/.test(r.url())) outbound.add(u.origin)
    })
    page.on('response', r => { if (r.url().startsWith(apiOrigin) && r.status() >= 400) apiFailures.push(`${r.status()} ${r.url().replace(apiOrigin, '')}`) })
    page.on('requestfailed', r => { if (r.url().startsWith(apiOrigin)) apiFailures.push(`failed ${r.url().replace(apiOrigin, '')} ${r.failure()?.errorText}`) })
    // What the preload is meant to do (src/webui/preload.js, "Inject api address"). Done
    // here for both modes so the Web UI never falls back to the default API port.
    await page.addInitScript((ma) => {
      if (location.protocol === 'webui:') window.localStorage.setItem('ipfsApi', ma)
    }, daemon.apiMa)
    await page.addInitScript(() => {
      window.__csp = []
      document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
    })
    await page.reload()
    await page.waitForLoadState('load')
    await page.waitForTimeout(2500)

    record('window loads the bundled Web UI from webui://localhost', page.url().startsWith('webui://localhost'), page.url().split('?')[0])
    record('app title present', /IPFS/i.test(await page.title()), await page.title())

    const info = await page.evaluate(async () => ({
      bridge: typeof window.ipfsDesktop,
      bridgeKeys: window.ipfsDesktop ? Object.keys(window.ipfsDesktop) : [],
      hasRequire: typeof window.require,
      ipfsApi: window.localStorage.getItem('ipfsApi'),
      csp: (await fetch(location.href)).headers.get('content-security-policy')
    }))
    record('preload bridge window.ipfsDesktop is exposed', info.bridge === 'object', info.bridgeKeys.join(','))
    record('renderer has no Node require', info.hasRequire === 'undefined', info.hasRequire)
    record('Web UI is pointed at the isolated API (ipfsApi)', info.ipfsApi === daemon.apiMa, String(info.ipfsApi))
    record('preload script loaded (no preload error in the console)', !consoleErrors.some(e => /preload/i.test(e)), consoleErrors.filter(e => /preload/i.test(e)).join(' | ') || 'ok')
    record(`CSP header on webui:// responses is ${mode === 'hardened' ? 'present' : 'absent (baseline)'}`, mode === 'hardened' ? Boolean(info.csp) : !info.csp, info.csp || 'none')

    // RPC from the page: the CORS-sensitive path (Origin: webui://localhost).
    const rpc = await page.evaluate(async (api) => {
      const post = async (p, body) => {
        try {
          const r = await fetch(`${api}/api/v0/${p}`, { method: 'POST', body })
          const text = await r.text()
          return { status: r.status, text: text.slice(0, 160) }
        } catch (e) { return { status: 0, text: String(e) } }
      }
      const fd = new FormData()
      fd.append('file', new Blob(['hardening probe\n']), 'probe.txt')
      const added = await post('add?pin=false&cid-version=1', fd)
      let cid = ''
      try { cid = JSON.parse(added.text.split('\n')[0]).Hash } catch (_) {}
      return {
        files: await post('files/ls?arg=/'),
        explore: await post(`dag/get?arg=${cid}`),
        peers: await post('swarm/peers'),
        settings: await post('config/show'),
        add: added,
        pin: await post(`pin/add?arg=${cid}`),
        pinLs: await post('pin/ls?type=recursive'),
        cid
      }
    }, apiOrigin)
    for (const [k, label] of [['files', 'files: files/ls'], ['explore', 'explore: dag/get'], ['peers', 'peers: swarm/peers'], ['settings', 'settings: config/show'], ['add', 'add: add (multipart POST)'], ['pin', 'pin: pin/add'], ['pinLs', 'pin: pin/ls']]) {
      record(label, rpc[k].status === 200, `status ${rpc[k].status} ${rpc[k].status === 200 ? '' : rpc[k].text}`)
    }

    // The Web UI routes render without a connection error banner.
    for (const route of ['/', '/files', '/explore', '/peers', '/settings']) {
      apiFailures.length = 0
      await page.evaluate((r) => { window.location.hash = r }, route)
      await page.waitForTimeout(2500)
      const view = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 4000), h: location.hash }))
      const bad = /Cannot connect|can't connect|connection failed|Unable to connect/i.test(view.text)
      // The Web UI bounces to #/welcome when it cannot reach the API, so a hash that
      // moved away from the requested route is a failure even though a page rendered.
      const stayed = view.h === `#${route}`
      record(`route #${route} renders on its own route with no API failure`, !bad && stayed && apiFailures.length === 0 && view.text.length > 50, `hash ${view.h}, ${view.text.length} chars, api failures: ${apiFailures.length ? apiFailures.slice(0, 3).join('; ') : 'none'}`)
    }

    const routeViolations = await page.evaluate(() => window.__csp.slice())
    record('CSP violations while using the Web UI (expected none)', routeViolations.length === 0, routeViolations.join(' | ') || 'none')

    // Containment: external fetch, inline script, eval.
    const contain = await page.evaluate(async () => {
      window.__csp.length = 0
      let fetchOutcome
      try { await fetch('https://csp-probe.invalid/x'); fetchOutcome = 'resolved' } catch (e) { fetchOutcome = 'rejected' }
      await new Promise(resolve => setTimeout(resolve, 300))
      const afterFetch = window.__csp.slice()
      window.__csp.length = 0
      const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s)
      const rs = document.createElement('script'); rs.src = 'https://csp-probe.invalid/a.js'; document.body.append(rs)
      let evalOutcome
      try {
        evalOutcome = String(eval('1+1')) // eslint-disable-line no-eval
      } catch (e) {
        evalOutcome = 'blocked'
      }
      await new Promise(resolve => setTimeout(resolve, 300))
      return { fetchOutcome, afterFetch, inlineRan: window.__inline === 1, evalOutcome, afterScripts: window.__csp.slice() }
    })
    const fetchBlockedByCsp = contain.afterFetch.some(v => v.startsWith('connect-src'))
    record('external fetch is blocked by CSP connect-src', fetchBlockedByCsp, `fetch ${contain.fetchOutcome}; violations: ${contain.afterFetch.join(' | ') || 'none'}`)
    record('inline script does not run', !contain.inlineRan, `ran=${contain.inlineRan}`)
    record('remote script is blocked by CSP script-src', contain.afterScripts.some(v => v.startsWith('script-src')), contain.afterScripts.join(' | ') || 'none')
    record('eval is blocked (no unsafe-eval)', contain.evalOutcome === 'blocked', `eval -> ${contain.evalOutcome}`)

    const allViolations = await page.evaluate(() => window.__csp.slice())
    record('info: outbound origins requested by the Web UI during the run', true, [...outbound].join(', ') || 'none')
    record('info: console errors', true, consoleErrors.slice(0, 6).join(' || ') || 'none')
    record('info: late CSP violations', true, allViolations.join(' | ') || 'none')
  } finally {
    if (app) { try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 8000))]) } catch (_) {} try { app.process().kill('SIGKILL') } catch (_) {} }
    if (daemon) { daemon.child.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 1500)); try { daemon.child.kill('SIGKILL') } catch (_) {} }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().then(() => {
  const failed = results.filter(r => !r.pass)
  if (args.json) console.log(JSON.stringify({ mode, acaoWebui: Boolean(args['acao-webui']), results }, null, 2))
  else for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`)
  console.log(`\nmode=${mode} acao-webui=${Boolean(args['acao-webui'])}: ${results.length - failed.length}/${results.length} pass`)
  process.exit(failed.length ? 1 : 0)
}).catch((err) => { console.error('probe error:', err.stack || err); process.exit(2) })
