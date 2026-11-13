// The Reader: foliate-js in the pages layout, with fixed page numbers, a remembered reading point,
// and underlines stored as CFI + quote. See spikes/pages and spikes/anchors for why each part is here.
import { makeBook } from './vendor/foliate-js/view.js'
import { Overlayer } from './vendor/foliate-js/overlayer.js'
import { fold, findQuote } from './anchors.js'
import { setting, setSetting, onSetting, darkNow } from './store.js'

const { invoke } = window.__TAURI__.core
const $ = id => document.getElementById(id)

export const LABELS = [null, ['Quote', '#d9a400'], ['Idea', '#2f9e63'], ['Question', '#7c85e0'], ['Disagree', '#d0517a']]
const FONTS = { Georgia: 'Georgia, serif', Charter: "Charter, 'Bitstream Charter', Georgia, serif", 'San Francisco': '-apple-system, system-ui, sans-serif' }
const PAPERS = [['day', 'Day', '#24221f'], ['sepia', 'Sepia', '#3b2f20'], ['night', 'Night', '#d8d5ce']]
const CHARS_PER_PAGE = 2000   // a page is 2,000 characters of text, whatever the font size (spikes/pages)
const LARGE_FILE = 300 * 1024

// Reader settings live with the other settings (store.js), so the Settings window and the Reader share them.
// Paper "match" follows the app: Day when it's light, Night when it's dark.
const prefs = {
  get size() { return +setting('reader_size') || 15 },
  get font() { return FONTS[setting('reader_font')] ? setting('reader_font') : 'Georgia' },
  get paper() { const p = setting('reader_paper'); return p === 'match' || !p ? (darkNow() ? 'night' : 'day') : p },
}
onSetting(k => { if (/^reader_|^theme$/.test(k) && entry) { paintTools(); relayout() } })

let view, book, entry, before = [], totalPages = 0
let readingAt = null        // CFI of a point just inside the first line, set only when the reader moves
let adjusting = false       // true while we change the layout and put the reader back
let underlines = []         // rows from the database
let selection = null        // { index, range } of the current text selection
let saveTimer, resizeObs, turned = false   // turned: a page has been turned since opening

const css = () => `
  html { color-scheme: ${prefs.paper === 'night' ? 'dark' : 'light'} !important; }
  html, body { background: transparent !important; color: ${PAPERS.find(p => p[0] === prefs.paper)[2]} !important; }
  body { font-family: ${FONTS[prefs.font]} !important; }
  html { font-size: ${prefs.size}pt; }
  p, li, blockquote, dd { line-height: 1.55; text-align: justify; hyphens: auto; -webkit-hyphens: auto; widows: 2; orphans: 2; }
  a { color: inherit; }
  ::selection { background: rgba(94,106,210,.25); }`

// target: an underline id to open at, instead of where the reader left off
export async function openReader(b, target) {
  entry = b; turned = false
  $('rtitle').textContent = `${b.title} · ${b.authors[0] ?? ''}`
  $('note').textContent = b.largestFile > LARGE_FILE ? 'This book is stored as one large file, so it can be slow.' : ''
  $('page').textContent = ''; $('chapter').textContent = 'Opening…'
  paintTools()

  const bytes = await invoke('read_book', { id: b.id })
  book = await makeBook(new File([bytes], b.file.split('/').pop()))
  view = document.createElement('foliate-view')
  $('stage').replaceChildren(view)
  await view.open(book)
  const r = view.renderer
  r.setAttribute('flow', 'paginated'); r.setAttribute('max-column-count', '1')
  r.setAttribute('margin', '40px'); r.setAttribute('gap', '7%'); r.setAttribute('max-inline-size', '640px')
  r.setStyles(css())

  view.addEventListener('relocate', onRelocate)
  view.addEventListener('load', onLoad)
  view.addEventListener('create-overlay', e => drawUnderlines(e.detail.index))
  view.addEventListener('draw-annotation', onDraw)
  view.addEventListener('show-annotation', e => showUnderlineMenu(e.detail))

  await countPages()
  // check underlines first, so opening at one uses its repaired CFI
  underlines = await invoke('list_underlines', { bookId: b.id })
  await placeUnderlines()
  const at = target != null ? underlines.find(u => u.id === target && u.index != null)?.cfi : b.position
  try { if (at) await view.goTo(at); else await view.goToTextStart() }
  catch { await view.goToTextStart() }

  resizeObs = new ResizeObserver(() => { clearTimeout(resizeObs.t); resizeObs.t = setTimeout(() => relayout(), 150) })
  resizeObs.observe($('stage'))
}

