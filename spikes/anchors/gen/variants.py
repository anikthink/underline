# Make two rewritten copies of Middlemarch:
#  details.epub  - what Nightstand's Edit details does: new OPF metadata, new cover, zip rewritten
#  edition.epub  - a harsher case, like a corrected re-download: a new front page at the start of
#                  the spine, a new element at the top of every chapter, a few words fixed
import sys, zipfile, re, io, random
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
names = z.namelist()
opf = [n for n in names if n.endswith('.opf')][0]

def write(path, edit):
    w = zipfile.ZipFile(path, 'w')
    w.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
    for n in reversed(names):  # different order on purpose
        if n == 'mimetype': continue
        data = edit(n, z.read(n))
        if data is None: continue
        w.writestr(n, data, zipfile.ZIP_DEFLATED)
    for n, d in getattr(edit, 'extra', {}).items(): w.writestr(n, d, zipfile.ZIP_DEFLATED)
    w.close()

def details(n, data):
    if n == opf:
        s = data.decode()
        s = s.replace('<dc:title>Middlemarch</dc:title>', '<dc:title>Middlemarch: A Study of Provincial Life</dc:title>')
        s = s.replace('<dc:creator id="author_0">George Eliot</dc:creator>', '<dc:creator id="author_0">George Eliot</dc:creator>\n    <dc:creator id="author_1">Mary Ann Evans</dc:creator>')
        s = re.sub(r'<dc:subject>.*?</dc:subject>\s*', '', s)
        s = s.replace('</metadata>', '  <dc:subject>Classics</dc:subject>\n    <dc:subject>Book club 2026</dc:subject>\n    <meta property="belongs-to-collection" id="c1">Penguin Classics</meta>\n    <meta refines="#c1" property="group-position">3</meta>\n    <meta name="calibre:series" content="Penguin Classics"/>\n  </metadata>')
        return s.encode()
    if n.endswith('_cover.jpg'):
        im = Image.open(io.BytesIO(data)).convert('RGB').resize((800, 1200))
        b = io.BytesIO(); im.save(b, 'JPEG', quality=80); return b.getvalue()
    return data
write(f'{out}/details.epub', details)

FIX = [('Miss Brooke', 'Miss Brooke'), ('  ', ' ')]
rnd = random.Random(7)
def edition(n, data):
    if n == opf:
        s = data.decode()
        s = s.replace('<manifest>', '<manifest>\n    <item href="new-front.xhtml" id="new-front" media-type="application/xhtml+xml"/>')
        s = re.sub(r'(<spine[^>]*>)', r'\1\n    <itemref idref="new-front"/>', s)
        return s.encode()
    if n.endswith('.xhtml') and 'h-' in n:
        s = data.decode()
        # a new element before the first child of <body>: every element path shifts by one
        s = re.sub(r'(<body[^>]*>)', r'\1<p class="ed-note">This edition was corrected in 2026.</p>', s, 1)
        # fix a typo-like change in some paragraphs (changes text offsets inside them)
        s = re.sub(r'\bto-day\b', 'today', s)
        s = re.sub(r'\bto-morrow\b', 'tomorrow', s)
        return s.encode()
    return data
edition.extra = {'OEBPS/new-front.xhtml': '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Note</title></head><body><h1>About this edition</h1><p>Corrected text, 2026.</p></body></html>'}
write(f'{out}/edition.epub', edition)
print('ok')
