// @ts-check
// Every user-facing string of the confirmation and pairing windows comes from
// assets/locales/en.json (and the other locales) through i18next, in the main process. The
// renderers hold no text of their own: main sends them this dictionary when a page loads,
// and the view of a request carries the one string that depends on it (the Approve label).

/** Dictionary keys the renderers use, in agentConfirm.*. */
const STRING_IDS = [
  'windowTitle', 'pairWindowTitle',
  'badgePending', 'badgeNative', 'badgeBusy', 'badgeApproved', 'badgeDenied', 'badgeExpired', 'badgeGone', 'badgeUntrusted', 'badgeRejected',
  'titleWrite', 'titleDestructive', 'titleNative', 'queue', 'expiresIn', 'expired',
  'factTool', 'factClass', 'factThrough', 'factTargets', 'classWrite', 'classDestructive', 'classUnknown',
  'kindCid', 'kindContentPath', 'kindMfsPath', 'kindKey', 'kindIpnsName', 'kindPeer', 'kindRepo', 'kindIndex', 'kindContent',
  'truncated', 'deny', 'hintDefault', 'hintNative', 'hintNoTouchId',
  'armUnfocused', 'armWaiting', 'armChanged', 'armBlur', 'armReady', 'touchBusy',
  'errTouchId', 'errUnreachable', 'errNoTouchId',
  'resultApproved', 'resultDenied', 'resultExpired', 'resultGone', 'resultRejected', 'resultUntrusted',
  'turnOff',
  'pairTitle', 'pairBadgeNot', 'pairBadgeDone', 'pairStop', 'pairRun', 'pairRestart', 'pairPrivacy', 'pairWhyRejected',
  'pairKeyLabel', 'pairKeyPlaceholder', 'pairShowKey', 'pairStore', 'pairLater', 'pairClose',
  'pairShape', 'pairUnavailable', 'pairFailed', 'pairDone'
]

/** Target kinds on the wire (contract `$defs/Target`) and their dictionary keys. */
const KIND_KEYS = Object.freeze({
  cid: 'kindCid',
  content_path: 'kindContentPath',
  mfs_path: 'kindMfsPath',
  key: 'kindKey',
  ipns_name: 'kindIpnsName',
  peer: 'kindPeer',
  repo: 'kindRepo',
  index: 'kindIndex',
  content: 'kindContent'
})

/**
 * @typedef {object} Translator
 * @property {(key: string, options?: Record<string, unknown>) => string} t
 * @property {(key: string) => boolean} exists
 */

/**
 * Strings that carry a number the page fills in each second (a count, a clock) are
 * resolved with their own placeholder, so the page substitutes it as plain text.
 *
 * @param {Translator} i18n
 * @param {number} armMs the arming delay, shown in seconds
 * @returns {Record<string, string>}
 */
function windowStrings ({ t }, armMs) {
  /** @type {Record<string, string>} */
  const out = {}
  const values = { count: '{count}', time: '{time}', seconds: String(armMs / 1000) }
  for (const id of STRING_IDS) out[id] = t(`agentConfirm.${id}`, values)
  return out
}

/**
 * The Approve button: the tool's own verb and object where the locale has one ("Remove
 * pin"), else "Approve" plus what the tool does.
 *
 * @param {Translator} i18n
 * @param {string} tool
 */
function approveLabel ({ t, exists }, tool) {
  const safe = /^[a-z0-9_]{1,60}$/.test(tool)
  if (safe && exists(`agentConfirm.button.${tool}`)) return t(`agentConfirm.button.${tool}`)
  const action = safe && exists(`agentConfirm.action.${tool}`) ? t(`agentConfirm.action.${tool}`) : tool.replace(/[_-]+/g, ' ').trim()
  return t('agentConfirm.approveGeneric', { tool: action })
}

/**
 * The sentence the Touch ID sheet shows: what is approved and what it touches.
 *
 * @param {Translator} i18n
 * @param {{ tool: string, targets: Array<{ value: string }> }} item
 */
function touchReason ({ t, exists }, item) {
  const safe = /^[a-z0-9_]{1,60}$/.test(item.tool)
  const action = safe && exists(`agentConfirm.action.${item.tool}`) ? t(`agentConfirm.action.${item.tool}`) : item.tool.replace(/[_-]+/g, ' ').trim()
  const first = item.targets[0]?.value
  if (!first) return t('agentConfirm.touchReasonNoTarget', { action })
  const short = Array.from(first).length > 48 ? `${Array.from(first).slice(0, 48).join('')}...` : first
  return t('agentConfirm.touchReason', { action, target: short })
}

module.exports = { windowStrings, approveLabel, touchReason, KIND_KEYS, STRING_IDS }
