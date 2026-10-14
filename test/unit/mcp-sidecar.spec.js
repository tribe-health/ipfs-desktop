const { EventEmitter } = require('events')
const net = require('net')
const { test, expect } = require('@playwright/test')

const proxyquire = require('proxyquire')
  .noCallThru()
  .noPreserveCache()

function fakeChild (pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stderr = new EventEmitter()
  child.stdout = new EventEmitter()
  child.killCalls = []
  child.kill = (signal) => {
    child.killCalls.push(signal)
    setTimeout(() => child.emit('exit', 0, signal), 1)
    return true
  }
  return child
}

// A reversible stand-in for Electron's safeStorage: the ciphertext is the
// plaintext reversed behind a marker, so a test can tell plaintext from cipher.
function fakeSafeStorage (available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('enc:' + [...plain].reverse().join('')),
    decryptString: (buf) => [...buf.toString().slice(4)].reverse().join('')
  }
}

function fakeStore (initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (k, fallback) => (data.has(k) ? data.get(k) : fallback),
    set: (k, v) => { data.set(k, v) },
    delete: (k) => { data.delete(k) }
  }
}

function fakeFs () {
  const files = new Map()
  return {
    files,
    mkdirSync: () => {},
    writeFileSync: (path, content) => { files.set(path, content) }
  }
}

// A manual clock for the restart scheduler: no wall-clock margins. A timer
// fires only when the test calls fire(); advance() moves "now" for the
// stayed-up-long-enough check.
function fakeClock () {
  let now = 0
  const pending = []
  const scheduled = []
  return {
    scheduled,
    pending,
    timers: {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, at: now + ms }
        pending.push(timer)
        scheduled.push(ms)
        return timer
      },
      clearTimeout: (timer) => {
        const i = pending.indexOf(timer)
        if (i !== -1) pending.splice(i, 1)
      },
      now: () => now
    },
    advance: (ms) => { now += ms },
    fire: () => {
      const timer = pending.shift()
      if (!timer) throw new Error('no pending timer')
      now = Math.max(now, timer.at)
      timer.fn()
    }
  }
}

function setup (opts = {}) {
  const spawns = []
  const infos = []
  const warns = []
  const errors = []
  const clock = fakeClock()
  let nextPid = 1000

  const spawnFn = (bin, args, options) => {
    const child = fakeChild(nextPid++)
    spawns.push({ bin, args, options, child })
    return child
  }

  const { createMcpSidecar } = proxyquire('../../src/daemon/mcp-sidecar', {
    electron: { app: { getPath: () => '/userdata' } },
    '../common/logger': {
      info: (m) => infos.push(m),
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m)
    },
    '../custom-ipfs-binary': { getCustomBinary: () => null }
  })

  const sidecar = createMcpSidecar({
    binPath: '/bin/ipfs',
    // An explicit port skips discovery, keeping the supervision tests
    // deterministic; discovery itself is covered by its own describe block.
    port: 5050,
    spawnFn,
    timers: clock.timers,
    safeStorage: fakeSafeStorage(),
    store: fakeStore(),
    fsImpl: fakeFs(),
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error: (m) => errors.push(m) },
    ...opts
  })

  return { sidecar, spawns, infos, warns, errors, clock }
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out')
}
const deferred = () => {
  let resolveFn
  const promise = new Promise((resolve) => { resolveFn = resolve })
  return { promise, resolve: resolveFn }
}
// A loopback port that is free right now and is not 5050 (never touched here).
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => resolve(p))
  })
})

