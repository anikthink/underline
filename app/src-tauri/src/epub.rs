//! Reading what the library needs from an EPUB: title, authors, cover, and the size of each
//! content file. The Reader itself (foliate-js) does the real rendering.

use std::io::{Read, Seek};
use zip::ZipArchive;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Meta {
    pub title: String,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub identifier: Option<String>,
    pub cover: Option<Vec<u8>>,
    /// Size in bytes of the largest content file. Over about 300 KB, WebKit gets slow (spikes/pages).
    pub largest_file: u64,
}

const OPF_NS: &str = "http://www.idpf.org/2007/opf";
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";

pub fn read<R: Read + Seek>(reader: R) -> Result<Meta, String> {
    let mut zip = ZipArchive::new(reader).map_err(|e| format!("not a zip file: {e}"))?;
    let container = read_text(&mut zip, "META-INF/container.xml")?;
    let doc = roxmltree::Document::parse(&container).map_err(|e| format!("bad container.xml: {e}"))?;
    let opf_path = doc
        .descendants()
        .find(|n| n.has_tag_name("rootfile"))
        .and_then(|n| n.attribute("full-path"))
        .ok_or("container.xml names no package file")?
        .to_string();
    let base = match opf_path.rfind('/') {
        Some(i) => opf_path[..=i].to_string(),
        None => String::new(),
    };
    let opf = read_text(&mut zip, &opf_path)?;
    let doc = roxmltree::Document::parse(&opf).map_err(|e| format!("bad package file: {e}"))?;

    let dc = |name: &str| -> Vec<String> {
        doc.descendants()
            .filter(|n| n.tag_name().name() == name && n.tag_name().namespace() == Some(DC_NS))
            .map(|n| n.text().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut meta = Meta {
        title: dc("title").into_iter().next().unwrap_or_default(),
        authors: dc("creator"),
        language: dc("language").into_iter().next(),
        identifier: dc("identifier").into_iter().next(),
        ..Default::default()
    };

    let items: Vec<_> = doc
        .descendants()
        .filter(|n| n.has_tag_name((OPF_NS, "item")) || n.has_tag_name("item"))
        .collect();
    let href = |n: &roxmltree::Node| resolve(&base, n.attribute("href").unwrap_or(""));

    // EPUB 3 marks the cover with a property; EPUB 2 points at it from <meta name="cover">
    let cover_item = items
        .iter()
        .find(|n| n.attribute("properties").is_some_and(|p| p.split_whitespace().any(|p| p == "cover-image")))
        .or_else(|| {
            let id = doc
                .descendants()
                .find(|n| n.has_tag_name("meta") && n.attribute("name") == Some("cover"))?
                .attribute("content")?;
            items.iter().find(|n| n.attribute("id") == Some(id))
        });
    if let Some(item) = cover_item {
        meta.cover = read_bytes(&mut zip, &href(item)).ok();
    }

    for item in &items {
        let kind = item.attribute("media-type").unwrap_or("");
        if kind == "application/xhtml+xml" || kind == "text/html" {
            if let Ok(file) = zip.by_name(&href(item)) {
                meta.largest_file = meta.largest_file.max(file.size());
            }
        }
    }
    Ok(meta)
}

/// Join an href from the package file onto its folder, undoing percent-encoding and "../".
fn resolve(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or("");
    let mut parts: Vec<String> = base.split('/').filter(|p| !p.is_empty()).map(String::from).collect();
    for p in percent_decode(href).split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p.to_string()),
        }
    }
    parts.join("/")
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn read_bytes<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<Vec<u8>, String> {
    let mut f = zip.by_name(name).map_err(|_| format!("{name} is missing"))?;
    let mut v = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut v).map_err(|e| e.to_string())?;
    Ok(v)
}

fn read_text<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<String, String> {
    let v = read_bytes(zip, name)?;
    Ok(String::from_utf8_lossy(v.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&v)).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_hrefs() {
        assert_eq!(resolve("OEBPS/", "images/cover%20art.jpg"), "OEBPS/images/cover art.jpg");
        assert_eq!(resolve("OEBPS/text/", "../img/a.png#x"), "OEBPS/img/a.png");
        assert_eq!(resolve("", "a.xhtml"), "a.xhtml");
    }

    #[test]
    fn reads_gutenberg_books() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spikes/azw3/books");
        let Ok(entries) = std::fs::read_dir(dir) else { return };  // the test books aren't in the repo
        for e in entries.flatten() {
            let m = read(std::fs::File::open(e.path()).unwrap()).unwrap();
            assert!(!m.title.is_empty(), "{:?}", e.path());
            assert!(!m.authors.is_empty(), "{:?}", e.path());
            assert!(m.cover.as_ref().is_some_and(|c| c.len() > 1000), "{:?}", e.path());
            assert!(m.largest_file > 0);
        }
    }
}
