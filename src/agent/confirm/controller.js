// @ts-check
// The confirmation loop. While it runs it polls every `ipfs mcp` confirmation socket the
// paired key is valid for, queues what is pending (soonest expiry first), puts the head of
// the queue in the confirmation window and sends the person's answer back. Nothing in
// here decides anything: Approve and Deny are buttons in a window of their own, Approve
// needs the operating system's Touch ID, and a request that is expired, withdrawn or
// unanswered is simply gone (expiry is denial on the server).
//
// Without a pairing key the loop touches nothing: no directory read, no socket, no
// request. That is the disabled state the tests pin.

const POLL_MS = 1000
const RESULT_MS = 1400
const MAX_QUEUE = 50

/**
 * @typedef {import('./channel-client').PendingItem} PendingItem
 *
 * @typedef {object} ShownRequest
 * @property {string} ref opaque handle for this request in this process
 * @property {string} summary
 * @property {boolean} summaryTruncated
 * @property {import('./channel-client').Target[]} targets
 * @property {string} tool
 * @property {string} cls
 * @property {number} expiresAt
 * @property {boolean} nativePrompt
 * @property {boolean} canApprove false when this surface cannot approve it (system prompt only, or no Touch ID)
 * @property {'native' | 'no-touch-id' | null} approveBlocked why, when canApprove is false
 * @property {string} principalKind
 * @property {number} position 1-based place in the queue
 * @property {number} total
 *
 * @typedef {'approved' | 'denied' | 'expired' | 'gone' | 'rejected' | 'untrusted'} ResultKind
 * @typedef {'unreachable' | 'touch-id' | 'no-touch-id'} ErrorKind
 *
 * @typedef {object} Presenter
 * @property {(request: ShownRequest) => void} show
 * @property {(result: { ref: string, kind: ResultKind }) => void} showResult
 * @property {(ref: string, kind: ErrorKind) => void} showError
 * @property {(ref: string) => void} showBusy Touch ID is being asked
 * @property {() => void} hide
 *
 * @typedef {object} Hooks
 * @property {(reason: 'rejected') => void} [onPairingRejected] the server does not accept the stored key
 *
 * @typedef {object} Authenticator
 * @property {() => boolean} available whether this computer can ask for Touch ID
 * @property {(reason: string) => Promise<boolean>} prompt true only when the person authenticated
 *
 * @typedef {object} DecideMeta
 * @property {number} [armedForMs] how long Approve had been armed when it was pressed
 * @property {boolean} [focused] whether the window had focus
 *
 * @typedef {object} Deps
 * @property {{ get: () => string | undefined }} pairing
 * @property {() => string} getDirectory
 * @property {Pick<typeof import('./channel-client'), 'discoverSockets' | 'listPending' | 'resolvePending'>} client
 * @property {Presenter} presenter
 * @property {Authenticator} authenticate
 * @property {(item: PendingItem) => string} touchReason the sentence the Touch ID sheet shows
 * @property {Hooks} [hooks]
 * @property {{ info: (m: string) => void, warn: (m: string) => void }} [logger]
 * @property {() => number} [now]
 * @property {number} [pollMs]
 * @property {number} [resultMs]
 */

/**
 * @param {Deps} deps
 */
