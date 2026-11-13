// Devices (prototypes/devices.html): a Kindle or Kobo plugged in over USB shows in the sidebar.
// Its page lists what's on it and sends books. On connect, highlights come in as Quote underlines
// and a Kobo's progress moves books forward; a banner says what came in, and it can be taken back out.
import { makeBook } from './vendor/foliate-js/view.js'
import * as CFI from './vendor/foliate-js/epubcfi.js'
import { indexBook, matchClip } from './anchors.js'
import { setting, setSetting } from './store.js'

const { invoke } = window.__TAURI__.core
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const gb = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`

let devices = [], H = {}
const contents = new Map()   // device id -> [{ path, title, author, format, protected, bytes, progress, finished, bookId }]
const banners = new Map()    // device id -> what came in on connect
let sending = null           // { device, done, total, title, step }

export const deviceFilter = f => f?.startsWith('device:') ? f.slice(7) : null
export const connected = () => devices

export async function initDevices(hooks) {
  H = hooks
  devices = await invoke('list_devices')
  window.__TAURI__.event.listen('devices-changed', ({ payload }) => {
    const before = new Set(devices.map(d => d.id))
    devices = payload
    for (const d of devices) if (!before.has(d.id)) connect(d)
    for (const id of before) if (!devices.some(d => d.id === id)) { contents.delete(id); if (H.filter() === 'device:' + id) H.go('All books') }
    H.render()
  })
  window.__TAURI__.event.listen('send-progress', ({ payload }) => { sending = payload.step === 'Done' ? null : payload; if (H.filter() === 'device:' + payload.device) renderDevice(payload.device) })
  for (const d of devices) connect(d)
}

// On connect: what's on it, then highlights and progress, unless Settings says Ask first or Never
async function connect(d) {
  await refresh(d.id)
  const how = setting(`bring_in:${d.id}`) ?? 'auto'
  if (how === 'auto') bringIn(d)
  else if (how === 'ask') { banners.set(d.id, { ask: true }); H.render() }
}

async function refresh(id) {
  try { contents.set(id, await invoke('device_contents', { id })) } catch (e) { console.warn(e) }
  if (H.filter() === 'device:' + id) renderDevice(id)
}

// ---------- Bringing things in ----------
async function bringIn(d) {
  const clips = await invoke('device_clips', { id: d.id })
  const batch = Date.now(), items = [], notFound = [], byBook = new Map()
  const leftOut = clips.filter(c => c.bookId == null)
  for (const c of clips) if (c.bookId != null) { if (!byBook.has(c.bookId)) byBook.set(c.bookId, []); byBook.get(c.bookId).push(c) }
  const books = H.books()
  for (const [bookId, list] of byBook) {
    const entry = books.find(b => b.id === bookId); if (!entry) continue
    const book = await makeBook(new File([await invoke('read_book', { id: bookId })], 'book.epub'))
    const ix = await indexBook(book)
    const chars = entry.sectionChars, before = chars?.map((_, i) => chars.slice(0, i).reduce((a, b) => a + b, 0))
    for (const c of list) {
      // Kindle: a location is about 150 bytes of the book's text; Kobo: the chapter file it was made in
      const at = c.location ? { frac: Math.min(1, (c.location[0] - 1) * 150 / Math.max(1, ix.bytes)), context: c.context } : c.chapterFile ? { file: c.chapterFile } : {}
      const m = matchClip(ix, c.text, at)
      if (!m) { notFound.push(c); continue }
      const sec = book.sections[m.index], doc = m.range.startContainer.ownerDocument, body = doc.body ?? doc.documentElement
      const pre = doc.createRange(); pre.setStart(body, 0); pre.setEnd(m.range.startContainer, m.range.startOffset)
      const at0 = pre.toString().length, exact = m.range.toString(), text = body.textContent
      items.push({ key: c.key, underline: {
        bookId, cfi: CFI.joinIndir(sec.cfi ?? CFI.fake.fromIndex(m.index), CFI.fromRange(m.range)), exact,
        prefix: text.slice(Math.max(0, at0 - 48), at0), suffix: text.slice(at0 + exact.length, at0 + exact.length + 48),
        label: 1, note: c.note ?? '', page: before ? Math.floor((before[m.index] + at0) / 2000) + 1 : null, chapter: null } })
    }
  }
  const added = items.length ? await invoke('import_underlines', { batch, items }) : []
  // a Kobo's position only moves books forward
  const moved = []
  if (d.kind === 'kobo') for (const b of contents.get(d.id) ?? []) {
    if (b.bookId == null || b.progress == null) continue
    const st = await invoke('apply_progress', { id: b.bookId, fraction: b.progress, finished: b.finished })
    if (st) moved.push([books.find(x => x.id === b.bookId)?.title, st])
  }
  const titles = [...new Set(added.map(u => books.find(b => b.id === u.bookId)?.title))]
  banners.set(d.id, { batch, added: added.length, titles, leftOut: leftOut.length, leftOutTitles: [...new Set(leftOut.map(c => c.title))], notFound: notFound.length, moved, at: Date.now() })
  if (added.length || moved.length) H.toast(`${d.name}: ${summary(banners.get(d.id))}`)
  await H.reload()
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`
function summary(b) {
  const parts = []
  if (b.added) parts.push(`brought in ${plural(b.added, 'highlight')} from ${b.titles.length > 2 ? plural(b.titles.length, 'book') : b.titles.join(' and ')}`)
  for (const [t, st] of b.moved) parts.push(`moved ${t} to ${st}`)
  if (!parts.length) parts.push('nothing new')
  return parts.join('; ')
}

