// @ts-check
// Desktop Search (vector index) for the `ipfs mcp` sidecar: the store keys, a validated read
// of them, and the generator of the `embeddings` block of the sidecar config
// (mcp/contract/config/ipfs-mcp-config.schema.json, docs/mcp/embeddings.md).
//
// Off by default (operator decision O-5): with Search off, or with anything it needs missing,
// no `embeddings` block is written, so `ipfs mcp` starts no `surreal` or `xberg` process and
// its search route answers 404. Desktop downloads nothing: the SurrealDB and xberg binaries
// are the operator's own, named by absolute path and never looked up on PATH; the embedder is
// an HTTP endpoint the operator runs (OG-17, OG-19). The generator makes no network call.
//
// Egress: the Desktop `ui` principal may send content only to loopback (`local`) and to
// non-loopback hosts the person confirmed by name (the dialog is in src/agent/search/).
// A host that is configured but not confirmed keeps Search unavailable; nothing is sent.

const nodeFs = require('fs')
const { dirname, isAbsolute, join } = require('path')

const SEARCH_KEYS = Object.freeze({
  ENABLED: 'search.enabled',
  SURREAL_BINARY: 'search.surrealBinary',
  XBERG_BINARY: 'search.xbergBinary',
  EMBEDDER_URL: 'search.embedder.baseUrl',
  EMBEDDER_MODEL: 'search.embedder.model',
  EMBEDDER_DIMENSIONS: 'search.embedder.dimensions',
  DESCRIBER_URL: 'search.describer.baseUrl',
  DESCRIBER_MODEL: 'search.describer.model',
  /** Hosts the person confirmed by name (Touch ID or the native dialog). */
  CONFIRMED_HOSTS: 'search.confirmedHosts'
})

const PATH_MAX = 4096
const URL_MAX = 2048
const MODEL_MAX = 256
const DIM_MAX = 8192
// https for any host, plain http only on this computer; never credentials in the URL.
const ENDPOINT = /^(https:\/\/[^\s/@]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?)(\/[^\s]*)?$/
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/

// xberg extracts these natively and offline (Desktop does not download models). Images are
// listed only when a describer is configured. docs/mcp/embeddings.md: the allowlist is the
// one place that decides what is indexed at all, and its default is text only.
const DOCUMENT_TYPES = Object.freeze([
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
])
const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// The contract defaults of the bulk run and the search route, written out so the generated
// file states them.
const BULK_DEFAULTS = Object.freeze({
  enabled: true,
  sources: ['pins', 'mfs'],
  mfs_root: '/',
  max_files_per_run: 1000,
  max_bytes_per_run: 1073741824,
  files_per_minute: 30
})

/**
 * @typedef {object} SearchSettings
 * @property {boolean} enabled
 * @property {string} surrealBinary
 * @property {string} xbergBinary
 * @property {{ baseUrl: string, model: string, dimensions: number | null }} embedder
 * @property {{ baseUrl: string, model: string } | null} describer null when no describer is configured
 * @property {string[]} confirmedHosts
 */

const str = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === 'string' && v.length <= max ? v.trim() : '')

/**
 * The stored Search settings, defensively typed: whatever the store holds that is not the
 * expected shape reads as empty.
 *
 * @param {{ get: (key: string, fallback?: any) => any }} store
 * @returns {SearchSettings}
 */
function readSearchSettings (store) {
  const dims = store.get(SEARCH_KEYS.EMBEDDER_DIMENSIONS)
  const confirmed = store.get(SEARCH_KEYS.CONFIRMED_HOSTS, [])
  const describerUrl = str(store.get(SEARCH_KEYS.DESCRIBER_URL), URL_MAX)
  const describerModel = str(store.get(SEARCH_KEYS.DESCRIBER_MODEL), MODEL_MAX)
  return {
    enabled: store.get(SEARCH_KEYS.ENABLED, false) === true,
    surrealBinary: str(store.get(SEARCH_KEYS.SURREAL_BINARY), PATH_MAX),
    xbergBinary: str(store.get(SEARCH_KEYS.XBERG_BINARY), PATH_MAX),
    embedder: {
      baseUrl: str(store.get(SEARCH_KEYS.EMBEDDER_URL), URL_MAX),
      model: str(store.get(SEARCH_KEYS.EMBEDDER_MODEL), MODEL_MAX),
      dimensions: Number.isInteger(dims) && dims >= 1 && dims <= DIM_MAX ? dims : null
    },
    describer: describerUrl || describerModel ? { baseUrl: describerUrl, model: describerModel } : null,
    confirmedHosts: Array.isArray(confirmed) ? confirmed.filter((h) => typeof h === 'string') : []
  }
}

