// @ts-nocheck
/* global pairApi */
// Renderer of the pairing window. It holds no user-facing text of its own: every string
// arrives from the main process (i18next). The typed key goes to the main process and
// nowhere else; the page keeps no copy once the field is cleared.
'use strict'

const $ = (id) => document.getElementById(id)
const form = $('form')
const key = $('key')
const show = $('show')
const notice = $('notice')
const badge = $('badge')
const store = $('store')
const later = $('later')
const why = $('why')

let S = {}
let paired = false

function setBadge () {
  badge.dataset.tone = paired ? 'ok' : 'warn'
  badge.textContent = paired ? S.pairBadgeDone : S.pairBadgeNot
}

pairApi.onStrings(({ strings, reason }) => {
  S = strings
  document.title = S.pairWindowTitle
  for (const node of document.querySelectorAll('[data-s]')) node.textContent = S[node.dataset.s] || ''
  key.placeholder = S.pairKeyPlaceholder
  later.textContent = paired ? S.pairClose : S.pairLater
  why.hidden = reason !== 'rejected'
  why.textContent = reason === 'rejected' ? S.pairWhyRejected : ''
  setBadge()
})

function say (tone, text) {
  notice.textContent = text
  if (tone) notice.dataset.tone = tone
  else notice.removeAttribute('data-tone')
}

show.addEventListener('change', () => {
  key.type = show.checked ? 'text' : 'password'
})

const MESSAGES = { shape: 'pairShape', unavailable: 'pairUnavailable', failed: 'pairFailed' }

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!event.isTrusted) return
  store.disabled = true
  say(null, '')
  let result
  try {
    result = await pairApi.submit(key.value)
  } catch (_) {
    result = { ok: false, reason: 'failed' }
  }
  store.disabled = false
  if (result && result.ok) {
    key.value = ''
    paired = true
    setBadge()
    say(null, S.pairDone)
    store.hidden = true
    $('off').hidden = true
    later.textContent = S.pairClose
    // Focus moves to the way out, so the next key press does not land in an empty field.
    later.focus()
    return
  }
  say('err', S[MESSAGES[(result && result.reason) || 'failed']] || S.pairFailed)
  key.focus()
})

later.addEventListener('click', (e) => { if (e.isTrusted) pairApi.dismiss() })
$('off').addEventListener('click', (e) => { if (e.isTrusted) pairApi.turnOff() })
key.focus()
