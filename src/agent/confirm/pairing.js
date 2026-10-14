// @ts-check
// The pairing key of the confirmation channel. `ipfs mcp pair` makes the key (32 random
// bytes, base64url without padding, printed once) and stores only its SHA-256 on the
// server side; the person enters the key here. Desktop keeps it as safeStorage
// ciphertext and sends it, as a bearer, over the server's Unix socket only. Desktop never
// makes a key: the key is the person's act at a terminal (docs/mcp/0003, R11 amendments).

const { KEYS } = require('../consts')
const { createSecretStore } = require('../secret-store')

/** `base64.RawURLEncoding` of 32 bytes is 43 characters. A different shape is a typing mistake. */
const PAIRING_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/

/**
 * What a pasted key looks like after the harmless parts are removed: surrounding
 * whitespace, and a terminal's line wrap.
 *
 * @param {unknown} input
 * @returns {string}
 */
function normalizePairingKey (input) {
  return typeof input === 'string' ? input.replace(/\s+/g, '') : ''
}

/**
 * @param {Omit<Parameters<typeof createSecretStore>[0], 'cipherKey' | 'label' | 'maxLength' | 'shape'>} deps
 */
function createPairingStore (deps) {
  return createSecretStore({
    ...deps,
    cipherKey: KEYS.PAIRING_CIPHERTEXT,
    label: 'pairing key',
    maxLength: 43,
    shape: PAIRING_KEY_SHAPE
  })
}

module.exports = { createPairingStore, normalizePairingKey, PAIRING_KEY_SHAPE }
