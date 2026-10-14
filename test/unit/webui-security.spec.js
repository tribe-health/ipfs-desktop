const { test, expect } = require('@playwright/test')
const { readFileSync } = require('fs')
const { join } = require('path')
const ipcMainEvents = require('../../src/common/ipc-main-events')
const { CHANNELS, ARG_AGENT_CHAT } = require('../../src/agent/consts')
const { WEBUI_ORIGIN, toHttpOrigin, originFromMultiaddr, buildCsp, installCsp, webPreferences } = require('../../src/webui/security')

const directives = (csp) => Object.fromEntries(csp.split('; ').map(d => {
  const [name, ...values] = d.split(' ')
  return [name, values]
}))

test.describe('Web UI window security', () => {
  test.describe('webPreferences', () => {
    test('keeps webSecurity on and isolates the renderer', () => {
      const prefs = webPreferences({ preload: '/p.js' })
      expect(prefs.webSecurity).toBe(true)
      expect(prefs.allowRunningInsecureContent).toBe(false)
      expect(prefs.contextIsolation).toBe(true)
      expect(prefs.sandbox).toBe(true)
      expect(prefs.nodeIntegration).toBe(false)
      expect(prefs.webviewTag).toBe(false)
    })

    test('only a test run may turn Node integration on, and then drops the sandbox', () => {
      const prefs = webPreferences({ preload: '/p.js', allowNodeIntegration: true })
      expect(prefs.nodeIntegration).toBe(true)
      expect(prefs.sandbox).toBe(false)
      expect(prefs.webSecurity).toBe(true)
    })
  })

  test.describe('buildCsp', () => {
    test('forbids unsafe-eval, unsafe inline scripts and remote asset origins', () => {
      const d = directives(buildCsp({ apiOrigin: 'http://127.0.0.1:5101', gatewayOrigin: 'http://127.0.0.1:8181' }))
      expect(d['default-src']).toEqual(["'none'"])
      expect(d['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"])
      expect(d['script-src']).not.toContain("'unsafe-eval'")
      expect(d['script-src']).not.toContain("'unsafe-inline'")
      expect(d['object-src']).toEqual(["'none'"])
      expect(d['frame-src']).toEqual(["'none'"])
      expect(d['frame-ancestors']).toEqual(["'none'"])
      expect(d['base-uri']).toEqual(["'none'"])
      expect(d['form-action']).toEqual(["'none'"])
    })

    test('connect-src lists self, the API and the gateway and nothing else when the chat is off', () => {
      const d = directives(buildCsp({ apiOrigin: 'http://127.0.0.1:5101', gatewayOrigin: 'http://127.0.0.1:8181' }))
      expect(d['connect-src']).toEqual(["'self'", 'http://127.0.0.1:5101', 'http://127.0.0.1:8181'])
    })

    test('connect-src gains exactly the ipfs mcp origin when one is configured', () => {
      const d = directives(buildCsp({ apiOrigin: 'http://127.0.0.1:5101', gatewayOrigin: null, mcpOrigin: 'http://127.0.0.1:7777' }))
      expect(d['connect-src']).toEqual(["'self'", 'http://127.0.0.1:5101', 'http://127.0.0.1:7777'])
    })

    test('an origin shared by two roles is listed once', () => {
      const d = directives(buildCsp({ apiOrigin: 'http://127.0.0.1:5101', gatewayOrigin: 'http://127.0.0.1:5101' }))
      expect(d['connect-src']).toEqual(["'self'", 'http://127.0.0.1:5101'])
    })

    test('no directive carries a wildcard, even when asked for one', () => {
      const csp = buildCsp({ apiOrigin: '*', gatewayOrigin: 'https://*.example.test', mcpOrigin: 'http://*:1' })
      expect(csp).not.toContain('*')
      expect(directives(csp)['connect-src']).toEqual(["'self'"])
    })

    test('origins that are not plain http(s) origins are dropped', () => {
      for (const bad of ['javascript:alert(1)', 'ws://127.0.0.1:1', 'http://u:p@127.0.0.1:1', 'not a url', '', 7, undefined, null]) {
        expect(toHttpOrigin(bad)).toBeNull()
      }
      expect(toHttpOrigin('http://127.0.0.1:5101/api/v0?x=1')).toBe('http://127.0.0.1:5101')
    })
  })

  test.describe('originFromMultiaddr', () => {
    test('maps the shapes the daemon reports', () => {
      expect(originFromMultiaddr('/ip4/127.0.0.1/tcp/5101')).toBe('http://127.0.0.1:5101')
      expect(originFromMultiaddr({ toString: () => '/ip4/0.0.0.0/tcp/8181' })).toBe('http://127.0.0.1:8181')
      expect(originFromMultiaddr('/ip6/::1/tcp/5101')).toBe('http://[::1]:5101')
      expect(originFromMultiaddr('/dns4/node.example/tcp/443/tls/http')).toBe('https://node.example')
    })

    test('yields null for anything it cannot reduce to a tcp origin', () => {
      for (const bad of ['/unix/tmp/ipfs.sock', '/ip4/1.2.3.4/udp/4001', 'garbage', null, undefined]) {
        expect(originFromMultiaddr(bad)).toBeNull()
      }
    })
  })

  test.describe('installCsp', () => {
    function fakeSession () {
      let filter, listener
      return {
        webRequest: { onHeadersReceived: (f, l) => { filter = f; listener = l } },
        filter: () => filter,
        respond: (responseHeaders) => new Promise(resolve => listener({ responseHeaders }, resolve))
      }
    }

    test('targets only webui://localhost responses', () => {
      const ses = fakeSession()
      installCsp(ses, () => ({}))
      expect(ses.filter()).toEqual({ urls: [`${WEBUI_ORIGIN}/*`] })
    })

    test('sets the policy and replaces any existing one, whatever its casing', async () => {
      const ses = fakeSession()
      installCsp(ses, () => ({ apiOrigin: 'http://127.0.0.1:5101' }))
      const { responseHeaders } = await ses.respond({ 'content-security-policy': ['default-src *'], 'Content-Type': ['text/html'] })
      expect(Object.keys(responseHeaders).filter(k => k.toLowerCase() === 'content-security-policy')).toEqual(['Content-Security-Policy'])
      expect(responseHeaders['Content-Security-Policy'][0]).toContain("script-src 'self'")
      expect(responseHeaders['Content-Type']).toEqual(['text/html'])
    })

    test('reads the sources per response, so a new daemon port applies on the next load', async () => {
      const ses = fakeSession()
      let api = 'http://127.0.0.1:5101'
      installCsp(ses, () => ({ apiOrigin: api }))
      expect((await ses.respond({})).responseHeaders['Content-Security-Policy'][0]).toContain('http://127.0.0.1:5101')
      api = 'http://127.0.0.1:5202'
      const second = (await ses.respond({})).responseHeaders['Content-Security-Policy'][0]
      expect(second).toContain('http://127.0.0.1:5202')
      expect(second).not.toContain('5101')
    })
  })

  // The sandboxed preload cannot require these modules, so it carries copies.
  test.describe('preload', () => {
    const source = readFileSync(join(__dirname, '../../src/webui/preload.js'), 'utf8')

    test('requires nothing but electron (a sandboxed preload cannot load relative files)', () => {
      const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1])
      expect(requires).toEqual(['electron'])
    })

    test('its copies of the channel and event names match the main process', () => {
      for (const event of ['COUNTLY_ADD_CONSENT', 'COUNTLY_REMOVE_CONSENT', 'LANG_UPDATED', 'ONLINE_STATUS_CHANGED', 'WEBUI_VISIBILITY_CHANGED']) {
        expect(source).toContain(`${event}: '${ipcMainEvents[event]}'`)
      }
      expect(source).toContain(`GET_ENDPOINT: '${CHANNELS.GET_ENDPOINT}'`)
      expect(source).toContain(`GET_TOKEN: '${CHANNELS.GET_TOKEN}'`)
      expect(source).toContain(`ARG_AGENT_CHAT = '${ARG_AGENT_CHAT}'`)
    })

    test('exposes the agent chat bridge only behind the flag', () => {
      expect(source).toContain('process.argv.includes(ARG_AGENT_CHAT) ? makeAgentChatBridge() : undefined')
    })
  })
})
