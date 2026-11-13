# The Kindle-side half of matching: for each highlight in My Clippings.txt, find it in the
# AZW3's own text near its location number, and record the words around it there.
# Those words then pick the right place in the EPUB, even for a two-word highlight.
# Location n is roughly byte (n-1)*150 of the book's text, so this only works because
# Nightstand has the AZW3 (it made it, or can read it off the Kindle).
import sys, os, re, zipfile, html, json, unicodedata, mobi, shutil
azw_dir, clip_path, out = sys.argv[1:4]
def fold(s): return ''.join(c.lower() for c in unicodedata.normalize('NFKD', s) if c.isalnum())
books = {}
for f in os.listdir(azw_dir):
    if not f.endswith('.azw3'): continue
    tmp, path = mobi.extract(os.path.join(azw_dir, f))
    z = zipfile.ZipFile(path)
    opfn = [x for x in z.namelist() if x.endswith('.opf')][0]; opf = z.read(opfn).decode()
    title = html.unescape(re.search(r'<dc:title[^>]*>(.*?)</dc:title>', opf).group(1))
    man = {i: h for h, i in re.findall(r'<item[^>]*href="([^"]+)"[^>]*id="([^"]+)"', opf)} | dict(re.findall(r'<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf))
    F, offs, base = [], [], 0
    for idref in re.findall(r'<itemref[^>]*idref="([^"]+)"', opf):
        raw = z.read(os.path.join(os.path.dirname(opfn), man[idref]).lstrip('/')).decode('utf8', 'replace')
        for m in re.finditer(r'<[^>]*>|[^<]+', raw):
            if m.group().startswith('<'): continue
            for c in fold(html.unescape(m.group())): F.append(c); offs.append(base + m.start())
        base += len(raw.encode())
    books[fold(title)] = (''.join(F), offs)
    shutil.rmtree(tmp, ignore_errors=True)
res = {}
for e in open(clip_path, encoding='utf-8').read().split('=========='):
    L = [l.strip('﻿\r ') for l in e.strip('\r\n').split('\n')]
    if len(L) < 4 or 'Your Highlight' not in L[1]: continue
    t = fold(re.sub(r'\s*\([^()]*\)$', '', L[0])); text = '\n'.join(L[3:]).strip()
    B = next((v for k, v in books.items() if k == t or k.startswith(t) or t.startswith(k)), None)
    if not B: continue
    F, offs = B; q = fold(text); loc = int(re.search(r'Location (\d+)', L[1]).group(1))
    hits = [m.start() for m in re.finditer(re.escape(q), F)] if q else []
    if not hits: continue
    h = min(hits, key=lambda i: abs(offs[i] - (loc - 1) * 150))
    res[f'{L[0]}|{loc}|{text}'] = {'prefix': F[max(0, h - 40):h], 'suffix': F[h + len(q):h + len(q) + 40], 'kindleHits': len(hits), 'at': h, 'len': len(q)}
json.dump(res, open(out, 'w'), ensure_ascii=False)
print(len(res), 'highlights given context;', sum(1 for v in res.values() if v['kindleHits'] > 1), 'had more than one place in the AZW3')
