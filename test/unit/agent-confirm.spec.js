const { test, expect } = require('@playwright/test')
const { EventEmitter } = require('events')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { KEYS, CONFIRM_CHANNELS } = require('../../src/agent/consts')
const { createPairingStore, normalizePairingKey, PAIRING_KEY_SHAPE } = require('../../src/agent/confirm/pairing')
const channel = require('../../src/agent/confirm/channel-client')
const { createConfirmationController } = require('../../src/agent/confirm/controller')
const { createAgentConfirmation, parseSwitch } = require('../../src/agent/confirm')
const { createConfirmationWindows, isFromWindow, isUiFileUrl, UI_DIR } = require('../../src/agent/confirm/windows')
const { createTouchId } = require('../../src/agent/confirm/touchid')
const { windowStrings, approveLabel, touchReason, STRING_IDS, KIND_KEYS } = require('../../src/agent/confirm/strings')
const { buildAgentConfirmSubmenu } = require('../../src/agent/confirm/tray-menu')

const KEY = 'A'.repeat(43)
const CID_V1 = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
const LOCALE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../assets/locales/en.json'), 'utf8'))

const lookup = (key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), LOCALE)

/** A translator over en.json with the `{name}` placeholders of its ICU strings. */
const i18n = {
  exists: (key) => lookup(key) !== undefined,
  t: (key, options = {}) => {
    const text = lookup(key)
    return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (m, k) => (k in options ? String(options[k]) : m)) : key
  }
}

function memoryStore (initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    set: (key, value) => { data.set(key, value) },
    delete: (key) => { data.delete(key) },
    dump: () => JSON.stringify([...data.entries()])
  }
}

function fakeSafeStorage ({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(plain.split('').reverse().join('') + '|sealed'),
    decryptString: (buf) => buf.toString().slice(0, -'|sealed'.length).split('').reverse().join('')
  }
}

const item = (over = {}) => ({
  id: 'c1',
  summary: `Pin /ipfs/${CID_V1} (recursive=true)`,
  summaryTruncated: false,
  targets: [{ kind: 'cid', value: CID_V1, truncated: false }],
  tool: 'pin_add',
  cls: 'write',
  expiresAt: Date.now() + 60000,
  nativePrompt: false,
  principalKind: 'human-mcp',
  ...over
})

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 5)) }
  throw new Error('timed out')
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test.describe('pairing key store', () => {
  test('accepts exactly what ipfs mcp pair prints and keeps ciphertext only', () => {
    const store = memoryStore()
    const pairing = createPairingStore({ safeStorage: fakeSafeStorage(), store })
    expect(pairing.has()).toBe(false)
    pairing.set(KEY)
    expect(pairing.get()).toBe(KEY)
    expect(store.dump()).not.toContain(KEY)
    expect(store.get(KEYS.PAIRING_CIPHERTEXT)).toBeTruthy()
  })

  test('refuses a key with the wrong shape, and stores nothing when the keystore is unavailable', () => {
    const store = memoryStore()
    const pairing = createPairingStore({ safeStorage: fakeSafeStorage(), store })
    for (const bad of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '=', 'A'.repeat(42) + ' ', 42]) {
      expect(() => pairing.set(bad)).toThrow(/invalid shape/)
    }
    const locked = createPairingStore({ safeStorage: fakeSafeStorage({ available: false }), store })
    expect(() => locked.set(KEY)).toThrow(/secure storage is unavailable/)
    expect(store.get(KEYS.PAIRING_CIPHERTEXT)).toBeUndefined()
  })

  test('a pasted key loses whitespace and line wraps only', () => {
    expect(normalizePairingKey(` ${KEY.slice(0, 20)}\n${KEY.slice(20)}\r\n`)).toBe(KEY)
    expect(PAIRING_KEY_SHAPE.test(normalizePairingKey(` ${KEY}\n`))).toBe(true)
  })
})

