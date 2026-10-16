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
const { createHostConfirm, ConfirmRefused } = require('./host-confirm')

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

/** @param {string} baseUrl @returns {string} scheme, host and port: what ADR-0012 calls the backend host */
function originOf (baseUrl) {
  return new URL(baseUrl).origin.toLowerCase()
}

/**
 * @param {unknown} req
 * @returns {{ revision: string, backend?: { kind?: string, base_url?: string, model?: string, api_key?: string | null }, system_prompt?: string, egress_confirmation?: { host: string } }}
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
    onlyKeys(b, ['kind', 'base_url', 'model', 'api_key'], 'the backend change')
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
    // Write-only (ADR-0012): a string stores a key with this change, null clears it. It is
    // checked like setApiKey and never leaves this process in a request to the sidecar.
    if (b.api_key !== undefined) {
      if (b.api_key !== null && (typeof b.api_key !== 'string' || b.api_key.length < 1 || b.api_key.length > KEY_MAX)) throw new BridgeFailure('the API key is not valid')
      backend.api_key = b.api_key
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
 * @param {boolean} [desktopCleared] this bridge deleted its stored key because the backend host moved (ADR-0012)
 */
function readShape (body, desktopKey, desktopCleared = false) {
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
  /** @type {any} */
  const shaped = {
    revision: body.revision,
    backend,
    system_prompt: { safety_prefix: body.system_prompt.safety_prefix, custom: body.system_prompt.custom ?? '' }
  }
  // ADR-0012: the stored key was not applied to a moved backend host. Only the reason
  // string and the cleared flag cross; a Desktop-stored key that this bridge deleted
  // counts as cleared even when the sidecar, which saw only an environment reference,
  // did not say so.
  const server = isRecord(body.key_not_carried) &&
    typeof body.key_not_carried.reason === 'string' && body.key_not_carried.reason.length <= 64 &&
    typeof body.key_not_carried.cleared === 'boolean'
    ? body.key_not_carried
    : null
  if (server !== null || desktopCleared) {
    shaped.key_not_carried = {
      reason: server?.reason ?? 'host_changed',
      cleared: (server?.cleared ?? false) || desktopCleared
    }
  }
  return shaped
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
 * @param {ReturnType<typeof createHostConfirm>} [deps.hostConfirm] the shared confirmation gate (src/agent/host-confirm.js); built from authenticate and confirmNative when absent
 * @param {(request: { host: string }) => Promise<boolean>} [deps.confirmNative] the native dialog used when Touch ID is unavailable (confirm/native-dialog.js); without it nothing that needs a confirmation proceeds
 * @param {(key: string, options?: Record<string, unknown>) => string} deps.t
 * @param {{ info: (m: string) => void, warn: (m: string) => void, error?: (m: string) => void }} [deps.logger]
 * @param {() => Date} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.restartWaitMs] how long a key change waits for the sidecar to be back
 */
