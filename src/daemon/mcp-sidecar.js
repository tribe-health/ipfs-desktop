// @ts-check
const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const { join } = require('path')
const electron = require('electron')
const logger = require('../common/logger')
const store = require('../common/store')
const { getCustomBinary } = require('../custom-ipfs-binary')
const { createSecretStore } = require('../agent/secret-store')

const DEFAULT_PORT = 5050
const BACKOFF_INITIAL_MS = 1000
const BACKOFF_MAX_MS = 30000
const BACKOFF_RESET_MS = 10000
const STOP_TIMEOUT_MS = 5000
// Consecutive restarts allowed without a run that outlives BACKOFF_RESET_MS.
// Past this the supervisor stops retrying and reports the 'failing' state
// (getState()) instead of restart-looping forever on a child that cannot start
// (bad config, port squatter, missing binary); the next start() tries again.
const MAX_RESTART_ATTEMPTS = 8
// Child stderr is untrusted text going to the Desktop log: buffer and line caps.
const STDERR_BUFFER_MAX = 64 * 1024
const LOG_LINE_MAX = 2048
// The whole line, nothing before or after it: a line that merely contains the
// phrase (a log message quoting it, an echoed request) is not the bound address.
const BOUND_ADDRESS_LINE = /^ipfs mcp: serving MCP over HTTP on http:\/\/127\.0\.0\.1:(\d+)\/mcp$/

// Environment variable NAMES under which the child reads its credentials. The
// generated --mcp-config file and the --llm-api-key-env flag reference these
// names; the values exist only in the child process environment and, at rest,
// as safeStorage ciphertext in the Desktop store. A token or key is never
// written in the clear to the store, the config file or the command line.
const SIDECAR_ENV = Object.freeze({
  UI_TOKEN: 'IPFS_MCP_DESKTOP_UI_TOKEN',
  ADMIN_TOKEN: 'IPFS_MCP_DESKTOP_ADMIN_TOKEN',
  LLM_API_KEY: 'IPFS_MCP_DESKTOP_LLM_API_KEY'
})

// Desktop store keys holding safeStorage ciphertext, never plaintext secrets.
const SIDECAR_STORE_KEYS = Object.freeze({
  UI_TOKEN_CIPHER: 'mcpSidecar.uiTokenCipher',
  ADMIN_TOKEN_CIPHER: 'mcpSidecar.adminTokenCipher',
  LLM_KEY_CIPHER: 'mcpSidecar.llmKeyCipher'
})

// Off switch (store key, plaintext boolean; the tray toggle writes it). On by
// default: the local agent endpoint is a fork feature. false means no child
// process and no bound port.
const MCP_SIDECAR_ENABLED_KEY = 'mcpSidecar.enabled'

const SIDECAR_CONFIG_NAME = 'sidecar-config.json'
const MAX_SECRET_LENGTH = 4096
// Bearer tokens are visible ASCII with no whitespace (same rule as the chat token).
const TOKEN_SHAPE = /^[\x21-\x7e]+$/ // eslint-disable-line no-control-regex

// 32 random bytes, base64url: 43 visible ASCII chars, above the server's
// minimum token length.
function generateToken () {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * The sidecar's secrets: the bearer tokens of the desktop-ui and desktop-admin
 * principals and the agent backend's API key. All three are held through the
 * shared safeStorage-ciphertext store (src/agent/secret-store.js), so the
 * Desktop store file carries ciphertext only.
 *
 * @param {object} deps
 * @param {import('../agent/secret-store').SafeStorageLike} deps.safeStorage
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void, delete: (key: string) => void }} deps.store
 * @param {{ warn: (msg: string) => void }} [deps.logger]
 * @param {string} [deps.platform]
 */