export async function closeReader() {
  hidePop(); $('toc').hidden = true
  resizeObs?.disconnect()
  await savePosition()
  view?.close(); view?.remove()
  view = book = entry = null; underlines = []
}

// ---------- Page numbers ----------
// Characters of text in each section, counted once and kept in the library
async function countPages() {
  let chars = entry.sectionChars
  if (!chars || chars.length !== book.sections.length) {
    chars = []
    for (const s of book.sections) {
      if (s.linear === 'no' || !s.createDocument) { chars.push(0); continue }
      const d = await s.createDocument(); chars.push(d.body?.textContent.length ?? 0)
    }
    invoke('save_section_chars', { id: entry.id, chars })
  }
  before = chars.map((_, i) => chars.slice(0, i).reduce((a, b) => a + b, 0))
  totalPages = Math.max(1, Math.ceil(chars.reduce((a, b) => a + b, 0) / CHARS_PER_PAGE))
}

function pageOf(index, range) {
  const doc = range.startContainer.ownerDocument, x = doc.createRange()
  x.setStart(doc.body ?? doc.documentElement, 0); x.setEnd(range.startContainer, range.startOffset)
  return Math.min(totalPages, Math.floor(((before[index] ?? 0) + x.toString().length) / CHARS_PER_PAGE) + 1)
}

// ---------- Keeping the reader's place ----------
function onRelocate(e) {
  const d = e.detail
  if (!d.range) return
  const index = view.resolveCFI(d.cfi).index
  if (['page', 'snap', 'scroll'].includes(d.reason)) turned = true
  if (!adjusting && d.reason !== 'anchor') {
    // a point a little way into the first line: the very first character can sit on the edge between screens
    const x = d.range.cloneRange(); x.collapse(true)
    const n = x.startContainer
    if (n.nodeType === 3 && n.length > x.startOffset + 12) x.setStart(n, x.startOffset + 12), x.collapse(true)
    readingAt = view.getCFI(index, x)
    clearTimeout(saveTimer); saveTimer = setTimeout(savePosition, 800)
  }
  $('page').textContent = `p. ${pageOf(index, d.range)} of ${totalPages}`
  $('chapter').textContent = d.tocItem?.label?.trim() ?? ''
  hidePop()
}

async function relayout() {
  if (!view) return
  adjusting = true
  view.renderer.setStyles(css())
  await new Promise(r => setTimeout(r, 30))
  if (readingAt) await view.goTo(readingAt).catch(() => {})
  setTimeout(() => adjusting = false, 250)
}

function savePosition() {
  if (!entry || !readingAt) return
  return invoke('save_position', { id: entry.id, cfi: readingAt, fraction: view?.lastLocation?.fraction ?? 0, turned }).catch(console.error)
}

// ---------- Underlines ----------
const byIndex = new Map()   // section index -> underlines placed in it

// Check every underline still sits on its words; if not, find the words again and store the new CFI.
async function placeUnderlines() {
  byIndex.clear()
  let lost = 0
  const docs = new Map(), docOf = async i => docs.get(i) ?? docs.set(i, await book.sections[i].createDocument()).get(i)
  for (const u of underlines) {
    let index, ok = false
    try {
      const res = view.resolveCFI(u.cfi); index = res.index
      const doc = await docOf(index)
      ok = fold(res.anchor(doc).toString()) === fold(u.exact)
    } catch {}
    if (!ok) {
      const found = await findQuote(book, u, index ?? 0)
      if (!found) { lost++; continue }
      index = found.index; u.cfi = view.getCFI(index, found.range)
      invoke('move_underline', { id: u.id, cfi: u.cfi, page: pageOf(index, found.range) })
    }
    u.index = index
    if (!byIndex.has(index)) byIndex.set(index, [])
    byIndex.get(index).push(u)
  }
  for (const i of byIndex.keys()) drawUnderlines(i)
  $('note').textContent = lost ? `${lost} underline${lost > 1 ? 's' : ''} couldn't be found in this copy of the book.` : $('note').textContent
}

