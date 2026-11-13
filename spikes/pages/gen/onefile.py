# Worst case for the pages layout: the whole of Middlemarch in one XHTML file.
# Some EPUBs really are built like this, and the web view has to lay out all of it at once.
import sys, zipfile, re
src, dst = sys.argv[1:3]
z = zipfile.ZipFile(src); names = z.namelist()
opfn = [n for n in names if n.endswith('.opf')][0]; opf = z.read(opfn).decode()
base = opfn.rsplit('/', 1)[0] + '/'
man = {i: h for h, i in re.findall(r'<item[^>]*href="([^"]+)"[^>]*id="([^"]+)"', opf)}
spine = re.findall(r'<itemref[^>]*idref="([^"]+)"', opf)
body = [h for h in (man[i] for i in spine) if h.endswith('.xhtml') and '-h-' in h]
first = z.read(base + body[0]).decode()
parts = [re.search(r'<body[^>]*>(.*)</body>', z.read(base + h).decode(), re.S).group(1) for h in body]
one = re.sub(r'(<body[^>]*>).*(</body>)', lambda m: m.group(1) + '\n'.join(parts) + m.group(2), first, flags=re.S)
w = zipfile.ZipFile(dst, 'w'); w.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
for n in names:
    if n == 'mimetype' or n in [base + h for h in body[1:]]: continue
    d = z.read(n)
    if n == base + body[0]: d = one.encode()
    if n == opfn:
        s = opf
        for h in body[1:]:
            i = [k for k, v in man.items() if v == h][0]
            s = re.sub(rf'\s*<itemref[^>]*idref="{re.escape(i)}"[^>]*/>', '', s)
            s = re.sub(rf'\s*<item[^>]*id="{re.escape(i)}"[^>]*/>', '', s)
        d = s.encode()
    if n.endswith(('.ncx', 'nav.xhtml')) or n.endswith('toc.xhtml'):
        s = d.decode()
        for h in body[1:]: s = s.replace(h, body[0])
        d = s.encode()
    w.writestr(n, d, zipfile.ZIP_DEFLATED)
w.close(); print(len(body), 'files merged,', len(one) // 1024, 'KB in one file')
