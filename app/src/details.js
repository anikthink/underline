// Edit details (prototypes/edit-details.html): a panel beside the library, so you can fix one book after another.
// Changes save as you type; ⌘Z undoes. A pencil marks fields you've changed. The book's file is rewritten
// (and moved to Author/Title.epub if those changed) when the panel lets go of it: on close, or on J/K to another book.
const { invoke } = window.__TAURI__.core
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const FIELDS = [
  ['series', 'Series'], ['seriesIndex', 'Number'], ['published', 'Published'], ['publisher', 'Publisher'],
  ['language', 'Language'], ['isbn', 'ISBN'], ['shelves', 'Shelves'], ['description', 'Description'],
]
let H = {}, book = null, undo = [], saveTimer = null, burst = null

export function initDetails(hooks) {
  H = hooks
  document.querySelector('#library').insertAdjacentHTML('beforeend', '<aside id="details" class="dpanel" hidden></aside>')
  $('details').addEventListener('input', onInput)
  $('details').addEventListener('change', onChange)
  $('details').addEventListener('click', onClick)
}
export const detailsOpen = () => !$('details').hidden
export const detailsBook = () => book?.id

export async function openDetails(id) {
  if (book && book.id !== id) await letGo()
  book = await invoke('book_details', { id })
  undo = []
  $('details').hidden = false; $('library').classList.add('with-details')
  draw()
}

export async function closeDetails() {
  await letGo()
  book = null
  $('details').hidden = true; $('library').classList.remove('with-details')
}

// write the book's file once we're done with it
async function letGo() {
  if (!book) return
  clearTimeout(saveTimer); await save()
  if (book.details?.pending || pendingWrite) {
    pendingWrite = false
    try { await invoke('commit_details', { id: book.id }) } catch (e) { H.toast(`Couldn't update ${book.title}'s file: ${e}`) }
    await H.reload()
  }
}
let pendingWrite = false

const d = () => book.details
const mine = k => d().sources?.[k] === 'you'
const val = k => k === 'shelves' ? (d().shelves ?? []).join(', ') : d()[k] ?? ''

function draw() {
  const b = book, stars = [1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" class="${n <= (d().rating ?? 0) ? 'on' : ''}" title="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')
  $('details').innerHTML = `
    <div class="dp-head">
      <button class="dp-cover" data-act="cover" title="Choose a cover image">${b.cover ? `<img src="${H.coverSrc(b.cover)}" alt="">` : `<span>Choose a cover</span>`}</button>
      <div class="dp-main">
        <label class="dp-l">Title ${mine('title') ? '<i title="You changed this">✎</i>' : ''}</label>
        <textarea data-f="title" rows="2" spellcheck="false">${esc(b.title)}</textarea>
        <label class="dp-l">Authors ${mine('authors') ? '<i title="You changed this">✎</i>' : ''}</label>
        <input data-f="authors" value="${esc(b.authors.join(', '))}" spellcheck="false" placeholder="Separate several with commas">
      </div>
    </div>
    <div class="dp-row"><label class="dp-l">Status</label><select data-act="status">${['Not started', 'Reading', 'Finished'].map(s => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <span class="dp-stars" title="Rating">${stars}</span></div>
    <div class="dp-grid">${FIELDS.map(([k, n]) => `
      <div class="dp-f ${k === 'description' ? 'wide' : ''} ${k === 'seriesIndex' ? 'narrow' : ''}">
        <label class="dp-l">${n} ${mine(k) ? '<i title="You changed this">✎</i>' : ''}</label>
        ${k === 'description' ? `<textarea data-f="${k}" rows="6">${esc(val(k))}</textarea>` : `<input data-f="${k}" value="${esc(val(k))}" spellcheck="false" ${k === 'shelves' ? 'placeholder="Separate with commas"' : ''}>`}
      </div>`).join('')}</div>
    <div class="dp-foot">
      <span>${book.details?.pending ? 'The book’s file is updated when you close this or move to another book.' : 'Changes save as you type. ⌘Z undoes.'}</span>
      <span><kbd>J</kbd> <kbd>K</kbd> next and previous · <kbd>Esc</kbd> close</span>
      <span><button class="lnk" data-act="reveal">Show in Finder</button><button class="lnk" data-act="close">Done</button></span>
    </div>`
}

function snapshot() { return { title: book.title, authors: [...book.authors], details: structuredClone(book.details) } }

function onInput(e) {
  const k = e.target.dataset.f; if (!k) return
  // one undo step per burst of typing in a field
  if (burst !== k) { undo.push(snapshot()); burst = k }
  clearTimeout(burst_t); burst_t = setTimeout(() => burst = null, 1200)
  const v = e.target.value
  if (k === 'title') book.title = v
  else if (k === 'authors') book.authors = v.split(',').map(s => s.trim()).filter(Boolean)
  else if (k === 'shelves') d().shelves = v.split(',').map(s => s.trim()).filter(Boolean)
  else d()[k] = v
  d().sources = { ...(d().sources ?? {}), [k]: 'you' }
  d().pending = true
  e.target.closest('.dp-f, .dp-main')?.querySelectorAll('.dp-l').forEach(l => { if (!l.querySelector('i') && l.nextElementSibling === e.target) l.insertAdjacentHTML('beforeend', ' <i title="You changed this">✎</i>') })
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 400)
}
let burst_t

async function save() {
  if (!book) return
  await invoke('update_details', { id: book.id, title: book.title, authors: book.authors, details: book.details })
  H.changed(book)
}

async function onChange(e) {
  if (e.target.dataset.act === 'status') { await invoke('set_status', { id: book.id, status: e.target.value }); book.status = e.target.value; H.changed(book) }
}

async function onClick(e) {
  const r = e.target.closest('[data-rate]')
  if (r) { undo.push(snapshot()); d().rating = d().rating === +r.dataset.rate ? 0 : +r.dataset.rate; d().pending = d().pending; await save(); return draw() }
  const a = e.target.closest('[data-act]')?.dataset.act
  if (a === 'cover') {
    const f = await window.__TAURI__.dialog.open({ filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] })
    if (!f) return
    try { await invoke('set_cover', { id: book.id, path: f }); pendingWrite = true; book = await invoke('book_details', { id: book.id }); H.changed(book); draw() } catch (err) { H.toast(`That image couldn't be used: ${err}`) }
  }
  if (a === 'reveal') window.__TAURI__.opener.revealItemInDir(`${await invoke('library_folder')}/${book.file}`)
  if (a === 'close') closeDetails()
}

// keys while the panel is open: ⌘Z anywhere in it, J/K and Esc when not typing
export function detailsKey(e) {
  if (!detailsOpen()) return false
  const typing = e.target.closest?.('input, textarea, select')
  if (e.metaKey && e.key === 'z' && !e.shiftKey) {
    const prev = undo.pop(); if (!prev) return true
    Object.assign(book, { title: prev.title, authors: prev.authors, details: prev.details }); burst = null
    save(); draw(); e.preventDefault(); return true
  }
  if (e.key === 'Escape') { if (typing) e.target.blur(); else closeDetails(); e.preventDefault(); return true }
  if (typing) return false
  if (e.key === 'j' || e.key === 'k') {
    const order = H.order(), i = order.indexOf(book.id), next = order[i + (e.key === 'j' ? 1 : -1)]
    if (next != null) openDetails(next)
    e.preventDefault(); return true
  }
  return false
}