function drawUnderlines(index) {
  for (const u of byIndex.get(index) ?? []) view.addAnnotation({ value: u.cfi, label: u.label }).catch(() => {})
}

function onDraw(e) {
  const { draw, annotation } = e.detail
  draw(Overlayer.underline, { color: LABELS[annotation.label]?.[1] ?? '#d9a400', width: 2 })
}

async function underlineSelection(label) {
  if (!selection) return
  const { index, range } = selection, doc = range.startContainer.ownerDocument
  const text = (doc.body ?? doc.documentElement).textContent
  const pre = doc.createRange(); pre.setStart(doc.body ?? doc.documentElement, 0); pre.setEnd(range.startContainer, range.startOffset)
  const at = pre.toString().length, exact = range.toString()
  if (!exact.trim()) return
  const u = await invoke('add_underline', { underline: {
    bookId: entry.id, cfi: view.getCFI(index, range), exact,
    prefix: text.slice(Math.max(0, at - 48), at), suffix: text.slice(at + exact.length, at + exact.length + 48), label,
    page: pageOf(index, range), chapter: view.lastLocation?.tocItem?.label?.trim() ?? null } })
  u.index = index; underlines.push(u)
  if (!byIndex.has(index)) byIndex.set(index, [])
  byIndex.get(index).push(u)
  view.addAnnotation({ value: u.cfi, label })
  doc.getSelection().removeAllRanges(); selection = null
  hidePop()
}

async function relabel(u, label) {
  await invoke('relabel_underline', { id: u.id, label }); u.label = label
  view.addAnnotation({ value: u.cfi, label }); hidePop()
}

async function remove(u) {
  await invoke('remove_underline', { id: u.id })
  underlines = underlines.filter(x => x !== u)
  byIndex.set(u.index, (byIndex.get(u.index) ?? []).filter(x => x !== u))
  view.deleteAnnotation({ value: u.cfi }); hidePop()
}

// ---------- Selection and the label menu ----------
function onLoad(e) {
  const { doc, index } = e.detail
  doc.addEventListener('keydown', onKey)
  doc.addEventListener('pointerup', () => setTimeout(() => {
    const sel = doc.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { selection = null; return }
    selection = { index, range: sel.getRangeAt(0) }
    showLabelMenu(sel.getRangeAt(0))
  }, 10))
}

function rectOf(range) {
  const r = range.getBoundingClientRect(), f = range.startContainer.ownerDocument.defaultView.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 }
  return { left: f.left + r.left, top: f.top + r.top, bottom: f.top + r.bottom, width: r.width }
}

function place(pop, range) {
  const r = rectOf(range)
  pop.hidden = false
  const w = pop.offsetWidth, h = pop.offsetHeight
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px'
  pop.style.top = (r.top - h - 8 < 50 ? r.bottom + 8 : r.top - h - 8) + 'px'
}

const labelButtons = current => LABELS.slice(1).map(([name, color], i) =>
  `<button data-label="${i + 1}" class="${current === i + 1 ? 'on' : ''}"><i style="background:${color}"></i>${name}<kbd>${i + 1}</kbd></button>`).join('')

let popFor = null
function showLabelMenu(range) {
  popFor = null
  $('pop').innerHTML = labelButtons()
  place($('pop'), range)
}

function showUnderlineMenu({ value, range }) {
  const u = underlines.find(x => x.cfi === value); if (!u) return
  popFor = u
  $('pop').innerHTML = labelButtons(u.label) + `<span class="sep"></span><button data-remove>Remove<kbd>⌫</kbd></button>`
  place($('pop'), range)
}

function hidePop() { $('pop').hidden = true; popFor = null }

$('pop').addEventListener('click', e => {
  const l = e.target.closest('[data-label]'), rm = e.target.closest('[data-remove]')
  if (l) popFor ? relabel(popFor, +l.dataset.label) : underlineSelection(+l.dataset.label)
  if (rm && popFor) remove(popFor)
})