test.describe('mcp sidecar supervision', () => {
  test('spawns ipfs mcp with the supervised flags and the daemon repo as IPFS_PATH', async () => {
    const { sidecar, spawns } = setup()

    await sidecar.start('/repo')

    expect(spawns.length).toEqual(1)
    expect(spawns[0].bin).toEqual('/bin/ipfs')
    expect(spawns[0].args).toEqual([
      'mcp',
      '--http=127.0.0.1:5050',
      '--agui',
      '--confirm=native,desktop',
      '--settings-dir=/userdata/mcp',
      '--mcp-config=/userdata/mcp/sidecar-config.json'
    ])
    expect(spawns[0].options.env.IPFS_PATH).toEqual('/repo')
    expect(spawns[0].options.stdio).toEqual(['ignore', 'ignore', 'pipe'])
    expect(sidecar.isRunning()).toBe(true)
    expect(sidecar.getState()).toEqual('running')
    expect(sidecar.getPort()).toEqual(5050)
  })

  test('honours an explicit port and settings dir', async () => {
    const { sidecar, spawns } = setup({ port: 5055, settingsDir: '/tmp/custom-mcp' })

    await sidecar.start('/repo')

    expect(spawns[0].args).toContain('--http=127.0.0.1:5055')
    expect(spawns[0].args).toContain('--settings-dir=/tmp/custom-mcp')
    expect(sidecar.getPort()).toEqual(5055)
  })

  test('pipes child stderr to the log, line buffered', async () => {
    const { sidecar, spawns, infos } = setup()

    await sidecar.start('/repo')
    spawns[0].child.stderr.emit('data', Buffer.from('ipfs mcp: serving MCP over HTTP on ht'))
    expect(infos.filter(m => m.includes('serving')).length).toEqual(0)
    spawns[0].child.stderr.emit('data', Buffer.from('tp://127.0.0.1:5050/mcp\nsecond line\n'))

    const logged = infos.filter(m => m.includes('serving') || m.includes('second line'))
    expect(logged).toEqual([
      '[mcp-sidecar] ipfs mcp: serving MCP over HTTP on http://127.0.0.1:5050/mcp',
      '[mcp-sidecar] second line'
    ])
    await sidecar.stop()
  })

  test('caps the stderr buffer and the logged line length', async () => {
    const { sidecar, spawns, infos } = setup()
    await sidecar.start('/repo')
    const before = infos.length

    // 200 KiB with no newline: held at most 64 KiB, flushed as one short line.
    for (let i = 0; i < 200; i++) {
      spawns[0].child.stderr.emit('data', Buffer.alloc(1024, 'a'))
    }
    // A long line that does end in a newline is cut as well.
    spawns[0].child.stderr.emit('data', Buffer.from('b'.repeat(10000) + '\n'))

    const lines = infos.slice(before)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.length).toBeLessThan(2100)
    }
    expect(lines.some(l => l.endsWith('[truncated]'))).toBe(true)
    await sidecar.stop()
  })

  test('getPort follows the address the child reports binding', async () => {
    const { sidecar, spawns, warns } = setup()
    await sidecar.start('/repo')

    spawns[0].child.stderr.emit('data', Buffer.from('ipfs mcp: serving MCP over HTTP on http://127.0.0.1:5050/mcp\n'))
    expect(sidecar.getPort()).toEqual(5050)
    expect(warns.length).toEqual(0)

    spawns[0].child.stderr.emit('data', Buffer.from('ipfs mcp: serving MCP over HTTP on http://127.0.0.1:41999/mcp\n'))
    expect(sidecar.getPort()).toEqual(41999)
    expect(warns.some(m => m.includes('41999') && m.includes('5050'))).toBe(true)
    await sidecar.stop()
  })

  test('restarts with exponential backoff after an unexpected exit', async () => {
    const { sidecar, spawns, clock } = setup({ backoffInitialMs: 30, backoffMaxMs: 100, backoffResetMs: 60000 })

    await sidecar.start('/repo')
    expect(spawns.length).toEqual(1)

    spawns[0].child.emit('exit', 1, null)
    clock.fire()
    await until(() => spawns.length === 2)
    spawns[1].child.emit('exit', 1, null)
    clock.fire()
    await until(() => spawns.length === 3)
    spawns[2].child.emit('exit', 1, null)
    clock.fire()
    await until(() => spawns.length === 4)
    spawns[3].child.emit('exit', 1, null)

    // 30, 60, then capped at the 100 ms maximum.
    expect(clock.scheduled).toEqual([30, 60, 100, 100])

    await sidecar.stop()
  })

  test('a run that stayed up resets the backoff', async () => {
    const { sidecar, spawns, clock } = setup({ backoffInitialMs: 40, backoffMaxMs: 500, backoffResetMs: 40 })

    await sidecar.start('/repo')
    spawns[0].child.emit('exit', 1, null)
    clock.fire()
    await until(() => spawns.length === 2)

    // This one lives past the reset window, so the next failure starts the
    // backoff from the initial delay again.
    clock.advance(60)
    spawns[1].child.emit('exit', 1, null)

    // Without the reset the second delay would be 80.
    expect(clock.scheduled).toEqual([40, 40])
    await sidecar.stop()
  })

  test('gives up after the restart cap and reports the failing state', async () => {
    const { sidecar, spawns, errors, clock } = setup({ backoffInitialMs: 10, backoffMaxMs: 10, backoffResetMs: 60000, maxRestartAttempts: 3 })

    await sidecar.start('/repo')
    for (let i = 1; i <= 3; i++) {
      spawns[i - 1].child.emit('exit', 1, null)
      clock.fire()
      await until(() => spawns.length === i + 1)
    }
    spawns[3].child.emit('exit', 1, null)

    expect(clock.pending.length).toEqual(0)
    expect(sidecar.getState()).toEqual('failing')
    expect(sidecar.isRunning()).toBe(false)
    expect(errors.some(m => m.includes('giving up'))).toBe(true)

    // The next start (daemon restart or toggle) tries again from a clean slate.
    await sidecar.stop()
    await sidecar.start('/repo')
    expect(sidecar.getState()).toEqual('running')
    expect(spawns.length).toEqual(5)
    await sidecar.stop()
  })

  test('stop signals only the tracked child PID and never restarts afterwards', async () => {
    const { sidecar, spawns, clock } = setup({ backoffInitialMs: 10 })

    await sidecar.start('/repo')
    const tracked = spawns[0].child

    await sidecar.stop()

    expect(tracked.killCalls).toEqual(['SIGTERM'])
    expect(sidecar.isRunning()).toBe(false)
    expect(sidecar.getState()).toEqual('stopped')
    expect(sidecar.childPid()).toBeUndefined()
    expect(clock.scheduled.length).toEqual(0)
    expect(spawns.length).toEqual(1)
  })

  test('stop during a pending backoff cancels the restart', async () => {
    const { sidecar, spawns, clock } = setup({ backoffInitialMs: 40, backoffMaxMs: 500 })

    await sidecar.start('/repo')
    spawns[0].child.emit('exit', 1, null)
    expect(clock.pending.length).toEqual(1)
    await sidecar.stop()

    expect(clock.pending.length).toEqual(0)
    expect(spawns.length).toEqual(1)
  })

  test('escalates to SIGKILL on the tracked PID when SIGTERM stalls', async () => {
    const { sidecar, spawns } = setup({ stopTimeoutMs: 20 })

    await sidecar.start('/repo')
    const tracked = spawns[0].child
    // A stalled child: records signals but never exits on its own.
    tracked.kill = (signal) => {
      tracked.killCalls.push(signal)
      return true
    }

    const stopping = sidecar.stop()
    await until(() => tracked.killCalls.includes('SIGKILL'))
    tracked.emit('exit', 0, 'SIGKILL')
    await stopping

    expect(tracked.killCalls).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('killNow SIGKILLs a child that is still being stopped, by tracked PID only', async () => {
    const { sidecar, spawns } = setup({ stopTimeoutMs: 60000 })

    await sidecar.start('/repo')
    const tracked = spawns[0].child
    tracked.kill = (signal) => {
      tracked.killCalls.push(signal)
      return true
    }

    const stopping = sidecar.stop()
    // stop() has untracked the child but it has not exited: still live.
    expect(sidecar.hasLiveProcess()).toBe(true)
    sidecar.killNow()
    expect(tracked.killCalls).toEqual(['SIGTERM', 'SIGKILL'])

    tracked.emit('exit', null, 'SIGKILL')
    await stopping
    expect(sidecar.hasLiveProcess()).toBe(false)
  })

  test('a spawn failure is logged and retried with backoff', async () => {
    const { sidecar, spawns, errors, clock } = setup({ backoffInitialMs: 20, backoffMaxMs: 200 })

    await sidecar.start('/repo')
    spawns[0].child.emit('error', new Error('spawn /bin/ipfs ENOENT'))
    clock.fire()

    await until(() => spawns.length === 2)
    expect(errors.length).toEqual(0)
    await sidecar.stop()
  })
})

