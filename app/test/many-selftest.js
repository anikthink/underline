// Editing several books together in the real app: ⌘-click two, set a series numbered in order, apply, undo.
// Run on a copy of the library: NIGHTSTAND_LIBRARY=<copy> NIGHTSTAND_SELFTEST=test/many-selftest.js
(async () => {
  const { invoke } = window.__TAURI__.core, W = ms => new Promise(r => setTimeout(r, ms)), R = { errs: [] }
  addEventListener('unhandledrejection', e => R.errs.push(String(e.reason?.stack ?? e.reason)))
  const click = (el, o = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...o }))
  const until = async (f, ms = 20000) => { for (let t = 0; t < ms && !f(); t += 100) await W(100); return f() }
  const set = (k, v) => { const el = document.querySelector(`[data-m="${k}"]`); if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
  try {
    await W(500)
    const cards = [...document.querySelectorAll('#shelf .bk[data-id]')].slice(0, 2)
    click(cards[0], { metaKey: true }); click(cards[1], { metaKey: true }); await W(200)
    R.bar = document.getElementById('selbar').innerText.replace(/\s+/g, ' ')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))
    await until(() => document.querySelector('[data-act="m-apply"]'))
    set('series', 'Nightstand test'); set('number', true); await W(100); set('addShelves', 'Testing')
    const t0 = performance.now()
    click(document.querySelector('[data-act="m-apply"]'))
    await until(() => document.querySelector('.mb-done'))
    R.applyMs = Math.round(performance.now() - t0)
    const ids = cards.map(c => +c.dataset.id), get = async () => (await invoke('list_books')).filter(b => ids.includes(b.id))
    R.applied = (await get()).map(b => [b.title.slice(0, 20), b.file, b.details.series, b.details.seriesIndex, b.details.shelves, b.details.pending])
    R.files = (await get()).map(b => b.file)
    click(document.querySelector('[data-act="m-undo"]'))
    await until(() => document.querySelector('[data-act="m-apply"]'))
    R.undone = (await get()).map(b => [b.title.slice(0, 20), b.details.series, b.details.seriesIndex, b.details.shelves])
  } catch (e) { R.errs.push(String(e.stack ?? e)) }
  await invoke('dev_log', { msg: 'SELFTEST ' + JSON.stringify(R) })
  await invoke('dev_exit')
})()
