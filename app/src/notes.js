// Notes: every underline from every book in one place (prototypes/notes.html).
// Revisit at the top, the list grouped by date, book or label, filtered by label chips and search.
import { LABELS } from './reader.js'

const { invoke } = window.__TAURI__.core
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const DAY = 86400, MONTH = 30 * DAY
const now = () => Math.floor(Date.now() / 1000)

let all = [], group = 'date', chips = new Set(), query = '', sel = 0, revisit = null, editing = null
let hooks = {}   // { open(bookId, underlineId), toast(text), render() } from app.js

export function initNotes(h) { hooks = h }

export async function loadNotes() {
  all = await invoke('list_notes')
  pickRevisit(false)
  return all.length
}

export const notesCount = () => all.length

// ---------- Revisit ----------
// A passage underlined over a month ago, never the one shown last. While nothing is that old yet, any passage will do.
function pickRevisit(again) {
  let last = null
  try { last = +localStorage.getItem('revisit') || null } catch {}
  if (again && revisit) last = revisit.id
  const old = all.filter(n => now() - n.created > MONTH)
  let pool = (old.length ? old : all).filter(n => n.id !== last)
  if (!pool.length) pool = all
  revisit = pool[Math.floor(Math.random() * pool.length)] ?? null
  try { if (revisit) localStorage.setItem('revisit', revisit.id) } catch {}
}

const ago = t => {
  const d = Math.floor((now() - t) / DAY)
  if (d < 1) return 'today'
  if (d < 2) return 'yesterday'
  if (d < 30) return `${d} days ago`
  const m = Math.round(d / 30)
  return m < 12 ? `${m} month${m > 1 ? 's' : ''} ago` : `${Math.round(m / 12)} year${m >= 18 ? 's' : ''} ago`
}

export const revisitCard = (small = false) => !revisit ? '' : `
  <div class="rv ${small ? 'sm' : ''}">
    <div class="rvh"><span>Revisit</span><span class="rva">underlined ${ago(revisit.created)}</span></div>
    <blockquote>${esc(revisit.exact)}</blockquote>
    <div class="rvf"><span>${esc(revisit.title)}${revisit.page ? ` · p. ${revisit.page}` : ''}</span>
      <span><button class="lnk" data-open="${revisit.id}">Open in book</button>${all.length > 1 ? `<button class="lnk" data-another>Another <kbd>R</kbd></button>` : ''}</span></div>
  </div>`

// ---------- Filtering ----------
// Every typed word must start a word in the quote, the note or the book title.
const words = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []
function matches(n) {
  if (chips.size && !chips.has(n.label)) return false
  const q = words(query); if (!q.length) return true
  const hay = words(`${n.exact} ${n.note} ${n.title}`)
  return q.every(w => hay.some(h => h.startsWith(w)))
}
function mark(text) {
  const q = words(query); if (!q.length) return esc(text)
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${q.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  return esc(text).replace(re, '<mark>$1</mark>')
}

function visible() {
  const list = all.filter(matches)
  const groups = new Map()
  const add = (k, head, n) => { if (!groups.has(k)) groups.set(k, { head, items: [] }); groups.get(k).items.push(n) }
  if (group === 'date') for (const n of list) { const d = new Date(n.created * 1000), k = d.toDateString(); add(k, dayName(d), n) }
  if (group === 'book') {
    for (const n of list) add(n.bookId, null, n)
    for (const g of groups.values()) { g.items.sort((a, b) => (a.page ?? 1e9) - (b.page ?? 1e9) || a.id - b.id); g.head = bookHead(g.items[0], all.filter(x => x.bookId === g.items[0].bookId)) }
  }
  if (group === 'label') for (const l of [1, 2, 3, 4]) for (const n of list.filter(n => n.label === l)) add(l, `<i class="mk" style="background:${LABELS[l][1]}"></i>${LABELS[l][0]}`, n)
  return [...groups.values()]
}

function dayName(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0)
  const diff = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5)
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