test.describe('port discovery', () => {
  test('with the preferred port occupied it picks another loopback port and reports it', async () => {
    // Occupy a dynamically chosen loopback port; the default 5050 is never bound.
    const blocker = net.createServer()
    const preferred = await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port))
    })

    try {
      const { sidecar, spawns, warns } = setup({ port: 0, preferredPort: preferred })
      await sidecar.start('/repo')

      const port = sidecar.getPort()
      expect(port).not.toEqual(preferred)
      expect(port).toBeGreaterThan(0)
      expect(spawns.length).toEqual(1)
      expect(spawns[0].args).toContain(`--http=127.0.0.1:${port}`)

      // Never a silent fallback: the report names the preferred and the chosen port.
      const report = warns.find(m => m.includes(String(preferred)))
      expect(report).toBeTruthy()
      expect(report).toContain(String(port))

      await sidecar.stop()
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })

  test('uses the preferred port when it is free and logs the choice', async () => {
    const preferred = await freePort()

    const { sidecar, spawns, infos, warns } = setup({ port: 0, preferredPort: preferred })
    await sidecar.start('/repo')

    expect(sidecar.getPort()).toEqual(preferred)
    expect(spawns[0].args).toContain(`--http=127.0.0.1:${preferred}`)
    expect(warns.length).toEqual(0)
    expect(infos.some(m => m.includes(`preferred port ${preferred}`))).toBe(true)

    await sidecar.stop()
  })

  test('rediscovers the port before every restart', async () => {
    const found = [{ port: 41001, fallback: false }, { port: 41002, fallback: true }]
    const calls = []
    const { sidecar, spawns, clock } = setup({
      port: 0,
      preferredPort: 41001,
      discoverPortFn: async (preferred) => { calls.push(preferred); return found[calls.length - 1] }
    })

    await sidecar.start('/repo')
    expect(spawns[0].args).toContain('--http=127.0.0.1:41001')

    // A squatter took 41001 after the first probe: the child dies, the restart
    // probes again instead of reusing the stale port.
    spawns[0].child.emit('exit', 1, null)
    clock.fire()
    await until(() => spawns.length === 2)

    expect(calls).toEqual([41001, 41001])
    expect(spawns[1].args).toContain('--http=127.0.0.1:41002')
    expect(sidecar.getPort()).toEqual(41002)
    await sidecar.stop()
  })

  test('stop() before discovery resolves means no spawn', async () => {
    const pending = deferred()
    const { sidecar, spawns } = setup({ port: 0, discoverPortFn: () => pending.promise })

    const starting = sidecar.start('/repo')
    await sidecar.stop()
    pending.resolve({ port: 41003, fallback: false })
    await starting

    expect(spawns.length).toEqual(0)
    expect(sidecar.isRunning()).toBe(false)
    expect(sidecar.hasLiveProcess()).toBe(false)
    expect(sidecar.getState()).toEqual('stopped')
  })

  test('a start that was stopped and started again during discovery spawns once', async () => {
    const first = deferred()
    const second = deferred()
    const queue = [first, second]
    const { sidecar, spawns } = setup({ port: 0, discoverPortFn: () => queue.shift().promise })

    const starting = sidecar.start('/repo')
    await sidecar.stop()
    const restarting = sidecar.start('/repo')
    first.resolve({ port: 41004, fallback: false })
    second.resolve({ port: 41005, fallback: false })
    await Promise.all([starting, restarting])

    expect(spawns.length).toEqual(1)
    expect(spawns[0].args).toContain('--http=127.0.0.1:41005')
    await sidecar.stop()
  })
})

