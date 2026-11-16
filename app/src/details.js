// Edit details (prototypes/edit-details.html): a panel beside the library, so you can fix one book after another.
// Changes save as you type; ⌘Z undoes. A pencil marks fields you've changed. The book's file is rewritten
// (and moved to Author/Title.epub if those changed) when the panel lets go of it: on close, or on J/K to another book.
//
// Three views share the panel:
//   one     — one book's details
//   online  — Find details online: Open Library's details beside yours, taken a field at a time (src/online.js)
//   many    — several selected books edited together, applied with one button and undone with another
const { invoke } = window.__TAURI__.core
import { search, load, fieldsFrom, compare, editionLabel, coverUrl } from './online.js'
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const olGet = path => invoke('online_get', { path })

const FIELDS = [
  ['series', 'Series'], ['seriesIndex', 'Number'], ['published', 'Published'], ['publisher', 'Publisher'],
  ['language', 'Language'], ['isbn', 'ISBN'], ['shelves', 'Shelves'], ['description', 'Description'],
]
let H = {}, book = null, undo = [], saveTimer = null, burst = null, mode = 'one', ol = null, many = null

export function initDetails(hooks) {
  H = hooks
  document.querySelector('#library').insertAdjacentHTML('beforeend', '<aside id="details" class="dpanel" hidden></aside>')
  $('details').addEventListener('input', onInput)
  $('details').addEventListener('change', onChange)
  $('details').addEventListener('click', onClick)
  $('details').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.act === 'ol-query') { e.preventDefault(); olSearch(e.target.value) } })
}
export const detailsOpen = () => !$('details').hidden
export const detailsBook = () => book?.id
export const detailsMany = () => mode === 'many'

function show(m) {
  mode = m
  $('details').hidden = false
  $('library').classList.add('with-details'); $('library').classList.toggle('wide-details', m === 'online')
  $('details').scrollTop = 0
}

export async function openDetails(id) {
  if (mode === 'many') many = null
  if (book && book.id !== id) await letGo()
  book = await invoke('book_details', { id })
  undo = []; ol = null
  show('one'); draw()
}

export async function closeDetails() {
  await letGo()
  book = null; ol = null; many = null; mode = 'one'
  $('details').hidden = true; $('library').classList.remove('with-details', 'wide-details')
}

// write the book's file once we're done with it
async function letGo() {
  if (!book) return
  await coverDownload   // a cover still on its way from Open Library goes into the file too
  clearTimeout(saveTimer); await save()
  if (book.details?.pending || pendingWrite) {
    pendingWrite = false
    try { await invoke('commit_details', { id: book.id }) } catch (e) { H.toast(`Couldn't update ${book.title}'s file: ${e}`) }
    await H.reload()
  }
}
let pendingWrite = false, coverDownload = null

