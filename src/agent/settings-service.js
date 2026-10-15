// @ts-check
// The setters and readers behind `ipfsDesktop.agentSettings.*`, run in the main process.
// The renderer sends requests shaped like mcp/contract/settings/client/*.schema.json; this
// module validates them (unknown fields are refused), talks to the sidecar's settings route
// with the desktop-admin token (settings-api.js), and answers with whitelisted fields only,
// so nothing the sidecar returns beyond the contract shape reaches the page.
//
// Secrets: the model API key is write-only. `setApiKey` stores it in safeStorage (the
// Keychain on macOS) and applies it by restarting the sidecar with the key in its
// environment; no read, status, event, error or log line carries it. A backend change and
// an egress extension ask for Touch ID first, through the same helper the confirmation
// window uses (confirm/touchid.js).

const { SettingsApiError } = require('./settings-api')

const BASE_URL_MAX = 2048
const PROMPT_MAX = 32768
const MODEL_MAX = 256
const KEY_MAX = 512
const REVISION_MAX = 256
const ERROR_TEXT_MAX = 2000
const KINDS = ['openai', 'uar']
const HTTP_BASE_URL = /^https?:\/\/[^\s/]+(\/[^\s]*)?$/
const CANDIDATE_URL = /^(https:\/\/[^\s/@]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?)(\/[^\s]*)?$/
const EGRESS_HOST = /^([a-z0-9.-]+|\[[0-9a-f:]+\])(:[0-9]{1,5})?$/

/** A rejection in the settings error shape of the contract (closed code set). */
class ContractError extends Error {
  /** @param {{ error: { code: string, message: string, details?: object } }} shape */
  constructor (shape) {
    super(shape.error.message)
    this.name = 'ContractError'
    this.shape = shape
  }
}

/** Any other refusal: an invalid request, the service not running, Touch ID declined. Message only. */
class BridgeFailure extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'BridgeFailure'
  }
}

const isRecord = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isRevision = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= REVISION_MAX

/**
 * Refuse a payload with a field the schema does not name (every request schema is
 * `additionalProperties: false`).
 *
 * @param {Record<string, unknown>} obj
 * @param {string[]} allowed
 * @param {string} what
 */
function onlyKeys (obj, allowed, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new BridgeFailure(`${what} has an unknown field`)
  }
}

/** @param {string} value */
function hasCredentials (value) {
  try {
    const url = new URL(value)
    return url.username !== '' || url.password !== ''
  } catch (_) {
    return true
  }
}

/** @param {string} baseUrl @returns {string} the URL host, lower case, with port */
function hostOf (baseUrl) {
  return new URL(baseUrl).host.toLowerCase()
}

/**
 * @param {unknown} req
 * @returns {{ revision: string, backend?: { kind?: string, base_url?: string, model?: string }, system_prompt?: string, egress_confirmation?: { host: string } }}
 */
function validateSet (req) {
  if (!isRecord(req)) throw new BridgeFailure('the settings change is not valid')
  onlyKeys(req, ['$schema', 'revision', 'backend', 'system_prompt', 'egress_confirmation'], 'the settings change')
  if (!isRevision(req.revision)) throw new BridgeFailure('the settings change needs the current revision')
  const out = /** @type {any} */({ revision: req.revision })
  let fields = 0
  if (req.backend !== undefined) {
    const b = req.backend
    if (!isRecord(b) || Object.keys(b).length === 0) throw new BridgeFailure('the backend change is not valid')
    onlyKeys(b, ['kind', 'base_url', 'model'], 'the backend change')
    const backend = /** @type {any} */({})
    if (b.kind !== undefined) {
      if (typeof b.kind !== 'string' || !KINDS.includes(b.kind)) throw new BridgeFailure('the backend kind is not valid')
      backend.kind = b.kind
    }
    if (b.base_url !== undefined) {
      if (typeof b.base_url !== 'string' || b.base_url.length > BASE_URL_MAX || !HTTP_BASE_URL.test(b.base_url) || hasCredentials(b.base_url)) {
        throw new BridgeFailure('the backend URL is not valid; it must be http or https and carry no credentials')
      }
      backend.base_url = b.base_url
    }
    if (b.model !== undefined) {
      if (typeof b.model !== 'string' || b.model.length < 1 || b.model.length > MODEL_MAX) throw new BridgeFailure('the model name is not valid')
      backend.model = b.model
    }
    out.backend = backend
    fields++
  }
  if (req.system_prompt !== undefined) {
    if (typeof req.system_prompt !== 'string' || req.system_prompt.length > PROMPT_MAX) throw new BridgeFailure('the system prompt is not valid')
    out.system_prompt = req.system_prompt
    fields++
  }
  if (req.egress_confirmation !== undefined) {
    const e = req.egress_confirmation
    if (!isRecord(e)) throw new BridgeFailure('the egress confirmation is not valid')
    onlyKeys(e, ['host'], 'the egress confirmation')
    if (typeof e.host !== 'string' || e.host.length > 260 || !EGRESS_HOST.test(e.host)) throw new BridgeFailure('the egress confirmation host is not valid')
    out.egress_confirmation = { host: e.host }
    fields++
  }
  if (fields === 0) throw new BridgeFailure('the settings change names nothing to change')
  return out
}