test.describe('principal tokens and secrets', () => {
  const NAMES = {
    ui: 'IPFS_MCP_DESKTOP_UI_TOKEN',
    admin: 'IPFS_MCP_DESKTOP_ADMIN_TOKEN',
    llm: 'IPFS_MCP_DESKTOP_LLM_API_KEY'
  }

  test('generates ui and admin tokens, passes them by environment name, and keeps no plaintext in the store', async () => {
    const store = fakeStore()
    const fsImpl = fakeFs()
    const { sidecar, spawns } = setup({ store, fsImpl })

    await sidecar.start('/repo')

    const env = spawns[0].options.env
    const ui = env[NAMES.ui]
    const admin = env[NAMES.admin]
    expect(ui).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(admin).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(ui).not.toEqual(admin)

    // The electron-store content holds ciphertext only.
    const stored = JSON.stringify([...store.data.entries()])
    expect(stored).not.toContain(ui)
    expect(stored).not.toContain(admin)
    expect(store.data.get('mcpSidecar.uiTokenCipher')).toBeTruthy()
    expect(store.data.get('mcpSidecar.adminTokenCipher')).toBeTruthy()

    // Neither the command line nor the generated config carries a secret.
    expect(spawns[0].args.join(' ')).not.toContain(ui)
    expect(spawns[0].args.join(' ')).not.toContain(admin)
    const config = [...fsImpl.files.values()][0]
    expect(config).not.toContain(ui)
    expect(config).not.toContain(admin)
    const parsed = JSON.parse(config)
    expect(parsed.principals.map(p => [p.kind, p.credential.env])).toEqual([
      ['ui', NAMES.ui],
      ['admin', NAMES.admin]
    ])
    await sidecar.stop()
  })

  test('the child gets an allowlisted environment; tokens come from the store and win over inherited and extra values', async () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LC_ALL: 'C.UTF-8',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'gh-secret',
      IPFS_PATH: '/other-repo',
      [NAMES.ui]: 'inherited-ui-token',
      [NAMES.admin]: 'inherited-admin-token',
      [NAMES.llm]: 'inherited-llm-key'
    }
    const { sidecar, spawns } = setup({
      env,
      extraEnv: { EXTRA_FLAG: '1', [NAMES.ui]: 'extra-ui-token' }
    })

    await sidecar.start('/repo')

    const childEnv = spawns[0].options.env
    expect(childEnv.PATH).toEqual('/usr/bin')
    expect(childEnv.HOME).toEqual('/home/u')
    expect(childEnv.LC_ALL).toEqual('C.UTF-8')
    expect(childEnv.IPFS_PATH).toEqual('/repo')
    expect(childEnv.EXTRA_FLAG).toEqual('1')
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(childEnv.GITHUB_TOKEN).toBeUndefined()
    // Neither the inherited nor the extra value can stand in for a principal token.
    expect(childEnv[NAMES.ui]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(childEnv[NAMES.admin]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // No LLM key stored: the inherited one must not leak through.
    expect(childEnv[NAMES.llm]).toBeUndefined()
    await sidecar.stop()
  })

  test('the environment allowlist matches Windows names case-insensitively', () => {
    const { buildChildEnv } = proxyquire('../../src/daemon/mcp-sidecar', {
      electron: { app: { getPath: () => '/userdata' } },
      '../common/logger': { info () {}, warn () {}, error () {} },
      '../custom-ipfs-binary': { getCustomBinary: () => null }
    })
    expect(buildChildEnv({ SystemRoot: 'C:\\Windows', Path: 'C:\\bin', LOCALAPPDATA: 'x', SECRET: 'y' }))
      .toEqual({ SystemRoot: 'C:\\Windows', Path: 'C:\\bin', LOCALAPPDATA: 'x' })
  })

  test('reuses the stored tokens on the next start', async () => {
    const store = fakeStore()
    const a = setup({ store })
    await a.sidecar.start('/repo')
    const first = a.spawns[0].options.env[NAMES.ui]
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await a.sidecar.stop()

    const b = setup({ store })
    await b.sidecar.start('/repo')
    expect(b.spawns[0].options.env[NAMES.ui]).toEqual(first)
    await b.sidecar.stop()
  })

  test('passes a stored LLM key by environment name only', async () => {
    const safeStorage = fakeSafeStorage()
    const store = fakeStore({ 'mcpSidecar.llmKeyCipher': safeStorage.encryptString('sk-test-1234').toString('base64') })
    const { sidecar, spawns, infos } = setup({ store, safeStorage })

    await sidecar.start('/repo')

    expect(spawns[0].options.env[NAMES.llm]).toEqual('sk-test-1234')
    expect(spawns[0].args).toContain(`--llm-api-key-env=${NAMES.llm}`)
    expect(spawns[0].args.join(' ')).not.toContain('sk-test-1234')
    expect(infos.join('\n')).not.toContain('sk-test-1234')
    await sidecar.stop()
  })

  test('without a stored LLM key no key flag is passed', async () => {
    const { sidecar, spawns } = setup()
    await sidecar.start('/repo')
    expect(spawns[0].args.some(a => a.startsWith('--llm-api-key-env'))).toBe(false)
    await sidecar.stop()
  })

  test('fails closed when the OS keystore is unavailable: no child, nothing stored', async () => {
    const store = fakeStore()
    const { sidecar, spawns } = setup({ store, safeStorage: fakeSafeStorage(false) })

    await expect(sidecar.start('/repo')).rejects.toThrow(/safeStorage/)

    expect(spawns.length).toEqual(0)
    expect(sidecar.isRunning()).toBe(false)
    expect(store.data.size).toEqual(0)
  })
})

