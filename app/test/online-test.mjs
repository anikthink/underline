// Live check of src/online.js against openlibrary.org:  node test/online-test.mjs
import { search, load, fieldsFrom, compare, editionLabel } from '../src/online.js'
const get = async p => { const r = await fetch('https://openlibrary.org' + p, { headers: { 'User-Agent': 'Nightstand/0.1 (desktop ebook app)' } }); return r.status === 404 ? null : r.json() }
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1 }

// a Project Gutenberg book: long title, no ISBN
let t = Date.now()
const mm = await search(get, { title: 'Middlemarch: A Study of Provincial Life', authors: ['George Eliot'] })
ok(mm[0]?.key === '/works/OL20867W' && mm[0].authors.includes('George Eliot'), `Middlemarch found first (${Date.now() - t} ms): ${mm.slice(0, 3).map(h => `${h.title} ${h.key} ${h.editions}`).join(' | ')}`)
t = Date.now()
const w = await load(get, mm[0].key, { prefer: mm[0].edition, language: 'en' })
ok(w.authors[0] === 'George Eliot' && w.editions.length > 20 && w.covers.length > 3 && w.description.length > 100, `work loaded (${Date.now() - t} ms): ${w.editions.length} editions, ${w.covers.length} covers`)
const f = fieldsFrom(w, w.edition)
ok(+w.firstPublished >= 1869 && +w.firstPublished <= 1874, `first published ${w.firstPublished}`)
console.log('     edition:', editionLabel(w.editions.find(e => e.key === w.edition)))
const rows = compare({ title: 'Middlemarch: A Study of Provincial Life', authors: 'George Eliot', language: 'en', publisher: 'Project Gutenberg', published: '1994-07-01' }, f)
for (const r of rows) console.log(`     ${r.same ? '=' : r.takeable ? '≠' : ' '} ${r.name}: ${r.yours.slice(0, 30)} | ${r.theirs.slice(0, 40)}`)
ok(rows.find(r => r.k === 'title').same && rows.find(r => r.k === 'authors').same && rows.find(r => r.k === 'language').same, 'title, author, language agree')
ok(rows.find(r => r.k === 'publisher').takeable, `publisher differs: ${f.publisher}`)
console.log('     description:', f.description.slice(0, 120).replace(/\n/g, ' '), '…')

// by ISBN: that exact edition is chosen
const ab = await search(get, { title: 'Pride and Prejudice', authors: ['Jane Austen'], isbn: '9780141439518' })
ok(ab[0]?.isbnMatch && ab[0].title.startsWith('Pride and Prejudice'), `ISBN match first: ${ab[0]?.title} ${ab[0]?.edition}`)
const pw = await load(get, ab[0].key, { prefer: ab[0].edition })
const pf = fieldsFrom(pw, pw.edition)
ok(pf.isbn.replace(/\D/g, '') === '9780141439518', `chosen edition has the ISBN: ${editionLabel(pw.editions.find(e => e.key === pw.edition))}`)

// something that isn't there
const none = await search(get, { title: 'Zzqxv Nonexistent Volume', authors: ['Nobody Atall'] })
ok(none.length === 0, 'nothing found for a made-up book')