function createMcpSidecarSecrets ({ safeStorage, store, logger, platform }) {
  const mk = (cipherKey, label) => createSecretStore({
    safeStorage,
    store,
    cipherKey,
    label,
    maxLength: MAX_SECRET_LENGTH,
    shape: TOKEN_SHAPE,
    logger,
    platform
  })
  const ui = mk(SIDECAR_STORE_KEYS.UI_TOKEN_CIPHER, 'MCP ui token')
  const admin = mk(SIDECAR_STORE_KEYS.ADMIN_TOKEN_CIPHER, 'MCP admin token')
  const llmKey = mk(SIDECAR_STORE_KEYS.LLM_KEY_CIPHER, 'LLM API key')

  /**
   * The stored token, or a freshly generated one on first run. set() throws
   * when the OS keystore is unavailable: nothing is stored and the caller
   * fails start instead of falling back to plaintext.
   *
   * @param {ReturnType<typeof createSecretStore>} api
   * @returns {{ value: string, generated: boolean }}
   */
  const ensureToken = (api) => {
    const existing = api.get()
    if (existing) return { value: existing, generated: false }
    const value = generateToken()
    api.set(value)
    return { value, generated: true }
  }

  return {
    isAvailable: () => ui.isAvailable(),
    ensureUiToken: () => ensureToken(ui),
    ensureAdminToken: () => ensureToken(admin),
    /**
     * A fresh desktop-admin token for one child, stored as safeStorage ciphertext so
     * the main process can read it for as long as that child lives. Replaces the previous
     * child's token: a token that leaked from an earlier run is dead with that run.
     *
     * @returns {string}
     */
    rotateAdminToken: () => {
      const value = generateToken()
      admin.set(value)
      return value
    },
    getLlmKey: () => llmKey.get(),
    hasLlmKey: () => llmKey.has(),
    setLlmKey: (key) => llmKey.set(key),
    clearLlmKey: () => llmKey.clear()
  }
}

/**
 * The generated --mcp-config content. It names the ui and admin principals by
 * environment reference only; it contains no secret. desktop-ui is the chat
 * principal (write groups per docs/mcp/chat-setup.md; writes still need a
 * confirmation). desktop-admin is scoped to the settings route. The allowlist
 * lets the Web UI window (webui://localhost) call /agui on the loopback
 * listener.
 */
function sidecarConfig () {
  return {
    principals: [
      {
        name: 'desktop-ui',
        kind: 'ui',
        credential: { env: SIDECAR_ENV.UI_TOKEN },
        write_groups: ['pin', 'content'],
        egress_ack: ['local']
      },
      {
        name: 'desktop-admin',
        kind: 'admin',
        credential: { env: SIDECAR_ENV.ADMIN_TOKEN }
      }
    ],
    agent: { origin_allowlist: ['webui://localhost'] }
  }
}

// Inherited environment variables the child may see. Everything else in
// Desktop's environment (cloud credentials, tokens, launcher state) is dropped.
// `ipfs mcp` needs a working PATH/HOME/TMPDIR, the locale, the Windows
// profile variables, the D-Bus session for the Linux polkit prompt, and the
// standard proxy and CA variables Go's net/http reads for the operator's LLM
// endpoint. The SIDECAR_ENV names are never inherited: they come from the
// secret store only.
const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ',
  'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'COMSPEC', 'PATHEXT',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // The opt-outs the child must see to honour them, and the model and runtime
  // locations of the content extractor (xberg / onnxruntime).
  'DO_NOT_TRACK', 'IPFS_TELEMETRY', 'HF_ENDPOINT', 'TESSDATA_PREFIX', 'ORT_DYLIB_PATH'
])

/**
 * The child's base environment: an allowlisted copy of `inherited`.
 *
 * @param {NodeJS.ProcessEnv} inherited
 * @returns {NodeJS.ProcessEnv}
 */
function buildChildEnv (inherited) {
  const sidecarNames = new Set(Object.values(SIDECAR_ENV))
  /** @type {NodeJS.ProcessEnv} */
  const out = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || sidecarNames.has(key)) continue
    // Windows environment names are case-insensitive (Path, SystemRoot).
    const upper = key.toUpperCase()
    if (ENV_ALLOW.has(upper) || key.startsWith('LC_')) out[key] = value
  }
  return out
}

// Same resolution order daemon.js uses for `ipfs daemon`.
function resolveIpfsBinPath () {
  return process.env.IPFS_GO_EXEC ||
    getCustomBinary() ||
    require('kubo')
      .path()
      .replace('app.asar', 'app.asar.unpacked')
}

function defaultSettingsDir () {
  return join(electron.app.getPath('userData'), 'mcp')
}

/**
 * True when 127.0.0.1:port can be bound right now.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function probeLoopbackPort (port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * Ask the OS for a free loopback port.
 *
 * @returns {Promise<number>}
 */
function freeLoopbackPort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr !== 'object' || addr === null) {
        srv.close(() => reject(new Error('listen returned no address')))
        return
      }
      srv.close(() => resolve(addr.port))
    })
  })
}

/**
 * Port discovery (R4): prefer `preferred`, else a free loopback port. The
 * caller logs the outcome; a fallback is never silent.
 *
 * @param {number} preferred
 * @returns {Promise<{ port: number, fallback: boolean }>}
 */