const d = () => book.details
const SRC = { you: '<i title="You changed this">✎</i>', openlibrary: '<i class="src" title="Taken from Open Library">Open Library</i>' }
const mark = k => SRC[d().sources?.[k]] ?? ''
const val = k => k === 'shelves' ? (d().shelves ?? []).join(', ') : d()[k] ?? ''
const stars = (r, mixed) => [1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" class="${n <= (r ?? 0) ? 'on' : ''}" title="${n} star${n > 1 ? 's' : ''}">★</button>`).join('') + (mixed ? '<small>mixed</small>' : '')

function draw() {
  if (mode === 'online') return drawOnline()
  if (mode === 'many') return drawMany()
  const b = book, linked = d().openLibrary?.work
  $('details').innerHTML = `
    <div class="dp-head">
      <button class="dp-cover" data-act="cover" title="Choose a cover image">${b.cover ? `<img src="${H.coverSrc(b.cover)}" alt="">` : `<span>Choose a cover</span>`}</button>
      <div class="dp-main">
        <label class="dp-l">Title ${mark('title')}</label>
        <textarea data-f="title" rows="2" spellcheck="false">${esc(b.title)}</textarea>
        <label class="dp-l">Authors ${mark('authors')}</label>
        <input data-f="authors" value="${esc(b.authors.join(', '))}" spellcheck="false" placeholder="Separate several with commas">
      </div>
    </div>
    <button class="btn dp-online" data-act="online" title="Compare with Open Library. Only the title, author and ISBN are sent.">${linked ? 'Refresh from Open Library' : 'Find details online'}…</button>
    <div class="dp-row"><label class="dp-l">Status</label><select data-act="status">${['Not started', 'Reading', 'Finished'].map(s => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <span class="dp-stars" title="Rating">${stars(d().rating)}</span></div>
    <div class="dp-grid">${FIELDS.map(([k, n]) => `
      <div class="dp-f ${k === 'description' ? 'wide' : ''} ${k === 'seriesIndex' ? 'narrow' : ''}">
        <label class="dp-l">${n} ${mark(k)}</label>
        ${k === 'description' ? `<textarea data-f="${k}" rows="6">${esc(val(k))}</textarea>` : `<input data-f="${k}" value="${esc(val(k))}" spellcheck="false" ${k === 'shelves' ? 'placeholder="Separate with commas"' : ''}>`}
      </div>`).join('')}</div>
    <div class="dp-foot">
      <span>${book.details?.pending ? 'The book’s file is updated when you close this or move to another book.' : 'Changes save as you type. ⌘Z undoes.'}</span>
      <span><kbd>J</kbd> <kbd>K</kbd> next and previous · <kbd>Esc</kbd> close · ⌘-click books to edit several together</span>
      <span><button class="lnk" data-act="reveal">Show in Finder</button><button class="lnk" data-act="close">Done</button></span>
    </div>`
}

function snapshot() { return { title: book.title, authors: [...book.authors], details: structuredClone(book.details) } }

// set one field, the same way typing does
function setField(k, v, source) {
  if (k === 'title') book.title = v
  else if (k === 'authors') book.authors = v.split(',').map(s => s.trim()).filter(Boolean)
  else if (k === 'shelves') d().shelves = v.split(',').map(s => s.trim()).filter(Boolean)
  else d()[k] = v
  d().sources = { ...(d().sources ?? {}), [k]: source }
  d().pending = true
}

function onInput(e) {
  if (mode === 'many') return manyInput(e)
  const k = e.target.dataset.f; if (!k || !book) return
  // one undo step per burst of typing in a field
  if (burst !== k) { undo.push(snapshot()); burst = k }
  clearTimeout(burst_t); burst_t = setTimeout(() => burst = null, 1200)
  setField(k, e.target.value, 'you')
  e.target.closest('.dp-f, .dp-main')?.querySelectorAll('.dp-l').forEach(l => { if (!l.querySelector('i') && l.nextElementSibling === e.target) l.insertAdjacentHTML('beforeend', ' ' + SRC.you) })
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 400)
}
let burst_t

async function save() {
  if (!book) return
  await invoke('update_details', { id: book.id, title: book.title, authors: book.authors, details: book.details })
  H.changed(book)
}

async function onChange(e) {
  const a = e.target.dataset.act
  if (a === 'status') { await invoke('set_status', { id: book.id, status: e.target.value }); book.status = e.target.value; H.changed(book) }
  if (a === 'ol-edition') { ol.edition = e.target.value; drawOnline() }
}

async function onClick(e) {
  if (mode === 'many') return manyClick(e)
  const r = e.target.closest('[data-rate]')
  if (r && mode === 'one') { undo.push(snapshot()); d().rating = d().rating === +r.dataset.rate ? 0 : +r.dataset.rate; await save(); return draw() }
  const take = e.target.closest('[data-take]')?.dataset.take
  if (take) return takeFields([take])
  const pick = e.target.closest('[data-work]')?.dataset.work
  if (pick) return olLoad(pick, ol.hits.find(h => h.key === pick)?.edition)
  const cov = e.target.closest('[data-olcover]')?.dataset.olcover
  if (cov) return takeCover(+cov)
  const a = e.target.closest('[data-act]')?.dataset.act
  if (a === 'cover') {
    const f = await window.__TAURI__.dialog.open({ filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] })
    if (!f) return
    try { await invoke('set_cover', { id: book.id, path: f }); await coverChanged() } catch (err) { H.toast(`That image couldn't be used: ${err}`) }
  }
  if (a === 'reveal') window.__TAURI__.opener.revealItemInDir(`${await invoke('library_folder')}/${book.file}`)
  if (a === 'close') closeDetails()
  if (a === 'online') openOnline()
  if (a === 'ol-back') { show('one'); draw() }
  if (a === 'ol-results') { ol.stage = 'search'; ol.hits?.length ? drawOnline() : olSearch() }
  if (a === 'ol-search') olSearch($('details').querySelector('[data-act="ol-query"]').value)
  if (a === 'ol-takeall') takeFields(ol.rows.filter(r => r.takeable).map(r => r.k))
}

