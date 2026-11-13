// Run with pretend devices: NIGHTSTAND_VOLUMES=<folder with a Kindle and a Kobo> NIGHTSTAND_SELFTEST=test/devices-selftest.js
// Checks what came in on connect, sending a book to the Kindle, taking an import back out, and removing from a device.
(async () => {
  const { invoke } = window.__TAURI__.core, W = ms => new Promise(r => setTimeout(r, ms)), $ = id => document.getElementById(id), R = { errs: [] }
  addEventListener('unhandledrejection', e => R.errs.push(String(e.reason?.stack ?? e.reason)))
  try {
    // highlights come in on connect; wait for both devices' imports to finish
    let notes = []
    for (let i = 0; i < 120; i++) { await W(500); notes = await invoke('list_notes'); if (notes.length >= 240 && (await invoke('list_books')).some(b => b.status === 'Reading')) break }
    R.sidebar = $('filters').innerText.replace(/\s+/g, ' ')
    R.notes = { total: notes.length, byBook: Object.entries(notes.reduce((m, n) => (m[n.title] = (m[n.title] ?? 0) + 1, m), {})), withNotes: notes.filter(n => n.note).length, kobo: notes.find(n => n.exact.startsWith('We are all humiliated'))?.note }
    // every underline as placed, for checking against spikes/anchors/books/truth.json
    await invoke('dev_log', { msg: 'NOTESDUMP ' + JSON.stringify(notes.map(n => [n.title, n.exact, n.prefix, n.suffix])) })
    R.statuses = (await invoke('list_books')).map(b => [b.title.slice(0, 20), b.status, Math.round(b.fraction * 100)])
    document.querySelector('[data-f="device:Kindle"]').click(); await W(600)
    R.kindlePage = $('shelf').innerText.slice(0, 600).replace(/\s+/g, ' ')
    // send Alice
    document.querySelector('[data-dev="send"]').click(); await W(200)
    const alice = [...document.querySelectorAll('.srow')].find(r => r.textContent.includes('Alice'))
    alice.querySelector('input').click(); alice.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }))
    const t0 = performance.now(); document.querySelector('[data-go]').click()
    for (let i = 0; i < 60 && !/Sent /.test($('toast').textContent); i++) await W(250)
    R.send = { toast: $('toast').textContent, ms: Math.round(performance.now() - t0) }
    await W(500)
    const kc = await invoke('device_contents', { id: 'Kindle' })
    R.kindleContents = kc.map(b => [b.title, b.format, b.bookId != null])
    // take the Kindle import back out
    const before = (await invoke('list_notes')).length
    document.querySelector('[data-dev="undo"]')?.click(); await W(1500)
    R.undo = { before, after: (await invoke('list_notes')).length, comesBack: (await invoke('device_clips', { id: 'Kindle' })).filter(c => c.bookId != null).length }
    // remove Alice from the Kindle
    await invoke('remove_from_device', { id: 'Kindle', path: kc.find(b => b.title.startsWith('Alice')).path })
    R.afterRemove = (await invoke('device_contents', { id: 'Kindle' })).length
    document.querySelector('[data-f="device:KOBOeReader"]').click(); await W(600)
    R.koboPage = $('shelf').innerText.slice(0, 500).replace(/\s+/g, ' ')
  } catch (e) { R.errs.push(String(e.stack ?? e)) }
  await invoke('dev_log', { msg: 'SELFTEST ' + JSON.stringify(R) })
  await invoke('dev_exit')
})()