/** @param {string} url @returns {{ host: string, hostname: string, loopback: boolean } | null} */
function parseEndpoint (url) {
  if (url.length === 0 || url.length > URL_MAX || !ENDPOINT.test(url)) return null
  try {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '') return null
    const hostname = u.hostname.toLowerCase()
    return { host: u.host.toLowerCase(), hostname, loopback: LOOPBACK.test(hostname) }
  } catch (_) {
    return null
  }
}

/**
 * The hosts Search would send content to, with whether each is on this computer.
 *
 * @param {SearchSettings} settings
 * @returns {{ role: 'embedder' | 'describer', host: string, loopback: boolean }[]}
 */
function searchHosts (settings) {
  /** @type {{ role: 'embedder' | 'describer', host: string, loopback: boolean }[]} */
  const out = []
  const e = parseEndpoint(settings.embedder.baseUrl)
  if (e) out.push({ role: 'embedder', host: e.host, loopback: e.loopback })
  const d = settings.describer ? parseEndpoint(settings.describer.baseUrl) : null
  if (d) out.push({ role: 'describer', host: d.host, loopback: d.loopback })
  return out
}

/**
 * The `egress_ack` of the Desktop `ui` principal: `local` always (loopback hosts), plus each
 * configured non-loopback host the person confirmed. A host that is no longer configured
 * is not carried over, which is how removing it, or turning Search off, removes the entry.
 *
 * @param {SearchSettings | null} settings null (or off) for the base list
 * @returns {string[]}
 */
function egressAck (settings) {
  const ack = ['local']
  if (!settings || !settings.enabled) return ack
  for (const { host, loopback } of searchHosts(settings)) {
    if (!loopback && settings.confirmedHosts.includes(host) && !ack.includes(host)) ack.push(host)
  }
  return ack
}

/**
 * @typedef {object} SearchFs
 * @property {typeof nodeFs.statSync} statSync
 * @property {typeof nodeFs.accessSync} accessSync
 * @property {typeof nodeFs.mkdirSync} mkdirSync
 *
 * @typedef {{ ok: true, embeddings: object, egressAck: string[], hosts: ReturnType<typeof searchHosts> }
 *   | { ok: false, reason: 'off' | 'incomplete' | 'binary_not_absolute' | 'binary_missing' | 'binary_not_executable' | 'embedder_invalid' | 'describer_invalid' | 'binary_unsafe' | 'host_not_confirmed' | 'dir_unsafe' | 'dir_failed', detail?: string }} SearchConfigResult
 */

/**
 * @param {string} dir
 * @param {SearchFs} fs
 * @param {number | null} uid null where ownership cannot be checked (Windows)
 * @returns {'ok' | 'unsafe' | 'failed'}
 */
function ensurePrivateDir (dir, fs, uid) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return 'unsafe'
    if (uid !== null && (st.uid !== uid || (st.mode & 0o022) !== 0)) return 'unsafe'
    return 'ok'
  } catch (_) {
    return 'failed'
  }
}

/**
 * Whether a program Desktop is about to run, and the folder it sits in, belong to this user
 * or to root and cannot be written by group or others. xberg loads libraries from its own
 * folder, so a writable folder is as unsafe as a writable file. Windows has no mode bits to
 * read (uid null), so it is not checked there.
 *
 * @param {string} path
 * @param {SearchFs} fs
 * @param {number | null} uid
 * @returns {boolean}
 */
function isTrustedProgram (path, fs, uid) {
  if (uid === null) return true
  for (const target of [path, dirname(path)]) {
    let st
    try {
      st = fs.statSync(target)
    } catch (_) {
      return false
    }
    if ((st.uid !== uid && st.uid !== 0) || (st.mode & 0o022) !== 0) return false
  }
  return true
}