/** @param {unknown} req @returns {{ base_url: string, kind?: string }} */
function validateTestConnection (req) {
  if (!isRecord(req)) throw new BridgeFailure('the connection test is not valid')
  onlyKeys(req, ['$schema', 'base_url', 'kind'], 'the connection test')
  if (typeof req.base_url !== 'string' || req.base_url.length > BASE_URL_MAX || !CANDIDATE_URL.test(req.base_url) || hasCredentials(req.base_url)) {
    throw new BridgeFailure('the URL to test must be https, or http on this computer, and carry no credentials')
  }
  /** @type {{ base_url: string, kind?: string }} */
  const out = { base_url: req.base_url }
  if (req.kind !== undefined) {
    if (typeof req.kind !== 'string' || !KINDS.includes(req.kind)) throw new BridgeFailure('the backend kind is not valid')
    out.kind = req.kind
  }
  return out
}

/** @param {unknown} req @returns {{ revision: string, api_key: string, kind?: string }} */
function validateSetApiKey (req) {
  if (!isRecord(req)) throw new BridgeFailure('the key change is not valid')
  onlyKeys(req, ['$schema', 'revision', 'api_key', 'kind'], 'the key change')
  if (!isRevision(req.revision)) throw new BridgeFailure('the key change needs the current revision')
  if (typeof req.api_key !== 'string' || req.api_key.length < 1 || req.api_key.length > KEY_MAX) throw new BridgeFailure('the API key is not valid')
  const out = { revision: req.revision, api_key: req.api_key }
  if (req.kind !== undefined) {
    if (typeof req.kind !== 'string' || !KINDS.includes(req.kind)) throw new BridgeFailure('the backend kind is not valid')
    return { ...out, kind: req.kind }
  }
  return out
}

/** @param {unknown} req @returns {{ revision: string, kind?: string }} */
function validateClearApiKey (req) {
  if (!isRecord(req)) throw new BridgeFailure('the key removal is not valid')
  onlyKeys(req, ['$schema', 'revision', 'kind'], 'the key removal')
  if (!isRevision(req.revision)) throw new BridgeFailure('the key removal needs the current revision')
  if (req.kind !== undefined) {
    if (typeof req.kind !== 'string' || !KINDS.includes(req.kind)) throw new BridgeFailure('the backend kind is not valid')
    return { revision: req.revision, kind: req.kind }
  }
  return { revision: req.revision }
}

/**
 * The settings read shape, field by field. Anything else in the answer is dropped, so a
 * sidecar bug cannot hand the renderer extra fields.
 *
 * @param {any} body
 * @param {boolean} desktopKey a key written through this bridge is stored in safeStorage
 */