function createSettingsService ({ api, getSidecar, secrets, authenticate, confirmNative, hostConfirm: sharedHostConfirm, t, logger, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), restartWaitMs = 20000 }) {
  /** @type {string | undefined} */
  let lastRevision
  /** @type {{ at: string, ok: boolean, error?: string } | undefined} */
  let applied
  // One gate for every host decision (one open at a time; a declined host is not asked again
  // until the window is closed). The Search settings share it when index.js passes one in.
  const hostConfirm = sharedHostConfirm ?? createHostConfirm({ authenticate, confirmNative, t, logger })
  // Keys a set() holds in this closure while it applies (the one it replaces, the one it
  // stores): redact() scrubs them from any text that may reach the page or a log.
  /** @type {Set<string>} */
  const inFlight = new Set()

  /** Drop any secret this process holds from text that may reach the page or a log. */
  const redact = (/** @type {string} */ text) => {
    let out = text
    for (const key of [secrets.getLlmKey(), ...inFlight]) {
      if (key) out = out.split(key).join('[redacted]')
    }
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
   * @param {import('./host-confirm').ConfirmOptions} [options]
   */
  async function confirmHost (host, touchReason, options) {
    try {
      return await hostConfirm.confirm(host, touchReason, options)
    } catch (err) {
      if (err instanceof ConfirmRefused) throw new BridgeFailure(err.message)
      throw err
    }
  }

  /**
   * Whether a set() moves the backend scheme, host or port (ADR-0012). A first backend
   * write is not a move: nothing was configured before.
   *
   * @param {ReturnType<typeof validateSet>} req @param {any} current
   */
  function movesBackendHost (req, current) {
    const next = req.backend?.base_url
    if (!next || !isRecord(current?.backend)) return false
    const was = current.backend.base_url
    if (typeof was !== 'string') return true
    try { return originOf(next) !== originOf(was) } catch (_) { return true }
  }

  /**
   * A kind change counts as a move too (ADR-0012, U2): a stored key is never carried
   * across kinds, and the change needs the same confirmation as a new host.
   *
   * @param {ReturnType<typeof validateSet>} req @param {any} current
   */
  function changesKind (req, current) {
    const kind = req.backend?.kind
    return kind !== undefined && isRecord(current?.backend) && kind !== current.backend.kind
  }

  /** The backend fields to write back if an apply fails after the sidecar took the new backend. @param {any} current */
  function previousBackend (current) {
    if (!isRecord(current?.backend)) return null
    const b = current.backend
    /** @type {{ kind?: string, base_url?: string, model?: string }} */
    const prev = {}
    if (typeof b.kind === 'string') prev.kind = b.kind
    if (typeof b.base_url === 'string') prev.base_url = b.base_url
    if (typeof b.model === 'string') prev.model = b.model
    return prev
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

  /**
   * Whether the key the settings route reports as set is one the server supplies by
   * reference rather than the one this bridge stores (which the sidecar sees as an
   * `environment` source). That key follows a backend host move.
   *
   * @param {any} current the settings read shape
   */
  function serverKeyFollows (current) {
    const key = isRecord(current?.backend) && isRecord(current.backend.api_key) ? current.backend.api_key : null
    if (key === null || key.set !== true) return false
    return !(secrets.hasLlmKey() && key.source === 'environment')
  }

  /**
   * A refused move: put the held key back and restart the sidecar with it. A failure here
   * is logged and does not replace the error the caller is about to throw.
   *
   * @param {string} key
   */
  async function restoreKey (key) {
    try {
      secrets.setLlmKey(key)
      logger?.warn('[agent-settings] the backend change was refused; the stored model API key was restored')
      lastRevision = (await restartSidecar()).revision
    } catch (err) {
      logger?.warn(`[agent-settings] the stored model API key could not be fully restored: ${redact(String(/** @type {Error} */(err).message))}`)
    }
  }

  /**
   * An apply that failed after the sidecar took the new backend: drop the new key, put
   * the previous backend back (the restart first, so no key rides along), then give the
   * previous key back. Best effort; a failure is logged and does not replace the error
   * the caller is about to throw.
   *
   * @param {{ kind?: string, base_url?: string, model?: string } | null} prev null when no backend existed before
   * @param {string | undefined} held the key this set() replaced
   */
  async function rollbackBackend (prev, held) {
    try {
      secrets.clearLlmKey()
      if (prev !== null) {
        const fresh = await restartSidecar()
        /** @type {Record<string, unknown>} */
        const write = { backend: prev }
        if (prev.base_url) write.egress_confirmation = { host: hostOf(prev.base_url) }
        await viaApi(() => api.put(fresh.revision, write))
      }
      if (held !== undefined) {
        secrets.setLlmKey(held)
        lastRevision = (await restartSidecar()).revision
      }
      logger?.warn('[agent-settings] the backend change failed to apply; the previous backend and model API key were restored')
    } catch (err) {
      logger?.warn(`[agent-settings] the previous backend and model API key could not be fully restored: ${redact(String(/** @type {Error} */(err).message))}`)
    }
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
      const validated = validateSet(input)
      // api_key is write-only and goes to safeStorage, never to the sidecar's settings route.
      const { api_key: suppliedKey, ...backendWrite } = validated.backend ?? {}
      const hasBackendWrite = Object.keys(backendWrite).length > 0
      const { backend: _unused, revision: presented, ...rest } = validated
      /** @type {Record<string, unknown>} */
      const write = { ...rest, ...(hasBackendWrite ? { backend: backendWrite } : {}) }
      const hasWrite = Object.keys(write).length > 0
      const req = /** @type {ReturnType<typeof validateSet>} */({ revision: presented, ...write })
      if (typeof suppliedKey === 'string') inFlight.add(suppliedKey)
      try {
        return await mutation(async () => {
          const current = await currentFor(req.revision)
          // ADR-0012: a host move or a kind change. A key stored through this bridge never
          // follows one, and both need the human confirmation.
          const moves = movesBackendHost(req, current) || changesKind(req, current)
          if (needsStrongAuth(req, current)) {
            const host = setHost(req, current)
            // A key the server holds by reference (environment, file or flag; not the one
            // this bridge stores) is applied to the new host by the server, so the person is
            // told it will be sent. Only the Desktop key is deleted before a move.
            const keyFollows = moves && serverKeyFollows(current)
            const reason = keyFollows
              ? t(host ? 'agentSettings.touchReasonHostKeyFollows' : 'agentSettings.touchReasonBackendKeyFollows', { host })
              : host ? t('agentSettings.touchReasonHost', { host }) : t('agentSettings.touchReasonBackend')
            if (!(await confirmHost(host, reason, { purpose: 'backend', keyFollows }))) throw new BridgeFailure(t('agentSettings.errTouchId'))
          }
          let revision = presented
          const hadBackend = isRecord(current?.backend)
          const prev = previousBackend(current)
          const storesKey = typeof suppliedKey === 'string'
          // The key this bridge holds is dropped before the write on a move (no request can
          // carry it to the new backend) and on an explicit clear. It is held in this closure
          // until the apply settles; if the apply fails, the old backend gets it back, so a
          // failed change never leaves it keyless. A new key arrives only after the backend
          // write, so it is never sent to the old backend either.
          const dropsKey = (moves || suppliedKey === null) && secrets.hasLlmKey()
          const keyCleared = moves && dropsKey && suppliedKey === undefined
          /** @type {string | undefined} */
          let held
          let wrote = false
          let stored = false
          let restarted = false
          let body = current
          try {
            if (dropsKey) {
              held = secrets.getLlmKey()
              if (held) inFlight.add(held)
              secrets.clearLlmKey()
              logger?.info(keyCleared
                ? '[agent-settings] the stored model API key was removed because the backend host or kind changed'
                : '[agent-settings] the stored model API key was removed')
              const fresh = await restartSidecar()
              revision = fresh.revision
              body = fresh
              restarted = true
            }
            if (hasWrite) {
              body = await viaApi(() => api.put(revision, write))
              wrote = true
            }
            if (storesKey) {
              try {
                secrets.setLlmKey(/** @type {string} */(suppliedKey))
              } catch (err) {
                const message = /** @type {Error} */(err).message
                throw new BridgeFailure(message.includes('unavailable') ? t('agentSettings.errKeystore') : t('agentSettings.errKeyShape'))
              }
              stored = true
              logger?.info('[agent-settings] the model API key was stored in secure storage')
              // With no backend configured the sidecar refuses to start with a key, so the
              // key waits for the first backend write.
              if (hadBackend || (wrote && isRecord(/** @type {any} */(body)?.backend))) {
                body = await restartSidecar()
                restarted = true
              }
            }
          } catch (err) {
            if (wrote && hasBackendWrite) await rollbackBackend(prev, held)
            else if (stored) await rollbackBackend(null, held)
            else if (held !== undefined) await restoreKey(held)
            throw err
          } finally {
            if (held) inFlight.delete(held)
            held = undefined
          }
          let shaped = readShape(body, secrets.hasLlmKey(), keyCleared)
          // A key staged before any backend existed was not passed to the sidecar (it
          // would not have started); the first backend write picks it up now.
          if (!hadBackend && !restarted && shaped.backend !== null && secrets.hasLlmKey()) {
            shaped = readShape(await restartSidecar(), secrets.hasLlmKey(), keyCleared)
          }
          lastRevision = shaped.revision
          return shaped
        })
      } finally {
        if (typeof suppliedKey === 'string') inFlight.delete(suppliedKey)
      }
    },

    /** @param {unknown} input */
    async testConnection (input) {
      const req = validateTestConnection(input)
      // No prompt here: the sidecar withholds the stored model key from a host it has not
      // been told is confirmed and answers "reachable, key not sent" (`key_sent`), so a
      // probe of an unknown host sends the page's candidate URL a request and nothing
      // secret. Deciding where the key may go is the job of set(), which asks.
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

    /** The Web UI window was closed or recreated: forget the hosts declined in its life. */
    forgetDeclined () {
      hostConfirm.forgetDeclined('backend')
    },

    /** The stream saw a new revision: remember it for status(). */
    observeRevision (/** @type {string} */ revision) {
      if (isRevision(revision)) lastRevision = revision
    }
  }
}

module.exports = { createSettingsService, ContractError, BridgeFailure, validateSet, validateTestConnection, validateSetApiKey, validateClearApiKey, readShape }
