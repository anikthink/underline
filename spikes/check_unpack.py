import sys, os, zipfile, re, json, mobi, shutil
out = {}
for f in sorted(os.listdir(sys.argv[1])):
    if not f.endswith('.azw3'): continue
    tmp, path = mobi.extract(os.path.join(sys.argv[1], f))
    r = {'extracted': os.path.basename(path)}
    if path.endswith('.epub'):
        z = zipfile.ZipFile(path); names = z.namelist()
        r['xhtml'] = len([n for n in names if n.endswith(('.xhtml', '.html'))])
        r['images'] = len([n for n in names if n.lower().endswith(('.jpg', '.jpeg', '.png', '.gif'))])
        ncx = [n for n in names if n.endswith('.ncx')]
        if ncx:
            t = z.read(ncx[0]).decode('utf8', 'replace')
            labels = re.findall(r'<text>(.*?)</text>', t)
            r['toc_entries'] = len(labels) - 1
            r['toc_sample'] = labels[1:5] + ['…'] + labels[-2:]
        text = ' '.join(re.sub(r'<[^>]+>', ' ', z.read(n).decode('utf8', 'replace')) for n in names if n.endswith(('.xhtml', '.html')))
        r['words'] = len(text.split())
        opf = [n for n in names if n.endswith('.opf')][0]
        o = z.read(opf).decode('utf8', 'replace')
        r['title'] = re.search(r'<dc:title[^>]*>(.*?)</dc:title>', o).group(1)
        r['cover_meta'] = 'name="cover"' in o
    out[f] = r
    shutil.rmtree(tmp, ignore_errors=True)
print(json.dumps(out, indent=1, ensure_ascii=False))
