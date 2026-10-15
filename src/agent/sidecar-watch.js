// @ts-check
/* global AbortController */
// Watches the sidecar supervisor, which has no event of its own, and reports what the
// Web UI window and the tray react to: a state change (running, restarting, failing,
// stopped) and a change of the port the child reported binding. The port is read only
// while getState() is 'running'. A running sidecar that comes back on another port than
// it last ran on is a port change even when the poll never saw the states in between.

const POLL_MS = 1000

/**
 * @param {object} deps
 * @param {() => ReturnType<typeof import('../daemon/mcp-sidecar').createMcpSidecar> | null} deps.getSidecar
 * @param {(snapshot: { state: string, port: number | null }, previous: { state: string, port: number | null }) => void} [deps.onState]
 * @param {(port: number, previousPort: number) => void} [deps.onPortChange]
 * @param {number} [deps.intervalMs]
 * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [deps.timers]
 */
function createSidecarWatcher ({ getSidecar, onState, onPortChange, intervalMs = POLL_MS, timers = { setInterval, clearInterval } }) {
  /** @type {{ state: string, port: number | null }} */
  let previous = { state: 'stopped', port: null }
  /** @type {number | null} */
  let lastRunningPort = null
  /** @type {any} */
  let handle = null

  function snapshot () {
    const sidecar = getSidecar()
    if (!sidecar) return { state: 'stopped', port: null }
    const state = sidecar.getState()
    return { state, port: state === 'running' ? sidecar.getPort() : null }
  }

  function poll () {
    const next = snapshot()
    if (next.state !== previous.state || next.port !== previous.port) {
      const before = previous
      previous = next
      if (next.port !== null) {
        if (lastRunningPort !== null && next.port !== lastRunningPort) onPortChange?.(next.port, lastRunningPort)
        lastRunningPort = next.port
      }
      onState?.(next, before)
    }
  }

  return {
    start () {
      if (handle !== null) return
      poll()
      handle = timers.setInterval(poll, intervalMs)
      if (handle && typeof handle.unref === 'function') handle.unref()
    },
    stop () {
      if (handle === null) return
      timers.clearInterval(handle)
      handle = null
    },
    poll,
    current: () => previous
  }
}

/**
 * Keeps one change-stream connection open to the sidecar while it runs, reconnecting
 * with backoff, and hands each new revision to `onRevision`.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('./settings-api').createSettingsApi>} deps.api
 * @param {(revision: string) => void} deps.onRevision
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.backoffInitialMs]
 * @param {number} [deps.backoffMaxMs]
 */
function createEventPump ({ api, onRevision, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), backoffInitialMs = 1000, backoffMaxMs = 30000 }) {
  /** @type {AbortController | null} */
  let ctl = null

  async function loop (/** @type {AbortSignal} */ signal) {
    let backoff = backoffInitialMs
    while (!signal.aborted) {
      try {
        await api.streamEvents((revision) => {
          backoff = backoffInitialMs
          onRevision(revision)
        }, signal)
      } catch (_) {
        // Not reachable yet or the stream broke; try again below.
      }
      if (signal.aborted) return
      await sleep(backoff)
      backoff = Math.min(backoff * 2, backoffMaxMs)
    }
  }

  return {
    start () {
      if (ctl) return
      ctl = new AbortController()
      loop(ctl.signal)
    },
    stop () {
      if (!ctl) return
      ctl.abort()
      ctl = null
    },
    isActive: () => ctl !== null
  }
}

module.exports = { createSidecarWatcher, createEventPump }