// Book header with its status and a bar of its labels, so it's clear which books you argued with
function bookHead(n, mine) {
  const counts = [1, 2, 3, 4].map(l => mine.filter(x => x.label === l).length)
  const bar = counts.map((c, i) => c ? `<i style="flex:${c};background:${LABELS[i + 1][1]}" title="${c} ${LABELS[i + 1][0]}"></i>` : '').join('')
  return `<span class="bt">${esc(n.title)}</span><span class="ba">${esc(n.authors[0] ?? '')} · ${esc(n.status)}${n.status === 'Reading' ? ` ${Math.round(n.fraction * 100)}%` : ''}</span><span class="lb">${bar}</span>`
}

// ---------- Drawing ----------
export function renderNotes() {
  const groups = visible(), flat = groups.flatMap(g => g.items)
  sel = Math.max(0, Math.min(sel, flat.length - 1))
  const chipsHTML = `<div class="chips">${[1, 2, 3, 4].map(l => `<button class="chip ${chips.has(l) ? 'on' : ''}" data-chip="${l}"><i class="mk" style="background:${LABELS[l][1]}"></i>${LABELS[l][0]}<span class="n">${all.filter(n => n.label === l).length}</span></button>`).join('')}</div>`
  let body
  if (!all.length) body = `<div class="empty"><h2>No underlines yet</h2><p>Select text in a book and press 1–4 to underline it as a Quote, Idea, Question or Disagree. Everything you underline shows up here.</p></div>`
  else if (!flat.length) body = chipsHTML + `<div class="empty"><h2>No underlines match</h2><p>Try fewer words, or turn off a label.</p>${revisitCard(true)}</div>`
  else {
    let i = 0
    body = chipsHTML + (!query && !chips.size ? revisitCard() : '') + groups.map(g => `
      <div class="ngrp ${group === 'book' ? 'bk' : ''}">${g.head}<span class="n">${g.items.length}</span></div>
      ${g.items.map(n => row(n, i++)).join('')}`).join('')
  }
  $('shelf').innerHTML = `<div class="notes">${body}</div>`
  $('shelf').querySelector('.nt.on')?.scrollIntoView({ block: 'nearest' })
  if (editing) { const t = $('shelf').querySelector(`.nt[data-id="${editing}"] textarea`); t?.focus(); t?.setSelectionRange(t.value.length, t.value.length) }
}

function row(n, i) {
  const [name, color] = LABELS[n.label] ?? LABELS[1]
  const meta = [group !== 'book' && esc(n.title), n.page && `p. ${n.page}`, group !== 'label' && name, group !== 'date' && ago(n.created)].filter(Boolean).join(' · ')
  const note = editing === n.id
    ? `<textarea class="ned" rows="2" placeholder="Your note. ⌘↵ to save, Esc to cancel">${esc(n.note)}</textarea>`
    : n.note ? `<div class="nn">${mark(n.note)}</div>` : ''
  return `<div class="nt ${i === sel ? 'on' : ''}" data-id="${n.id}" data-i="${i}">
    <i class="mk" style="background:${color}"></i>
    <div class="nb"><div class="q">${mark(n.exact)}</div>${note}<div class="nm">${meta}</div></div>
    <div class="na">
      <button data-act="open" title="Open in book (↵)">Open</button>
      <button data-act="note" title="Note (N)">${n.note ? 'Edit note' : 'Note'}</button>
      <button data-act="copy" title="Copy (C)">Copy</button>
      <span class="lbs">${[1, 2, 3, 4].map(l => `<button data-label="${l}" class="${l === n.label ? 'on' : ''}" title="${LABELS[l][0]} (${l})"><i class="mk" style="background:${LABELS[l][1]}"></i></button>`).join('')}</span>
    </div>
  </div>`
}

