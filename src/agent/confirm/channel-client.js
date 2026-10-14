// @ts-check
// Client of the `ipfs mcp` confirmation channel, version 2 (kubo mcp/server/confirm/
// MECHANISMS.md, "Channel authentication, version 2"): HTTP over a Unix socket in a private
// directory, one socket per server process named `<pid>-<seq>.sock`.
//
//   GET  /v1/pending   {"pending": [{id, summary, tool, class, expires_at, targets, native_prompt?, principal_kind?}]}
//   POST /v1/resolve   {"id": "...", "approve": true|false}
//
// The pairing key never crosses the socket. K = SHA-256(key); every request carries a
// timestamp, a random nonce and HMAC-SHA-256(K, request string); every answer must carry
// X-IPFS-MCP-Server-Proof = HMAC(K, response string), checked before one byte of it is read.
// A socket that cannot prove it holds the verifier is ignored (by the caller) and nothing
// from it is shown or answered. Nothing here touches the network; a Unix socket is a file.

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { ENV_SOCKET_DIR } = require('../consts')

const SOCKET_NAME = /^(\d+)-\d+\.sock$/
const MAX_SOCKETS = 32
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_PENDING = 50
const REQUEST_TOTAL_MS = 3000
const MAX_SUMMARY = 600
const MAX_TARGET = 1024
const MAX_TARGETS = 12
const AUTH_VERSION = '2'
const TARGET_KINDS = new Set(['cid', 'content_path', 'mfs_path', 'key', 'ipns_name', 'peer', 'repo', 'index', 'content'])

const b64url = (/** @type {Buffer} */ buf) => buf.toString('base64url')
const sha256hex = (/** @type {Buffer | string} */ data) => crypto.createHash('sha256').update(data).digest('hex')
const hmac = (/** @type {Buffer} */ k, /** @type {string} */ text) => crypto.createHmac('sha256', k).update(text).digest()

/**
 * K, the 32 raw bytes of SHA-256 of the pairing key's UTF-8 bytes.
 *
 * @param {string} pairingKey
 * @returns {Buffer}
 */
function deriveKey (pairingKey) {
  return crypto.createHash('sha256').update(Buffer.from(pairingKey, 'utf8')).digest()
}

/**
 * @param {object} p
 * @param {string} p.socket base name of the socket
 * @param {string} p.method
 * @param {string} p.path
 * @param {string} p.timestamp
 * @param {string} p.nonce
 * @param {Buffer | string} p.body
 */
function requestString ({ socket, method, path: reqPath, timestamp, nonce, body }) {
  return ['ipfs-mcp-confirm-v2', 'request', socket, method, reqPath, timestamp, nonce, sha256hex(body)].join('\n')
}

/** @param {Parameters<typeof requestString>[0] & { K: Buffer }} p */
function signRequest (p) {
  return b64url(hmac(p.K, requestString(p)))
}

/**
 * @param {object} p
 * @param {Buffer} p.K
 * @param {string} p.socket
 * @param {string} p.nonce
 * @param {number} p.status
 * @param {Buffer | string} p.body
 */
function serverProof ({ K, socket, nonce, status, body }) {
  return b64url(hmac(K, ['ipfs-mcp-confirm-v2', 'response', socket, nonce, String(status), sha256hex(body)].join('\n')))
}

/** @param {string} a @param {string} b */
function sameString (a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/**
 * Where `ipfs mcp` puts its sockets: the same three-step rule as confirm/config.go.
 *
 * @param {{ env?: Record<string, string | undefined>, tmpdir?: string, uid?: number }} [options]
 * @returns {string}
 */
function socketDirectory ({ env = process.env, tmpdir = os.tmpdir(), uid = process.getuid?.() ?? 0 } = {}) {
  const fromEnv = env[ENV_SOCKET_DIR]
  if (fromEnv) return fromEnv
  const runtime = env.XDG_RUNTIME_DIR
  if (runtime) return path.join(runtime, 'ipfs-mcp')
  return path.join(tmpdir, `ipfs-mcp-${uid}`)
}

/** @param {number} pid */
function processExists (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return /** @type {any} */(err).code === 'EPERM'
  }
}

/**
 * The sockets of running servers, or why none can be trusted. A missing directory is not
 * an error: no server has made a channel yet. Sockets of processes that no longer exist
 * are skipped, so leftovers cannot crowd out a live server.
 *
 * @param {string} dir
 * @param {{ uid?: number, fsApi?: Pick<typeof fs, 'lstatSync' | 'readdirSync'>, alive?: (pid: number) => boolean }} [options]
 * @returns {{ sockets: string[], problem: string | null }}
 */