async function discoverPort (preferred) {
  if (await probeLoopbackPort(preferred)) {
    return { port: preferred, fallback: false }
  }
  return { port: await freeLoopbackPort(), fallback: true }
}

/**
 * @typedef {object} McpSidecarOptions
 * @property {string} [binPath]
 * @property {number} [port] explicit port; skips discovery
 * @property {number} [preferredPort] discovery preference, default 5050
 * @property {string} [settingsDir]
 * @property {NodeJS.ProcessEnv} [env] the environment the child's base is filtered from, default process.env
 * @property {NodeJS.ProcessEnv} [extraEnv]
 * @property {typeof spawn} [spawnFn]
 * @property {(preferred: number) => Promise<{ port: number, fallback: boolean }>} [discoverPortFn]
 * @property {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, now: () => number }} [timers] restart scheduling clock (injectable for tests)
 * @property {{ info: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void }} [log]
 * @property {import('../agent/secret-store').SafeStorageLike} [safeStorage]
 * @property {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void, delete: (key: string) => void }} [store]
 * @property {{ mkdirSync: typeof fs.mkdirSync, writeFileSync: typeof fs.writeFileSync }} [fsImpl]
 * @property {ReturnType<typeof createMcpSidecarSecrets>} [secrets]
 * @property {number} [backoffInitialMs]
 * @property {number} [backoffMaxMs]
 * @property {number} [backoffResetMs]
 * @property {number} [stopTimeoutMs]
 * @property {number} [maxRestartAttempts]
 */

/**
 * @typedef {object} McpSidecar
 * @property {(repoPath: string) => Promise<void>} start
 * @property {() => Promise<void>} stop daemon-driven stop: also forgets the repo path
 * @property {(enabled: boolean) => Promise<void>} setEnabled
 * @property {() => boolean} isRunning
 * @property {() => boolean} hasLiveProcess a child process that has not exited yet, even one being stopped
 * @property {() => void} killNow synchronous SIGKILL of every tracked child (quit last resort)
 * @property {() => Promise<void>} restart stop and start again without touching the off switch store key
 * @property {() => 'stopped'|'starting'|'running'|'restarting'|'failing'} getState 'starting' is a spawned child that has not reported its bound address
 * @property {() => number} getPort the port the child reported binding, else the one it was told to bind
 * @property {() => number|undefined} childPid
 */

/**
 * Supervise `ipfs mcp` as a loopback child of the daemon lifecycle. The child
 * talks to the daemon through the RPC api file in the repo named by IPFS_PATH;
 * it never opens the repo itself. The listen port is discovered before every
 * spawn (5050 preferred, otherwise a free loopback port, always logged) and
 * getPort() follows the address the child reports on stderr. A child that
 * exits while the sidecar is active is restarted with exponential backoff, up
 * to maxRestartAttempts in a row; stop() signals only the tracked child PID.
 *
 * @param {McpSidecarOptions} [options]
 * @returns {McpSidecar}
 */
