/* global Response, ReadableStream, AbortController */
const { test, expect } = require('@playwright/test')
const { createSettingsApi, SettingsApiError, parseEventRevision } = require('../../src/agent/settings-api')
const { createSidecarWatcher, createEventPump } = require('../../src/agent/sidecar-watch')
const { setMcpSidecar, getMcpSidecar } = require('../../src/agent/sidecar-registry')

const TOKEN = 'admin-token-0123456789abcdefghijklmnopqrstuvw'

function jsonResponse (status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function setupApi (respond, { base = 'http://127.0.0.1:41999', token = TOKEN } = {}) {
  const requests = []
  const api = createSettingsApi({
    getBaseUrl: () => base,
    getAdminToken: () => token,
    fetchFn: async (url, init) => {
      requests.push({ url, init })
      return respond(url, init)
    }
  })
  return { api, requests }
}

test.describe('settings API client', () => {
  test('GET reads the settings route on the loopback sidecar with the admin bearer', async () => {
    const { api, requests } = setupApi(() => jsonResponse(200, { revision: 'r1' }))
    expect(await api.get()).toEqual({ revision: 'r1' })
    expect(requests[0].url).toEqual('http://127.0.0.1:41999/agent/settings')
    expect(requests[0].init.method).toEqual('GET')
    expect(requests[0].init.headers.Authorization).toEqual(`Bearer ${TOKEN}`)
    expect(requests[0].init.redirect).toEqual('error')
  })

  test('PUT sends If-Match with the quoted revision and the body as JSON', async () => {
    const { api, requests } = setupApi(() => jsonResponse(200, { revision: 'r2' }))
    await api.put('r1', { system_prompt: 'x' })
    expect(requests[0].init.method).toEqual('PUT')
    expect(requests[0].init.headers['If-Match']).toEqual('"r1"')
    expect(JSON.parse(requests[0].init.body)).toEqual({ system_prompt: 'x' })
  })

  test('test-connection is a POST and model listing passes the candidate in the query, not the key', async () => {
    const { api, requests } = setupApi(() => jsonResponse(200, { ok: true, models: [] }))
    await api.testConnection({ base_url: 'https://llm.example/v1', kind: 'openai' })
    await api.listModels('https://llm.example/v1', 'openai')
    expect(requests[0].url).toEqual('http://127.0.0.1:41999/agent/settings/test-connection')
    expect(requests[0].init.method).toEqual('POST')
    expect(requests[1].url).toEqual('http://127.0.0.1:41999/agent/settings/models?base_url=https%3A%2F%2Fllm.example%2Fv1&kind=openai')
    for (const r of requests) expect(JSON.stringify(r)).not.toMatch(/api_key|apiKey/)
  })

  test('a contract error body becomes SettingsApiError.shape; other bodies and codes do not', async () => {
    const shape = { error: { code: 'revision_conflict', message: 'stale', details: { current_revision: 'r9' } } }
    const a = setupApi(() => jsonResponse(412, shape))
    const err = await a.api.put('r1', { system_prompt: 'x' }).catch(e => e)
    expect(err).toBeInstanceOf(SettingsApiError)
    expect(err.status).toEqual(412)
    expect(err.shape).toEqual(shape)

    const unknownCode = setupApi(() => jsonResponse(409, { error: { code: 'made_up', message: 'x' } }))
    expect((await unknownCode.api.get().catch(e => e)).shape).toBeNull()

    const text = setupApi(() => new Response('backend kind uar is not served by this build\n', { status: 400 }))
    const e2 = await text.api.get().catch(e => e)
    expect(e2.shape).toBeNull()
    expect(e2.status).toEqual(400)
    expect(e2.message).toContain('not served by this build')
  })

  test('401 and 404 are reported as HTTP-level failures', async () => {
    for (const status of [401, 404]) {
      const { api } = setupApi(() => new Response('nope', { status }))
      const err = await api.get().catch(e => e)
      expect(err.status).toEqual(status)
      expect(err.shape).toBeNull()
    }
  })

  test('no call without a running sidecar or an admin token, and a network failure does not leak the token', async () => {
    const stopped = createSettingsApi({ getBaseUrl: () => null, getAdminToken: () => TOKEN, fetchFn: async () => { throw new Error('must not be called') } })
    expect((await stopped.get().catch(e => e)).message).toContain('not running')

    const noToken = createSettingsApi({ getBaseUrl: () => 'http://127.0.0.1:5050', getAdminToken: () => undefined, fetchFn: async () => { throw new Error('must not be called') } })
    expect((await noToken.get().catch(e => e)).message).toContain('admin token')

    const down = createSettingsApi({ getBaseUrl: () => 'http://127.0.0.1:5050', getAdminToken: () => TOKEN, fetchFn: async () => { throw new Error(`connect refused with ${TOKEN}`) } })
    const err = await down.get().catch(e => e)
    expect(err.message).not.toContain(TOKEN)
  })

  test('contract error details keep only current_revision and host as short strings', async () => {
    const body = { error: { code: 'egress_confirmation_required', message: 'confirm', details: { host: 'llm.example', current_revision: 'r9', secret: 'sk-leak', nested: { a: 1 }, extra: 'x' } } }
    const { api } = setupApi(() => jsonResponse(403, body))
    const err = await api.get().catch(e => e)
    expect(err.shape.error.details).toEqual({ host: 'llm.example', current_revision: 'r9' })

    const bad = setupApi(() => jsonResponse(403, { error: { code: 'egress_confirmation_required', message: 'confirm', details: { host: 42, current_revision: 'x'.repeat(300), other: 'y' } } }))
    const err2 = await bad.api.get().catch(e => e)
    expect(err2.shape.error.details).toBeUndefined()
  })

  test('the size cap is enforced while reading, not after buffering', async () => {
    let pulled = 0
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    const endless = new ReadableStream({
      pull (controller) {
        pulled++
        controller.enqueue(chunk)
      }
    })
    const { api } = setupApi(() => new Response(endless, { status: 200 }))
    const err = await api.get().catch(e => e)
    expect(err.message).toContain('oversized')
    // 4 MiB cap, 1 MiB chunks: reading stops a chunk or two past it, far from endless.
    expect(pulled).toBeLessThan(12)
  })

  test('an oversized body is refused', async () => {
    const { api } = setupApi(() => new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } }))
    expect((await api.get().catch(e => e)).message).toContain('oversized')
  })
})