function readShape (body, desktopKey) {
  if (!isRecord(body) || !isRevision(body.revision) || !isRecord(body.system_prompt)) {
    throw new BridgeFailure('the agent service answered with settings in an unexpected shape')
  }
  /** @type {any} */
  let backend = null
  if (isRecord(body.backend)) {
    const b = body.backend
    backend = { kind: b.kind }
    if (b.base_url !== undefined) backend.base_url = b.base_url
    if (b.model !== undefined) backend.model = b.model
    if (isRecord(b.api_key)) {
      // The sidecar receives the Desktop key through an environment variable, so it
      // reports `environment`; for the page that key is the one written through the bridge.
      const source = b.api_key.set === true
        ? (b.api_key.source === 'environment' && desktopKey ? 'settings_api' : b.api_key.source)
        : undefined
      backend.api_key = b.api_key.set === true ? { set: true, source } : { set: false }
    }
  }
  return {
    revision: body.revision,
    backend,
    system_prompt: { safety_prefix: body.system_prompt.safety_prefix, custom: body.system_prompt.custom ?? '' }
  }
}

/**
 * @typedef {object} Authenticator
 * @property {() => boolean} available
 * @property {(reason: string) => Promise<boolean>} prompt
 */

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./settings-api').createSettingsApi>} deps.api
 * @param {() => import('../daemon/mcp-sidecar').McpSidecar | null} deps.getSidecar
 * @param {{ hasLlmKey: () => boolean, setLlmKey: (key: string) => void, clearLlmKey: () => void, getLlmKey: () => string | undefined }} deps.secrets
 * @param {Authenticator} deps.authenticate Touch ID (confirm/touchid.js)
 * @param {(request: { host: string }) => Promise<boolean>} [deps.confirmNative] the native dialog used when Touch ID is unavailable (confirm/native-dialog.js); without it nothing that needs a confirmation proceeds
 * @param {(key: string, options?: Record<string, unknown>) => string} deps.t
 * @param {{ info: (m: string) => void, warn: (m: string) => void, error?: (m: string) => void }} [deps.logger]
 * @param {() => Date} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.restartWaitMs] how long a key change waits for the sidecar to be back
 */
