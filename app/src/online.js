// Find details online: Open Library search, its editions, and a field-by-field comparison with yours.
// `get` fetches one Open Library path and returns its JSON (null for "not found"). In the app that's the
// online_get command (src-tauri/src/online.rs); test/online-test.mjs passes fetch instead.

const LANGS = { eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru', dut: 'nl', nld: 'nl', jpn: 'ja', chi: 'zh', zho: 'zh', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', gre: 'el', ell: 'el', tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', kor: 'ko', lat: 'la', cze: 'cs', ces: 'cs', hun: 'hu', ukr: 'uk', ben: 'bn', ind: 'id', vie: 'vi', tha: 'th', per: 'fa', fas: 'fa', cat: 'ca', rum: 'ro', ron: 'ro', ice: 'is', isl: 'is', wel: 'cy', cym: 'cy', gle: 'ga' }
const lang = key => { const c = String(key ?? '').split('/').pop(); return LANGS[c] ?? c }
const year = s => String(s ?? '').match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1]
const text = v => typeof v === 'string' ? v : v?.value ?? ''
const q = s => encodeURIComponent(s).replace(/%20/g, '+')
export const coverUrl = (id, size = 'M') => `https://covers.openlibrary.org/b/id/${id}-${size}.jpg`

// Descriptions often end with a source line or a list of links; keep the prose
function cleanDescription(s) {
  return text(s).split(/\r?\n\s*-{3,}|\r?\n\s*\(\[source\]|\r?\nSee also:?/i)[0]
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const FIELDS = 'key,title,subtitle,author_name,first_publish_year,cover_i,edition_count,cover_edition_key'
const hit = d => ({ key: d.key, title: d.subtitle ? `${d.title}: ${d.subtitle}` : d.title, authors: d.author_name ?? [], year: d.first_publish_year, cover: d.cover_i, editions: d.edition_count ?? 0, edition: d.cover_edition_key && `/books/${d.cover_edition_key}` })

// Works that might be this book. With an ISBN, the work that edition belongs to comes first.
export async function search(get, { title = '', authors = [], isbn = '', query = '' }) {
  const out = []
  const add = (h, extra = {}) => { if (h?.key && !out.some(o => o.key === h.key)) out.push({ ...h, ...extra }) }
  if (isbn && !query) {
    const ed = await get(`/isbn/${q(isbn.replace(/[^0-9X]/gi, ''))}.json`)
    const wk = ed?.works?.[0]?.key
    if (wk) {
      const r = await get(`/search.json?q=key:${q(wk)}&fields=${FIELDS}&limit=1`)
      add(r?.docs?.[0] ? hit(r.docs[0]) : { key: wk, title: ed.title, authors: [], editions: 1 }, { edition: ed.key, isbnMatch: true })
    }
  }
  const short = title.split(':')[0].trim(), au = authors[0] ?? ''
  const tries = query ? [`q=${q(query)}`] : [...new Set([
    `title=${q(title)}&author=${q(au)}`,
    // Project Gutenberg style "Title: A Subtitle", or an author spelled differently
    `title=${q(short)}&author=${q(au)}`,
    `title=${q(short)}`,
  ])]
  const found = []
  for (const t of tries) {
    const r = await get(`/search.json?${t}&fields=${FIELDS}&limit=10`)
    found.push(...(r?.docs ?? []).map(hit))
    if (found.filter(h => h.editions > 1).length >= 3) break
  }
  // the work most editions belong to is nearly always the one meant; one-off reprints sink
  found.sort((a, b) => b.editions - a.editions).forEach(h => add(h))
  return out.slice(0, 8)
}

function edition(e) {
  const t = e.subtitle ? `${e.title}: ${e.subtitle}` : e.title
  const series = text(e.series?.[0]).trim()
  const num = series.match(/[;,]\s*(?:no\.?|#|v\.?|vol\.?|book)?\s*(\d+(?:\.\d+)?)\s*\.?$/i)
  return {
    key: e.key, title: t, publisher: e.publishers?.[0] ?? '', published: String(e.publish_date ?? ''),
    isbn: e.isbn_13?.[0] ?? e.isbn_10?.[0] ?? '', language: lang(e.languages?.[0]?.key),
    series: num ? series.slice(0, num.index).trim() : series, seriesIndex: num?.[1] ?? '',
    cover: (e.covers ?? []).find(c => c > 0), description: cleanDescription(e.description),
  }
}

// A work with its editions, best first for this book: same language, with an ISBN, with a cover, newest.
export async function load(get, workKey, { prefer, language } = {}) {
  const [w, eds] = await Promise.all([get(`${workKey}.json`), get(`${workKey}/editions.json?limit=100`)])
  if (!w) throw new Error('Open Library no longer has that book.')
  const authors = (await Promise.all((w.authors ?? []).slice(0, 6).map(a => a.author?.key && get(`${a.author.key}.json`)))).map(a => a?.name).filter(Boolean)
  const want = (language ?? 'en').slice(0, 2)
  const editions = (eds?.entries ?? []).map(edition).sort((a, b) =>
    (b.language === want) - (a.language === want) || !!b.isbn - !!a.isbn || !!b.cover - !!a.cover || (year(b.published) ?? 0) - (year(a.published) ?? 0))
  if (prefer && !editions.some(e => e.key === prefer)) { const p = await get(`${prefer}.json`); if (p) editions.unshift(edition(p)) }
  const covers = [...new Set([...editions.map(e => e.cover), ...(w.covers ?? [])].filter(c => c > 0))]
  return {
    key: w.key, title: w.subtitle ? `${w.title}: ${w.subtitle}` : w.title, authors, firstPublished: firstYear(w, editions),
    description: cleanDescription(w.description), editions, covers,
    edition: prefer && editions.some(e => e.key === prefer) ? prefer : editions[0]?.key,
  }
}

// The work's own date is often a reprint's, so take the earliest of it and every edition's. A year counts only
// when a different year lands within five years of it, and round centuries ("1800" for "18--", as three
// Middlemarch editions have it) only when there's nothing else.
function firstYear(w, editions) {
  let ys = [year(w.first_publish_date), ...editions.map(e => year(e.published))].filter(Boolean).map(Number)
  if (ys.some(y => y % 100)) ys = ys.filter(y => y % 100)
  ys = [...new Set(ys)].sort((a, b) => a - b)
  if (ys.length < 2) return ys[0] && String(ys[0])
  return String(ys.find((y, i) => ys[i + 1] - y <= 5) ?? ys[0])
}

// What Open Library says for each field, for one edition of the work. The title is the work's: edition titles
// carry things like "Second Edition (Norton Critical Editions)".
export function fieldsFrom(work, editionKey) {
  const e = work.editions.find(x => x.key === editionKey) ?? {}
  return {
    title: work.title || e.title, authors: work.authors.join(', '), published: e.published, publisher: e.publisher,
    language: e.language, isbn: e.isbn, series: e.series, seriesIndex: e.seriesIndex, description: e.description || work.description,
  }
}

export const ROWS = [['title', 'Title'], ['authors', 'Authors'], ['published', 'Published'], ['publisher', 'Publisher'], ['language', 'Language'], ['isbn', 'ISBN'], ['series', 'Series'], ['seriesIndex', 'Number'], ['description', 'Description']]
const norm = s => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Each field side by side. `yours` is { title, authors (text), ...details }.
export function compare(yours, theirs) {
  return ROWS.map(([k, name]) => {
    const a = String(yours[k] ?? ''), b = String(theirs[k] ?? '')
    const same = norm(a) === norm(b) || (k === 'isbn' && a.replace(/\D/g, '') === b.replace(/\D/g, ''))
    return { k, name, yours: a, theirs: b, same, takeable: !!b.trim() && !same }
  })
}

export function editionLabel(e) {
  return [e.publisher || 'Unknown publisher', e.published, e.language && e.language.toUpperCase(), e.isbn && `ISBN ${e.isbn}`].filter(Boolean).join(' · ')
}