function discoverSockets (dir, { uid = process.getuid?.() ?? 0, fsApi = fs, alive = processExists } = {}) {
  let st
  try {
    st = fsApi.lstatSync(dir)
  } catch (err) {
    return { sockets: [], problem: /** @type {any} */(err).code === 'ENOENT' ? null : 'the confirmation directory cannot be read' }
  }
  if (!st.isDirectory()) return { sockets: [], problem: 'the confirmation directory is not a directory' }
  if (st.uid !== uid) return { sockets: [], problem: 'the confirmation directory belongs to another user' }
  if ((st.mode & 0o077) !== 0) return { sockets: [], problem: 'the confirmation directory is accessible to other users' }
  let names
  try {
    names = fsApi.readdirSync(dir)
  } catch (_) {
    return { sockets: [], problem: 'the confirmation directory cannot be read' }
  }
  /** @type {string[]} */
  const sockets = []
  for (const name of names.sort()) {
    const m = SOCKET_NAME.exec(name)
    if (!m || !alive(Number(m[1]))) continue
    const full = path.join(dir, name)
    try {
      const s = fsApi.lstatSync(full)
      if (s.isSocket() && s.uid === uid) sockets.push(full)
    } catch (_) {
      // gone between readdir and lstat: a server that just exited
    }
    if (sockets.length >= MAX_SOCKETS) break
  }
  return { sockets, problem: null }
}

/**
 * @typedef {object} Reply
 * @property {number} status 0 when the socket could not be used at all
 * @property {any} body parsed JSON, or null
 * @property {'ok' | 'bad' | 'absent'} proof the server proof: valid, present but wrong, or missing
 */

/**
 * One signed request with one total deadline (a socket that trickles bytes cannot hold the
 * poll longer than REQUEST_TOTAL_MS).
 *
 * @param {string} socketPath
 * @param {{ method: 'GET' | 'POST', path: string, K: Buffer, body?: unknown, now?: () => number, totalMs?: number }} request
 * @returns {Promise<Reply>}
 */
function send (socketPath, { method, path: reqPath, K, body, now = Date.now, totalMs = REQUEST_TOTAL_MS }) {
  return new Promise((resolve) => {
    const socket = path.basename(socketPath)
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
    const timestamp = String(Math.floor(now() / 1000))
    const nonce = b64url(crypto.randomBytes(16))
    const signature = signRequest({ K, socket, method, path: reqPath, timestamp, nonce, body: payload })
    let done = false
    /** @param {Reply} reply */
    const finish = (reply) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      resolve(reply)
    }
    const req = http.request({
      socketPath,
      method,
      path: reqPath,
      headers: {
        Accept: 'application/json',
        'X-IPFS-MCP-Auth-Version': AUTH_VERSION,
        'X-IPFS-MCP-Timestamp': timestamp,
        'X-IPFS-MCP-Nonce': nonce,
        'X-IPFS-MCP-Signature': signature,
        ...(payload.length > 0 ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy()
          finish({ status: 0, body: null, proof: 'absent' })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        const status = res.statusCode ?? 0
        const header = res.headers['x-ipfs-mcp-server-proof']
        /** @type {Reply['proof']} */
        let proof = 'absent'
        if (typeof header === 'string' && header !== '') {
          proof = sameString(header, serverProof({ K, socket, nonce, status, body: raw })) ? 'ok' : 'bad'
        }
        let parsed = null
        // Nothing from an answer is read until its proof checks; an error answer to a key the
        // server does not hold cannot carry one, and only its status is used.
        if (proof === 'ok') {
          try { parsed = JSON.parse(raw.toString('utf8')) } catch (_) {}
        }
        finish({ status, body: parsed, proof })
      })
      res.on('error', () => finish({ status: 0, body: null, proof: 'absent' }))
    })
    const deadline = setTimeout(() => {
      req.destroy()
      finish({ status: 0, body: null, proof: 'absent' })
    }, totalMs)
    req.on('error', () => finish({ status: 0, body: null, proof: 'absent' }))
    if (payload.length > 0) req.write(payload)
    req.end()
  })
}

// Text from an agent's arguments reaches the screen. Control, invisible, joiner and bidi
// characters could reorder or hide it, so they become U+FFFD; tabs and line breaks become
// spaces. Lone surrogates are made well-formed first.
// Code point ranges (inclusive) that are replaced: C0 and C1 controls except tab and line
// feed, soft hyphen, Arabic letter mark, zero-width and directional marks (200B-200F),
// line and paragraph separators, bidi embeddings and isolates, invisible operators
// (2060-2064), the byte order mark, interlinear annotation marks and the tag block.
const UNSAFE_RANGES = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x200b, 0x200f],
  [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
  [0xfff9, 0xfffb], [0xe0000, 0xe007f]
]

/** @param {number} cp */
const isUnsafe = (cp) => UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

/** @param {string} text */
const replaceUnsafe = (text) => Array.from(text, (ch) => (isUnsafe(/** @type {number} */(ch.codePointAt(0))) ? String.fromCodePoint(0xfffd) : ch)).join('')

