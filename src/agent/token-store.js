// @ts-check
// The `ipfs mcp` bearer for the chat's `ui` principal. Held by the main process only:
// encrypted with the OS keystore through Electron's safeStorage and kept as ciphertext
// in the Desktop store, so it survives a restart and is never written, in the clear, to
// any file or to any renderer storage. Nothing here logs a token.

const { KEYS } = require('./consts')
const { createSecretStore } = require('./secret-store')

const MAX_TOKEN_LENGTH = 4096
// Bearer tokens are visible ASCII with no whitespace; anything else is a paste mistake.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/ // eslint-disable-line no-control-regex

/**
 * @param {Omit<Parameters<typeof createSecretStore>[0], 'cipherKey' | 'label' | 'maxLength' | 'shape'>} deps
 */
function createTokenStore (deps) {
  return createSecretStore({
    ...deps,
    cipherKey: KEYS.TOKEN_CIPHERTEXT,
    label: 'agent chat token',
    maxLength: MAX_TOKEN_LENGTH,
    shape: TOKEN_SHAPE
  })
}

module.exports = { createTokenStore, MAX_TOKEN_LENGTH }
