# Build a My Clippings.txt the way a Kindle would, from the AZW3 files our converter made.
# Text comes from KindleUnpack's view of each AZW3, so it is the Kindle's text, not the EPUB's.
# Writes My Clippings.txt and truth.json (what each highlight really was, for scoring).
import sys, os, re, zipfile, html, json, random, shutil, datetime, mobi
azw_dir, out = sys.argv[1], sys.argv[2]
rnd = random.Random(30)
PLAN = {'pg145': 120, 'pg1342': 60, 'pg11': 30, 'pg84': 40}
entries, truth = [], []
when = datetime.datetime(2026, 9, 1, 21, 0)

def stamp():
    global when
    when += datetime.timedelta(minutes=rnd.randint(1, 600))
    return when.strftime('%A, %-d %B %Y %H:%M:%S')

def entry(head, kind, loc, text):
    entries.append(f'{head}\r\n- Your {kind} on Location {loc} | Added on {stamp()}\r\n\r\n{text}\r\n==========')

for name, n in PLAN.items():
    tmp, path = mobi.extract(os.path.join(azw_dir, name + '.azw3'))
    z = zipfile.ZipFile(path)
    opfn = [x for x in z.namelist() if x.endswith('.opf')][0]
    opf = z.read(opfn).decode()
    title = html.unescape(re.search(r'<dc:title[^>]*>(.*?)</dc:title>', opf).group(1))
    author = html.unescape(re.search(r'<dc:creator[^>]*>(.*?)</dc:creator>', opf).group(1))
    head = f'{title} ({author})'
    head = '\ufeff' + head  # real Kindles start every entry's title with a BOM
    man = dict(re.findall(r'<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf)) | {i: h for h, i in re.findall(r'<item[^>]*href="([^"]+)"[^>]*id="([^"]+)"', opf)}
    spine = re.findall(r'<itemref[^>]*idref="([^"]+)"', opf)
    base = os.path.dirname(opfn)
    paras, raw_off = [], 0
    for idref in spine:
        raw = z.read(os.path.join(base, man[idref]).lstrip('/')).decode('utf8', 'replace')
        for m in re.finditer(r'<p\b[^>]*>(.*?)</p>', raw, re.S):
            t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', m.group(1)))).strip()
            if t: paras.append((raw_off + m.start(), t))
        raw_off += len(raw.encode())
    shutil.rmtree(tmp, ignore_errors=True)
    total = raw_off
    loc = lambda off: off // 150 + 1
    chosen = sorted(rnd.sample([i for i, p in enumerate(paras) if len(p[1].split()) >= 6], n))
    for k, i in enumerate(chosen):
        off, t = paras[i]
        words = t.split(' ')
        r = rnd.random()
        if r < 0.12 and i + 1 < len(paras):            # crosses into the next paragraph
            a = rnd.randint(max(0, len(words) - 12), len(words) - 1)
            nxt = paras[i + 1][1].split(' ')
            b = rnd.randint(2, min(15, len(nxt)))
            joiner = rnd.choice([' ', ''])
            text = ' '.join(words[a:]) + joiner + ' '.join(nxt[:b])
            kind = 'cross'
            ctx_after = paras[i + 1][1][len(' '.join(nxt[:b])):][:60]
            ctx_before = ' '.join(words[:a])[-60:]
        else:
            if r < 0.25: ln = rnd.randint(2, 3); kind = 'short'
            else: ln = rnd.randint(5, min(60, len(words))); kind = 'span'
            a = rnd.randint(0, max(0, len(words) - ln))
            text = ' '.join(words[a:a + ln])
            ctx_before = ' '.join(words[:a])[-60:]
            ctx_after = ' '.join(words[a + ln:])[:60]
        l1 = loc(off + 40); l2 = l1 + max(0, len(text) // 150)
        if rnd.random() < 0.06 and kind == 'span' and len(text.split()) > 8:
            # highlighted, then extended: the Kindle keeps both entries
            first = ' '.join(text.split()[:len(text.split()) // 2])
            entry(head, 'Highlight', f'{l1}-{l1 + len(first) // 150}', first)
            kind = 'extended'
        entry(head, 'Highlight', f'{l1}-{l2}', text)
        truth.append({'book': name, 'head': head.lstrip('﻿'), 'text': text, 'kind': kind, 'before': ctx_before, 'after': ctx_after, 'loc': l1, 'frac': off / total})
        if rnd.random() < 0.08:
            entry(head, 'Note', l2, rnd.choice(['compare ch. 20', 'so true', 'ask the book club about this', 'cf. Dorothea']))
        if rnd.random() < 0.05:
            entry(head, 'Bookmark', l1, '')
    truth_meta = {'book': name, 'maxloc': loc(total)}
    truth.append({'meta': truth_meta})
# a book that isn't in the library
for t in ['We are the Martians of our own lives.', 'A very short one.']:
    entry('\ufeffSapiens: A Brief History of Humankind (Yuval Noah Harari)', 'Highlight', '1200-1201', t)
open(os.path.join(out, 'My Clippings.txt'), 'w', encoding='utf-8', newline='').write('\r\n'.join(entries) + '\r\n')
json.dump(truth, open(os.path.join(out, 'truth.json'), 'w'), ensure_ascii=False, indent=0)
print(len(entries), 'entries,', len([t for t in truth if 'text' in t]), 'highlights')
