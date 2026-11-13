// Run on a copy of the library: NIGHTSTAND_LIBRARY=<copy> NIGHTSTAND_SELFTEST=test/details-selftest.js; window.COVER is an image path.
(async () => {
  const { invoke } = window.__TAURI__.core, W = ms => new Promise(r => setTimeout(r, ms)), R = { errs: [] }
  addEventListener('unhandledrejection', e => R.errs.push(String(e.reason?.stack ?? e.reason)))
  const key = (k, o = {}, t = document.body) => t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }))
  try {
    await W(500)
    const mm = (await invoke('list_books')).find(b => b.title === 'Middlemarch')
    document.querySelector(`[data-edit="${mm.id}"]`).click(); await W(500)
    R.fromFile = Object.fromEntries([...document.querySelectorAll('#details [data-f]')].map(f => [f.dataset.f, f.value.slice(0, 40)]))
    const set = (f, v) => { const el = document.querySelector(`#details [data-f="${f}"]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('title', 'Middlemarch: A Study of Provincial Life'); await W(100)
    set('series', 'Penguin Classics'); set('seriesIndex', '3'); set('shelves', 'Book club, Victorian'); await W(700)
    await invoke('set_cover', { id: mm.id, path: window.COVER })
    const t0 = performance.now()
    document.activeElement?.blur(); key('Escape'); await W(200)
    for (let i = 0; i < 40 && (await invoke('list_books')).find(b => b.id === mm.id).details?.pending; i++) await W(100)
    R.commitMs = Math.round(performance.now() - t0)
    const after = (await invoke('list_books')).find(b => b.id === mm.id)
    R.after = { file: after.file, title: after.title, pending: after.details?.pending, shelves: after.details?.shelves, card: document.querySelector(`.bk[data-id="${mm.id}"] .t`)?.textContent }
  } catch (e) { R.errs.push(String(e.stack ?? e)) }
  await invoke('dev_log', { msg: 'SELFTEST ' + JSON.stringify(R) })
  await invoke('dev_exit')
})()
