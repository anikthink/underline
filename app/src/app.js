// The library window: books grouped by status, adding books by dropping files or with Add books.
import { openReader, closeReader, reader } from './reader.js'
import { initNotes, loadNotes, notesCount, renderNotes, notesTools, notesKey, revisitCard, allNotes, focusNote, focusBook } from './notes.js'
import { initPalette, openPalette, paletteOpen } from './palette.js'
import { loadSettings, setting } from './store.js'
import { initDevices, deviceSidebar, deviceFilter, deviceTools, renderDevice, connected } from './devices.js'

const { invoke, convertFileSrc } = window.__TAURI__.core
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const STATUSES = ['Reading', 'Not started', 'Finished']
let books = [], filter = 'All books'

async function load() {
  [books] = await Promise.all([invoke('list_books'), loadNotes()])
  render()
}

function render() {
  const counts = Object.fromEntries(STATUSES.map(s => [s, books.filter(b => b.status === s).length]))
  $('filters').innerHTML = ['All books', ...STATUSES].map(f =>
    `<button class="fl ${f === filter ? 'on' : ''}" data-f="${f}"><span>${f}</span><span class="n">${f === 'All books' ? books.length : counts[f]}</span></button>`).join('')
    + `<div class="fsep"></div><button class="fl ${filter === 'Notes' ? 'on' : ''}" data-f="Notes"><span>Notes</span><span class="n">${notesCount()}</span></button>`
    + deviceSidebar(filter)
  const dev = deviceFilter(filter), device = dev && connected().find(d => d.id === dev)
  $('heading').textContent = device ? device.name : filter
  const notes = filter === 'Notes', view = notes ? 'notes' : dev ? 'device:' + dev : 'books'
  if ($('tools').dataset.view !== view) {
    $('tools').dataset.view = view
    $('tools').innerHTML = notes ? notesTools() : dev ? deviceTools(dev) : '<button id="add" class="btn">Add books…</button>'
  }
  if (notes) return renderNotes()
  if (dev) return renderDevice(dev)
  if (!books.length) {
    $('shelf').innerHTML = `<div class="empty"><h2>No books yet</h2><p>Drop EPUB files anywhere in this window, or choose them. They're copied into your library folder; the originals stay where they are.</p><button class="btn pri" data-add>Add books…</button></div>`
    return
  }
  const groups = (filter === 'All books' ? STATUSES : [filter]).map(s => [s, books.filter(b => b.status === s)]).filter(([, l]) => l.length)
  if (!groups.length) {
    // an empty view offers the next step and a passage from your underlines (prototypes/notes.html, frame 05)
    const next = filter === 'Reading' ? 'Nothing in progress. Pick something from Not started.' : filter === 'Finished' ? 'No finished books yet.' : 'Nothing here yet.'
    $('shelf').innerHTML = `<div class="empty"><h2>${next}</h2>${revisitCard(true)}</div>`
    return
  }
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

async function open(id, target) {
  const book = books.find(b => b.id === id)
  $('library').hidden = true; $('reader').hidden = false
  try { await openReader(book, target) } catch (e) { console.error(e); toast(`Couldn't open ${book.title}: ${e}`); back() }
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

initNotes({ open, toast, render })

function go(place) { if (!$('reader').hidden) back(); filter = place; render() }
initPalette({
  books: () => books, notes: allNotes, readerBook: reader.book, view: reader.view,
  openBook: (id, underline) => open(id, underline), closeReader: back, reader: reader.command, goToText: reader.goToText,
  go, addBooks: chooseFiles, settings: () => invoke('open_settings'),
  exportNotes: () => { go('Notes'); setTimeout(() => document.querySelector('[data-export="folder"]')?.click(), 50) },
  notesAt: id => { go('Notes'); focusNote(id); render() },
  notesFor: id => { go('Notes'); focusBook(id); render() },
  setStatus: async (id, status) => { await invoke('set_status', { id, status }); await load(); toast(`Marked ${books.find(b => b.id === id)?.title} as ${status}.`) },
  reveal: async id => { const b = books.find(b => b.id === id); window.__TAURI__.opener.revealItemInDir(`${await invoke('library_folder')}/${b.file}`) },
})

// app-wide keys: ⌘K, ⌘, and ⌘O anywhere; G then A, R, N, F or U in the library
let gArmed = 0
function shortcut(k) {
  if (k === 'k') paletteOpen() ? null : openPalette()
  if (k === ',') invoke('open_settings')
  if (k === 'o' && !$('library').hidden) chooseFiles()
}
window.addEventListener('nightstand:shortcut', e => shortcut(e.detail))
document.addEventListener('keydown', e => {
  if (paletteOpen()) return
  if (e.metaKey && ['k', ',', 'o'].includes(e.key)) { shortcut(e.key); return e.preventDefault() }
  if ($('library').hidden || e.target.closest?.('input, textarea, .sheet')) return
  if (!e.metaKey && !e.ctrlKey && Date.now() - gArmed < 1200) {
    const place = { a: 'All books', r: 'Reading', n: 'Not started', f: 'Finished', u: 'Notes' }[e.key.toLowerCase()]
    gArmed = 0
    if (place) { go(place); return e.preventDefault() }
  }
  if (e.key === 'g' && !e.metaKey) { gArmed = Date.now(); return }
  if (filter === 'Notes') notesKey(e)
})

await loadSettings()
$('folder').textContent = (await invoke('library_folder')).replace(/^\/Users\/[^/]+/, '~')
await load()
initDevices({ filter: () => filter, go, render, books: () => books, toast, reload: load })
if (setting('open_at') === 'book') { const last = books.filter(b => b.lastOpened).sort((a, b) => b.lastOpened - a.lastOpened)[0]; if (last) open(last.id) }
