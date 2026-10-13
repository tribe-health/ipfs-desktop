// @ts-check
// A secret kept as safeStorage ciphertext in the Desktop store: the bearer for the chat's
// `ui` principal (token-store.js) and the `ipfs mcp pair` key (confirm/pairing.js). It is
// encrypted with the OS keystore through Electron's safeStorage and kept as ciphertext, so
// it survives a restart and is never written, in the clear, to any file or to any renderer
// storage. Nothing here logs a secret.

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
 * @param {string} deps.cipherKey store key that holds the ciphertext
 * @param {string} deps.label what the secret is called in messages, for example "agent chat token"
 * @param {number} deps.maxLength
 * @param {RegExp} deps.shape the accepted form; anything else is a paste mistake
 * @param {{ warn: (msg: string) => void }} [deps.logger]
 * @param {string} [deps.platform]
 */
function createSecretStore ({ safeStorage, store, cipherKey, label, maxLength, shape, logger, platform = process.platform }) {
  /**
   * False when the OS offers no real keystore. On Linux, Chromium falls back to
   * `basic_text` (a fixed key, so no protection) when no secret service is running; that
   * counts as unavailable, because a secret "encrypted" with it is a secret in the clear.
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
    const cipher = store.get(cipherKey, '')
    return typeof cipher === 'string' && cipher !== ''
  }

  /** @returns {string | undefined} undefined when none is stored or it cannot be decrypted */
  function get () {
    const cipher = store.get(cipherKey, '')
    if (typeof cipher !== 'string' || cipher === '') return undefined
    if (!isAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (_) {
      // The keystore entry changed (new machine, reset keychain). Treat as none.
      logger?.warn(`[agent-chat] stored ${label} could not be decrypted; it must be set again`)
      return undefined
    }
  }

  /**
   * @param {unknown} secret
   * @throws when the keystore is unavailable or the secret has the wrong shape
   */
  function set (secret) {
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > maxLength || !shape.test(secret)) {
      throw new Error(`${label} has an invalid shape`)
    }
    if (!isAvailable()) {
      throw new Error(`secure storage is unavailable; the ${label} is not stored`)
    }
    store.set(cipherKey, safeStorage.encryptString(secret).toString('base64'))
  }

  function clear () {
    store.delete(cipherKey)
  }

  return { isAvailable, has, get, set, clear }
}

module.exports = { createSecretStore }