test.describe('settings change stream', () => {
  test('parseEventRevision accepts only the contract event', () => {
    expect(parseEventRevision('data: {"type":"settings_changed","revision":"r7"}')).toEqual('r7')
    expect(parseEventRevision(': keepalive')).toBeNull()
    expect(parseEventRevision('data: {"type":"other","revision":"r7"}')).toBeNull()
    expect(parseEventRevision('data: {"type":"settings_changed","revision":""}')).toBeNull()
    expect(parseEventRevision('data: {"type":"settings_changed","revision":"' + 'x'.repeat(300) + '"}')).toBeNull()
    expect(parseEventRevision('data: not json')).toBeNull()
  })

  test('streamEvents delivers revisions split across chunks and ignores keepalives', async () => {
    const chunks = ['data: {"type":"settings_changed",', '"revision":"r1"}\n\n: keepalive\n\ndata: {"type":"settings_changed","revision":"r2"}\n\n']
    const body = new ReadableStream({
      start (controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
        controller.close()
      }
    })
    const { api, requests } = setupApi(() => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const seen = []
    await api.streamEvents((r) => seen.push(r), new AbortController().signal)
    expect(seen).toEqual(['r1', 'r2'])
    expect(requests[0].url).toEqual('http://127.0.0.1:41999/agent/settings/events')
    expect(requests[0].init.headers.Authorization).toEqual(`Bearer ${TOKEN}`)
  })

  test('the event pump reconnects with backoff and stops when told to', async () => {
    const sleeps = []
    let attempts = 0
    const seen = []
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const api = {
      streamEvents: async (onRevision, signal) => {
        attempts++
        if (attempts === 1) throw new Error('not up yet')
        if (attempts === 2) { onRevision('r1'); return }
        await gate
      }
    }
    const pump = createEventPump({
      api,
      onRevision: (r) => seen.push(r),
      sleep: async (ms) => { sleeps.push(ms) },
      backoffInitialMs: 10,
      backoffMaxMs: 40
    })
    pump.start()
    expect(pump.isActive()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual(['r1'])
    expect(sleeps).toEqual([10, 10])
    pump.stop()
    release()
    expect(pump.isActive()).toBe(false)
    const before = attempts
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(attempts).toEqual(before)
  })
})

test.describe('sidecar watcher (window recreated when the port changes)', () => {
  function fakeSidecar () {
    const s = { state: 'stopped', port: 5050, getState: () => s.state, getPort: () => s.port }
    return s
  }
  function setup () {
    const sidecar = fakeSidecar()
    const states = []
    const ports = []
    const watcher = createSidecarWatcher({
      getSidecar: () => sidecar,
      onState: (snap, prev) => states.push([prev.state, snap.state, snap.port]),
      onPortChange: (port, previous) => ports.push([previous, port]),
      timers: { setInterval: () => 0, clearInterval: () => {} }
    })
    return { sidecar, states, ports, watcher }
  }

  test('reports state changes and reads the port only while running', () => {
    const { sidecar, states, watcher } = setup()
    watcher.poll()
    sidecar.state = 'running'
    watcher.poll()
    sidecar.state = 'restarting'
    sidecar.port = 7777 // not read while restarting
    watcher.poll()
    expect(states).toEqual([['stopped', 'running', 5050], ['running', 'restarting', null]])
  })

  test('a running sidecar on a new port is a port change, once, even across states the poll missed', () => {
    const { sidecar, ports, watcher } = setup()
    sidecar.state = 'running'
    watcher.poll()
    expect(ports).toEqual([])
    sidecar.port = 41999
    watcher.poll()
    expect(ports).toEqual([[5050, 41999]])
    watcher.poll()
    expect(ports).toEqual([[5050, 41999]])

    // Stopped and back on the same port: not a change. Back on another port: a change.
    sidecar.state = 'stopped'
    watcher.poll()
    sidecar.state = 'running'
    watcher.poll()
    expect(ports.length).toEqual(1)
    sidecar.state = 'restarting'
    watcher.poll()
    sidecar.port = 42000
    sidecar.state = 'running'
    watcher.poll()
    expect(ports).toEqual([[5050, 41999], [41999, 42000]])
  })

  test('a failing sidecar is reported and its stale port is not', () => {
    const { sidecar, states, ports, watcher } = setup()
    sidecar.state = 'running'
    watcher.poll()
    sidecar.state = 'failing'
    sidecar.port = 9999
    watcher.poll()
    expect(states.at(-1)).toEqual(['running', 'failing', null])
    expect(ports).toEqual([])
  })

  test('with no sidecar yet the state is stopped', () => {
    const states = []
    const watcher = createSidecarWatcher({ getSidecar: () => null, onState: (s) => states.push(s), timers: { setInterval: () => 0, clearInterval: () => {} } })
    watcher.poll()
    expect(states).toEqual([])
    expect(watcher.current()).toEqual({ state: 'stopped', port: null })
  })

  test('start polls on an interval and stop clears it', () => {
    const calls = []
    const watcher = createSidecarWatcher({
      getSidecar: () => null,
      intervalMs: 123,
      timers: { setInterval: (fn, ms) => { calls.push(['set', ms]); return 7 }, clearInterval: (h) => calls.push(['clear', h]) }
    })
    watcher.start()
    watcher.start()
    watcher.stop()
    expect(calls).toEqual([['set', 123], ['clear', 7]])
  })

  test('the registry hands the daemon module sidecar to the bridge and the tray', () => {
    const marker = { getState: () => 'running' }
    setMcpSidecar(marker)
    expect(getMcpSidecar()).toBe(marker)
    setMcpSidecar(null)
    expect(getMcpSidecar()).toBeNull()
  })
})