/**
 * Clean and cut by code point, never inside a surrogate pair, and say when it was cut.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {{ text: string, truncated: boolean }}
 */
function cleanText (value, max) {
  if (typeof value !== 'string') return { text: '', truncated: false }
  const points = Array.from(replaceUnsafe(value.toWellFormed().replace(/[\t\n]/g, ' ')))
  if (points.length <= max) return { text: points.join(''), truncated: false }
  return { text: points.slice(0, max).join(''), truncated: true }
}

/**
 * @typedef {object} Target
 * @property {string} kind one of the contract's target kinds
 * @property {string} value
 * @property {boolean} truncated
 *
 * @typedef {object} PendingItem
 * @property {string} id
 * @property {string} summary
 * @property {boolean} summaryTruncated
 * @property {Target[]} targets
 * @property {string} tool
 * @property {string} cls
 * @property {number} expiresAt epoch ms
 * @property {boolean} nativePrompt
 * @property {string} principalKind
 */

/**
 * The wire form checked field by field; a record that does not fit is dropped, never
 * guessed at.
 *
 * @param {unknown} body
 * @returns {PendingItem[]}
 */
function parsePending (body) {
  const list = body && typeof body === 'object' ? /** @type {any} */(body).pending : null
  if (!Array.isArray(list)) return []
  /** @type {PendingItem[]} */
  const out = []
  for (const raw of list.slice(0, MAX_PENDING)) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 200 ? raw.id : ''
    const expiresAt = typeof raw.expires_at === 'string' ? Date.parse(raw.expires_at) : NaN
    if (id === '' || Number.isNaN(expiresAt) || typeof raw.summary !== 'string') continue
    const summary = cleanText(raw.summary, MAX_SUMMARY)
    /** @type {Target[]} */
    const targets = []
    for (const t of (Array.isArray(raw.targets) ? raw.targets : []).slice(0, MAX_TARGETS)) {
      if (!t || typeof t.value !== 'string' || t.value === '') continue
      const value = cleanText(t.value, MAX_TARGET)
      targets.push({ kind: TARGET_KINDS.has(t.kind) ? t.kind : 'content', value: value.text, truncated: value.truncated })
    }
    out.push({
      id,
      summary: summary.text,
      summaryTruncated: summary.truncated,
      targets,
      tool: cleanText(raw.tool, 100).text,
      cls: cleanText(raw.class, 40).text,
      expiresAt,
      nativePrompt: raw.native_prompt === true,
      principalKind: cleanText(raw.principal_kind, 40).text
    })
  }
  return out
}

/**
 * @typedef {{ ok: true, items: PendingItem[] } | { ok: false, reason: 'proof' | 'rejected' | 'unreachable', status: number }} ListResult
 */

/**
 * @param {string} socketPath
 * @param {string} key the pairing key; only K = SHA-256(key) is used and sent nowhere
 * @param {{ now?: () => number, totalMs?: number }} [options]
 * @returns {Promise<ListResult>}
 */
async function listPending (socketPath, key, options = {}) {
  const reply = await send(socketPath, { method: 'GET', path: '/v1/pending', K: deriveKey(key), ...options })
  if (reply.status === 200) {
    return reply.proof === 'ok' ? { ok: true, items: parsePending(reply.body) } : { ok: false, reason: 'proof', status: 200 }
  }
  // 401 and 403: the server does not accept this pairing (or a clock is off by more than 30 s).
  if (reply.status === 401 || reply.status === 403) return { ok: false, reason: 'rejected', status: reply.status }
  return { ok: false, reason: 'unreachable', status: reply.status }
}

/**
 * @typedef {'resolved' | 'expired' | 'gone' | 'rejected' | 'untrusted' | 'conflict' | 'unreachable'} ResolveOutcome
 */

/**
 * @param {string} socketPath
 * @param {string} key
 * @param {string} id
 * @param {boolean} approve
 * @param {{ now?: () => number, totalMs?: number }} [options]
 * @returns {Promise<ResolveOutcome>}
 */
async function resolvePending (socketPath, key, id, approve, options = {}) {
  const reply = await send(socketPath, { method: 'POST', path: '/v1/resolve', K: deriveKey(key), body: { id, approve }, ...options })
  if (reply.status === 401 || reply.status === 403) return 'rejected'
  if (reply.status === 0 || reply.status >= 500) return 'unreachable'
  // Any other answer is believed only with a valid proof.
  if (reply.proof !== 'ok') return 'untrusted'
  switch (reply.status) {
    case 200: return 'resolved'
    case 410: return 'expired'
    case 404: return 'gone'
    case 409: return 'conflict'
    default: return 'unreachable'
  }
}

module.exports = {
  socketDirectory,
  discoverSockets,
  listPending,
  resolvePending,
  parsePending,
  cleanText,
  deriveKey,
  requestString,
  signRequest,
  serverProof,
  MAX_PENDING
}