function createConfirmationController (deps) {
  const { pairing, getDirectory, client, presenter, authenticate, touchReason, hooks = {}, logger } = deps
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? POLL_MS
  const resultMs = deps.resultMs ?? RESULT_MS

  /** ref -> where the request lives. Never leaves the main process. */
  const entries = new Map()
  let refSeq = 0
  /**
   * Requests this process has answered (or found already answered), `socket|id` -> expiry,
   * so a request the server still lists is not shown again.
   *
   * @type {Map<string, number>}
   */
  const settled = new Map()
  /** Sockets that refused the current key. Cleared when the key changes. */
  const refused = new Set()
  /** Sockets that could not prove they hold the verifier. Cleared when the key changes. */
  const untrusted = new Set()
  /** Last warning per kind, so a standing condition is logged once, not every poll. */
  const warned = new Map()
  let lastKey = ''
  let announcedRejection = false
  /** @type {string | null} */
  let head = null
  let busy = false
  let showingResult = false
  let windowOpen = false
  let shownSignature = ''
  let disposed = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let pollsRun = 0

  /**
   * @param {string} kind
   * @param {string | null} message null clears the condition
   */
  function warnOnChange (kind, message) {
    if (warned.get(kind) === message) return
    if (message === null) warned.delete(kind)
    else warned.set(kind, message)
    if (message !== null) logger?.warn(`[agent-confirm] ${message}`)
  }

  function schedule () {
    if (disposed) return
    timer = setTimeout(() => { poll() }, pollMs)
  }

  function dropAll () {
    entries.clear()
    head = null
  }

  /** The queue, soonest expiry first. */
  function queue () {
    return [...entries.entries()].sort((a, b) => a[1].item.expiresAt - b[1].item.expiresAt || (a[0] < b[0] ? -1 : 1))
  }

  function hideWindow () {
    if (!windowOpen) return
    windowOpen = false
    shownSignature = ''
    presenter.hide()
  }

  function present () {
    if (disposed || busy || showingResult) return
    const q = queue()
    if (q.length === 0) {
      head = null
      hideWindow()
      return
    }
    const [ref, entry] = q[0]
    head = ref
    const touchId = authenticate.available()
    const signature = `${ref}|${q.length}|${touchId}`
    if (windowOpen && signature === shownSignature) return // nothing changed; do not reset the page
    shownSignature = signature
    windowOpen = true
    const item = entry.item
    presenter.show({
      ref,
      summary: item.summary,
      summaryTruncated: item.summaryTruncated,
      targets: item.targets,
      tool: item.tool,
      cls: item.cls,
      expiresAt: item.expiresAt,
      nativePrompt: item.nativePrompt,
      canApprove: !item.nativePrompt && touchId,
      approveBlocked: item.nativePrompt ? 'native' : touchId ? null : 'no-touch-id',
      principalKind: item.principalKind,
      position: 1,
      total: q.length
    })
  }

  async function poll () {
    timer = null
    pollsRun++
    try {
      await refresh()
    } catch (err) {
      warnOnChange('poll', `poll failed: ${/** @type {Error} */(err).message}`)
    }
    schedule()
  }

  async function refresh () {
    const key = pairing.get()
    if (!key) {
      // Unpaired (or the keystore cannot open the key): no contact with any channel.
      if (entries.size > 0) { dropAll(); if (!showingResult) hideWindow() }
      lastKey = ''
      return
    }
    if (key !== lastKey) {
      lastKey = key
      refused.clear()
      untrusted.clear()
      announcedRejection = false
    }
    const { sockets, problem } = client.discoverSockets(getDirectory())
    warnOnChange('directory', problem ? `${problem}; not contacting the channel` : null)
    // What is no longer there cannot stay refused or distrusted by name.
    for (const set of [refused, untrusted]) {
      for (const s of [...set]) if (!sockets.includes(s)) set.delete(s)
    }
    const targets = sockets.filter((s) => !refused.has(s) && !untrusted.has(s))
    const answers = await Promise.allSettled(targets.map(async (sock) => ({ sock, answer: await client.listPending(sock, key) })))
    if (disposed) return

    /** @type {Map<string, PendingItem[]>} */
    const live = new Map()
    for (const result of answers) {
      if (result.status !== 'fulfilled') continue
      const { sock, answer } = result.value
      const name = sock.split(/[\\/]/).pop()
      if (answer.ok) {
        live.set(sock, answer.items)
      } else if (answer.reason === 'proof') {
        untrusted.add(sock)
        warnOnChange(`proof:${sock}`, `${name} did not prove it holds the pairing; ignored until you pair again`)
      } else if (answer.reason === 'rejected') {
        refused.add(sock)
        warnOnChange(`rejected:${sock}`, `${name} does not accept this pairing (status ${answer.status})`)
        if (!announcedRejection) {
          announcedRejection = true
          hooks.onPairingRejected?.('rejected')
        }
      }
    }
    // A request stays only while its socket still lists it and it has not expired.
    const t = now()
    for (const [ref, entry] of [...entries]) {
      const items = live.get(entry.sock)
      const stillThere = items?.some((i) => i.id === entry.item.id) === true
      if (!stillThere || entry.item.expiresAt <= t) {
        if (ref === head && busy) continue // an answer is in flight; its outcome removes it
        entries.delete(ref)
      }
    }
    for (const [sock, items] of live) {
      for (const item of items) {
        if (entries.size >= MAX_QUEUE) break
        if (item.expiresAt <= t) continue
        if (settled.has(`${sock}|${item.id}`)) continue
        const known = [...entries.values()].some((e) => e.sock === sock && e.item.id === item.id)
        if (!known) entries.set(`r${++refSeq}`, { sock, item })
      }
    }
    for (const [settledKey, expiresAt] of [...settled]) {
      if (expiresAt <= t) settled.delete(settledKey)
    }
    if (head !== null && !entries.has(head)) head = null
    present()
  }

  /**
   * @param {string} ref
   * @param {boolean} approve
   * @param {DecideMeta} [meta]
   */
  async function decide (ref, approve, meta = {}) {
    if (disposed || busy || showingResult || ref !== head) return
    const entry = entries.get(ref)
    const key = pairing.get()
    if (!entry || !key) return
    // A request the server will not let Desktop approve is denied only; the window offers
    // no Approve for it and a forged message does not get one either.
    if (approve && entry.item.nativePrompt) return
    const item = entry.item
    const tool = item.tool
    busy = true
    let outcome
    try {
      if (approve) {
        if (!authenticate.available()) {
          presenter.showError(ref, 'no-touch-id')
          return
        }
        presenter.showBusy(ref)
        const started = now()
        const ok = await authenticate.prompt(touchReason(item))
        logger?.info(`[agent-confirm] touch id for ${tool} ${item.id}: ${ok ? 'ok' : 'not given'} after ${now() - started} ms; armed for ${meta.armedForMs ?? 'unknown'} ms, window focused: ${meta.focused ?? 'unknown'}`)
        if (disposed) return
        if (!ok) {
          presenter.showError(ref, 'touch-id')
          return
        }
        // The request may have gone while the sheet was up.
        if (!entries.has(ref)) {
          presenter.showResult({ ref, kind: 'gone' })
          return
        }
      }
      outcome = await client.resolvePending(entry.sock, key, item.id, approve)
    } finally {
      busy = false
    }
    if (disposed) return
    logger?.info(`[agent-confirm] ${approve ? 'approve' : 'deny'} ${tool} ${item.id}: ${outcome}`)
    if (outcome === 'unreachable') {
      presenter.showError(ref, 'unreachable')
      return
    }
    entries.delete(ref)
    settled.set(`${entry.sock}|${item.id}`, item.expiresAt)
    head = null
    /** @type {ResultKind} */
    let kind
    if (outcome === 'resolved') kind = approve ? 'approved' : 'denied'
    else if (outcome === 'expired') kind = 'expired'
    else if (outcome === 'rejected') { refused.add(entry.sock); kind = 'rejected' } else if (outcome === 'untrusted') { untrusted.add(entry.sock); kind = 'untrusted' } else kind = 'gone'
    showingResult = true
    presenter.showResult({ ref, kind })
    await new Promise((resolve) => setTimeout(resolve, resultMs))
    showingResult = false
    if (disposed) return
    present()
  }

  /** The stored key changed (a new pairing): sockets that refused the old one may accept this. */
  function keyChanged () {
    refused.clear()
    untrusted.clear()
    announcedRejection = false
    lastKey = ''
  }

  /**
   * The person closed the window. It is no longer a surface: forget that it shows
   * anything, so the next poll puts what is still pending back in front of them.
   */
  function surfaceClosed () {
    windowOpen = false
    shownSignature = ''
  }

  function start () {
    if (timer === null && !disposed) timer = setTimeout(() => { poll() }, 0)
  }

  function dispose () {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    dropAll()
  }

  return {
    start,
    decide,
    keyChanged,
    surfaceClosed,
    dispose,
    /** @returns {number} polls started; the disabled-state tests read it */
    get polls () { return pollsRun },
    /** @returns {number} */
    get pending () { return entries.size },
    /** @returns {string | null} the handle of the request on screen; tests use it to forge an answer */
    get shownRef () { return head }
  }
}

module.exports = { createConfirmationController, POLL_MS, RESULT_MS }