test.describe('channel authentication version 2', () => {
  // kubo mcp/server/confirm/MECHANISMS.md, "Channel authentication, version 2".
  const K = channel.deriveKey('example-pairing-key')
  const nonce = Buffer.from([...Array(16).keys()]).toString('base64url')

  test('reproduces the specification test vector byte for byte', () => {
    expect(K.toString('hex')).toBe('bb7a643be3798381e468615dc1397a9e2cb519d7d2a927fcb7f5ea7a7a6d847f')
    expect(nonce).toBe('AAECAwQFBgcICQoLDA0ODw')
    expect(channel.requestString({ socket: '4242-1.sock', method: 'GET', path: '/v1/pending', timestamp: '1760270400', nonce, body: '' }).split('\n')).toEqual([
      'ipfs-mcp-confirm-v2', 'request', '4242-1.sock', 'GET', '/v1/pending', '1760270400', nonce,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    ])
    expect(channel.signRequest({ K, socket: '4242-1.sock', method: 'GET', path: '/v1/pending', timestamp: '1760270400', nonce, body: '' }))
      .toBe('kJV7qp4TLPIC1phDIUnyT_W0YR9_eMnJlKfzv4uWtzs')
    expect(channel.serverProof({ K, socket: '4242-1.sock', nonce, status: 200, body: '{"pending":[]}\n' }))
      .toBe('paaByo8rrHXnI8pwzkw0SFyWQ7DUnkM3CwbGy0bZsbs')
  })

  test('a different socket, method, path, body or nonce gives a different signature', () => {
    const base = { K, socket: '4242-1.sock', method: 'GET', path: '/v1/pending', timestamp: '1760270400', nonce, body: '' }
    const sig = channel.signRequest(base)
    for (const change of [{ socket: '4242-2.sock' }, { method: 'POST' }, { path: '/v1/resolve' }, { body: 'x' }, { nonce: 'AAECAwQFBgcICQoLDA0ODx' }, { timestamp: '1760270401' }]) {
      expect(channel.signRequest({ ...base, ...change })).not.toBe(sig)
    }
  })

  let dir
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-')) })
  test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  /**
   * A server socket that verifies the request exactly as the spec says and answers with
   * `proofMode`: 'valid', 'none', or 'wrong'. It records what the client sent.
   */
  function server (name, { key = KEY, proofMode = 'valid', pending = [], resolveStatus = 200 } = {}) {
    const sock = path.join(dir, name)
    const Kserver = channel.deriveKey(key)
    const seen = []
    const srv = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const h = req.headers
        seen.push({ method: req.method, url: req.url, headers: h, body: body.toString() })
        const expected = channel.signRequest({ K: Kserver, socket: name, method: req.method, path: req.url, timestamp: h['x-ipfs-mcp-timestamp'], nonce: h['x-ipfs-mcp-nonce'], body })
        const answer = (status, obj) => {
          const raw = Buffer.from(JSON.stringify(obj) + '\n')
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          if (proofMode === 'valid') res.setHeader('X-IPFS-MCP-Server-Proof', channel.serverProof({ K: Kserver, socket: name, nonce: h['x-ipfs-mcp-nonce'], status, body: raw }))
          if (proofMode === 'wrong') res.setHeader('X-IPFS-MCP-Server-Proof', 'A'.repeat(43))
          res.end(raw)
        }
        if (h.authorization || h['x-ipfs-mcp-auth-version'] !== '2' || h['x-ipfs-mcp-signature'] !== expected) return answer(403, { error: 'no', code: 'auth_invalid' })
        if (req.url === '/v1/pending') return answer(200, { pending })
        return answer(resolveStatus, resolveStatus === 200 ? { id: 'c1', approved: true } : { error: 'x' })
      })
    })
    return new Promise((resolve) => srv.listen(sock, () => resolve({ sock, srv, seen })))
  }

  test('requests carry the four headers once, a signature the server accepts, and never the key', async () => {
    test.skip(process.platform === 'win32', 'Unix sockets: Desktop is inert on win32')
    const { sock, srv, seen } = await server('7-1.sock', { pending: [{ id: 'c1', summary: 'Pin x', tool: 'pin_add', class: 'write', expires_at: new Date(Date.now() + 60000).toISOString(), targets: [{ kind: 'cid', value: CID_V1 }] }] })
    const listed = await channel.listPending(sock, KEY)
    expect(listed.ok).toBe(true)
    expect(listed.items[0]).toMatchObject({ id: 'c1', targets: [{ kind: 'cid', value: CID_V1, truncated: false }] })
    expect(await channel.resolvePending(sock, KEY, 'c1', true)).toBe('resolved')
    for (const r of seen) {
      expect(r.headers['x-ipfs-mcp-auth-version']).toBe('2')
      expect(r.headers['x-ipfs-mcp-timestamp']).toMatch(/^[1-9]\d{9}$/)
      expect(r.headers['x-ipfs-mcp-nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(r.headers['x-ipfs-mcp-signature']).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(r.headers.authorization).toBeUndefined()
      expect(JSON.stringify(r)).not.toContain(KEY)
    }
    expect(seen[1].body).toBe('{"id":"c1","approve":true}')
    expect(new Set(seen.map((r) => r.headers['x-ipfs-mcp-nonce'])).size).toBe(2)
    srv.close()
  })

  test('a socket that cannot prove it holds the verifier is not believed', async () => {
    test.skip(process.platform === 'win32', 'Unix sockets: Desktop is inert on win32')
    for (const proofMode of ['none', 'wrong']) {
      const { sock, srv } = await server(`${proofMode === 'none' ? 8 : 9}-1.sock`, { proofMode, pending: [{ id: 'c1', summary: 'Pin x', tool: 'pin_add', class: 'write', expires_at: new Date(Date.now() + 60000).toISOString() }] })
      expect(await channel.listPending(sock, KEY)).toMatchObject({ ok: false, reason: 'proof' })
      expect(await channel.resolvePending(sock, KEY, 'c1', true)).toBe('untrusted')
      srv.close()
    }
  })

  test('a server holding another key answers 403: rejected, not trusted', async () => {
    test.skip(process.platform === 'win32', 'Unix sockets: Desktop is inert on win32')
    const { sock, srv } = await server('10-1.sock', { key: 'another-key' })
    expect(await channel.listPending(sock, KEY)).toMatchObject({ ok: false, reason: 'rejected', status: 403 })
    expect(await channel.resolvePending(sock, KEY, 'c1', false)).toBe('rejected')
    srv.close()
  })

  test('a socket that trickles bytes is cut off at the total deadline', async () => {
    test.skip(process.platform === 'win32', 'Unix sockets: Desktop is inert on win32')
    const sock = path.join(dir, '11-1.sock')
    const srv = http.createServer((req, res) => {
      res.writeHead(200)
      const t = setInterval(() => res.write(' '), 20)
      res.on('close', () => clearInterval(t))
    })
    await new Promise((resolve) => srv.listen(sock, resolve))
    const started = Date.now()
    expect(await channel.listPending(sock, KEY, { totalMs: 150 })).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(Date.now() - started).toBeLessThan(1500)
    srv.closeAllConnections()
    srv.close()
  })

  test('an answer is unreachable when nothing listens', async () => {
    test.skip(process.platform === 'win32', 'Unix sockets: Desktop is inert on win32')
    expect(await channel.listPending(path.join(dir, '5-1.sock'), KEY)).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(await channel.resolvePending(path.join(dir, '5-1.sock'), KEY, 'c1', true)).toBe('unreachable')
  })

  test('socket directory follows the server rule: env, XDG_RUNTIME_DIR, then the temp directory', () => {
    expect(channel.socketDirectory({ env: { IPFS_MCP_CONFIRM_DIR: '/a', XDG_RUNTIME_DIR: '/b' }, tmpdir: '/t', uid: 7 })).toBe('/a')
    expect(channel.socketDirectory({ env: { XDG_RUNTIME_DIR: '/b' }, tmpdir: '/t', uid: 7 })).toBe(path.join('/b', 'ipfs-mcp'))
    expect(channel.socketDirectory({ env: {}, tmpdir: '/t', uid: 7 })).toBe(path.join('/t', 'ipfs-mcp-7'))
  })

  test('only live <pid>-<seq>.sock sockets in a private directory we own are trusted', async () => {
    test.skip(process.platform === 'win32', 'Unix sockets and uids: Desktop is inert on win32')
    fs.chmodSync(dir, 0o700)
    const live = await server(`${process.pid}-1.sock`)
    const dead = await server('2147483646-1.sock') // no such process
    fs.writeFileSync(path.join(dir, 'notes.sock'), 'x')
    const found = channel.discoverSockets(dir)
    expect(found.problem).toBeNull()
    expect(found.sockets.map((s) => path.basename(s))).toEqual([`${process.pid}-1.sock`])
    live.srv.close()
    dead.srv.close()
  })

  test('a missing directory is quiet; a shared, foreign or linked one is refused', () => {
    test.skip(process.platform === 'win32', 'Unix modes and symlinks: Desktop is inert on win32')
    expect(channel.discoverSockets(path.join(dir, 'absent'))).toEqual({ sockets: [], problem: null })
    fs.chmodSync(dir, 0o755)
    expect(channel.discoverSockets(dir).problem).toMatch(/accessible to other users/)
    fs.chmodSync(dir, 0o700)
    expect(channel.discoverSockets(dir, { uid: (process.getuid() + 1) }).problem).toMatch(/another user/)
    const link = path.join(os.tmpdir(), `dc-link-${process.pid}`)
    fs.symlinkSync(dir, link)
    try {
      expect(channel.discoverSockets(link).problem).toMatch(/not a directory/)
    } finally {
      fs.unlinkSync(link)
    }
  })
})