function createSettingsService ({ api, getSidecar, secrets, authenticate, confirmNative, t, logger, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), restartWaitMs = 20000 }) {
  /** @type {string | undefined} */
  let lastRevision
  /** @type {{ at: string, ok: boolean, error?: string } | undefined} */
  let applied

  /** Drop any secret this process holds from text that may reach the page or a log. */
  const redact = (/** @type {string} */ text) => {
    let out = text
    const key = secrets.getLlmKey()
    if (key) out = out.split(key).join('[redacted]')
    return out.slice(0, ERROR_TEXT_MAX)
  }

  const sidecarRunning = () => getSidecar()?.getState() === 'running'

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function viaApi (fn) {
    if (!sidecarRunning()) throw new BridgeFailure(t('agentSettings.errNotRunning'))
    try {
      return await fn()
    } catch (err) {
      if (err instanceof SettingsApiError) {
        if (err.shape) throw new ContractError(err.shape)
        if (err.status === 401) throw new BridgeFailure(t('agentSettings.errToken'))
        if (err.status === 404) throw new BridgeFailure(t('agentSettings.errRouteAbsent'))
        throw new BridgeFailure(redact(err.status === 0 ? err.message : t('agentSettings.errRejected', { status: err.status, detail: err.message })))
      }
      throw err
    }
  }

  /** @param {unknown} err */
  function recordFailure (err) {
    const message = err instanceof ContractError || err instanceof BridgeFailure ? err.message : t('agentSettings.errUnexpected')
    applied = { at: now().toISOString(), ok: false, error: redact(message) }
  }

  const recordSuccess = () => { applied = { at: now().toISOString(), ok: true } }

  /**
   * @template T
   * @param {() => Promise<T>} fn a mutation
   * @returns {Promise<T>}
   */
  async function mutation (fn) {
    try {
      const result = await fn()
      recordSuccess()
      return result
    } catch (err) {
      recordFailure(err)
      throw err
    }
  }

  /** The revision the caller presents must be the one the sidecar holds now. */
  async function currentFor (/** @type {string} */ revision) {
    const current = await viaApi(() => api.get())
    if (isRecord(current) && current.revision !== revision) {
      throw new ContractError({ error: { code: 'revision_conflict', message: t('agentSettings.errStale'), details: { current_revision: current.revision } } })
    }
    return current
  }

  /**
   * Restart the sidecar so it reads the key from its environment, then wait until it
   * has reported its bound address and answers. The supervisor's own restart() stops and
   * starts the child without writing the persisted off switch.
   */
  async function restartSidecar () {
    const sidecar = getSidecar()
    if (!sidecar) throw new BridgeFailure(t('agentSettings.errNotRunning'))
    await sidecar.restart()
    const deadline = Date.now() + restartWaitMs
    while (Date.now() < deadline) {
      if (sidecar.getState() === 'failing') break
      if (sidecar.getState() === 'running') {
        try {
          const fresh = await api.get()
          if (isRecord(fresh) && isRevision(fresh.revision)) return fresh
        } catch (_) {}
      }
      await sleep(250)
    }
    throw new BridgeFailure(t('agentSettings.errRestart'))
  }

  /**
   * Whether a set() changes the backend or the egress, which Touch ID guards: any
   * kind, URL or model that differs from the current one, or an egress confirmation.
   */
  function needsStrongAuth (/** @type {ReturnType<typeof validateSet>} */ req, /** @type {any} */ current) {
    if (req.egress_confirmation) return true
    const b = req.backend
    if (!b) return false
    const cur = isRecord(current?.backend) ? current.backend : null
    if (cur === null) return true
    return (b.kind !== undefined && b.kind !== cur.kind) ||
      (b.base_url !== undefined && b.base_url !== cur.base_url) ||
      (b.model !== undefined && b.model !== cur.model)
  }

  /**
   * The independent human confirmation: Touch ID where the computer has it, otherwise a
   * native main-process dialog that names the host. Without either, or on a decline,
   * nothing proceeds.
   *
   * @param {string} host '' when the change names no host
   * @param {string} touchReason what Touch ID shows
   */
  async function confirmHost (host, touchReason) {
    if (authenticate.available()) return authenticate.prompt(touchReason)
    logger?.warn('[agent-settings] Touch ID is unavailable on this computer; asking in a native dialog')
    if (!confirmNative) return false
    return confirmNative({ host })
  }

  /** @param {ReturnType<typeof validateSet>} req @param {any} current */
  function setHost (req, current) {
    if (req.backend?.base_url) return hostOf(req.backend.base_url)
    if (req.egress_confirmation) return req.egress_confirmation.host
    return currentBackendHost(current) ?? ''
  }

  /** @param {any} current the settings read shape @returns {string | null} */
  function currentBackendHost (current) {
    const b = isRecord(current) && isRecord(current.backend) ? current.backend : null
    if (b === null || typeof b.base_url !== 'string') return null
    try { return hostOf(b.base_url) } catch (_) { return null }
  }

  return {
    async get () {
      const body = await viaApi(() => api.get())
      const shaped = readShape(body, secrets.hasLlmKey())
      lastRevision = shaped.revision
      return shaped
    },

    /** @param {unknown} input */
    async set (input) {
      const req = validateSet(input)
      return mutation(async () => {
        const current = await currentFor(req.revision)
        if (needsStrongAuth(req, current)) {
          const host = setHost(req, current)
          const reason = host ? t('agentSettings.touchReasonHost', { host }) : t('agentSettings.touchReasonBackend')
          if (!(await confirmHost(host, reason))) throw new BridgeFailure(t('agentSettings.errTouchId'))
        }
        const { revision, ...write } = req
        const hadBackend = isRecord(current?.backend)
        const body = await viaApi(() => api.put(revision, write))
        let shaped = readShape(body, secrets.hasLlmKey())
        // A key staged before any backend existed was not passed to the sidecar (it
        // would not have started); the first backend write picks it up now.
        if (!hadBackend && shaped.backend !== null && secrets.hasLlmKey()) {
          shaped = readShape(await restartSidecar(), secrets.hasLlmKey())
        }
        lastRevision = shaped.revision
        return shaped
      })
    },

    /** @param {unknown} input */
    async testConnection (input) {
      const req = validateTestConnection(input)
      // The probe and the model listing carry the stored model key. To a host that is not
      // the current backend's, that is a decision for the person: confirm it, naming the
      // host, before anything is sent. The server also withholds the key from a host it
      // has not been told is confirmed, and answers "reachable, key not sent" then; that
      // is an ordinary result here.
      const candidateHost = hostOf(req.base_url)
      const current = await viaApi(() => api.get())
      if (candidateHost !== currentBackendHost(current)) {
        if (!(await confirmHost(candidateHost, t('agentSettings.touchReasonKeyHost', { host: candidateHost })))) {
          throw new BridgeFailure(t('agentSettings.errTouchId'))
        }
      }
      const started = Date.now()
      const result = await viaApi(() => api.testConnection(req))
      if (!isRecord(result) || typeof result.ok !== 'boolean') throw new BridgeFailure(t('agentSettings.errUnexpected'))
      /** @type {{ ok: boolean, detail?: string, latency_ms?: number, models?: string[], key_sent?: boolean }} */
      const out = { ok: result.ok, latency_ms: Date.now() - started }
      // Whether the stored key went to the candidate (test-connection.schema.json); false
      // or absent with ok means reachable, key not sent.
      if (typeof result.key_sent === 'boolean') out.key_sent = result.key_sent
      if (!result.ok) {
        if (typeof result.detail === 'string') out.detail = redact(result.detail)
        return out
      }
      try {
        const listed = await viaApi(() => api.listModels(req.base_url, req.kind))
        if (isRecord(listed) && Array.isArray(listed.models)) {
          const ids = listed.models
            .map((/** @type {any} */ m) => (isRecord(m) ? m.id : undefined))
            .filter((/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0 && id.length <= MODEL_MAX)
            .slice(0, 10000)
          out.models = ids
        }
      } catch (_) {
        // The probe worked; a backend that hides its model list leaves the combobox free text.
      }
      return out
    },

    /** @param {unknown} input */
    async setApiKey (input) {
      const req = validateSetApiKey(input)
      return mutation(async () => {
        const current = await currentFor(req.revision)
        try {
          secrets.setLlmKey(req.api_key)
        } catch (err) {
          const message = /** @type {Error} */(err).message
          throw new BridgeFailure(message.includes('unavailable') ? t('agentSettings.errKeystore') : t('agentSettings.errKeyShape'))
        }
        logger?.info('[agent-settings] the model API key was stored in secure storage')
        // With no backend configured the sidecar refuses to start with a key, so the
        // key waits for the first backend write.
        if (!isRecord(current?.backend)) return { revision: current.revision, api_key: { set: true, source: 'settings_api' } }
        const fresh = await restartSidecar()
        lastRevision = fresh.revision
        return { revision: fresh.revision, api_key: { set: true, source: 'settings_api' } }
      })
    },

    /** @param {unknown} input */
    async clearApiKey (input) {
      const req = validateClearApiKey(input)
      return mutation(async () => {
        const current = await currentFor(req.revision)
        const hadKey = secrets.hasLlmKey()
        secrets.clearLlmKey()
        logger?.info('[agent-settings] the model API key was removed from secure storage')
        if (!hadKey || !isRecord(current?.backend)) return { revision: current.revision, api_key: { set: false } }
        const fresh = await restartSidecar()
        lastRevision = fresh.revision
        return { revision: fresh.revision, api_key: { set: false } }
      })
    },

    async status () {
      const sidecar = getSidecar()
      const running = sidecar?.getState() === 'running'
      /** @type {any} */
      const out = { transport: 'desktop-bridge', managed_by_desktop: true }
      if (sidecar && running) {
        const port = sidecar.getPort()
        out.endpoint = `http://127.0.0.1:${port}/agui`
        out.sidecar = { running: true, port }
      } else {
        out.sidecar = { running: false }
      }
      if (lastRevision !== undefined) out.revision = lastRevision
      if (applied) out.applied = { ...applied }
      return out
    },

    /** The stream saw a new revision: remember it for status(). */
    observeRevision (/** @type {string} */ revision) {
      if (isRevision(revision)) lastRevision = revision
    }
  }
}

module.exports = { createSettingsService, ContractError, BridgeFailure, validateSet, validateTestConnection, validateSetApiKey, validateClearApiKey, readShape }
