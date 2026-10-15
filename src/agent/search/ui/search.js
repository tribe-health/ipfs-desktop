// @ts-nocheck
/* global searchApi */
// Renderer of the Search settings window. It holds no user-facing text of its own: every
// string arrives from the main process (i18next), and what it shows is the view the main
// process built (src/agent/search/view.js). Values go to the main process and nowhere else.
'use strict'

const $ = (id) => document.getElementById(id)
const form = $('form')
const notice = $('notice')
const badge = $('badge')
const save = $('save')

let S = {}

// The form fields the main process can name in a refusal, by the id of their input.
const FIELD_INPUT = {
  surrealBinary: 'surreal',
  xbergBinary: 'xberg',
  embedderUrl: 'embedder-url',
  embedderModel: 'embedder-model',
  embedderDimensions: 'embedder-dims',
  describerUrl: 'describer-url',
  describerModel: 'describer-model'
}
const WARNING_IDS = ['embedderRemote', 'describerRemote', 'videoHosted']
const PREVIEW_DELAY_MS = 250
const BADGE_TONE = { on: 'ok', off: 'warn', pending: 'warn', unavailable: 'err' }

function clearInvalid () {
  for (const id of Object.values(FIELD_INPUT)) $(id).removeAttribute('aria-invalid')
}

// Tie a refusal to its field: mark it invalid (the notice describes it) and move focus there.
function markInvalid (field) {
  const input = FIELD_INPUT[field] && $(FIELD_INPUT[field])
  if (!input) return
  input.setAttribute('aria-invalid', 'true')
  input.focus()
}

function showWarnings (warnings) {
  for (const id of WARNING_IDS) {
    const node = $('warn-' + id)
    const found = warnings.find((w) => w.id === id)
    node.hidden = !found
    node.textContent = found ? found.text : ''
  }
}

// The notice sits above the notes by default. A refusal that names a field puts it right under
// that field, so at a narrow width the words and the marked field are on screen together.
const NOTICE_HOME = $('notes')
function placeNotice (field) {
  const input = FIELD_INPUT[field] && $(FIELD_INPUT[field])
  const holder = input && input.closest('.field')
  if (holder) holder.after(notice)
  else NOTICE_HOME.before(notice)
}

function say (tone, text, field) {
  placeNotice(field)
  notice.textContent = text
  if (tone) notice.dataset.tone = tone
  else notice.removeAttribute('data-tone')
}

function render (view) {
  $('enabled').checked = view.enabled
  form.dataset.off = String(!view.enabled)
  $('surreal').value = view.fields.surrealBinary
  $('xberg').value = view.fields.xbergBinary
  $('embedder-url').value = view.fields.embedderUrl
  $('embedder-model').value = view.fields.embedderModel
  $('embedder-dims').value = view.fields.embedderDimensions
  $('describer-url').value = view.fields.describerUrl
  $('describer-model').value = view.fields.describerModel
  badge.textContent = view.status.message
  // Waiting (pending) and off are not faults: warn tone with their words. Only a reason the
  // endpoint gave (unavailable) is an error.
  badge.dataset.tone = BADGE_TONE[view.status.state] || 'err'
  showWarnings(view.warnings)
  $('off-hint').hidden = view.enabled
  const notes = $('notes')
  notes.replaceChildren(...view.notes.map((n) => {
    const li = document.createElement('li')
    li.textContent = n.text
    return li
  }))
  if (view.bulkPaused) say(null, S.bulkPaused)
}

function read () {
  return {
    enabled: $('enabled').checked,
    surrealBinary: $('surreal').value.trim(),
    xbergBinary: $('xberg').value.trim(),
    embedder: { baseUrl: $('embedder-url').value.trim(), model: $('embedder-model').value.trim(), dimensions: $('embedder-dims').value.trim() },
    describer: { baseUrl: $('describer-url').value.trim(), model: $('describer-model').value.trim() }
  }
}

searchApi.onStrings(async ({ strings }) => {
  S = strings
  document.title = S.windowTitle
  for (const node of document.querySelectorAll('[data-s]')) node.textContent = S[node.dataset.s] || ''
  $('surreal').placeholder = S.pathPlaceholder
  $('xberg').placeholder = S.pathPlaceholder
  $('embedder-url').placeholder = S.embedderUrlPlaceholder
  render(await searchApi.get())
  $('title').focus()
})

async function pick (which, target) {
  const chosen = await searchApi.pick(which)
  if (typeof chosen === 'string' && chosen !== '') target.value = chosen
  target.focus()
}
$('pick-surreal').addEventListener('click', (e) => { if (e.isTrusted) pick('surreal', $('surreal')) })
$('pick-xberg').addEventListener('click', (e) => { if (e.isTrusted) pick('xberg', $('xberg')) })
$('enabled').addEventListener('change', () => {
  form.dataset.off = String(!$('enabled').checked)
  $('off-hint').hidden = $('enabled').checked
})

// A warning appears as the address is typed, not only after Save: the main process says which
// warnings the typed values earn (it owns the wording and the loopback check). Only the
// latest request is shown, and nothing is stored.
let previewTimer = 0
let previewSeq = 0
function schedulePreview () {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(async () => {
    const seq = ++previewSeq
    let warnings = []
    try { warnings = await searchApi.preview(read()) } catch (_) {}
    if (seq === previewSeq && Array.isArray(warnings)) showWarnings(warnings)
  }, PREVIEW_DELAY_MS)
}
for (const id of ['embedder-url', 'describer-url']) $(id).addEventListener('input', schedulePreview)
for (const id of Object.values(FIELD_INPUT)) $(id).addEventListener('input', () => $(id).removeAttribute('aria-invalid'))

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!event.isTrusted) return
  save.disabled = true
  clearInvalid()
  say(null, '')
  let result
  try {
    result = await searchApi.apply(read())
  } catch (_) {
    result = { ok: false, message: S.errFailed }
  }
  save.disabled = false
  if (result && result.ok) {
    render(result.view)
    say('ok', result.restarted ? S.saved : S.savedNoRestart)
    if (result.view.bulkPaused) say('ok', S.saved + ' ' + S.bulkPaused)
    return
  }
  say('err', (result && result.message) || S.errFailed, result && result.field)
  if (result && typeof result.field === 'string') markInvalid(result.field)
})

$('close').addEventListener('click', (e) => { if (e.isTrusted) searchApi.close() })