test.describe('what the window shows from the server', () => {
  const view = (over) => channel.parsePending({ pending: [{ id: 'a', summary: 's', tool: 't', class: 'write', expires_at: new Date(Date.now() + 1000).toISOString(), ...over }] })[0]

  test('targets arrive with their kind, in full, and unknown kinds fall back to content', () => {
    const p = view({ targets: [{ kind: 'cid', value: CID_V1 }, { kind: 'mfs_path', value: '/docs/a.txt' }, { kind: 'weird', value: 'v' }, { kind: 'cid', value: '' }, 'junk'] })
    expect(p.targets).toEqual([
      { kind: 'cid', value: CID_V1, truncated: false },
      { kind: 'mfs_path', value: '/docs/a.txt', truncated: false },
      { kind: 'content', value: 'v', truncated: false }
    ])
    expect(view({}).targets).toEqual([])
  })

  test('invisible, joining, bidi and tag characters become U+FFFD, in summary and targets', () => {
    const bad = [0x07, 0xad, 0x61c, 0x200b, 0x200d, 0x200f, 0x2028, 0x2029, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff, 0xfff9, 0xfffb, 0xe0041].map((cp) => String.fromCodePoint(cp))
    const p = view({ summary: `a${bad.join('x')}b`, targets: [{ kind: 'key', value: `k${bad.join('')}` }] })
    for (const ch of bad) {
      expect(p.summary).not.toContain(ch)
      expect(p.targets[0].value).not.toContain(ch)
    }
    expect(p.summary).toBe(`a${bad.map(() => String.fromCodePoint(0xfffd)).join('x')}b`)
    expect(view({ summary: 'tab\there\nline' }).summary).toBe('tab here line')
  })

  test('a cut is marked and never lands inside a surrogate pair', () => {
    const long = '\u{1F600}'.repeat(2000)
    const p = view({ summary: long, targets: [{ kind: 'content', value: long }] })
    expect(p.summaryTruncated).toBe(true)
    expect(p.targets[0].truncated).toBe(true)
    expect(Array.from(p.summary)).toHaveLength(600)
    expect(p.summary).toBe(p.summary.toWellFormed())
    expect(Array.from(p.targets[0].value)).toHaveLength(1024)
    expect(view({ summary: 'short' }).summaryTruncated).toBe(false)
    expect(channel.cleanText('x\ud800y', 10).text).toBe('x�y')
  })
})

/** A recorded controller over fakes. */
function harness ({ key = KEY, pending = [item()], socks = ['/s/1-1.sock'], resolveOutcome = 'resolved', touch = 'allow' } = {}) {
  const calls = { discover: 0, list: [], resolve: [], shown: [], results: [], errors: [], busy: [], hidden: 0, rejected: 0, touch: [], logs: [] }
  const state = { key, pending, socks, resolveOutcome, listAnswer: null, touch, problem: null }
  const controller = createConfirmationController({
    pairing: { get: () => state.key || undefined },
    getDirectory: () => '/s',
    client: {
      discoverSockets: () => { calls.discover++; return { sockets: state.socks, problem: state.problem } },
      listPending: async (sock, k) => {
        calls.list.push({ sock, key: k })
        return state.listAnswer ?? { ok: true, items: state.pending }
      },
      resolvePending: async (sock, k, id, approve) => { calls.resolve.push({ sock, key: k, id, approve }); return state.resolveOutcome }
    },
    presenter: {
      show: (v) => calls.shown.push(v),
      showResult: (r) => calls.results.push(r),
      showError: (ref, kind) => calls.errors.push({ ref, kind }),
      showBusy: (ref) => calls.busy.push(ref),
      hide: () => { calls.hidden++ }
    },
    authenticate: {
      available: () => state.touch !== 'unavailable',
      prompt: async (reason) => { calls.touch.push(reason); return state.touch === 'allow' }
    },
    touchReason: (it) => `approve ${it.tool}`,
    hooks: { onPairingRejected: () => { calls.rejected++ } },
    logger: { info: (m) => calls.logs.push(['info', m]), warn: (m) => calls.logs.push(['warn', m]) },
    pollMs: 10,
    resultMs: 5
  })
  return { controller, calls, state }
}

