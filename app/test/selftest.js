// Run inside the real app: NIGHTSTAND_SELFTEST=app/test/selftest.js app/src-tauri/target/debug/nightstand
// Checks the library, opens Middlemarch, underlines with key 1, changes size there and back, reopens,
// then removes the test underline, prints a JSON report and quits.
(async () => {
  const { invoke } = window.__TAURI__.core, W = ms => new Promise(r => setTimeout(r, ms)), $ = id => document.getElementById(id), R = { errs: [] }
  addEventListener('unhandledrejection', e => R.errs.push(String(e.reason?.stack ?? e.reason)))
  try {
    await W(500)
    const imgs = [...document.querySelectorAll('.cv img')]
    await W(800)
    R.library = { books: document.querySelectorAll('.bk').length, coversShown: imgs.filter(i => i.complete && i.naturalWidth > 0).length, filters: $('filters').innerText.replace(/\s+/g, ' ') }
    const card = [...document.querySelectorAll('.bk')].find(b => b.title === 'Middlemarch')
    const t0 = performance.now(); card.click()
    for (let i = 0; i < 150 && !/^p\./.test($('page').textContent); i++) await W(50)
    R.openMs = Math.round(performance.now() - t0)
    // only opening a book doesn't start it
    $('back').click(); await W(500)
    R.statusAfterJustOpening = (await invoke('list_books')).find(b => b.title === 'Middlemarch').status
    // the shelf was redrawn on the way back, so find the card again
    document.querySelector('.bk[title="Middlemarch"]').click()
    for (let i = 0; i < 150 && !(document.querySelector('foliate-view')?.lastLocation && /^p\./.test($('page').textContent)); i++) await W(50)
    const v = document.querySelector('foliate-view')
    await W(300)
    const flat = []; const walk = l => l?.forEach(x => { flat.push(x); walk(x.subitems) }); walk(v.book.toc)
    await v.goTo(flat.find(x => /^CHAPTER XXXV\.?$/i.test(x.label.trim())).href); await W(800)
    R.page = $('page').textContent
    const { doc } = v.renderer.getContents()[0]
    const p = [...doc.querySelectorAll('p')].find(p => p.textContent.includes('When the animals entered the Ark'))
    const tn = p.firstChild, s = tn.nodeValue.indexOf('When'), r = doc.createRange()
    r.setStart(tn, s); r.setEnd(tn, s + 41); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r)
    doc.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await W(150)
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); await W(500)
    const book = (await invoke('list_books')).find(b => b.title === 'Middlemarch')
    let us = await invoke('list_underlines', { bookId: book.id })
    R.saved = us.map(u => [u.label, u.exact])
    const words = () => document.querySelector('foliate-view').lastLocation.range.toString().replace(/\s+/g, ' ').trim()
    for (let i = 0; i < 2; i++) { await v.next(); await W(200) }
    await W(500); const a = words().slice(0, 40), pa = $('page').textContent
    for (let i = 0; i < 9; i++) $('bigger').click(); await W(1500); const pb = $('page').textContent, kept = words().includes(a.slice(12, 30))
    for (let i = 0; i < 9; i++) $('smaller').click(); await W(1500)
    R.size = { before: pa, at24: pb, after: $('page').textContent, wordStillOnScreenAt24: kept, sameScreenAfter: words().slice(0, 40) === a }
    $('back').click(); await W(800)
    document.querySelector('.bk[title="Middlemarch"]').click(); await W(2500)
    R.reopened = { page: $('page').textContent, sameScreen: words().slice(0, 40) === a }
    // Notes and export, into a throwaway folder given by NIGHTSTAND_EXPORT_TEST
    $('back').click(); await W(800)
    document.querySelector('[data-f="Notes"]').click(); await W(400)
    R.notes = { rows: document.querySelectorAll('.nt').length, revisit: !!document.querySelector('.rv'), first: document.querySelector('.nt .nm')?.textContent }
    const folder = window.EXPORT_TEST
    if (folder) {
      R.exported = await invoke('set_export', { folder, keep: true })
      await invoke('relabel_underline', { id: (await invoke('list_underlines', { bookId: book.id }))[0].id, label: 2 })
    }
    us = await invoke('list_underlines', { bookId: book.id })
    for (const u of us) await invoke('remove_underline', { id: u.id })
    R.cleanedUp = us.length
    if (folder) await invoke('set_export', { folder: null, keep: false })
    R.statusAfterTurning = (await invoke('list_books')).find(b => b.title === 'Middlemarch').status

    // ⌘K in the library, a setting changed through the event round trip, and the Settings window
    const key = (k, o = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }))
    const type = v => { const q = $('pq'); q.value = v; q.dispatchEvent(new Event('input')) }
    key('k', { metaKey: true }); await W(150)
    type('alice'); await W(100)
    R.palette = [...document.querySelectorAll('#pres .pr')].map(r => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 50))
    key('Escape'); $('pq').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await W(100)
    await invoke('set_setting', { key: 'theme', value: 'dark' }); await W(300)
    R.themeApplied = document.documentElement.dataset.theme
    await invoke('set_setting', { key: 'theme', value: null }); await W(300)
    R.themeCleared = document.documentElement.dataset.theme ?? 'match'
    await invoke('open_settings'); await W(1200)
    R.settingsWindow = (await window.__TAURI__.window.getAllWindows?.())?.map(w => w.label) ?? 'opened'
  } catch (e) { R.errs.push(String(e.stack ?? e)) }
  await invoke('dev_log', { msg: 'SELFTEST ' + JSON.stringify(R) })
  await invoke('dev_exit')
})()