test.describe('off switch', () => {
  test('mcpSidecar.enabled=false starts no child and binds no port', async () => {
    const free = await new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port
        srv.close(() => resolve(p))
      })
    })
    const { sidecar, spawns, infos } = setup({
      port: 0,
      preferredPort: free,
      store: fakeStore({ 'mcpSidecar.enabled': false })
    })

    await sidecar.start('/repo')

    expect(spawns.length).toEqual(0)
    expect(sidecar.isRunning()).toBe(false)
    expect(sidecar.isEnabled()).toBe(false)
    expect(sidecar.getPort()).toEqual(0)
    expect(infos.some(m => m.includes('disabled'))).toBe(true)
    // Nothing is listening on the port discovery would have chosen.
    const bound = await new Promise((resolve) => {
      const sock = net.connect(free, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => resolve(false))
    })
    expect(bound).toBe(false)
  })

  test('is on by default', async () => {
    const { sidecar, spawns } = setup()
    expect(sidecar.isEnabled()).toBe(true)
    await sidecar.start('/repo')
    expect(spawns.length).toEqual(1)
    await sidecar.stop()
  })

  test('setEnabled(false) stops the tracked child and persists; setEnabled(true) restarts it', async () => {
    const store = fakeStore()
    const { sidecar, spawns } = setup({ store })
    await sidecar.start('/repo')

    await sidecar.setEnabled(false)
    expect(store.data.get('mcpSidecar.enabled')).toBe(false)
    expect(spawns[0].child.killCalls).toEqual(['SIGTERM'])
    expect(sidecar.isRunning()).toBe(false)

    await sidecar.setEnabled(true)
    expect(spawns.length).toEqual(2)
    expect(sidecar.isRunning()).toBe(true)
    await sidecar.stop()
  })

  test('enabling while the daemon is stopped starts nothing; the next daemon start does', async () => {
    const store = fakeStore({ 'mcpSidecar.enabled': false })
    const { sidecar, spawns } = setup({ store })

    // Daemon up, switch off: start() only records the repo.
    await sidecar.start('/repo')
    expect(spawns.length).toEqual(0)

    // Daemon goes down (its stop path), then the operator flips the switch on.
    await sidecar.stop()
    await sidecar.setEnabled(true)

    expect(store.data.get('mcpSidecar.enabled')).toBe(true)
    expect(spawns.length).toEqual(0)
    expect(sidecar.isRunning()).toBe(false)
    expect(sidecar.getState()).toEqual('stopped')

    // The next daemon start brings it up.
    await sidecar.start('/repo')
    expect(spawns.length).toEqual(1)
    expect(sidecar.isRunning()).toBe(true)
    await sidecar.stop()
  })

  test('the switch toggled off then on while the daemon runs restarts the child', async () => {
    const { sidecar, spawns } = setup()
    await sidecar.start('/repo')
    await sidecar.setEnabled(false)
    await sidecar.setEnabled(true)
    expect(spawns.length).toEqual(2)
    await sidecar.stop()
  })
})