test.describe('confirmation controller', () => {
  test('unpaired: polls but never reads a directory, a socket or a request', async () => {
    const { controller, calls } = harness({ key: null })
    controller.start()
    await until(() => controller.polls >= 5)
    controller.dispose()
    expect(calls.discover).toBe(0)
    expect(calls.list).toEqual([])
    expect(calls.resolve).toEqual([])
    expect(calls.shown).toEqual([])
  })

  test('paired: shows the pending request with its targets once, and hands only the pairing key to the client', async () => {
    const { controller, calls } = harness()
    controller.start()
    await until(() => calls.shown.length >= 1)
    await until(() => controller.polls >= 4)
    controller.dispose()
    expect(calls.shown).toHaveLength(1) // an unchanged request does not reset the page
    expect(calls.shown[0]).toMatchObject({ summary: `Pin /ipfs/${CID_V1} (recursive=true)`, targets: [{ kind: 'cid', value: CID_V1 }], tool: 'pin_add', total: 1, canApprove: true, approveBlocked: null })
    expect(calls.list[0]).toEqual({ sock: '/s/1-1.sock', key: KEY })
  })

  test('deny sends one deny with no Touch ID; the answer is for the shown request only', async () => {
    const { controller, calls } = harness()
    controller.start()
    await until(() => calls.shown.length === 1)
    await controller.decide('not-the-ref', false)
    expect(calls.resolve).toEqual([])
    await controller.decide(calls.shown[0].ref, false)
    expect(calls.resolve).toEqual([{ sock: '/s/1-1.sock', key: KEY, id: 'c1', approve: false }])
    expect(calls.results[0].kind).toBe('denied')
    expect(calls.touch).toEqual([])
    controller.dispose()
  })

  test('approve asks for Touch ID first and sends exactly one approve on success', async () => {
    const { controller, calls } = harness()
    controller.start()
    await until(() => calls.shown.length === 1)
    await controller.decide(calls.shown[0].ref, true, { armedForMs: 1800, focused: true })
    expect(calls.touch).toEqual(['approve pin_add'])
    expect(calls.busy).toHaveLength(1)
    expect(calls.resolve).toEqual([{ sock: '/s/1-1.sock', key: KEY, id: 'c1', approve: true }])
    expect(calls.results[0].kind).toBe('approved')
    const log = calls.logs.map((l) => l[1]).join('\n')
    expect(log).toMatch(/touch id for pin_add c1: ok .* armed for 1800 ms, window focused: true/)
    expect(log).not.toContain(KEY)
    controller.dispose()
  })

  test('a failed or cancelled Touch ID sends nothing and leaves the request pending', async () => {
    const { controller, calls, state } = harness({ touch: 'deny' })
    controller.start()
    await until(() => calls.shown.length === 1)
    await controller.decide(calls.shown[0].ref, true)
    expect(calls.touch).toHaveLength(1)
    expect(calls.resolve).toEqual([])
    expect(calls.errors).toEqual([{ ref: calls.shown[0].ref, kind: 'touch-id' }])
    expect(controller.pending).toBe(1)
    state.touch = 'allow' // the person tries again
    await controller.decide(calls.shown[0].ref, true)
    expect(calls.resolve).toHaveLength(1)
    controller.dispose()
  })

  test('without Touch ID this app cannot approve, and says so; it can still deny', async () => {
    const { controller, calls } = harness({ touch: 'unavailable' })
    controller.start()
    await until(() => calls.shown.length === 1)
    expect(calls.shown[0]).toMatchObject({ canApprove: false, approveBlocked: 'no-touch-id' })
    await controller.decide(calls.shown[0].ref, true)
    expect(calls.touch).toEqual([])
    expect(calls.resolve).toEqual([])
    expect(calls.errors[0].kind).toBe('no-touch-id')
    await controller.decide(calls.shown[0].ref, false)
    expect(calls.resolve).toHaveLength(1)
    controller.dispose()
  })

  test('a request flagged for the system prompt gets no approval, even from a forged message', async () => {
    const { controller, calls } = harness({ pending: [item({ nativePrompt: true })] })
    controller.start()
    await until(() => calls.shown.length === 1)
    expect(calls.shown[0]).toMatchObject({ nativePrompt: true, canApprove: false, approveBlocked: 'native' })
    await controller.decide(calls.shown[0].ref, true)
    expect(calls.touch).toEqual([])
    expect(calls.resolve).toEqual([])
    await controller.decide(calls.shown[0].ref, false)
    expect(calls.resolve).toHaveLength(1)
    controller.dispose()
  })

  test('the server may keep listing a request after it is decided; it is not shown again', async () => {
    const { controller, calls } = harness()
    controller.start()
    await until(() => calls.shown.length === 1)
    await controller.decide(calls.shown[0].ref, false)
    const polled = controller.polls
    await until(() => controller.polls >= polled + 4)
    controller.dispose()
    expect(calls.shown).toHaveLength(1)
    expect(calls.resolve).toHaveLength(1)
  })

  test('the soonest expiry is shown first, and a withdrawn request disappears', async () => {
    const soon = item({ id: 'soon', summary: 'soon one', expiresAt: Date.now() + 5000 })
    const later = item({ id: 'later', summary: 'later one', expiresAt: Date.now() + 50000 })
    const { controller, calls, state } = harness({ pending: [later, soon] })
    controller.start()
    await until(() => calls.shown.length >= 1)
    expect(calls.shown[0]).toMatchObject({ summary: 'soon one', total: 2 })
    state.pending = [later]
    await until(() => calls.shown.some((v) => v.summary === 'later one'))
    state.pending = []
    await until(() => calls.hidden >= 1)
    controller.dispose()
  })

  test('a window the person closed is shown again while a request is still pending', async () => {
    const { controller, calls } = harness()
    controller.start()
    await until(() => calls.shown.length === 1)
    controller.surfaceClosed()
    await until(() => calls.shown.length === 2)
    expect(calls.shown[1].ref).toBe(calls.shown[0].ref)
    controller.dispose()
  })

  test('a server that does not accept the key is reported once and left alone', async () => {
    const { controller, calls, state } = harness()
    state.listAnswer = { ok: false, reason: 'rejected', status: 403 }
    controller.start()
    await until(() => calls.rejected === 1)
    const listed = calls.list.length
    await until(() => controller.polls >= 6)
    controller.dispose()
    expect(calls.rejected).toBe(1)
    expect(calls.list.length).toBe(listed)
    expect(calls.shown).toEqual([])
  })

  test('a socket without a valid server proof is ignored: nothing shown, nothing sent, one warning', async () => {
    const { controller, calls, state } = harness()
    state.listAnswer = { ok: false, reason: 'proof', status: 200 }
    controller.start()
    await until(() => calls.list.length === 1)
    await until(() => controller.polls >= 6)
    controller.dispose()
    expect(calls.list).toHaveLength(1) // not asked again for this key
    expect(calls.shown).toEqual([])
    expect(calls.resolve).toEqual([])
    expect(calls.logs.filter((l) => l[0] === 'warn' && /did not prove/.test(l[1]))).toHaveLength(1)
  })

  test('a standing problem is logged once, not on every poll', async () => {
    const { controller, calls, state } = harness()
    state.problem = 'the confirmation directory is accessible to other users'
    controller.start()
    await until(() => controller.polls >= 6)
    controller.dispose()
    expect(calls.logs.filter((l) => l[0] === 'warn')).toHaveLength(1)
  })

  test('an unreachable server leaves the request open for another answer', async () => {
    const { controller, calls, state } = harness({ resolveOutcome: 'unreachable' })
    controller.start()
    await until(() => calls.shown.length === 1)
    await controller.decide(calls.shown[0].ref, false)
    expect(calls.errors).toEqual([{ ref: calls.shown[0].ref, kind: 'unreachable' }])
    expect(controller.pending).toBe(1)
    state.resolveOutcome = 'resolved'
    await controller.decide(calls.shown[0].ref, false)
    expect(calls.results[0].kind).toBe('denied')
    controller.dispose()
  })

  test('an expired request is never shown', async () => {
    const { controller, calls } = harness({ pending: [item({ expiresAt: Date.now() - 1 })] })
    controller.start()
    await until(() => controller.polls >= 4)
    controller.dispose()
    expect(calls.shown).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------

class FakeWindow extends EventEmitter {
  constructor (options) {
    super()
    FakeWindow.all.push(this)
    this.options = options
    this.visible = false
    this.focused = false
    this.destroyed = false
    this.calls = []
    this.protected = false
    const contents = new EventEmitter()
    contents.sent = []
    contents.send = (channelName, payload) => contents.sent.push([channelName, payload])
    contents.setWindowOpenHandler = () => {}
    contents.mainFrame = { url: '' }
    this.webContents = contents
  }

  loadFile (file) {
    this.webContents.mainFrame.url = pathToFileURL(file).href
    setImmediate(() => this.webContents.emit('did-finish-load'))
  }

  setMenuBarVisibility () {}
  setContentProtection (v) { this.protected = v }
  setAlwaysOnTop () { this.calls.push('setAlwaysOnTop') }
  isVisible () { return this.visible }
  isFocused () { return this.focused }
  isDestroyed () { return this.destroyed }
  show () { this.visible = true; this.calls.push('show') }
  showInactive () { this.visible = true; this.calls.push('showInactive') }
  focus () { this.calls.push('focus'); this.focused = true; this.emit('focus') }
  blur () { this.focused = false; this.emit('blur') }
  hide () { this.visible = false; this.focused = false; this.emit('blur'); this.emit('hide') }
  destroy () { this.destroyed = true; this.emit('closed') }
  close () {
    const event = { prevented: false, preventDefault () { this.prevented = true } }
    this.emit('close', event)
    if (!event.prevented) this.destroy()
  }

  last (channelName) { return [...this.webContents.sent].reverse().find(([c]) => c === channelName)?.[1] }
}
FakeWindow.all = []

function fakeElectron () {
  FakeWindow.all = []
  const handlers = new Map()
  const registered = []
  const ipcMain = {
    on: (c, fn) => { handlers.set(c, fn); registered.push(c) },
    handle: (c, fn) => { handlers.set(c, fn); registered.push(c) },
    removeListener: (c) => handlers.delete(c),
    removeHandler: (c) => handlers.delete(c)
  }
  const sessionApi = { setPermissionRequestHandler () {}, setPermissionCheckHandler () {}, webRequest: { onBeforeRequest () {} } }
  return {
    handlers,
    registered,
    emit: (c, event, ...args) => handlers.get(c)(event, ...args),
    electron: { BrowserWindow: FakeWindow, ipcMain, session: { fromPartition: () => sessionApi }, safeStorage: fakeSafeStorage() }
  }
}

const requestView = (over = {}) => ({
  ref: 'r1',
  summary: 's',
  summaryTruncated: false,
  targets: [],
  tool: 'pin_add',
  cls: 'write',
  expiresAt: Date.now() + 60000,
  nativePrompt: false,
  canApprove: true,
  approveBlocked: null,
  principalKind: 'human-mcp',
  position: 1,
  total: 1,
  ...over
})

test.describe('request window', () => {
  function build ({ armMs = 40 } = {}) {
    const fe = fakeElectron()
    const decisions = []
    const closed = []
    const turnedOff = []
    const w = createConfirmationWindows({
      electron: fe.electron,
      i18n,
      armMs,
      logger: { info () {}, warn () {} },
      onDecide: (ref, approve, meta) => decisions.push({ ref, approve, meta }),
      onSurfaceClosed: () => closed.push(1),
      onPairSubmit: () => ({ ok: true }),
      onTurnOff: () => turnedOff.push(1)
    })
    const win = () => FakeWindow.all[0]
    const fromRequest = () => ({ sender: win().webContents, senderFrame: win().webContents.mainFrame })
    const show = async (view = requestView()) => { w.presenter.show(view); await pause(10) }
    const decide = (payload) => fe.emit(CONFIRM_CHANNELS.DECIDE, fromRequest(), payload)
    return { fe, w, win, show, decide, decisions, closed, turnedOff, fromRequest }
  }

  test('is shown without taking focus: showInactive, never always on top, content protected', async () => {
    const { win, show, w } = build()
    await show()
    expect(win().calls).toEqual(['showInactive'])
    expect(win().protected).toBe(true)
    expect(win().options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false })
    expect(w.arming()).toEqual({ armed: false, reason: 'unfocused' })
    // the page is told the strings, the request (with its Approve label) and the arming state
    expect(win().last(CONFIRM_CHANNELS.STRINGS).strings.deny).toBe('Deny')
    expect(win().last(CONFIRM_CHANNELS.SHOW)).toMatchObject({ ref: 'r1', approveLabel: 'Approve pin content' })
    expect(win().last(CONFIRM_CHANNELS.ARM)).toEqual({ armed: false, reason: 'unfocused' })
  })

  test('Approve arms only after the window has been focused for the delay; an early approval is dropped', async () => {
    const { win, show, w, decide, decisions } = build({ armMs: 60 })
    await show()
    decide({ ref: 'r1', approve: true }) // not focused: ignored
    win().focus()
    expect(w.arming()).toEqual({ armed: false, reason: 'waiting' })
    decide({ ref: 'r1', approve: true }) // inside the delay: ignored
    expect(decisions).toEqual([])
    await pause(100)
    expect(w.arming()).toEqual({ armed: true, reason: 'ready' })
    expect(win().last(CONFIRM_CHANNELS.ARM)).toEqual({ armed: true, reason: 'ready' })
    decide({ ref: 'r1', approve: true })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ ref: 'r1', approve: true })
    expect(decisions[0].meta.armedForMs).toBeGreaterThanOrEqual(0)
    expect(decisions[0].meta.focused).toBe(true)
  })

  test('losing focus disarms; one arming allows one approval attempt', async () => {
    const { win, show, w, decide, decisions } = build({ armMs: 30 })
    await show()
    win().focus()
    await pause(60)
    expect(w.arming().armed).toBe(true)
    win().blur()
    expect(w.arming()).toEqual({ armed: false, reason: 'blur' })
    decide({ ref: 'r1', approve: true })
    expect(decisions).toEqual([])
    win().focus()
    await pause(60)
    decide({ ref: 'r1', approve: true })
    decide({ ref: 'r1', approve: true }) // the second one finds it disarmed
    expect(decisions).toHaveLength(1)
  })

  test('a new request on screen disarms, with a notice, and re-arms only after the delay again', async () => {
    const { win, show, w, decide, decisions } = build({ armMs: 50 })
    await show()
    win().focus()
    await pause(80)
    expect(w.arming().armed).toBe(true)
    await show(requestView({ ref: 'r2', summary: 'a different request' })) // swapped under the cursor
    expect(w.arming()).toEqual({ armed: false, reason: 'changed' })
    expect(win().last(CONFIRM_CHANNELS.ARM)).toEqual({ armed: false, reason: 'changed' })
    decide({ ref: 'r1', approve: true }) // the old ref is gone
    decide({ ref: 'r2', approve: true }) // not armed for the new one yet
    expect(decisions).toEqual([])
    await pause(90)
    expect(w.arming().armed).toBe(true)
    decide({ ref: 'r2', approve: true })
    expect(decisions).toEqual([{ ref: 'r2', approve: true, meta: expect.objectContaining({ focused: true }) }])
  })

  test('deny is never delayed, and only the shown request can be answered', async () => {
    const { show, decide, decisions } = build()
    await show()
    decide({ ref: 'r1', approve: false })
    decide({ ref: 'other', approve: false })
    decide({ ref: 'r1', approve: 'yes' })
    decide(null)
    expect(decisions).toEqual([{ ref: 'r1', approve: false, meta: {} }])
  })

  test('only this window\'s own main frame can answer', async () => {
    const { win, show, fe, decisions } = build()
    await show()
    win().focus()
    await pause(60)
    const webUi = new EventEmitter()
    webUi.mainFrame = { url: 'webui://localhost/' }
    fe.emit(CONFIRM_CHANNELS.DECIDE, { sender: webUi, senderFrame: webUi.mainFrame }, { ref: 'r1', approve: true })
    fe.emit(CONFIRM_CHANNELS.DECIDE, { sender: win().webContents, senderFrame: { url: win().webContents.mainFrame.url } }, { ref: 'r1', approve: true })
    expect(decisions).toEqual([])
  })

  test('closing the window denies what it shows, and tells the controller the surface is gone', async () => {
    const { win, show, decisions, closed } = build()
    await show()
    win().close()
    expect(decisions).toEqual([{ ref: 'r1', approve: false, meta: {} }])
    expect(closed).toHaveLength(1)
    expect(win().visible).toBe(false)
    expect(win().destroyed).toBe(false) // hidden, reused for the next request
  })

  test('the turn-off control works from the request window only', async () => {
    const { show, fe, turnedOff, fromRequest } = build()
    await show()
    fe.emit(CONFIRM_CHANNELS.TURN_OFF, { sender: {}, senderFrame: {} })
    expect(turnedOff).toEqual([])
    fe.emit(CONFIRM_CHANNELS.TURN_OFF, fromRequest())
    expect(turnedOff).toHaveLength(1)
  })

  test('the pairing window opens in the back unless the person asked for it', async () => {
    const { w } = build()
    w.openPairing({ reason: 'rejected' })
    await pause(10)
    const pair = FakeWindow.all[0]
    expect(pair.calls).toEqual(['showInactive'])
    expect(pair.protected).toBe(true)
    expect(pair.last(CONFIRM_CHANNELS.STRINGS).reason).toBe('rejected')
    w.closePairing()
    w.openPairing({ userInitiated: true })
    await pause(10)
    expect(FakeWindow.all[1].calls).toEqual(['show', 'focus'])
  })

  test('disposing removes every handler and destroys both windows', async () => {
    const { w, show, win, fe } = build()
    await show()
    w.openPairing()
    await pause(10)
    w.dispose()
    expect(fe.handlers.size).toBe(0)
    expect(FakeWindow.all.every((x) => x.destroyed)).toBe(true)
    expect(win().destroyed).toBe(true)
  })
})

test.describe('Touch ID', () => {
  test('is available only on macOS with the hardware, and reports success or failure of the prompt', async () => {
    const prefs = (ok) => ({ canPromptTouchID: () => true, promptTouchID: async () => { if (!ok) throw new Error('cancelled') } })
    expect(createTouchId(prefs(true), 'darwin').available()).toBe(true)
    expect(createTouchId(prefs(true), 'linux').available()).toBe(false)
    expect(createTouchId(undefined, 'darwin').available()).toBe(false)
    expect(createTouchId({ canPromptTouchID: () => false }, 'darwin').available()).toBe(false)
    expect(await createTouchId(prefs(true), 'darwin').prompt('r')).toBe(true)
    expect(await createTouchId(prefs(false), 'darwin').prompt('r')).toBe(false)
    expect(await createTouchId(prefs(true), 'linux').prompt('r')).toBe(false)
  })
})

test.describe('strings', () => {
  test('every dictionary id and every Approve label exists in en.json', () => {
    const dict = windowStrings(i18n, 1500)
    for (const id of STRING_IDS) expect(i18n.exists(`agentConfirm.${id}`), id).toBe(true)
    expect(Object.values(KIND_KEYS).every((k) => STRING_IDS.includes(k))).toBe(true)
    expect(dict.armUnfocused).toContain('1.5 seconds')
    expect(dict.queue).toBe('{count} requests waiting')
    expect(dict.expiresIn).toBe('Expires in {time}')
    expect(Object.keys(LOCALE.agentConfirm.button).every((t) => i18n.exists(`agentConfirm.action.${t}`))).toBe(true)
  })

  test('the pairing copy says what the operator decided', () => {
    expect(LOCALE.agentConfirm.pairRestart).toContain('--confirm=native,desktop')
    expect(LOCALE.agentConfirm.pairStop).toMatch(/stop ipfs mcp/i)
    expect(LOCALE.agentConfirm.pairWhyRejected).toMatch(/rejected the stored key/)
  })

  test('the Approve button names a verb and an object; destructive tools say what they remove', () => {
    expect(approveLabel(i18n, 'pin_add')).toBe('Approve pin content')
    expect(approveLabel(i18n, 'pin_rm')).toBe('Remove pin')
    expect(approveLabel(i18n, 'some_new_tool')).toBe('Approve some new tool')
    expect(approveLabel(i18n, '../../x')).toBe('Approve ../../x')
  })

  test('the Touch ID reason names the action and the first target, shortened', () => {
    expect(touchReason(i18n, { tool: 'pin_rm', targets: [{ value: CID_V1 }] })).toBe(`Approve remove a pin on ${CID_V1.slice(0, 48)}...`)
    expect(touchReason(i18n, { tool: 'repo_gc', targets: [] })).toBe('Approve run garbage collection')
    expect(touchReason(i18n, { tool: 'pin_add', targets: [{ value: 'x'.repeat(100) }] })).toContain('x'.repeat(48) + '...')
  })

  test('the pages hold no user-facing text of their own', () => {
    for (const page of ['confirm.html', 'pair.html']) {
      const html = fs.readFileSync(path.join(UI_DIR, page), 'utf8')
      const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '').trim()
      expect(text, page).toBe('')
    }
  })
})