/**
 * The embeddings block for the sidecar config, or the reason there is none. No network, no
 * PATH lookup: only stat and access checks on the paths the operator named.
 *
 * @param {object} args
 * @param {SearchSettings} args.settings
 * @param {string} args.searchDir where Desktop keeps the store and the xberg cache (under userData)
 * @param {SearchFs} [args.fs]
 * @param {string} [args.platform]
 * @param {number | null} [args.uid]
 * @returns {SearchConfigResult}
 */
function buildSearchConfig ({ settings, searchDir, fs = nodeFs, platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : null }) {
  if (!settings.enabled) return { ok: false, reason: 'off' }
  if (settings.surrealBinary === '' || settings.xbergBinary === '' || settings.embedder.baseUrl === '' || settings.embedder.model === '' || settings.embedder.dimensions === null) {
    return { ok: false, reason: 'incomplete' }
  }
  for (const [name, path] of [['surreal', settings.surrealBinary], ['xberg', settings.xbergBinary]]) {
    if (!isAbsolute(path) || path.includes('\0')) return { ok: false, reason: 'binary_not_absolute', detail: name }
  }
  const embedder = parseEndpoint(settings.embedder.baseUrl)
  if (!embedder) return { ok: false, reason: 'embedder_invalid' }
  const describer = settings.describer ? parseEndpoint(settings.describer.baseUrl) : null
  if (settings.describer && (!describer || settings.describer.model === '')) return { ok: false, reason: 'describer_invalid' }

  for (const [name, path] of [['surreal', settings.surrealBinary], ['xberg', settings.xbergBinary]]) {
    let st
    try {
      st = fs.statSync(path)
    } catch (_) {
      return { ok: false, reason: 'binary_missing', detail: name }
    }
    if (!st.isFile()) return { ok: false, reason: 'binary_missing', detail: name }
    try {
      fs.accessSync(path, nodeFs.constants.X_OK)
    } catch (_) {
      return { ok: false, reason: 'binary_not_executable', detail: name }
    }
    if (!isTrustedProgram(path, fs, platform === 'win32' ? null : uid)) return { ok: false, reason: 'binary_unsafe', detail: name }
  }

  const hosts = searchHosts(settings)
  const ack = egressAck(settings)
  const unconfirmed = hosts.find((h) => !h.loopback && !ack.includes(h.host))
  if (unconfirmed) return { ok: false, reason: 'host_not_confirmed', detail: unconfirmed.host }

  const ownerUid = platform === 'win32' ? null : uid
  const dataDir = join(searchDir, 'surreal')
  const cacheDir = join(searchDir, 'xberg-cache')
  // The cache must belong to this user and not be writable by group or others: `ipfs mcp`
  // refuses to start xberg on it otherwise (docs/mcp/embeddings.md).
  for (const dir of [searchDir, dataDir, cacheDir]) {
    const state = ensurePrivateDir(dir, fs, ownerUid)
    if (state !== 'ok') return { ok: false, reason: state === 'unsafe' ? 'dir_unsafe' : 'dir_failed', detail: dir }
  }

  /** @type {Record<string, any>} */
  const embeddings = {
    mode: 'embedded',
    embedded: { surreal_binary: settings.surrealBinary, data_dir: dataDir },
    embedder: { base_url: settings.embedder.baseUrl, model: settings.embedder.model, dimensions: settings.embedder.dimensions },
    policy: { mime_allowlist: describer ? [...DOCUMENT_TYPES, ...IMAGE_TYPES] : [...DOCUMENT_TYPES] },
    extractor: {
      mode: 'embedded',
      embedded: { xberg_binary: settings.xbergBinary, cache_dir: cacheDir, allow_model_downloads: false },
      ocr: false,
      transcribe: false
    },
    bulk: { ...BULK_DEFAULTS, sources: [...BULK_DEFAULTS.sources] },
    search_route: { enabled: true }
  }
  if (settings.describer && describer) {
    // Images only. Video description needs a hosted model and stays off.
    embeddings.describer = { base_url: settings.describer.baseUrl, model: settings.describer.model, kinds: ['image'] }
  }
  return { ok: true, embeddings, egressAck: ack, hosts }
}

module.exports = { SEARCH_KEYS, readSearchSettings, searchHosts, egressAck, buildSearchConfig, parseEndpoint, DOCUMENT_TYPES, IMAGE_TYPES, BULK_DEFAULTS }
