// The library window: books grouped by status, adding books by dropping files or with Add books.
import { openReader, closeReader } from './reader.js'

const { invoke, convertFileSrc } = window.__TAURI__.core
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const STATUSES = ['Reading', 'Not started', 'Finished']
let books = [], filter = 'All books'

async function load() {
  books = await invoke('list_books')
  render()
}

function render() {
  const counts = Object.fromEntries(STATUSES.map(s => [s, books.filter(b => b.status === s).length]))
  $('filters').innerHTML = ['All books', ...STATUSES].map(f =>
    `<button class="fl ${f === filter ? 'on' : ''}" data-f="${f}"><span>${f}</span><span class="n">${f === 'All books' ? books.length : counts[f]}</span></button>`).join('')
  $('heading').textContent = filter
  if (!books.length) {
    $('shelf').innerHTML = `<div class="empty"><h2>No books yet</h2><p>Drop EPUB files anywhere in this window, or choose them. They're copied into your library folder; the originals stay where they are.</p><button class="btn pri" data-add>Add books…</button></div>`
    return
  }
  const groups = (filter === 'All books' ? STATUSES : [filter]).map(s => [s, books.filter(b => b.status === s)]).filter(([, l]) => l.length)
  $('shelf').innerHTML = groups.map(([s, list]) => `
    <div class="grp">${s}<span class="n">${list.length}</span></div>
    <div class="grid">${list.map(card).join('')}</div>`).join('')
}

const card = b => `
  <button class="bk" data-id="${b.id}" title="${esc(b.title)}">
    <div class="cv">${b.cover ? `<img src="${convertFileSrc(b.cover)}?v=${b.added}" alt="" loading="lazy">` : `<div class="ph">${esc(b.title)}<small>${esc(b.authors[0])}</small></div>`}
      ${b.fraction > 0 ? `<div class="pr" style="width:${Math.round(b.fraction * 100)}%"></div>` : ''}</div>
    <div class="t">${esc(b.title)}</div><div class="a">${esc(b.authors.join(', ') || 'Unknown author')}</div>
  </button>`

async function addPaths(paths) {
  const epubs = paths.filter(p => /\.epub$/i.test(p)), other = paths.length - epubs.length
  if (!epubs.length) return toast(other ? 'Only EPUB books can be added for now.' : '')
  toast(`Adding ${epubs.length} book${epubs.length > 1 ? 's' : ''}…`, 0)
  const res = await invoke('add_books', { paths: epubs })
  const added = res.filter(r => r.result === 'added'), there = res.filter(r => r.result === 'alreadyThere'), failed = res.filter(r => r.result === 'failed')
  const parts = []
  if (added.length) parts.push(added.length === 1 ? `Added ${added[0].book.title}` : `Added ${added.length} books`)
  if (there.length) parts.push(`${there.length === 1 ? there[0].title + ' is' : there.length + ' books are'} already in the library`)
  if (failed.length) parts.push(`couldn't read ${failed.map(f => f.file).join(', ')}`)
  if (other) parts.push(`skipped ${other} file${other > 1 ? 's' : ''} that aren't EPUB`)
  if (failed.length) console.warn(failed)
  toast(parts.join('; ') + '.')
  await load()
}

let toastTimer
function toast(text, ms = 4000) {
  clearTimeout(toastTimer)
  $('toast').hidden = !text; $('toast').textContent = text
  if (ms) toastTimer = setTimeout(() => $('toast').hidden = true, ms)
}

async function chooseFiles() {
  const picked = await window.__TAURI__.dialog.open({ multiple: true, filters: [{ name: 'EPUB books', extensions: ['epub'] }] })
  if (picked) addPaths([].concat(picked))
}

document.addEventListener('click', e => {
  const f = e.target.closest('[data-f]'); if (f) { filter = f.dataset.f; render() }
  if (e.target.closest('#add, [data-add]')) chooseFiles()
  const b = e.target.closest('.bk[data-id]'); if (b) open(+b.dataset.id)
})

async function open(id) {
  const book = books.find(b => b.id === id)
  $('library').hidden = true; $('reader').hidden = false
  try { await openReader(book) } catch (e) { console.error(e); toast(`Couldn't open ${book.title}: ${e}`); back() }
}
async function back() {
  await closeReader()
  $('reader').hidden = true; $('library').hidden = false
  load()
}
$('back').addEventListener('click', back)
window.addEventListener('nightstand:close-reader', back)

// files dragged onto the window
window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
  if ($('library').hidden) return
  if (payload.type === 'enter' || payload.type === 'over') $('drop').hidden = false
  else $('drop').hidden = true
  if (payload.type === 'drop') addPaths(payload.paths)
})

$('folder').textContent = (await invoke('library_folder')).replace(/^\/Users\/[^/]+/, '~')
load()