test.describe('the confirmation manager', () => {
  function build (initial = {}, options = {}) {
    const fe = fakeElectron()
    const store = memoryStore(initial)
    store.safeSet = async (k, v) => { store.set(k, v) }
    const logs = []
    const manager = createAgentConfirmation({
      electron: fe.electron,
      store,
      i18n,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      env: { IPFS_MCP_CONFIRM_DIR: '/nonexistent-dir-for-test' },
      pollMs: 10,
      authenticate: { available: () => true, prompt: async () => true },
      ...options
    })
    return { fe, store, manager, logs }
  }

  test('parseSwitch: only a clear "on" is on', () => {
    for (const on of [true, 1, 'true', 'TRUE', ' on ', '1', 'yes']) expect(parseSwitch(on), String(on)).toBe(true)
    for (const off of [false, 0, 'false', 'False', 'off', 'no', '0', '', ' ', 'nope', null, undefined, {}, []]) expect(parseSwitch(off), String(off)).toBe(false)
  })

  for (const [name, initial] of [
    ['nothing stored (the default)', {}],
    ['false', { [KEYS.CONFIRM_ENABLED]: false }],
    ['the string "false"', { [KEYS.CONFIRM_ENABLED]: 'false' }],
    ['the string "off"', { [KEYS.CONFIRM_ENABLED]: 'off' }],
    ['the string "0"', { [KEYS.CONFIRM_ENABLED]: '0' }]
  ]) {
    test(`disabled (${name}): no handler, no session, no window, no timer; a pairing key does not change that`, () => {
      const { fe, manager } = build({ ...initial, [KEYS.PAIRING_CIPHERTEXT]: Buffer.from('x|sealed').toString('base64') })
      expect(manager.enabled).toBe(false)
      expect(fe.registered).toEqual([])
      expect(FakeWindow.all).toEqual([])
      expect(manager.controller).toBeUndefined()
      manager.unpair()
      manager.dispose()
      expect(FakeWindow.all).toEqual([])
    })
  }

  test('the confirmation does not depend on the agent chat: on by its own switch, with the chat settings absent', async () => {
    const { manager, store } = build({ [KEYS.CONFIRM_ENABLED]: true })
    expect(store.get(KEYS.ENABLED, false)).toBe(false) // the chat is off
    expect(manager.enabled).toBe(true)
    await until(() => manager.controller.polls >= 2)
    manager.dispose()
  })

  test('on and unpaired: the pairing window opens in the back and nothing reads a directory', async () => {
    const { manager, fe } = build({ [KEYS.CONFIRM_ENABLED]: 'true' })
    await until(() => FakeWindow.all.length === 1)
    await pause(20)
    expect(FakeWindow.all[0].calls).toEqual(['showInactive'])
    expect(fe.registered).toContain(CONFIRM_CHANNELS.DECIDE)
    manager.dispose()
  })

  test('win32: inert, and the tray entries are greyed out', () => {
    const { manager, fe, store } = build({ [KEYS.CONFIRM_ENABLED]: true }, { platform: 'win32' })
    expect(manager.supported).toBe(false)
    expect(manager.enabled).toBe(false)
    manager.setEnabled(true)
    manager.openPairing()
    expect(manager.enabled).toBe(false)
    expect(fe.registered).toEqual([])
    expect(FakeWindow.all).toEqual([])
    expect(store.get(KEYS.CONFIRM_ENABLED)).toBe(true) // nothing was rewritten
    const [sub] = buildAgentConfirmSubmenu({ t: i18n.t, getConfirmation: () => manager })
    expect(sub.enabled).toBe(false)
  })

  test('tray actions: enable, pair, unpair and turn off, each with its effect and a change event', async () => {
    const { manager, store, fe } = build()
    const events = []
    manager.onChange(() => events.push(1))
    const menu = () => buildAgentConfirmSubmenu({ t: i18n.t, getConfirmation: () => manager })[0]
    const entry = (id) => menu().submenu.find((m) => m.id === id)

    expect(menu().enabled).toBe(true)
    expect(entry('agentConfirm.enable')).toMatchObject({ type: 'checkbox', checked: false })
    expect(entry('agentConfirm.unpair').enabled).toBe(false)

    entry('agentConfirm.enable').click() // turn on
    expect(manager.enabled).toBe(true)
    expect(store.get(KEYS.CONFIRM_ENABLED)).toBe(true)
    expect(entry('agentConfirm.enable').checked).toBe(true)
    await until(() => FakeWindow.all.length === 1) // unpaired: the pairing window opens

    FakeWindow.all[0].destroy()
    entry('agentConfirm.pair').click() // pair, asked by the person: may take focus
    await until(() => FakeWindow.all.length === 2)
    await pause(10)
    expect(FakeWindow.all[1].calls).toEqual(['show', 'focus'])

    // enter a key through the pairing window's own handler
    const pairWin = FakeWindow.all[1]
    const result = await fe.emit(CONFIRM_CHANNELS.PAIR_SUBMIT, { sender: pairWin.webContents, senderFrame: pairWin.webContents.mainFrame }, KEY)
    expect(result).toEqual({ ok: true })
    expect(manager.paired).toBe(true)
    expect(entry('agentConfirm.status').label).toBe('Paired')
    expect(entry('agentConfirm.unpair').enabled).toBe(true)

    entry('agentConfirm.unpair').click()
    expect(manager.paired).toBe(false)
    expect(manager.enabled).toBe(true) // unpairing is not turning off

    entry('agentConfirm.enable').click() // turn off
    expect(manager.enabled).toBe(false)
    expect(store.get(KEYS.CONFIRM_ENABLED)).toBe(false)
    expect(fe.handlers.size).toBe(0)
    expect(FakeWindow.all.every((x) => x.destroyed)).toBe(true)
    expect(entry('agentConfirm.enable').checked).toBe(false)

    // the way back: the same entry turns it on again
    entry('agentConfirm.enable').click()
    expect(manager.enabled).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(5)
    manager.dispose()
  })

  test('"Turn off" in the pairing window and in the request window both end the feature and persist it', async () => {
    for (const which of ['pair', 'request']) {
      const { manager, store, fe } = build({ [KEYS.CONFIRM_ENABLED]: true })
      await until(() => FakeWindow.all.length === 1) // the pairing window (unpaired)
      const pairWin = FakeWindow.all[0]
      if (which === 'pair') {
        fe.emit(CONFIRM_CHANNELS.PAIR_TURN_OFF, { sender: pairWin.webContents, senderFrame: pairWin.webContents.mainFrame })
      } else {
        // a request window of its own: the presenter creates it on the first request
        const frame = { url: pathToFileURL(path.join(UI_DIR, 'confirm.html')).href }
        const contents = new EventEmitter()
        contents.mainFrame = frame
        const fake = { isDestroyed: () => false, webContents: contents }
        expect(isFromWindow({ sender: contents, senderFrame: frame }, fake, 'confirm.html', UI_DIR)).toBe(true)
        // the manager wires TURN_OFF to the same off path as the pairing window; use that one
        fe.emit(CONFIRM_CHANNELS.PAIR_TURN_OFF, { sender: pairWin.webContents, senderFrame: pairWin.webContents.mainFrame })
      }
      await until(() => !manager.enabled)
      expect(store.get(KEYS.CONFIRM_ENABLED)).toBe(false)
      expect(fe.handlers.size).toBe(0)
      manager.dispose()
    }
  })

  test('a hand-written off value in the store keeps it off after a restart', () => {
    const { manager } = build({ [KEYS.CONFIRM_ENABLED]: 'False' })
    expect(manager.enabled).toBe(false)
  })
})