async function coverChanged() {
  pendingWrite = true
  const keep = { title: book.title, authors: book.authors, details: { ...book.details } }
  book = await invoke('book_details', { id: book.id })
  // the cover is the only thing that changed on disk; keep any typing that hasn't saved yet
  Object.assign(book, keep, { details: { ...keep.details, newCover: true, pending: true } })
  H.changed(book); draw()
}

// ---------- Find details online ----------

async function openOnline() {
  clearTimeout(saveTimer); await save()
  ol = { stage: 'search', query: [book.title.split(':')[0], book.authors[0]].filter(Boolean).join(' '), hits: null, busy: true }
  show('online')
  const link = d().openLibrary
  if (link?.work) return olLoad(link.work, link.edition)
  olSearch()
}

async function olSearch(query) {
  Object.assign(ol, { stage: 'search', busy: true, error: null }); if (query != null) ol.query = query
  drawOnline()
  try {
    ol.hits = await search(olGet, query != null ? { query } : { title: book.title, authors: book.authors, isbn: d().isbn ?? '' })
  } catch (e) { ol.error = String(e) }
  ol.busy = false
  if (mode === 'online') drawOnline()
}

async function olLoad(key, prefer) {
  Object.assign(ol, { stage: 'compare', busy: true, error: null }); drawOnline()
  try {
    ol.work = await load(olGet, key, { prefer, language: d().language })
    ol.edition = ol.work.edition
  } catch (e) { ol.error = String(e); ol.stage = 'search' }
  ol.busy = false
  if (mode === 'online') drawOnline()
}

const yours = () => ({ ...d(), title: book.title, authors: book.authors.join(', ') })

function drawOnline() {
  const head = `<div class="ol-head"><button class="lnk" data-act="ol-back">‹ Details</button><b>Open Library</b><span class="ol-for">${esc(book.title)}</span></div>`
  const note = `<p class="ol-note">Looked up on openlibrary.org, a free catalogue anyone can edit. Nothing changes until you take it, and ⌘Z undoes.</p>`
  if (ol.error) {
    $('details').innerHTML = head + searchBox() + `<div class="ol-msg">${esc(ol.error)} <button class="lnk" data-act="ol-search">Try again</button></div>` + note
    return
  }
  if (ol.busy) {
    $('details').innerHTML = head + (ol.stage === 'search' ? searchBox() : '') + `<div class="ol-msg"><span class="spin"></span>${ol.stage === 'search' ? 'Searching Open Library…' : 'Getting its editions…'}</div>`
    return
  }
  if (ol.stage === 'search') {
    $('details').innerHTML = head + searchBox() + (ol.hits?.length ? `<div class="ol-hits">${ol.hits.map(h => `
      <button class="ol-hit" data-work="${esc(h.key)}">
        <span class="ol-th">${h.cover ? `<img src="${coverUrl(h.cover, 'S')}" alt="" loading="lazy">` : ''}</span>
        <span><b>${esc(h.title)}</b><small>${esc(h.authors.slice(0, 3).join(', ') || 'Unknown author')}${h.year ? ` · ${h.year}` : ''} · ${h.editions} edition${h.editions === 1 ? '' : 's'}${h.isbnMatch ? ' · <em>same ISBN as yours</em>' : ''}</small></span>
      </button>`).join('')}</div>` : `<div class="ol-msg">Open Library has nothing under that. Try fewer words, or just the title.</div>`) + note
    return
  }
  const w = ol.work, e = w.editions.find(x => x.key === ol.edition)
  ol.rows = compare(yours(), fieldsFrom(w, ol.edition))
  const diff = ol.rows.filter(r => r.takeable).length
  const cell = (r, side) => { const v = r[side]; return v ? `<div class="${r.k === 'description' ? 'clip' : ''}" title="${r.k === 'description' ? esc(v) : ''}">${esc(v)}</div>` : '<span class="none">—</span>' }
  $('details').innerHTML = head + `
    <div class="ol-work"><div><b>${esc(w.title)}</b> <span>by ${esc(w.authors.join(', ') || 'unknown')}${w.firstPublished ? ` · first published ${w.firstPublished}` : ''}</span></div>
      <button class="lnk" data-act="ol-results">Not this book?</button></div>
    <label class="dp-l">Edition <small>${w.editions.length} on Open Library, closest to yours first</small></label>
    <select data-act="ol-edition">${w.editions.slice(0, 80).map(x => `<option value="${esc(x.key)}" ${x.key === ol.edition ? 'selected' : ''}>${esc(editionLabel(x))}</option>`).join('')}</select>
    ${w.covers.length ? `<label class="dp-l">Covers <small>click one to use it</small></label>
    <div class="ol-covers">
      <span class="ol-cv yours" title="Your cover">${book.cover ? `<img src="${H.coverSrc(book.cover)}" alt="">` : '<i>none</i>'}<small>Yours</small></span>
      ${[...new Set([e?.cover, ...w.covers].filter(Boolean))].slice(0, 14).map(c => `<button class="ol-cv" data-olcover="${c}" title="Use this cover"><img src="${coverUrl(c, 'M')}" alt="" loading="lazy"></button>`).join('')}
    </div>` : ''}
    <table class="ol-cmp"><thead><tr><th></th><th>Yours</th><th>Open Library</th><th></th></tr></thead><tbody>
      ${ol.rows.map(r => `<tr class="${r.same ? 'same' : ''}"><th>${r.name}</th><td>${cell(r, 'yours')}</td><td>${cell(r, 'theirs')}</td>
        <td>${r.takeable ? `<button class="btn sm" data-take="${r.k}">Take</button>` : r.same && r.yours ? '<span class="ok" title="Same">✓</span>' : ''}</td></tr>`).join('')}
    </tbody></table>
    <div class="ol-actions">${diff ? `<button class="btn pri" data-act="ol-takeall">Take all ${diff} difference${diff > 1 ? 's' : ''}</button>` : '<span class="ol-msg">Everything Open Library has already matches yours.</span>'}
      <button class="lnk" data-act="ol-back">Done</button></div>` + note
}