function createMcpSidecar (options = {}) {
  const binPath = options.binPath || resolveIpfsBinPath()
  const explicitPort = options.port || 0
  const preferredPort = options.preferredPort || DEFAULT_PORT
  const settingsDir = options.settingsDir || defaultSettingsDir()
  const inheritedEnv = options.env || process.env
  const extraEnv = options.extraEnv || {}
  const spawnFn = options.spawnFn || spawn
  const discover = options.discoverPortFn || discoverPort
  const timers = options.timers || { setTimeout, clearTimeout, now: Date.now }
  const log = options.log || logger
  const backoffInitialMs = options.backoffInitialMs || BACKOFF_INITIAL_MS
  const backoffMaxMs = options.backoffMaxMs || BACKOFF_MAX_MS
  const backoffResetMs = options.backoffResetMs || BACKOFF_RESET_MS
  const stopTimeoutMs = options.stopTimeoutMs || STOP_TIMEOUT_MS
  const maxRestartAttempts = options.maxRestartAttempts || MAX_RESTART_ATTEMPTS
  const fsImpl = options.fsImpl || fs
  const settingsStore = options.store || store
  const secrets = options.secrets || createMcpSidecarSecrets({
    safeStorage: options.safeStorage || electron.safeStorage,
    store: settingsStore,
    logger: log
  })
  const configPath = join(settingsDir, SIDECAR_CONFIG_NAME)

  /** @type {import('child_process').ChildProcess|null} */
  let child = null
  /** Every spawned child that has not emitted exit yet, including one being stopped. */
  const live = new Set()
  let repoPath = null
  let active = false
  let failing = false
  /** Bumped by every halt; an async step that started under an older value is stale. */
  let epoch = 0
  let attempts = 0
  let spawnedAt = 0
  let port = explicitPort
  /** Credentials captured at start: values for the names in SIDECAR_ENV. */
  let secretEnv = {}
  let hasLlmKey = false
  /** @type {NodeJS.Timeout|null} */
  let restartTimer = null

  const args = () => {
    const argv = [
      'mcp',
      `--http=127.0.0.1:${port}`,
      '--agui',
      '--confirm=native,desktop',
      `--settings-dir=${settingsDir}`,
      `--mcp-config=${configPath}`
    ]
    // The key is referenced by environment NAME, never by value. With a key
    // stored but no backend configured anywhere, ipfs mcp refuses to start;
    // the settings bridge only stores a key alongside a backend write, whose
    // base URL and model persist in the settings overlay in settingsDir.
    if (hasLlmKey) argv.push(`--llm-api-key-env=${SIDECAR_ENV.LLM_API_KEY}`)
    return argv
  }

  /**
   * Resolve the principal tokens and the LLM key and write the generated
   * config file. Throws when the OS keystore is unavailable: no token is
   * ever written in the clear, so the sidecar does not start without it.
   */
  const prepareCredentials = () => {
    if (!secrets.isAvailable()) {
      throw new Error('secure storage (safeStorage) is unavailable; the MCP sidecar cannot store its principal tokens and is not started')
    }
    const uiToken = secrets.ensureUiToken()
    if (uiToken.generated) log.info('[mcp-sidecar] generated the ui principal token (stored as safeStorage ciphertext)')
    // The admin token is not set here: every spawn gets a fresh one (spawnChild).
    secretEnv = {
      [SIDECAR_ENV.UI_TOKEN]: uiToken.value
    }
    const llmKey = secrets.getLlmKey()
    hasLlmKey = llmKey !== undefined
    if (hasLlmKey) {
      secretEnv[SIDECAR_ENV.LLM_API_KEY] = llmKey
      log.info(`[mcp-sidecar] passing the LLM API key to the child as $${SIDECAR_ENV.LLM_API_KEY}`)
    }
    fsImpl.mkdirSync(settingsDir, { recursive: true, mode: 0o700 })
    fsImpl.writeFileSync(configPath, JSON.stringify(sidecarConfig(), null, 2) + '\n', { mode: 0o600 })
  }

  const isEnabled = () => settingsStore.get(MCP_SIDECAR_ENABLED_KEY, true) !== false

  /**
   * Pick the listen port for the next spawn: the explicit one, else a fresh
   * discovery (5050 when free, otherwise a free loopback port). Runs before
   * every spawn, so a restart never reuses a port that something else took
   * after the first probe.
   */
  const resolvePort = async () => {
    if (explicitPort) return
    const found = await discover(preferredPort)
    port = found.port
    if (found.fallback) {
      log.warn(`[mcp-sidecar] preferred port ${preferredPort} on 127.0.0.1 is in use; falling back to free loopback port ${port}`)
    } else {
      log.info(`[mcp-sidecar] using preferred port ${port} on 127.0.0.1`)
    }
  }

  /** Children whose bound address was already taken: only the first report counts. */
  const boundSeen = new WeakSet()
  /**
   * The child whose bound-address line arrived. A child is 'starting' until it is this
   * one: before that line the port is only a request, and something else may hold it, so
   * nothing may be sent to it (the settings bearer least of all).
   *
   * @type {import('child_process').ChildProcess|null}
   */
  let boundChild = null

  /** Cap a line from the child before it reaches the Desktop log. */
  const logChildLine = (line, expectedPort, proc) => {
    const text = line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)} [truncated]` : line
    log.info(`[mcp-sidecar] ${text}`)
    // The child's own report of where it bound is the single source for
    // getPort(); everything else in Desktop reads that, not the requested port.
    // Only the current child speaks, only while the sidecar is 'running', and
    // only once: a later line cannot move the port the window was built for.
    if (child !== proc || failing || boundSeen.has(proc)) return
    const bound = BOUND_ADDRESS_LINE.exec(line)
    if (!bound) return
    const reported = Number(bound[1])
    if (!Number.isInteger(reported) || reported < 1 || reported > 65535) return
    boundSeen.add(proc)
    boundChild = proc
    if (reported !== expectedPort) {
      log.warn(`[mcp-sidecar] ipfs mcp reported port ${reported}, expected ${expectedPort}; using the reported port`)
    }
    port = reported
  }

  const spawnChild = () => {
    let proc
    try {
      // A fresh desktop-admin token per child, still held as safeStorage ciphertext.
      secretEnv = { ...secretEnv, [SIDECAR_ENV.ADMIN_TOKEN]: secrets.rotateAdminToken() }
    } catch (err) {
      log.error(`[mcp-sidecar] could not create the admin token: ${err}`)
      scheduleRestart()
      return
    }
    try {
      // Allowlisted inherited environment first, then the operator extras, then
      // the repo, then the credentials last: nothing inherited or configured
      // can override the repo the child reaches or a principal token.
      proc = spawnFn(binPath, args(), {
        env: { ...buildChildEnv(inheritedEnv), ...extraEnv, IPFS_PATH: repoPath, ...secretEnv },
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (err) {
      log.error(`[mcp-sidecar] spawn failed: ${err}`)
      scheduleRestart()
      return
    }

    child = proc
    live.add(proc)
    spawnedAt = timers.now()
    const requestedPort = port
    log.info(`[mcp-sidecar] started ipfs mcp (pid ${proc.pid}) on 127.0.0.1:${requestedPort}, settings dir ${settingsDir}`)

    let errBuf = ''
    proc.stderr.on('data', (chunk) => {
      errBuf += chunk.toString()
      let idx
      while ((idx = errBuf.indexOf('\n')) !== -1) {
        const line = errBuf.slice(0, idx).trim()
        errBuf = errBuf.slice(idx + 1)
        if (line) logChildLine(line, requestedPort, proc)
      }
      // A child that never writes a newline must not grow the buffer without
      // bound: flush what is held as one truncated line.
      if (errBuf.length > STDERR_BUFFER_MAX) {
        logChildLine(errBuf.slice(0, LOG_LINE_MAX).trim(), requestedPort, proc)
        errBuf = ''
      }
    })

    const onGone = (why) => {
      live.delete(proc)
      if (child !== proc) return
      child = null
      if (errBuf.trim()) {
        logChildLine(errBuf.trim(), requestedPort, proc)
        errBuf = ''
      }
      if (timers.now() - spawnedAt >= backoffResetMs) {
        attempts = 0
      }
      log.warn(`[mcp-sidecar] ipfs mcp (pid ${proc.pid}) exited: ${why}`)
      scheduleRestart()
    }

    proc.on('error', (err) => onGone(err.toString()))
    proc.on('exit', (code, signal) => onGone(signal ? `signal ${signal}` : `code ${code}`))
  }

  const relaunch = async () => {
    const mine = epoch
    try {
      await resolvePort()
    } catch (err) {
      log.error(`[mcp-sidecar] port discovery failed: ${err}`)
      if (active && mine === epoch) scheduleRestart()
      return
    }
    // stop() or a new start() may have run during the await.
    if (!active || mine !== epoch || child) return
    spawnChild()
  }

  const scheduleRestart = () => {
    if (!active || restartTimer) return
    if (attempts >= maxRestartAttempts) {
      failing = true
      log.error(`[mcp-sidecar] ipfs mcp failed ${attempts} restarts in a row without staying up; giving up until the next daemon start or toggle`)
      return
    }
    const delay = Math.min(backoffInitialMs * 2 ** attempts, backoffMaxMs)
    attempts++
    log.info(`[mcp-sidecar] restarting ipfs mcp in ${delay}ms (attempt ${attempts})`)
    restartTimer = timers.setTimeout(() => {
      restartTimer = null
      if (active && !child) relaunch()
    }, delay)
    if (restartTimer.unref) restartTimer.unref()
  }

  /**
   * Signal the tracked child PID: SIGTERM, then SIGKILL after stopTimeoutMs.
   * Nothing else on the system is ever signalled.
   *
   * @param {import('child_process').ChildProcess} proc
   * @returns {Promise<void>}
   */
  const stopChild = (proc) => new Promise((resolve) => {
    const giveUp = setTimeout(() => resolve(), stopTimeoutMs * 2)
    const force = setTimeout(() => {
      log.warn(`[mcp-sidecar] ipfs mcp (pid ${proc.pid}) did not exit on SIGTERM; sending SIGKILL`)
      try {
        proc.kill('SIGKILL')
      } catch (err) {
        log.error(`[mcp-sidecar] SIGKILL failed: ${err}`)
      }
    }, stopTimeoutMs)
    if (force.unref) force.unref()
    if (giveUp.unref) giveUp.unref()

    proc.once('exit', () => {
      clearTimeout(force)
      clearTimeout(giveUp)
      resolve()
    })

    try {
      proc.kill('SIGTERM')
    } catch (err) {
      log.error(`[mcp-sidecar] SIGTERM failed: ${err}`)
      clearTimeout(force)
      clearTimeout(giveUp)
      resolve()
    }
  })

  /** Stop supervising and end the child; keeps repoPath so enabling again can start. */
  const halt = async () => {
    active = false
    failing = false
    epoch++
    if (restartTimer) {
      timers.clearTimeout(restartTimer)
      restartTimer = null
    }
    const proc = child
    child = null
    if (!proc) return
    log.info(`[mcp-sidecar] stopping ipfs mcp (pid ${proc.pid})`)
    await stopChild(proc)
  }

  return {
    /**
     * Start supervising. repoPath is the daemon's repo; the child reads the
     * api file there to reach the daemon's RPC endpoint. Unless an explicit
     * port was configured, the port is discovered first: 5050 when free,
     * otherwise a free loopback port, reported in the log either way.
     *
     * @param {string} path
     * @returns {Promise<void>}
     */
    async start (path) {
      if (active) return
      repoPath = path
      if (!isEnabled()) {
        log.info(`[mcp-sidecar] disabled (${MCP_SIDECAR_ENABLED_KEY} is false); not started`)
        return
      }
      active = true
      failing = false
      attempts = 0
      const mine = epoch
      try {
        prepareCredentials()
      } catch (err) {
        active = false
        log.error(`[mcp-sidecar] ${err.message}`)
        throw err
      }
      try {
        await resolvePort()
      } catch (err) {
        if (mine === epoch) active = false
        log.error(`[mcp-sidecar] port discovery failed: ${err}`)
        throw err
      }
      // stop() ran while the port was being discovered: the off switch or a
      // daemon stop wins, no child is spawned.
      if (!active || mine !== epoch) return
      spawnChild()
    },

    /**
     * Daemon-driven stop (daemon stop, restart or quit). Also forgets the repo
     * path: with no daemon there is nothing for a child to reach, so a later
     * setEnabled(true) must not spawn one; the next start() supplies the path.
     */
    async stop () {
      repoPath = null
      await halt()
    },

    /**
     * Apply the off switch at runtime (the tray toggle). Persists the value
     * and starts or stops the supervised child accordingly; a switch to true
     * takes effect now only while a daemon is running (a repo path from
     * start()), otherwise at the next daemon start.
     *
     * @param {boolean} enabled
     * @returns {Promise<void>}
     */
    async setEnabled (enabled) {
      settingsStore.set(MCP_SIDECAR_ENABLED_KEY, Boolean(enabled))
      if (!enabled) {
        await halt()
        return
      }
      if (repoPath && !active) await this.start(repoPath)
    },

    /**
     * Stop and start the child again without touching the persisted off switch (a new
     * key is applied this way). A no-op while no daemon gave a repo path. The start
     * still honours the off switch: a sidecar the operator turned off stays off.
     *
     * @returns {Promise<void>}
     */
    async restart () {
      const path = repoPath
      if (path === null) return
      await halt()
      await this.start(path)
    },

    /**
     * Last resort at quit: SIGKILL every tracked child synchronously. Only PIDs
     * this supervisor spawned and that have not exited are signalled.
     */
    killNow () {
      active = false
      epoch++
      if (restartTimer) {
        timers.clearTimeout(restartTimer)
        restartTimer = null
      }
      for (const proc of live) {
        try {
          proc.kill('SIGKILL')
        } catch (err) {
          log.error(`[mcp-sidecar] SIGKILL on quit failed: ${err}`)
        }
      }
    },

    isEnabled,
    isRunning: () => child !== null,
    hasLiveProcess: () => live.size > 0,
    getState: () => {
      if (failing) return 'failing'
      if (child) return boundChild === child ? 'running' : 'starting'
      return active ? 'restarting' : 'stopped'
    },
    getPort: () => port,
    childPid: () => (child ? child.pid : undefined)
  }
}

module.exports = { createMcpSidecar, createMcpSidecarSecrets, sidecarConfig, buildChildEnv, DEFAULT_PORT, MCP_SIDECAR_ENABLED_KEY, SIDECAR_ENV, SIDECAR_STORE_KEYS }
