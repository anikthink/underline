// ⌘K: one box for books, underlines and commands (prototypes/search.html).
// What shows first depends on where you are. In the Reader the open book is the scope and its text is
// searched; elsewhere titles, authors, underlines and notes are, but not the text inside books.
import { LABELS } from './reader.js'

const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const words = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []
// every typed word must begin a word in the text, in any order, so "pri" never finds "surprise"
const hits = (q, text) => { const hay = words(text); return q.every(w => hay.some(h => h.startsWith(w))) }
function mark(text, q) {
  if (!q.length) return esc(text)
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${q.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  return esc(text).replace(re, '<mark>$1</mark>')
}

let H = {}            // hooks from app.js
let lastSearched = '', items = [], sel = 0, scope = null, actionsFor = null, back = '', searchToken = 0, textHits = []

export function initPalette(hooks) {
  H = hooks
  document.body.insertAdjacentHTML('beforeend', `
    <div id="palette" class="pal-bg" hidden><div class="pal">
      <div class="pal-in"><span id="pscope"></span><input id="pq" spellcheck="false" autocomplete="off"></div>
      <div id="pres" class="pal-res"></div>
      <div class="pal-foot"><span>↑↓ move</span><span>↵ open</span><span>Tab actions</span><span>Esc close</span></div>
    </div></div>`)
  $('pq').addEventListener('input', () => { sel = 0; refresh() })
  $('pq').addEventListener('keydown', onKey)
  $('palette').addEventListener('mousedown', e => { if (e.target.id === 'palette') close() })
  $('pres').addEventListener('click', e => { const r = e.target.closest('[data-i]'); if (r) { sel = +r.dataset.i; run(e.metaKey) } })
}

export function openPalette() {
  const book = H.readerBook()
  scope = book ? { id: book.id, title: book.title } : null
  actionsFor = null; sel = 0; $('pq').value = ''
  // over Night paper the box is dark too, whatever the app's theme (prototypes/search.html, frame 03)
  $('palette').classList.toggle('dark', !!book && document.getElementById('reader').dataset.paper === 'night')
  $('palette').hidden = false; $('pq').focus()
  refresh()
}
// search marks stay only when going to one of them
const close = keepMarks => { $('palette').hidden = true; searchToken++; lastSearched = ''; textHits = []; if (!keepMarks) H.view()?.clearSearch() }
export const paletteOpen = () => !$('palette').hidden

// ---------- Results ----------
const kbd = k => k ? `<kbd>${k}</kbd>` : ''
const PLACES = [['All books', 'G A'], ['Reading', 'G R'], ['Not started', 'G N'], ['Finished', 'G F'], ['Notes', 'G U']]

function commands() {
  const c = []
  // the Reader's commands while a book is open, even with the scope removed
  if (H.readerBook()) c.push(
    { t: 'Back to the library', k: 'Esc', run: () => H.closeReader() },
    { t: 'Contents', k: '⌘T', run: () => H.reader('contents') },
    { t: 'Bigger text', k: '⌘+', run: () => H.reader('bigger') },
    { t: 'Smaller text', k: '⌘−', run: () => H.reader('smaller') },
    ...['Day', 'Sepia', 'Night'].map(p => ({ t: `${p} paper`, run: () => H.reader('paper', p.toLowerCase()) })))
  c.push(...PLACES.map(([p, k]) => ({ t: `Go to ${p}`, k, run: () => H.go(p) })),
    { t: 'Add books…', k: '⌘O', run: () => H.addBooks() },
    { t: 'Export notes to folder…', run: () => H.exportNotes() },
    { t: 'Settings', k: '⌘,', run: () => H.settings() })
  return c.map(x => ({ ...x, kind: 'cmd' }))
}

function bookActions(b) {
  const st = s => ({ t: `Mark as ${s}`, run: () => H.setStatus(b.id, s) })
  return [
    { t: b.status === 'Not started' ? 'Start reading' : 'Open', k: '↵', run: () => H.openBook(b.id) },
    ...['Reading', 'Not started', 'Finished'].filter(s => s !== b.status).map(st),
    { t: 'Underlines in Notes', run: () => H.notesFor(b.id) },
    { t: 'Show in Finder', run: () => H.reveal(b.id) },
  ].map(x => ({ ...x, kind: 'cmd' }))
}

function refresh() {
  const raw = $('pq').value, q = words(raw)
  $('pscope').innerHTML = actionsFor ? `<span class="chip on">${esc(actionsFor.title)}</span>` : scope ? `<span class="chip on" title="⌫ searches everything">${esc(scope.title)}</span>` : ''
  $('pq').placeholder = actionsFor ? 'Things to do with this book' : scope ? 'Search this book, its underlines and commands' : 'Search books, underlines and commands'
  const groups = []
  if (actionsFor) {
    groups.push(['', bookActions(actionsFor).filter(c => !q.length || hits(q, c.t))])
  } else {
    const books = H.books(), notes = H.notes()
    if (!q.length) {
      // nothing typed: carry on with what you're reading, then places and a few commands
      if (!scope) groups.push(['Reading', books.filter(b => b.status === 'Reading').slice(0, 5).map(bookItem)])
      if (scope) groups.push(['Underlines in this book', notes.filter(n => n.bookId === scope.id).slice(0, 4).map(n => noteItem(n, []))])
      groups.push(['Commands', commands().slice(0, H.readerBook() ? 6 : 8)])
    } else {
      const inScope = n => !scope || n.bookId === scope.id
      if (scope && raw.trim().length >= 3) groups.push(['In this book', textHits.slice(0, 8)])
      if (!scope) {
        const bs = books.filter(b => hits(q, `${b.title} ${b.authors.join(' ')}`))
          .sort((a, b) => hits(q, b.title) - hits(q, a.title))   // titles rank above authors
        groups.push(['Books', bs.slice(0, 5).map(b => bookItem(b, q))])
      }
      const ns = notes.filter(n => inScope(n) && hits(q, `${n.exact} ${n.note} ${scope ? '' : n.title}`))
        .sort((a, b) => hits(q, b.exact) - hits(q, a.exact))      // quotes rank above notes
      groups.push([scope ? 'Underlines in this book' : 'Underlines', ns.slice(0, 5).map(n => noteItem(n, q))])
      groups.push(['Commands', commands().filter(c => hits(q, c.t))])
    }
  }
  items = []
  $('pres').innerHTML = groups.filter(([, l]) => l.length).map(([g, l]) =>
    (g ? `<div class="pg">${g}</div>` : '') + l.map(it => { const i = items.push(it) - 1; return `<div class="pr ${i === sel ? 'on' : ''}" data-i="${i}">${it.html ?? `<span>${mark(it.t, q)}</span>${kbd(it.k)}`}</div>` }).join('')
  ).join('') || `<div class="pempty">${scope && raw.trim().length >= 3 && searchToken ? 'Searching…' : 'Nothing matches'}</div>`
  $('pres').querySelector('.pr.on')?.scrollIntoView({ block: 'nearest' })
  if (scope && !actionsFor && raw.trim().length >= 3 && raw !== lastSearched) searchText(raw)
}

const bookItem = (b, q = []) => ({ kind: 'book', book: b, run: () => H.openBook(b.id),
  html: `<span class="pb"><b>${mark(b.title, q)}</b><small>${mark(b.authors.join(', '), q)} · ${b.status}${b.status === 'Reading' ? ` ${Math.round(b.fraction * 100)}%` : ''}</small></span><kbd>Tab</kbd>` })
const noteItem = (n, q) => ({ kind: 'note', note: n, run: meta => meta ? H.openBook(n.bookId, n.id) : H.notesAt(n.id),
  html: `<i class="mk" style="background:${LABELS[n.label][1]}"></i><span class="pb"><span class="pqt">${mark(n.exact, q)}</span><small>${n.note ? mark(n.note, q) + ' · ' : ''}${esc(n.title)}${n.page ? ` · p. ${n.page}` : ''}</small></span><kbd>⌘↵ book</kbd>` })

// Text of the open book, searched as you type; newer keystrokes cancel older searches
async function searchText(raw) {
  lastSearched = raw
  const token = ++searchToken, found = []
  textHits = []
  const view = H.view(); if (!view) return
  for await (const r of view.search({ query: raw.trim() })) {
    if (token !== searchToken) return
    if (r === 'done') break
    for (const { cfi, excerpt } of r.subitems ?? []) found.push({ kind: 'text', run: () => H.goToText(cfi),
      html: `<span class="pb"><span class="pqt">${esc(excerpt.pre)}<mark>${esc(excerpt.match)}</mark>${esc(excerpt.post)}</span><small>${esc(r.label?.trim() ?? '')}</small></span>` })
    if (found.length >= 8) break
  }
  if (token !== searchToken) return
  textHits = found; searchToken = 0
  if ($('pq').value === raw) refresh()
}

// ---------- Keys ----------
function run(meta) {
  const it = items[sel]; if (!it) return
  close(it.kind === 'text')
  it.run(meta)
}
function onKey(e) {
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { sel = Math.min(items.length - 1, sel + 1); refresh(); return e.preventDefault() }
  if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { sel = Math.max(0, sel - 1); refresh(); return e.preventDefault() }
  if (e.key === 'Enter') { run(e.metaKey); return e.preventDefault() }
  if (e.key === 'Tab') {
    const it = items[sel]
    if (it?.kind === 'book' && !actionsFor) { back = $('pq').value; actionsFor = it.book; $('pq').value = ''; sel = 0; refresh() }
    return e.preventDefault()
  }
  if (e.key === 'Escape') {
    // Esc from a book's actions goes back to the results, with the query as it was
    if (actionsFor) { actionsFor = null; $('pq').value = back; sel = 0; refresh() } else close()
    return e.preventDefault()
  }
  if (e.key === 'Backspace' && !$('pq').value && scope) { scope = null; textHits = []; lastSearched = ''; H.view()?.clearSearch(); refresh(); return e.preventDefault() }
}