const searchBox = () => `<div class="ol-search"><input data-act="ol-query" value="${esc(ol.query)}" spellcheck="false" placeholder="Title, author or ISBN"><button class="btn" data-act="ol-search">Search</button></div>`

async function takeFields(keys) {
  if (!keys.length) return
  undo.push(snapshot()); burst = null
  for (const k of keys) setField(k, ol.rows.find(r => r.k === k).theirs, 'openlibrary')
  d().openLibrary = { work: ol.work.key, edition: ol.edition }
  await save(); drawOnline()
}

function takeCover(id) {
  coverDownload = downloadCover(id).finally(() => coverDownload = null)
  return coverDownload
}
async function downloadCover(id) {
  const btn = $('details').querySelector(`[data-olcover="${id}"]`); btn?.classList.add('busy')
  try {
    await invoke('online_cover', { id: book.id, coverId: id })
    d().openLibrary = { work: ol.work.key, edition: ol.edition }
    await coverChanged()
    H.toast('Cover changed. It goes into the book’s file when you close the panel.')
  } catch (e) { btn?.classList.remove('busy'); H.toast(String(e)) }
}

// ---------- Several books together ----------

const BULK = [['authors', 'Authors'], ['series', 'Series'], ['publisher', 'Publisher'], ['language', 'Language'], ['published', 'Published']]

export async function openMany(ids) {
  if (book) await letGo()
  book = null; ol = null
  const books = await Promise.all(ids.map(id => invoke('book_details', { id })))
  many = { books, set: {}, addShelves: '', removeShelves: '', number: false, applied: null, busy: null }
  show('many'); draw()
}

// a field's value if every book has the same one, or null when they differ
function common(k) {
  const vs = many.books.map(b => k === 'authors' ? b.authors.join(', ') : k === 'status' ? b.status : b.details?.[k] ?? '')
  return vs.every(v => String(v) === String(vs[0])) ? vs[0] : null
}