test.describe('daemon lifecycle wiring', () => {
  function setupDaemonWithSidecar ({ local = true, live = false } = {}) {
    const noop = () => {}
    const ipcMain = new EventEmitter()
    const appHandlers = new Map()
    const sidecars = []
    const store = { listeners: new Map() }
    const quits = []
    const errors = []

    const createDaemon = async () => ({
      err: null,
      id: 'peer-1',
      ipfsd: { path: '/repo', stop: async () => {} }
    })

    const setupDaemon = proxyquire('../../src/daemon/index', {
      electron: {
        app: { on: (ev, fn) => appHandlers.set(ev, fn), quit: () => quits.push(true) },
        ipcMain
      },
      'fs-extra': { pathExistsSync: () => local },
      '../dialogs': { ipfsNotRunningDialog: async () => {} },
      '../common/store': {
        get: () => ({ path: '/repo', flags: [] }),
        safeSet: noop,
        onDidChange: (key, cb) => store.listeners.set(key, cb)
      },
      '../common/logger': {
        start: () => ({ end: noop, fail: noop }),
        info: noop,
        error: (m) => errors.push(m)
      },
      './daemon': createDaemon,
      './mcp-sidecar': {
        MCP_SIDECAR_ENABLED_KEY: 'mcpSidecar.enabled',
        createMcpSidecar: () => {
          const s = {
            starts: [],
            stops: 0,
            kills: 0,
            enabledCalls: [],
            alive: live,
            start (p) { s.starts.push(p); s.alive = true },
            async stop () { s.stops++; s.alive = false },
            async setEnabled (v) { s.enabledCalls.push(v) },
            hasLiveProcess: () => s.alive,
            killNow () { s.kills++ }
          }
          sidecars.push(s)
          return s
        }
      },
      '../context': () => ({ setProp: noop })
    })

    return { setupDaemon, sidecars, appHandlers, store, quits, errors }
  }

  const fakeEvent = () => {
    const event = { prevented: 0, preventDefault () { event.prevented++ } }
    return event
  }

  test('starts the sidecar with the daemon repo', async () => {
    const { setupDaemon, sidecars } = setupDaemonWithSidecar({ local: true })

    await setupDaemon()

    expect(sidecars.length).toEqual(1)
    expect(sidecars[0].starts).toEqual(['/repo'])
  })

  test('quit waits for the sidecar: defers once, stops it, then quits', async () => {
    const { setupDaemon, sidecars, appHandlers, quits } = setupDaemonWithSidecar({ local: true })
    await setupDaemon()

    const event = fakeEvent()
    await appHandlers.get('before-quit')(event)

    expect(event.prevented).toEqual(1)
    expect(sidecars[0].stops).toBeGreaterThanOrEqual(1)
    expect(sidecars[0].alive).toBe(false)
    expect(quits.length).toEqual(1)

    // The re-issued quit passes straight through.
    const again = fakeEvent()
    await appHandlers.get('before-quit')(again)
    expect(again.prevented).toEqual(0)
  })

  test('quit is deferred only once even if the sidecar will not stop', async () => {
    const { setupDaemon, sidecars, appHandlers, quits } = setupDaemonWithSidecar({ local: true })
    await setupDaemon()
    // A sidecar that stays live after stop().
    sidecars[0].stop = async () => { sidecars[0].stops++ }

    const first = fakeEvent()
    await appHandlers.get('before-quit')(first)
    const second = fakeEvent()
    await appHandlers.get('before-quit')(second)

    expect(first.prevented).toEqual(1)
    expect(second.prevented).toEqual(0)
    expect(quits.length).toEqual(1)
  })

  test('quit without a live sidecar keeps the original behaviour: no deferral', async () => {
    const { setupDaemon, sidecars, appHandlers, quits } = setupDaemonWithSidecar({ local: true })
    await setupDaemon()
    sidecars[0].alive = false

    const event = fakeEvent()
    await appHandlers.get('before-quit')(event)

    expect(event.prevented).toEqual(0)
    expect(quits.length).toEqual(0)
  })

  test('will-quit kills whatever child is still tracked', async () => {
    const { setupDaemon, sidecars, appHandlers } = setupDaemonWithSidecar({ local: true })
    await setupDaemon()

    appHandlers.get('will-quit')()

    expect(sidecars[0].kills).toEqual(1)
  })

  test('does not start the sidecar for a remote daemon', async () => {
    const { setupDaemon, sidecars } = setupDaemonWithSidecar({ local: false })

    await setupDaemon()

    expect(sidecars.length).toEqual(0)
  })

  test('the store key onDidChange applies the off switch to the sidecar', async () => {
    const { setupDaemon, sidecars, store } = setupDaemonWithSidecar({ local: true })
    await setupDaemon()

    const listener = store.listeners.get('mcpSidecar.enabled')
    expect(typeof listener).toEqual('function')

    listener(false)
    listener(true)
    // An unset key means the default (on).
    listener(undefined)

    expect(sidecars[0].enabledCalls).toEqual([false, true, true])
  })

  test('a failure applying the off switch is logged, not thrown', async () => {
    const { setupDaemon, sidecars, store, errors } = setupDaemonWithSidecar({ local: true })
    await setupDaemon()
    sidecars[0].setEnabled = async () => { throw new Error('boom') }

    store.listeners.get('mcpSidecar.enabled')(false)
    await until(() => errors.length > 0)

    expect(errors[0]).toContain('boom')
  })
})
