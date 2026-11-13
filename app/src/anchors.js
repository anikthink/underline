// Finding underlined words again when their CFI no longer points at them (spikes/anchors).
// Text is "folded" to letters and digits only, so quotes, dashes and line breaks don't matter.

const keep = /[\p{L}\p{N}]/u
export const fold = s => { let o = ''; for (const c of s.normalize('NFKD')) if (keep.test(c)) o += c.toLowerCase(); return o }

// Folded text of one section, with a map from each folded character back to its text node and offset
export function indexDoc(doc) {
  const w = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT)
  let F = ''; const nodes = [], offs = []
  for (let n; (n = w.nextNode());) {
    const v = n.nodeValue
    for (let k = 0; k < v.length; k++) for (const c of v[k].normalize('NFKD')) if (keep.test(c)) { F += c.toLowerCase(); nodes.push(n); offs.push(k) }
  }
  return { F, nodes, offs }
}

const agree = (a, b, rev) => { let n = 0; const L = Math.min(a.length, b.length); while (n < L && (rev ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++; return n }

// Look for the quote in each section in turn; best match by how much of the text around it agrees.
// Returns { index, range } or null.
export async function findQuote(book, { exact, prefix, suffix }, preferIndex) {
  const q = fold(exact), fp = fold(prefix).slice(-40), fs = fold(suffix).slice(0, 40)
  if (!q) return null
  const order = book.sections.map((_, i) => i).sort((a, b) => Math.abs(a - preferIndex) - Math.abs(b - preferIndex))
  let best = null
  for (const i of order) {
    const s = book.sections[i]; if (!s.createDocument) continue
    const doc = await s.createDocument(), X = indexDoc(doc)
    for (let h = X.F.indexOf(q); h >= 0; h = X.F.indexOf(q, h + 1)) {
      const score = agree(X.F.slice(Math.max(0, h - 40), h), fp, true) + agree(X.F.slice(h + q.length, h + q.length + 40), fs)
      if (!best || score > best.score) best = { score, index: i, doc, X, h }
    }
    if (best && best.score >= Math.min(80, fp.length + fs.length)) break   // a full match: no need to look further
  }
  if (!best) return null
  const { doc, X, h, index } = best, e = h + q.length - 1
  const range = doc.createRange()
  range.setStart(X.nodes[h], X.offs[h]); range.setEnd(X.nodes[e], X.offs[e] + 1)
  return { index, range }
}

// ---------- Highlights from a device (spikes/anchors, part two) ----------
// The whole book folded once; each highlight is found by its text, and when it occurs more than once,
// the occurrence nearest the device's position wins (a Kindle location, or a Kobo chapter file).
export async function indexBook(book) {
  const secs = []
  let total = 0
  for (const [i, s] of book.sections.entries()) {
    if (!s.createDocument || s.linear === 'no') { secs.push(null); continue }
    const doc = await s.createDocument(), X = indexDoc(doc)
    secs.push({ i, doc, X, start: total, href: s.id ?? '' }); total += X.F.length
  }
  return { secs: secs.filter(Boolean), total, bytes: book.sections.reduce((a, s) => a + (s.size ?? 0), 0) }
}

// at: { frac } (0–1 through the book) or { file } (a chapter file name). Returns { index, range, count } or null.
export function matchClip(ix, text, at = {}) {
  const q = fold(text); if (!q) return null
  const hits = []
  for (const s of ix.secs) for (let h = s.X.F.indexOf(q); h >= 0; h = s.X.F.indexOf(q, h + 1)) hits.push([s, h])
  if (!hits.length) return null
  const dist = ([s, h]) => at.file ? (s.href.endsWith(at.file) || at.file.endsWith(s.href) ? 0 : 1) + h / 1e9
    : at.frac != null ? Math.abs((s.start + h) / ix.total - at.frac) : 0
  // with the words around it on the device, the place whose surroundings agree most wins; position breaks ties
  const ctx = at.context && (([s, h]) => agree(s.X.F.slice(Math.max(0, h - 40), h), at.context[0], true) + agree(s.X.F.slice(h + q.length, h + q.length + 40), at.context[1]))
  const cost = x => (ctx ? -ctx(x) : 0) + dist(x)
  const [s, h] = hits.reduce((a, b) => cost(b) < cost(a) ? b : a)
  const e = h + q.length - 1, range = s.doc.createRange()
  range.setStart(s.X.nodes[h], s.X.offs[h]); range.setEnd(s.X.nodes[e], s.X.offs[e] + 1)
  return { index: s.i, range, count: hits.length }
}
