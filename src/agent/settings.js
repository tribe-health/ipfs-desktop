// @ts-check
// Agent chat settings, read from the Desktop store. The chat is off and has no endpoint
// until the operator sets both. There is no default endpoint and no discovery: the value
// is whatever the operator typed, accepted only in the shape the island itself accepts.

const { KEYS } = require('./consts')
const { toHttpOrigin } = require('../webui/security')

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/

/**
 * The same rules as the Web UI island's `endpoint` attribute: https, or http on a
 * loopback host; the path ends in /agui; no credentials, query or fragment.
 *
 * @param {unknown} input
 * @returns {{ ok: true, value: string, origin: string } | { ok: false, reason: 'empty' | 'invalid' | 'scheme' | 'path' | 'extras' }}
 */
function validateEndpoint (input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return { ok: false, reason: 'empty' }
  let url
  try {
    url = new URL(text)
  } catch (_) {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) return { ok: false, reason: 'scheme' }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return { ok: false, reason: 'extras' }
  if (!url.pathname.endsWith('/agui')) return { ok: false, reason: 'path' }
  const origin = toHttpOrigin(url.href)
  if (origin === null) return { ok: false, reason: 'invalid' }
  return { ok: true, value: url.href, origin }
}

/**
 * `enabled` is true only when the switch is on AND the endpoint is valid, so a half
 * configured chat behaves exactly like a disabled one.
 *
 * @param {{ get: (key: string, fallback?: any) => any }} store
 * @returns {{ enabled: boolean, endpoint: string | null, origin: string | null }}
 */
function readAgentChatSettings (store) {
  const switchedOn = store.get(KEYS.ENABLED, false) === true
  const endpoint = validateEndpoint(store.get(KEYS.ENDPOINT, ''))
  if (!switchedOn || !endpoint.ok) return { enabled: false, endpoint: null, origin: null }
  return { enabled: true, endpoint: endpoint.value, origin: endpoint.origin }
}

module.exports = { validateEndpoint, readAgentChatSettings }