function drawMany() {
  const m = many, n = m.books.length, touched = Object.keys(m.set).length || m.addShelves.trim() || m.removeShelves.trim() || m.number
  if (m.applied) {
    $('details').innerHTML = `<div class="mb-done"><h3>Updated ${m.applied.length} book${m.applied.length > 1 ? 's' : ''}</h3>
      <p>Their files have the new details too.</p>
      <div class="ol-actions"><button class="btn" data-act="m-undo">Undo</button><button class="lnk" data-act="m-close">Done</button></div></div>`
    return
  }
  if (m.busy) { $('details').innerHTML = `<div class="ol-msg"><span class="spin"></span>${esc(m.busy)}</div>`; return }
  const input = (k, label) => {
    const c = common(k), v = m.set[k] ?? (c ?? '')
    return `<div class="dp-f"><label class="dp-l">${label} ${k in m.set ? SRC.you : ''}</label><input data-m="${k}" value="${esc(v)}" placeholder="${c == null ? 'Mixed. Leave it to keep each book’s own' : ''}" spellcheck="false"></div>`
  }
  const cs = common('status'), rating = m.set.rating ?? common('rating')
  const allShelves = [...new Set(m.books.flatMap(b => b.details?.shelves ?? []))]
  $('details').innerHTML = `
    <div class="mb-head"><div class="mb-covers">${m.books.slice(0, 5).map(b => b.cover ? `<img src="${H.coverSrc(b.cover)}" alt="">` : '<span></span>').join('')}</div>
      <div><h3>${n} books</h3><small>${esc(m.books.slice(0, 3).map(b => b.title).join(', '))}${n > 3 ? ` and ${n - 3} more` : ''}</small></div></div>
    <div class="dp-row"><label class="dp-l">Status</label><select data-m="status"><option value="" ${!(m.set.status ?? cs) ? 'selected' : ''}>${cs ? '' : 'Mixed'}</option>${['Not started', 'Reading', 'Finished'].map(s => `<option ${(m.set.status ?? cs) === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <span class="dp-stars" title="Rating">${stars(rating, rating == null)}</span></div>
    ${input('authors', 'Authors')}
    <div class="dp-grid">${input('series', 'Series')}
      <div class="dp-f"><label class="dp-l">Number</label><label class="mb-check"><input type="checkbox" data-m="number" ${m.number ? 'checked' : ''}> 1, 2, 3… in the order shown</label></div>
      ${input('publisher', 'Publisher')}${input('language', 'Language')}${input('published', 'Published')}</div>
    <div class="dp-grid">
      <div class="dp-f"><label class="dp-l">Add to shelves</label><input data-m="addShelves" value="${esc(m.addShelves)}" placeholder="Separate with commas" spellcheck="false"></div>
      <div class="dp-f"><label class="dp-l">Take off shelves</label><input data-m="removeShelves" value="${esc(m.removeShelves)}" placeholder="${esc(allShelves.slice(0, 3).join(', '))}" spellcheck="false"></div>
    </div>
    <div class="ol-actions"><button class="btn pri" data-act="m-apply" ${touched ? '' : 'disabled'}>Apply to ${n} books</button><button class="lnk" data-act="m-close">${touched ? 'Cancel' : 'Done'}</button></div>
    <div class="dp-foot"><span>Only the fields you change are applied. The rest stay as each book has them.</span><span><kbd>Esc</kbd><span class="esc"> ${touched ? 'cancel' : 'close'}</span> · click a book on its own to edit just that one</span></div>`
}

function manyInput(e) {
  const k = e.target.dataset.m; if (!k || !many) return
  if (k === 'number') many.number = e.target.checked
  else if (k === 'addShelves' || k === 'removeShelves') many[k] = e.target.value
  else if (k === 'status') { if (e.target.value) many.set.status = e.target.value; else delete many.set.status }
  else many.set[k] = e.target.value
  if (k === 'number' || k === 'status') return drawMany()
  // while typing, keep the cursor where it is: only the pencil and the buttons change
  const l = e.target.previousElementSibling
  if (l?.classList.contains('dp-l') && !l.querySelector('i') && k in many.set) l.insertAdjacentHTML('beforeend', ' ' + SRC.you)
  const touched = Object.keys(many.set).length || many.addShelves.trim() || many.removeShelves.trim() || many.number
  $('details').querySelector('[data-act="m-apply"]').disabled = !touched
  $('details').querySelector('[data-act="m-close"]').textContent = touched ? 'Cancel' : 'Done'
  $('details').querySelector('.dp-foot .esc')?.replaceWith(Object.assign(document.createElement('span'), { className: 'esc', textContent: touched ? ' cancel' : ' close' }))
}

async function manyClick(e) {
  const r = e.target.closest('[data-rate]')
  if (r) { many.set.rating = many.set.rating === +r.dataset.rate ? 0 : +r.dataset.rate; return drawMany() }
  const a = e.target.closest('[data-act]')?.dataset.act
  if (a === 'm-apply') applyMany()
  if (a === 'm-undo') undoMany()
  if (a === 'm-close') { closeDetails(); H.clearSelection?.() }
}

async function applyMany() {
  const m = many, order = H.order(), list = [...m.books].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  const split = s => s.split(',').map(x => x.trim()).filter(Boolean)
  const add = split(m.addShelves), remove = split(m.removeShelves).map(s => s.toLowerCase())
  const before = list.map(b => ({ id: b.id, title: b.title, authors: [...b.authors], details: structuredClone(b.details), status: b.status }))
  let i = 0
  for (const [n, b] of list.entries()) {
    m.busy = `Updating ${++i} of ${list.length}: ${b.title}`; drawMany()
    const dd = structuredClone(b.details), src = { ...(dd.sources ?? {}) }
    let authors = b.authors
    for (const [k, v] of Object.entries(m.set)) {
      if (k === 'status') continue
      if (k === 'authors') authors = split(v)
      else if (k === 'rating') dd.rating = v
      else dd[k] = v
      if (k !== 'rating') src[k] = 'you'
    }
    if (m.number) { dd.seriesIndex = String(n + 1); src.seriesIndex = 'you' }
    if (add.length || remove.length) {
      const sh = (dd.shelves ?? []).filter(s => !remove.includes(s.toLowerCase()))
      dd.shelves = [...sh, ...add.filter(a => !sh.some(s => s.toLowerCase() === a.toLowerCase()))]
    }
    dd.sources = src
    try {
      await invoke('update_details', { id: b.id, title: b.title, authors, details: dd })
      if (m.set.status && m.set.status !== b.status) await invoke('set_status', { id: b.id, status: m.set.status })
      await invoke('commit_details', { id: b.id })
    } catch (err) { H.toast(`Couldn't update ${b.title}: ${err}`) }
  }
  m.busy = null; m.applied = before
  await H.reload(); drawMany()
}

