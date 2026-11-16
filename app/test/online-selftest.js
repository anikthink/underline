// Find details online in the real app, through the Rust side (src-tauri/src/online.rs) to openlibrary.org.
// Run on a copy of the library: NIGHTSTAND_LIBRARY=<copy> NIGHTSTAND_SELFTEST=test/online-selftest.js
(async () => {
  const { invoke } = window.__TAURI__.core, W = ms => new Promise(r => setTimeout(r, ms)), R = { errs: [] }
  addEventListener('unhandledrejection', e => R.errs.push(String(e.reason?.stack ?? e.reason)))
  const key = (k, o = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }))
  const until = async (f, ms = 20000) => { for (let t = 0; t < ms && !f(); t += 100) await W(100); return f() }
  try {
    await W(500)
    R.refused = await invoke('online_get', { path: '/account/login' }).then(() => 'allowed!', e => String(e))
    const al = (await invoke('list_books')).find(b => b.title.startsWith('Alice'))
    document.querySelector(`[data-edit="${al.id}"]`).click(); await W(500)
    let t0 = performance.now()
    document.querySelector('[data-act="online"]').click()
    await until(() => document.querySelector('.ol-hit, .ol-msg:not(:has(.spin))'))
    R.searchMs = Math.round(performance.now() - t0)
    R.hits = [...document.querySelectorAll('.ol-hit')].slice(0, 3).map(h => h.innerText.replace(/\s+/g, ' '))
    t0 = performance.now()
    document.querySelector('.ol-hit').click()
    await until(() => document.querySelector('.ol-cmp'))
    R.loadMs = Math.round(performance.now() - t0)
    R.work = document.querySelector('.ol-work')?.innerText.replace(/\s+/g, ' ')
    R.rows = [...document.querySelectorAll('.ol-cmp tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').slice(0, 80))
    document.querySelector('[data-take="publisher"]')?.click(); await W(500)
    t0 = performance.now()
    document.querySelector('[data-olcover]').click()
    await until(() => !document.getElementById('toast').hidden, 30000)
    R.coverMs = Math.round(performance.now() - t0)
    R.toast = document.getElementById('toast').hidden ? null : document.getElementById('toast').textContent
    R.coverId = document.querySelector('[data-olcover]')?.dataset.olcover
    key('Escape'); await W(300); document.activeElement?.blur(); key('Escape'); await W(300)
    await until(async () => false, 0)
    for (let i = 0; i < 60 && (await invoke('list_books')).find(b => b.id === al.id).details?.pending; i++) await W(100)
    const after = (await invoke('list_books')).find(b => b.id === al.id)
    R.after = { file: after.file, publisher: after.details?.publisher, sources: after.details?.sources, openLibrary: after.details?.openLibrary, pending: after.details?.pending, newCover: after.details?.newCover }
  } catch (e) { R.errs.push(String(e.stack ?? e)) }
  await invoke('dev_log', { msg: 'SELFTEST ' + JSON.stringify(R) })
  await invoke('dev_exit')
})()
