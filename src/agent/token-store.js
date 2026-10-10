// @ts-check
// The `ipfs mcp` bearer for the chat's `ui` principal. Held by the main process only:
// encrypted with the OS keystore through Electron's safeStorage and kept as ciphertext
// in the Desktop store, so it survives a restart and is never written, in the clear, to
// any file or to any renderer storage. Nothing here logs a token.

const { KEYS } = require('./consts')

const MAX_TOKEN_LENGTH = 4096
// Bearer tokens are visible ASCII with no whitespace; anything else is a paste mistake.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/ // eslint-disable-line no-control-regex

/**
 * @typedef {object} SafeStorageLike
 * @property {() => boolean} isEncryptionAvailable
 * @property {(plain: string) => Buffer} encryptString
 * @property {(cipher: Buffer) => string} decryptString
 * @property {() => string} [getSelectedStorageBackend] Linux only
 */

/**
 * @param {object} deps
 * @param {SafeStorageLike} deps.safeStorage
 * @param {{ get: (key: string, fallback?: any) => any, set: (key: string, value: any) => void, delete: (key: string) => void }} deps.store
 * @param {{ warn: (msg: string) => void }} [deps.logger]
 * @param {string} [deps.platform]
 */
function createTokenStore ({ safeStorage, store, logger, platform = process.platform }) {
  /**
   * False when the OS offers no real keystore. On Linux, Chromium falls back to
   * `basic_text` (a fixed key, so no protection) when no secret service is running; that
   * counts as unavailable, because a token "encrypted" with it is a token in the clear.
   */
  function isAvailable () {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text' || backend === 'unknown') return false
    }
    return true
  }

  function has () {
    const cipher = store.get(KEYS.TOKEN_CIPHERTEXT, '')
    return typeof cipher === 'string' && cipher !== ''
  }

  /** @returns {string | undefined} undefined when none is stored or it cannot be decrypted */
  function get () {
    const cipher = store.get(KEYS.TOKEN_CIPHERTEXT, '')
    if (typeof cipher !== 'string' || cipher === '') return undefined
    if (!isAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (_) {
      // The keystore entry changed (new machine, reset keychain). Treat as no token.
      logger?.warn('[agent-chat] stored token could not be decrypted; it must be set again')
      return undefined
    }
  }

  /**
   * @param {unknown} token
   * @throws when the keystore is unavailable or the token has the wrong shape
   */
  function set (token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) {
      throw new Error('agent chat token has an invalid shape')
    }
    if (!isAvailable()) {
      throw new Error('secure storage is unavailable; the agent chat token is not stored')
    }
    store.set(KEYS.TOKEN_CIPHERTEXT, safeStorage.encryptString(token).toString('base64'))
  }

  function clear () {
    store.delete(KEYS.TOKEN_CIPHERTEXT)
  }

  return { isAvailable, has, get, set, clear }
}

module.exports = { createTokenStore, MAX_TOKEN_LENGTH }