export function notesTools() {
  return `<input id="nsearch" class="search" placeholder="Search notes  /" value="${esc(query)}" spellcheck="false">
    <div class="seg2" id="ngroup">${[['date', 'Date'], ['book', 'Book'], ['label', 'Label']].map(([k, n]) => `<button data-group="${k}" class="${k === group ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="menu-wrap"><button id="export" class="btn">Export ▾</button>
      <div id="exportMenu" class="menu" hidden>
        <button data-export="copy">Copy as Markdown<small>What's on screen, filters included</small></button>
        <button data-export="folder">Export to folder…<small>One file per book, for Obsidian and the like</small></button>
      </div></div>`
}

// ---------- Actions ----------
const flat = () => visible().flatMap(g => g.items)
const current = () => flat()[sel]

async function relabel(n, label) {
  await invoke('relabel_underline', { id: n.id, label }); n.label = label; renderNotes()
}
async function saveNote(n, text) {
  await invoke('set_note', { id: n.id, note: text.trim() }); n.note = text.trim(); editing = null; renderNotes()
}

const lineFor = n => `#${LABELS[n.label][0].toLowerCase()}${n.page ? ` · p. ${n.page}` : ''}`
const quoteMd = n => `> ${n.exact.replace(/\s+/g, ' ').trim()}\n\n${n.note ? n.note.trim() + '\n\n' : ''}${lineFor(n)}`
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text) } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove()
  }
  hooks.toast?.(`Copied ${what}.`)
}
// Copy as Markdown: what's on screen, filters included, grouped by book
function copyAll() {
  const list = flat(), books = new Map()
  for (const n of list) { if (!books.has(n.bookId)) books.set(n.bookId, []); books.get(n.bookId).push(n) }
  const md = [...books.values()].map(items => `## ${items[0].title}\n${items[0].authors.join(', ')}\n\n` + items.map(quoteMd).join('\n\n')).join('\n\n')
  copy(md + '\n', `${list.length} underline${list.length > 1 ? 's' : ''} as Markdown`)
}

async function exportDialog() {
  const s = await invoke('export_settings')
  const d = document.createElement('div'); d.className = 'sheet-bg'
  let folder = s.folder
  const draw = () => d.innerHTML = `<div class="sheet">
    <h2>Export to folder</h2>
    <p>One Markdown file per book, with frontmatter and labels as tags, so the folder can sit inside an Obsidian vault. Filters don't apply: the folder is a full copy. Nightstand never touches files it didn't create.</p>
    <div class="frow"><span class="path">${folder ? esc(folder.replace(/^\/Users\/[^/]+/, '~')) : 'No folder chosen'}</span><button class="btn" data-choose>Choose…</button></div>
    <label class="frow"><input type="checkbox" id="keep" ${s.keep || !s.folder ? 'checked' : ''}> Keep up to date<small>Rewrite a book's file when you add or change an underline</small></label>
    <div class="sbtns">${s.folder ? '<button class="btn" data-off>Turn off export</button>' : ''}<span></span><button class="btn" data-cancel>Cancel</button><button class="btn pri" data-go ${folder ? '' : 'disabled'}>Export</button></div>
  </div>`
  draw(); document.body.append(d)
  d.addEventListener('click', async e => {
    if (e.target === d || e.target.closest('[data-cancel]')) return d.remove()
    if (e.target.closest('[data-choose]')) { const f = await window.__TAURI__.dialog.open({ directory: true, defaultPath: folder ?? undefined }); if (f) { folder = f; s.keep = d.querySelector('#keep').checked; draw() } }
    if (e.target.closest('[data-off]')) { await invoke('set_export', { folder: null, keep: false }); d.remove(); hooks.toast?.('Export is off. Files already written stay where they are.') }
    if (e.target.closest('[data-go]')) {
      const r = await invoke('set_export', { folder, keep: d.querySelector('#keep').checked }); d.remove()
      const parts = [`Exported ${r.written} book${r.written === 1 ? '' : 's'}`]
      if (r.removed) parts.push(`removed ${r.removed} old file${r.removed > 1 ? 's' : ''}`)
      if (r.skipped.length) parts.push(`left ${r.skipped.join(', ')} alone because Nightstand didn't make ${r.skipped.length > 1 ? 'them' : 'it'}`)
      hooks.toast?.(parts.join('; ') + '.')
    }
  })
}