async function undoMany() {
  const m = many, list = m.applied
  let i = 0
  for (const b of list) {
    m.busy = `Putting back ${++i} of ${list.length}`; m.applied = null; drawMany()
    try {
      await invoke('update_details', { id: b.id, title: b.title, authors: b.authors, details: b.details })
      await invoke('set_status', { id: b.id, status: b.status })
      await invoke('commit_details', { id: b.id })
    } catch (err) { H.toast(`Couldn't put back ${b.title}: ${err}`) }
  }
  m.busy = null
  await H.reload()
  many.books = await Promise.all(list.map(b => invoke('book_details', { id: b.id })))
  many.set = {}; many.addShelves = many.removeShelves = ''; many.number = false
  H.toast(`Put back ${list.length} book${list.length > 1 ? 's' : ''} as they were.`)
  drawMany()
}

// keys while the panel is open: ⌘Z anywhere in it, J/K and Esc when not typing
export function detailsKey(e) {
  if (!detailsOpen()) return false
  const typing = e.target.closest?.('input, textarea, select')
  if (mode === 'many') {
    if (e.key === 'Escape') { if (typing) e.target.blur(); else { closeDetails(); H.clearSelection?.() } e.preventDefault(); return true }
    return false
  }
  if (e.metaKey && e.key === 'z' && !e.shiftKey) {
    const prev = undo.pop(); if (!prev) return true
    Object.assign(book, { title: prev.title, authors: prev.authors, details: prev.details }); burst = null
    save(); draw(); e.preventDefault(); return true
  }
  if (e.key === 'Escape') {
    if (typing) e.target.blur()
    else if (mode === 'online') { show('one'); draw() }
    else closeDetails()
    e.preventDefault(); return true
  }
  if (typing || mode === 'online') return false
  if (e.key === 'j' || e.key === 'k') {
    const order = H.order(), i = order.indexOf(book.id), next = order[i + (e.key === 'j' ? 1 : -1)]
    if (next != null) openDetails(next)
    e.preventDefault(); return true
  }
  return false
}
