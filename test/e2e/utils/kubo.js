'use strict'

// A throwaway Kubo node and an `ipfs mcp` stdio client for the confirmation e2e. Everything
// lives under one temporary directory: its own IPFS_PATH, its own pairing file and socket
// directory. Ports are OS-assigned, never 4001, 5001, 8080 or 4000. Processes started here
// are stopped by their own handle; nothing is killed by name.

const { spawn, spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')

const FORBIDDEN_PORTS = new Set([4000, 4001, 5001, 8080])

/** The binary under test: IPFS_KUBO_BIN, else the sibling kubo checkout's build. */
function kuboBinary () {
  const bin = process.env.IPFS_KUBO_BIN || path.resolve(__dirname, '../../../../kubo/cmd/ipfs/ipfs')
  return fs.existsSync(bin) ? bin : null
}

async function freePort () {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address()
        srv.close(() => resolve(port))
      })
    })
    if (!FORBIDDEN_PORTS.has(port)) return port
  }
}

/** A short directory: Unix socket paths are limited to about 104 bytes. */
function shortTempDir (prefix = 'dc-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function nodeEnv (root) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('IPFS_')) delete env[name]
  }
  return Object.assign(env, {
    IPFS_TELEMETRY: 'off',
    IPFS_PATH: path.join(root, 'repo'),
    IPFS_MCP_CONFIRM_DIR: path.join(root, 's'),
    IPFS_MCP_PAIRING_FILE: path.join(root, 'pairing.json')
  })
}

function ipfs (bin, root, args, options = {}) {
  return execFileSync(bin, args, { env: nodeEnv(root), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function apiPost (port, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout: 2000 }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

/**
 * Init a repository on loopback ports, with no bootstrap peers, and start an offline daemon.
 *
 * @param {string} bin
 * @param {string} root
 */
async function startNode (bin, root) {
  const [api, gateway, swarm] = [await freePort(), await freePort(), await freePort()]
  ipfs(bin, root, ['init', '--empty-repo'])
  ipfs(bin, root, ['bootstrap', 'rm', '--all'])
  ipfs(bin, root, ['config', 'Addresses.API', `/ip4/127.0.0.1/tcp/${api}`])
  ipfs(bin, root, ['config', 'Addresses.Gateway', `/ip4/127.0.0.1/tcp/${gateway}`])
  ipfs(bin, root, ['config', '--json', 'Addresses.Swarm', JSON.stringify([`/ip4/127.0.0.1/tcp/${swarm}`])])
  const log = fs.openSync(path.join(root, 'daemon.log'), 'a')
  const child = spawn(bin, ['daemon', '--offline'], { env: nodeEnv(root), cwd: root, stdio: ['ignore', log, log] })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const deadline = Date.now() + 60000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`ipfs daemon exited early; see ${path.join(root, 'daemon.log')}`)
    try {
      if (await apiPost(api, '/api/v0/id') === 200) break
    } catch (_) {}
    if (Date.now() > deadline) throw new Error('ipfs daemon did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return {
    api,
    pid: child.pid,
    async stop () {
      try { await apiPost(api, '/api/v0/shutdown') } catch (_) {}
      const done = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 15000))])
      if (!done) child.kill('SIGKILL')
      fs.closeSync(log)
    }
  }
}

function addContent (bin, root, text) {
  const file = path.join(root, `content-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(file, text)
  return ipfs(bin, root, ['add', '-Q', '--pin=false', '--cid-version=1', file]).trim()
}

function isPinned (bin, root, cid) {
  const res = spawnSync(bin, ['pin', 'ls', '--type=recursive', cid], { env: nodeEnv(root), encoding: 'utf8', timeout: 30000 })
  return res.status === 0 && res.stdout.includes(cid)
}

/**
 * `ipfs mcp pair` refuses without a terminal on stdin, so it runs under `script`, which
 * gives it a pseudo-terminal. It is the real command: it prints the key once and stores
 * only a hash of it in the pairing file.
 */
function pairWithTerminal (bin, root) {
  const args = process.platform === 'darwin'
    ? ['-q', '/dev/null', bin, 'mcp', 'pair']
    : ['-qec', `${bin} mcp pair`, '/dev/null']
  const res = spawnSync('script', args, { env: nodeEnv(root), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
  const key = /[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/.exec(res.stdout || '')
  if (!key) throw new Error(`ipfs mcp pair printed no key (exit ${res.status}): ${res.stdout} ${res.stderr}`)
  return key[0]
}

/** `ipfs mcp` over stdio: the client an agent host would be. */
class McpClient {
  constructor (bin, root, args = []) {
    this.nextId = 0
    this.waiting = new Map()
    this.stderr = ''
    this.child = spawn(bin, ['mcp', ...args], { env: nodeEnv(root), cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (d) => { this.stderr += d })
    let buf = ''
    this.child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try { msg = JSON.parse(line) } catch (_) { continue }
        const w = this.waiting.get(msg.id)
        if (w) { this.waiting.delete(msg.id); w(msg) }
      }
    })
  }

  rpc (method, params) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr}`)), 60000)
      this.waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async initialize () {
    const res = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop-e2e', version: '0' } })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return res
  }

  /** @returns {Promise<{ ok: boolean, code: string, id: string }>} */
  pinAdd (cid) {
    return this.call('pin_add', { path: `/ipfs/${cid}` })
  }

  /** @returns {Promise<{ ok: boolean, code: string, id: string }>} */
  pinRm (cid) {
    return this.call('pin_rm', { path: `/ipfs/${cid}` })
  }

  /** @returns {Promise<{ ok: boolean, code: string, id: string }>} */
  async call (name, args) {
    const res = await this.rpc('tools/call', { name, arguments: args })
    const result = res.result
    if (!result.isError) return { ok: true, code: '', id: '' }
    const err = (result.structuredContent || {}).error || {}
    return { ok: false, code: err.code || 'error', id: (err.confirmation || {}).confirmation_id || '' }
  }

  /** Stop the server and wait until the process has exited, so its socket no longer accepts. */
  stop () {
    return new Promise((resolve) => {
      const child = this.child
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const hard = setTimeout(() => { try { child.kill('SIGKILL') } catch (_) {} }, 5000)
      child.once('exit', () => { clearTimeout(hard); resolve() })
      try { child.stdin.end() } catch (_) {}
      try { child.kill() } catch (_) {}
    })
  }

  close () {
    this.stop()
  }
}

module.exports = { kuboBinary, shortTempDir, startNode, addContent, isPinned, pairWithTerminal, McpClient, nodeEnv }