test.describe('window colors', () => {
  const css = fs.readFileSync(path.join(UI_DIR, 'ui.css'), 'utf8')
  const vars = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))
  const dark = vars(/:root\s*\{([^}]*)\}/.exec(css)[1])
  const light = { ...dark, ...vars(/prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1]) }

  const channelValue = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * channelValue(n >> 16) + 0.7152 * channelValue((n >> 8) & 255) + 0.0722 * channelValue(n & 255)
  }
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  for (const [theme, t] of [['dark', dark], ['light', light]]) {
    test(`${theme}: every text pairing holds 4.5:1 and the focus ring 3.7:1 (WCAG 2.2 AA)`, () => {
      const text = [
        ['text', ['ground', 'surface', 'raised', 'control', 'control-hover']],
        ['text-muted', ['ground', 'surface', 'raised', 'control']],
        ['on-accent', ['accent', 'accent-hover']],
        ['warn', ['warn-tint']],
        ['ok', ['ok-tint']],
        ['err', ['err-tint']]
      ]
      for (const [fg, backgrounds] of text) {
        for (const bg of backgrounds) expect(ratio(t[fg], t[bg]), `${theme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const bg of ['ground', 'surface', 'raised', 'control']) {
        expect(ratio(t.accent, t[bg]), `${theme} focus ring on ${bg}`).toBeGreaterThanOrEqual(3.7)
      }
    })
  }

  test('the stylesheet uses no border or shadow and removes no focus outline from a control', () => {
    expect(css).not.toMatch(/\bbox-shadow\b|\bborder\s*:\s*[^\s0]/)
    expect(css.replace(/h1:focus\s*\{[^}]*\}/, '')).not.toMatch(/outline\s*:\s*(none|0)\b/)
    expect(css).toContain(':focus-visible')
    expect(css).toContain('prefers-reduced-motion')
  })
})

test.describe('window files', () => {
  test('an IPC message is accepted only from the main frame of its own window, loaded from its own page', () => {
    const mk = (url) => { const mainFrame = { url }; return { isDestroyed: () => false, webContents: { mainFrame } } }
    const w = mk(pathToFileURL(path.join(UI_DIR, 'confirm.html')).href)
    const good = { sender: w.webContents, senderFrame: w.webContents.mainFrame }
    expect(isFromWindow(good, w, 'confirm.html', UI_DIR)).toBe(true)
    expect(isFromWindow(good, w, 'pair.html', UI_DIR)).toBe(false)
    expect(isFromWindow({ sender: {}, senderFrame: w.webContents.mainFrame }, w, 'confirm.html', UI_DIR)).toBe(false)
    expect(isFromWindow({ sender: w.webContents, senderFrame: { url: w.webContents.mainFrame.url } }, w, 'confirm.html', UI_DIR)).toBe(false)
    const navigated = mk('webui://localhost/#/peers')
    expect(isFromWindow({ sender: navigated.webContents, senderFrame: navigated.webContents.mainFrame }, navigated, 'confirm.html', UI_DIR)).toBe(false)
    expect(isFromWindow(good, null, 'confirm.html', UI_DIR)).toBe(false)
    expect(isFromWindow(good, { ...w, isDestroyed: () => true }, 'confirm.html', UI_DIR)).toBe(false)
  })

  test('the request filter lets only the window\'s own files through', () => {
    expect(isUiFileUrl(pathToFileURL(path.join(UI_DIR, 'ui.css')).href, UI_DIR)).toBe(true)
    for (const other of ['https://example.com/x.js', 'http://127.0.0.1:5001/api/v0/id', 'webui://localhost/', 'file:///etc/hosts', `${pathToFileURL(UI_DIR).href}-sibling/x`, 'data:text/html,x']) {
      expect(isUiFileUrl(other, UI_DIR)).toBe(false)
    }
  })

  test('the preload copies of the channel names match the shared constants', () => {
    for (const [file, names] of [
      ['confirm-preload.js', ['STRINGS', 'SHOW', 'ARM', 'RESULT', 'ERROR', 'DECIDE', 'TURN_OFF']],
      ['pair-preload.js', ['STRINGS', 'PAIR_SUBMIT', 'PAIR_DISMISS', 'PAIR_TURN_OFF']]
    ]) {
      const source = fs.readFileSync(path.join(UI_DIR, file), 'utf8')
      for (const name of names) expect(source).toContain(`${name}: '${CONFIRM_CHANNELS[name]}'`)
    }
  })

  test('the pages carry a CSP with no unsafe-inline, no eval and no remote source, and load no remote asset', () => {
    for (const page of ['confirm.html', 'pair.html']) {
      const html = fs.readFileSync(path.join(UI_DIR, page), 'utf8')
      const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1]
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).not.toMatch(/unsafe-|https?:|\*/)
      expect(html).not.toMatch(/(src|href)="https?:/)
      expect(html).not.toMatch(/<script>|\son[a-z]+=/)
    }
    expect(fs.readFileSync(path.join(UI_DIR, 'ui.css'), 'utf8')).not.toMatch(/https?:\/\//)
  })

  test('the renderers ignore synthetic events and keep no text of their own', () => {
    const confirmJs = fs.readFileSync(path.join(UI_DIR, 'confirm.js'), 'utf8')
    expect(confirmJs).toContain('isTrusted')
    expect(fs.readFileSync(path.join(UI_DIR, 'pair.js'), 'utf8')).toContain('isTrusted')
    expect(confirmJs).not.toMatch(/textContent\s*=\s*'[A-Za-z]/)
  })
})