// ---------- The sidebar and the page ----------
export const deviceSidebar = current => !devices.length ? '' :
  `<div class="fsep"></div><div class="fhead">Devices</div>` + devices.map(d =>
    `<button class="fl ${current === 'device:' + d.id ? 'on' : ''}" data-f="device:${esc(d.id)}"><span>${esc(d.name)}</span><span class="n">${(contents.get(d.id) ?? []).length || ''}</span></button>`).join('')

export const deviceTools = id => `<button class="btn" data-dev="eject">Eject</button><button class="btn pri" data-dev="send">Send books…</button>`

export function renderDevice(id) {
  const d = devices.find(d => d.id === id); if (!d) return
  const list = contents.get(id) ?? [], mine = list.filter(b => b.bookId != null), theirs = list.filter(b => b.bookId == null)
  const books = H.books(), b = banners.get(id)
  let banner = ''
  if (b?.ask) banner = `<div class="dbanner"><span>Bring in highlights${d.kind === 'kobo' ? ' and reading progress' : ''} from this ${esc(d.name)}?</span><span><button class="btn pri" data-dev="bring">Bring them in</button></span></div>`
  else if (b) banner = `<div class="dbanner"><span>${esc(summary(b)[0].toUpperCase() + summary(b).slice(1))}.${b.leftOut ? ` ${plural(b.leftOut, 'passage')} from ${plural(b.leftOutTitles.length, 'book')} not in your library ${b.leftOut === 1 ? 'was' : 'were'} left out.` : ''}${b.notFound ? ` ${plural(b.notFound, 'highlight')} couldn't be placed in the book's text.` : ''}</span>
    <span>${b.added ? `<button class="lnk" data-dev="notes">See in Notes</button><button class="lnk" data-dev="undo">Take them back out</button>` : ''}</span></div>`
  const row = (x, lib) => `<div class="drow" data-path="${esc(x.path)}">
    ${lib && lib.cover ? `<img class="dcv" src="${window.__TAURI__.core.convertFileSrc(lib.cover.split('#')[0])}" alt="">` : `<div class="dcv ph"></div>`}
    <div class="dt"><b>${esc(lib?.title ?? x.title)}</b><small>${esc(lib?.authors?.join(', ') ?? x.author ?? '')}${x.progress != null && x.progress > 0 ? ` · ${Math.round(x.progress * 100)}% on the ${esc(d.name)}` : ''}${x.finished ? ' · finished' : ''}</small></div>
    <span class="dfmt">${esc(x.format)}${x.bytes ? ` · ${gb(x.bytes)}` : ''}</span>
    ${x.protected ? `<span class="dprot" title="Bought from ${d.kind === 'kindle' ? 'Amazon' : 'Kobo'}, so it can't be copied in">Protected</span>` : `<button class="lnk drm" data-dev="remove">Remove from ${esc(d.name)}</button>`}
  </div>`
  $('shelf').innerHTML = `<div class="dev">
    <div class="dhead"><div><h2>${esc(d.name)}</h2><small>${gb(d.freeBytes)} free of ${gb(d.totalBytes)} · ${esc(d.path.replace(/^\/Volumes\//, ''))}</small></div>
      <label class="dset">Highlights${d.kind === 'kobo' ? ' and progress' : ''} come in <select data-dev="bring-setting">${[['auto', 'Automatically'], ['ask', 'Ask first'], ['never', 'Never']].map(([v, n]) => `<option value="${v}" ${(setting(`bring_in:${id}`) ?? 'auto') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
    ${sending?.device === id ? `<div class="dbanner"><span>Sending ${sending.done + 1} of ${sending.total}: ${esc(sending.title)} · ${esc(sending.step)}…</span><span class="bar"><i style="width:${Math.round(100 * sending.done / sending.total)}%"></i></span></div>` : ''}
    ${banner}
    <div class="grp">From your library<span class="n">${mine.length}</span></div>
    ${mine.length ? mine.map(x => row(x, books.find(b => b.id === x.bookId))).join('') : `<div class="dempty">Nothing from your library yet. Send books to read them on the ${esc(d.name)}.</div>`}
    ${theirs.length ? `<div class="grp">Only on the ${esc(d.name)}<span class="n">${theirs.length}</span></div>${theirs.map(x => row(x, null)).join('')}` : ''}
  </div>`
}

// ---------- Sending ----------
function sendSheet(d) {
  const on = new Set((contents.get(d.id) ?? []).map(b => b.bookId).filter(x => x != null))
  const list = H.books().filter(b => !on.has(b.id))
  const sheet = document.createElement('div'); sheet.className = 'sheet-bg'
  sheet.innerHTML = `<div class="sheet wide"><h2>Send to ${esc(d.name)}</h2>
    <p>${d.kind === 'kindle' ? 'Kindles don\'t read EPUB, so each book is converted to AZW3 the first time it\'s sent. The converted copy is kept in your library so it only happens once.' : 'Books go as EPUB, into a Nightstand folder on the Kobo.'}</p>
    <div class="slist">${list.length ? list.map(b => `<label class="srow"><input type="checkbox" value="${b.id}"><span><b>${esc(b.title)}</b><small>${esc(b.authors.join(', '))} · ${esc(b.status)}</small></span></label>`).join('') : '<div class="dempty">Every book in your library is already on it.</div>'}</div>
    <div class="sbtns"><span class="scount"></span><button class="btn" data-cancel>Cancel</button><button class="btn pri" data-go disabled>Send</button></div></div>`
  document.body.append(sheet)
  const update = () => { const n = sheet.querySelectorAll('input:checked').length; sheet.querySelector('[data-go]').disabled = !n; sheet.querySelector('.scount').textContent = n ? `${plural(n, 'book')} selected` : '' }
  sheet.addEventListener('change', update)
  sheet.addEventListener('click', async e => {
    if (e.target === sheet || e.target.closest('[data-cancel]')) return sheet.remove()
    if (!e.target.closest('[data-go]')) return
    const ids = [...sheet.querySelectorAll('input:checked')].map(i => +i.value); sheet.remove()
    sending = { device: d.id, done: 0, total: ids.length, title: '', step: 'Starting' }; renderDevice(d.id)
    const res = await invoke('send_to_device', { id: d.id, bookIds: ids })
    sending = null
    const bad = res.filter(r => !r.ok)
    H.toast(bad.length ? `Sent ${res.length - bad.length} of ${res.length}. ${bad.map(r => `${r.title}: ${r.detail}`).join('; ')}` : `Sent ${plural(res.length, 'book')} to the ${d.name}.`)
    await refresh(d.id)
  })
}

document.addEventListener('click', async e => {
  const a = e.target.closest('[data-dev]')?.dataset.dev; if (!a) return
  const id = deviceFilter(H.filter()), d = devices.find(x => x.id === id); if (!d) return
  if (a === 'send') sendSheet(d)
  if (a === 'eject') { try { await invoke('eject_device', { id }); H.toast(`${d.name} ejected. You can unplug it.`) } catch (err) { H.toast(`Couldn't eject: ${err}`) } }
  if (a === 'bring') { banners.delete(id); bringIn(d) }
  if (a === 'notes') H.go('Notes')
  if (a === 'undo') {
    const b = banners.get(id); await invoke('undo_import', { batch: b.batch })
    banners.set(id, { ...b, added: 0, titles: [], undone: true }); H.toast(`Took ${plural(b.added, 'highlight')} back out. They won't come in again from this ${d.name}.`); await H.reload()
  }
  if (a === 'remove') {
    const path = e.target.closest('[data-path]').dataset.path
    await invoke('remove_from_device', { id, path }); H.toast('Removed from the device. Your library still has it.'); refresh(id)
  }
})
document.addEventListener('change', e => {
  if (e.target.dataset.dev !== 'bring-setting') return
  setSetting(`bring_in:${deviceFilter(H.filter())}`, e.target.value)
})