// ---------- Keys and tools ----------
function onKey(e) {
  if (!view || $('reader').hidden || e.target.closest?.('#palette')) return
  const k = e.key
  // keys pressed inside the book's page don't reach the window, so pass the app-wide shortcuts on
  if (e.metaKey && ['k', ',', 'o'].includes(k) && e.target.ownerDocument !== document) {
    window.dispatchEvent(new CustomEvent('nightstand:shortcut', { detail: k })); return e.preventDefault()
  }
  if (/^[1-4]$/.test(k) && !e.metaKey) {
    if (popFor) relabel(popFor, +k); else if (selection) underlineSelection(+k)
    return e.preventDefault()
  }
  if ((k === 'Backspace' || k === 'Delete') && popFor) { remove(popFor); return e.preventDefault() }
  if (e.metaKey && k === 't') { toggleContents(); return e.preventDefault() }
  if (k === 'Escape') { if (!$('toc').hidden) $('toc').hidden = true; else if (!$('pop').hidden) hidePop(); else window.dispatchEvent(new Event('nightstand:close-reader')); return }
  if (e.metaKey && (k === '=' || k === '+')) { setSize(prefs.size + 1); return e.preventDefault() }
  if (e.metaKey && k === '-') { setSize(prefs.size - 1); return e.preventDefault() }
  if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { view.goRight?.() ?? view.next(); return e.preventDefault() }
  if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { view.goLeft?.() ?? view.prev(); return e.preventDefault() }
}
document.addEventListener('keydown', onKey)

function setSize(n) { setSetting('reader_size', Math.max(12, Math.min(28, n))); paintTools(); relayout() }

function paintTools() {
  $('size').textContent = prefs.size + ' pt'
  $('font').innerHTML = Object.keys(FONTS).map(f => `<option ${f === prefs.font ? 'selected' : ''}>${f}</option>`).join('')
  $('themes').innerHTML = PAPERS.map(([k, n]) => `<button data-paper="${k}" class="${k === prefs.paper ? 'on' : ''}">${n}</button>`).join('')
  $('reader').dataset.paper = prefs.paper
}
$('smaller').addEventListener('click', () => setSize(prefs.size - 1))
$('bigger').addEventListener('click', () => setSize(prefs.size + 1))
$('font').addEventListener('change', e => { setSetting('reader_font', e.target.value); relayout() })
$('themes').addEventListener('click', e => { const b = e.target.closest('[data-paper]'); if (!b) return; setSetting('reader_paper', b.dataset.paper); paintTools(); relayout() })
document.addEventListener('pointerdown', e => { if (!e.target.closest('#pop')) hidePop() })

// ---------- Contents ----------
function toggleContents() {
  const toc = $('toc')
  if (!toc.hidden) return toc.hidden = true
  const items = []; const walk = (l, d) => l?.forEach(x => { items.push([x, d]); walk(x.subitems, d + 1) }); walk(book?.toc, 0)
  const here = view?.lastLocation?.tocItem?.href
  toc.innerHTML = items.length ? items.map(([x, d], i) => `<button data-i="${i}" class="${x.href === here ? 'on' : ''}" style="padding-left:${10 + d * 14}px">${x.label.trim().replace(/[&<]/g, c => c === '&' ? '&amp;' : '&lt;')}</button>`).join('') : '<div style="padding:10px;color:var(--pmu)">This book has no contents list.</div>'
  toc.hidden = false
  toc.querySelector('.on')?.scrollIntoView({ block: 'center' })
  toc.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; toc.hidden = true; view.goTo(items[+b.dataset.i][0].href) }
}
$('contents').addEventListener('click', toggleContents)

// ---------- For ⌘K ----------
export const reader = {
  book: () => (entry && !$('reader').hidden ? entry : null),
  view: () => view,
  command(c, arg) {
    if (c === 'contents') toggleContents()
    if (c === 'bigger') setSize(prefs.size + 1)
    if (c === 'smaller') setSize(prefs.size - 1)
    if (c === 'paper') { setSetting('reader_paper', arg); paintTools(); relayout() }
  },
  async goToText(cfi) { await view?.goTo(cfi); setTimeout(() => view?.clearSearch(), 4000) },
}
