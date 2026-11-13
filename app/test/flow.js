// One pass through the Reader in whatever engine loads harness.html: open Middlemarch, go to chapter 35,
// underline with key 1, change size there and back, reopen. Sets window.TR to a JSON report.
window.T ??= (async () => {
  const W = ms => new Promise(r => setTimeout(r, ms)), $ = id => document.getElementById(id), R = { errs: [] }
  addEventListener('unhandledrejection', e => R.errs.push(String(e.reason?.stack ?? e.reason)))
  addEventListener('error', e => R.errs.push(e.message))
  try {
    while (!window.READY) await W(100)
    document.querySelector('.bk[data-id="1"]').click()
    for (let i = 0; i < 100 && !/^p\./.test($('page').textContent); i++) await W(100)
    const v = document.querySelector('foliate-view')
    const flat = []; const walk = l => l?.forEach(x => { flat.push(x); walk(x.subitems) }); walk(v.book.toc)
    await v.goTo(flat.find(x => /^CHAPTER XXXV\.?$/i.test(x.label.trim())).href); await W(800)
    R.page = $('page').textContent
    const { doc } = v.renderer.getContents()[0]
    const p = [...doc.querySelectorAll('p')].find(p => p.textContent.includes('When the animals entered the Ark'))
    const tn = p.firstChild, s = tn.nodeValue.indexOf('When'), r = doc.createRange()
    r.setStart(tn, s); r.setEnd(tn, s + 41); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r)
    doc.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await W(150)
    R.menu = $('pop').hidden ? 'hidden' : $('pop').innerText.replace(/\s+/g, ' ')
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); await W(500)
    const db = () => JSON.parse(localStorage.getItem('harness-db'))
    R.saved = db().underlines.map(u => [u.label, u.exact])
    R.drawn = v.renderer.getContents()[0].overlayer?.element?.querySelectorAll('rect').length ?? 'no overlayer'
    const words = () => document.querySelector('foliate-view').lastLocation.range.toString().replace(/\s+/g, ' ').trim()
    for (let i = 0; i < 2; i++) { await v.next(); await W(200) }
    await W(500); const a = words().slice(0, 40), pa = $('page').textContent
    for (let i = 0; i < 9; i++) $('bigger').click(); await W(1500); const pb = $('page').textContent, kept = words().includes(a.slice(12, 30))
    for (let i = 0; i < 9; i++) $('smaller').click(); await W(1500)
    R.size = { before: pa, at24: pb, after: $('page').textContent, wordStillOnScreenAt24: kept, sameScreenAfter: words().slice(0, 40) === a }
    $('back').click(); await W(800)
    document.querySelector('.bk[data-id="1"]').click(); await W(2500)
    R.reopened = { page: $('page').textContent, sameScreen: words().slice(0, 40) === a, underlines: db().underlines.length }
  } catch (e) { R.errs.push(String(e.stack ?? e)) }
  window.TR = JSON.stringify(R)
})()
