// @ts-nocheck
/* global confirmApi */
// Renderer of the confirmation window. It holds no user-facing text of its own: every
// string arrives from the main process (i18next). Everything the server or an agent wrote
// reaches the page through textContent, never as markup. Initial focus is Deny. Approve is
// off until the main process says it is armed, answers only to a trusted activation, and
// there is no keyboard shortcut for it. Escape denies.
'use strict'

const $ = (id) => document.getElementById(id)
const el = {
  badge: $('badge'),
  queue: $('queue'),
  expiry: $('expiry'),
  title: $('title'),
  request: $('request'),
  summary: $('summary'),
  summaryCut: $('summary-cut'),
  tool: $('tool'),
  cls: $('class'),
  principal: $('principal'),
  targetBlock: $('target-block'),
  targets: $('targets'),
  arm: $('arm'),
  notice: $('notice'),
  actions: $('actions'),
  hint: $('hint'),
  announce: $('announce'),
  deny: $('deny'),
  approve: $('approve'),
  off: $('off')
}

const KIND_KEYS = { cid: 'kindCid', content_path: 'kindContentPath', mfs_path: 'kindMfsPath', key: 'kindKey', ipns_name: 'kindIpnsName', peer: 'kindPeer', repo: 'kindRepo', index: 'kindIndex', content: 'kindContent' }
const ARM_KEYS = { unfocused: 'armUnfocused', waiting: 'armWaiting', changed: 'armChanged', blur: 'armBlur', ready: 'armReady' }
const RESULT = {
  approved: ['ok', 'badgeApproved', 'resultApproved'],
  denied: ['err', 'badgeDenied', 'resultDenied'],
  expired: ['err', 'badgeExpired', 'resultExpired'],
  gone: ['err', 'badgeGone', 'resultGone'],
  rejected: ['err', 'badgeRejected', 'resultRejected'],
  untrusted: ['err', 'badgeUntrusted', 'resultUntrusted']
}
const ERROR_KEYS = { unreachable: 'errUnreachable', 'touch-id': 'errTouchId', 'no-touch-id': 'errNoTouchId' }

let S = {}
let current = null
let arm = { armed: false, reason: 'unfocused' }
let busy = false
let timer = null

const fmt = (text, vars) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))

function applyStrings (strings) {
  S = strings
  document.title = S.windowTitle
  for (const node of document.querySelectorAll('[data-s]')) node.textContent = S[node.dataset.s] || ''
  el.request.setAttribute('aria-label', S.windowTitle)
  el.actions.setAttribute('aria-label', S.deny)
  if (current) render()
}

function clock (ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function tick () {
  if (!current) return
  const left = current.expiresAt - Date.now()
  el.expiry.textContent = left > 0 ? fmt(S.expiresIn, { time: clock(left) }) : S.expired
}

function setBadge (tone, text) {
  el.badge.dataset.tone = tone
  el.badge.textContent = text
}

function say (text) {
  // A live region only speaks when its text changes.
  el.announce.textContent = ''
  el.announce.textContent = text
}

function renderArm () {
  if (!current || !current.canApprove) {
    el.arm.hidden = true
    return
  }
  el.arm.hidden = false
  el.arm.textContent = S[ARM_KEYS[arm.reason]] || ''
  el.approve.disabled = busy || !arm.armed
}

function render () {
  const v = current
  const destructive = v.cls === 'destructive'
  el.request.hidden = false
  el.actions.hidden = false
  el.hint.hidden = false

  if (v.approveBlocked === 'native') {
    setBadge('warn', S.badgeNative)
    el.title.textContent = S.titleNative
  } else {
    setBadge('warn', busy ? S.badgeBusy : S.badgePending)
    el.title.textContent = destructive ? S.titleDestructive : S.titleWrite
  }
  el.summary.textContent = v.summary
  el.summaryCut.hidden = !v.summaryTruncated
  el.summaryCut.textContent = S.truncated
  el.tool.textContent = v.tool || ''
  el.cls.textContent = v.cls === 'write' ? S.classWrite : destructive ? S.classDestructive : (v.cls || S.classUnknown)
  el.principal.textContent = v.principalKind || ''
  el.queue.textContent = v.total > 1 ? fmt(S.queue, { count: v.total }) : ''

  el.targets.replaceChildren()
  for (const target of v.targets) {
    const li = document.createElement('li')
    const kind = document.createElement('span')
    kind.className = 'label'
    kind.textContent = S[KIND_KEYS[target.kind]] || S.kindContent
    const code = document.createElement('code')
    code.className = 'target'
    code.textContent = target.value
    li.append(kind, code)
    if (target.truncated) {
      const cut = document.createElement('span')
      cut.className = 'label'
      cut.textContent = S.truncated
      li.append(cut)
    }
    el.targets.append(li)
  }
  el.targetBlock.hidden = v.targets.length === 0

  // The button names the object, in the brand's verb-plus-object form. A request this
  // surface cannot approve gets no Approve control at all.
  el.approve.textContent = v.approveLabel
  el.approve.hidden = !v.canApprove
  el.hint.textContent = v.approveBlocked === 'native' ? S.hintNative : v.approveBlocked === 'no-touch-id' ? S.hintNoTouchId : ''
  el.hint.hidden = el.hint.textContent === ''
  renderArm()
  tick()
}

function show (view) {
  const changed = !current || current.ref !== view.ref
  current = view
  busy = false
  el.deny.disabled = false
  el.notice.textContent = ''
  el.notice.removeAttribute('data-tone')
  render()
  if (timer === null) timer = setInterval(tick, 1000)
  if (changed) {
    el.deny.focus()
    say(el.title.textContent)
  }
}

function showResult ({ kind }) {
  const [tone, badge, text] = RESULT[kind] || RESULT.gone
  setBadge(tone, S[badge])
  el.title.textContent = S[text]
  el.request.hidden = true
  el.actions.hidden = true
  el.arm.hidden = true
  el.hint.hidden = true
  el.expiry.textContent = ''
  el.queue.textContent = ''
  el.notice.textContent = ''
  current = null
  busy = false
  // Focus follows the news: the result heading, which the screen reader reads.
  el.title.focus()
  say(S[text])
}

function showError ({ kind }) {
  if (kind === 'busy') {
    busy = true
    setBadge('warn', S.badgeBusy)
    el.notice.removeAttribute('data-tone')
    el.notice.textContent = S.touchBusy
    el.deny.disabled = true
    el.approve.disabled = true
    return
  }
  busy = false
  el.deny.disabled = false
  if (current) setBadge('warn', S.badgePending)
  el.notice.dataset.tone = 'err'
  el.notice.textContent = S[ERROR_KEYS[kind]] || S.errUnreachable
  renderArm()
  el.deny.focus()
}

function answer (approve, event) {
  // A synthetic click (page script, an injected event) is not a person.
  if (!event.isTrusted || !current || busy) return
  if (approve && (!current.canApprove || !arm.armed)) return
  if (!approve) { busy = true; el.deny.disabled = true; el.approve.disabled = true }
  confirmApi.decide(current.ref, approve)
}

el.deny.addEventListener('click', (e) => answer(false, e))
el.approve.addEventListener('click', (e) => answer(true, e))
el.off.addEventListener('click', (e) => { if (e.isTrusted) confirmApi.turnOff() })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    answer(false, event)
  }
})

confirmApi.onStrings(({ strings }) => applyStrings(strings))
confirmApi.onShow(show)
confirmApi.onArm((state) => { arm = state; if (current) renderArm() })
confirmApi.onResult(showResult)
confirmApi.onError(showError)