const byId = id => all.find(n => n.id === +id)

document.addEventListener('click', e => {
  // Revisit cards also appear on the library's empty states
  if (e.target.closest('[data-another]')) { pickRevisit(true); return hooks.render() }
  const o = e.target.closest('[data-open]'); if (o) { const n = byId(o.dataset.open); return hooks.open(n.bookId, n.id) }
  if ($('tools').dataset.view !== 'notes' || $('library').hidden) return
  const chip = e.target.closest('[data-chip]'); if (chip) { const l = +chip.dataset.chip; chips.has(l) ? chips.delete(l) : chips.add(l); sel = 0; return renderNotes() }
  const g = e.target.closest('[data-group]'); if (g) { group = g.dataset.group; sel = 0; document.querySelectorAll('[data-group]').forEach(b => b.classList.toggle('on', b === g)); return renderNotes() }
  if (e.target.closest('#export')) return $('exportMenu').hidden = !$('exportMenu').hidden
  const ex = e.target.closest('[data-export]'); if (ex) { $('exportMenu').hidden = true; return ex.dataset.export === 'copy' ? copyAll() : exportDialog() }
  if (!e.target.closest('.menu-wrap') && $('exportMenu')) $('exportMenu').hidden = true
  const r = e.target.closest('.nt'); if (!r) return
  sel = +r.dataset.i
  const n = byId(r.dataset.id)
  const l = e.target.closest('[data-label]'); if (l) return relabel(n, +l.dataset.label)
  const a = e.target.closest('[data-act]')?.dataset.act
  if (a === 'open') return hooks.open(n.bookId, n.id)
  if (a === 'copy') return copy(quoteMd(n) + '\n', 'the underline')
  if (a === 'note') { editing = n.id; return renderNotes() }
  if (!e.target.closest('textarea')) renderNotes()
})
document.addEventListener('dblclick', e => { const r = e.target.closest('.nt'); if (r && !e.target.closest('button, textarea')) { const n = byId(r.dataset.id); hooks.open(n.bookId, n.id) } })
document.addEventListener('input', e => { if (e.target.id === 'nsearch') { query = e.target.value; sel = 0; renderNotes() } })

export function notesKey(e) {
  const typing = e.target.closest?.('input, textarea')
  if (e.target.classList?.contains('ned')) {
    const n = byId(e.target.closest('.nt').dataset.id)
    if (e.key === 'Enter' && e.metaKey) { saveNote(n, e.target.value); e.preventDefault() }
    if (e.key === 'Escape') { editing = null; renderNotes(); e.preventDefault() }
    return
  }
  if (e.target.id === 'nsearch') {
    if (e.key === 'Escape') { if (query) { query = ''; e.target.value = ''; renderNotes() } else e.target.blur(); e.preventDefault() }
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.target.blur(); e.preventDefault() }
    return
  }
  if (typing || e.metaKey || e.ctrlKey) return
  const list = flat(), n = list[sel], k = e.key
  if (k === '/') { $('nsearch')?.focus(); return e.preventDefault() }
  if (k === 'r' || k === 'R') { pickRevisit(true); renderNotes(); return }
  if (!n) return
  if (k === 'j' || k === 'ArrowDown') { sel = Math.min(list.length - 1, sel + 1); renderNotes(); return e.preventDefault() }
  if (k === 'k' || k === 'ArrowUp') { sel = Math.max(0, sel - 1); renderNotes(); return e.preventDefault() }
  if (k === 'Enter') { hooks.open(n.bookId, n.id); return e.preventDefault() }
  if (/^[1-4]$/.test(k)) return relabel(n, +k)
  if (k === 'c' || k === 'C') return copy(quoteMd(n) + '\n', 'the underline')
  if (k === 'n' || k === 'N') { editing = n.id; renderNotes(); return e.preventDefault() }
}
