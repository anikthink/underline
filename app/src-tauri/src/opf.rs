//! Writing edited details back into an EPUB, so other apps and devices see them too.
//! Only the package file's metadata (and the cover image, if a new one was chosen) change; the chapters are
//! copied untouched, which keeps underline CFIs valid (spikes/anchors: Edit details kept 300 of 300).

use crate::epub;
use regex::Regex;
use std::io::{Cursor, Read, Write};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

#[derive(Debug, Default, Clone)]
pub struct FileDetails {
    pub title: String,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub published: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<String>,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The package file with our fields replaced and everything else left as it was.
pub fn rewrite_opf(opf: &str, d: &FileDetails) -> String {
    let re_meta = Regex::new(r"(?s)(<(?:opf:)?metadata\b[^>]*>)(.*?)(</(?:opf:)?metadata>)").unwrap();
    let Some(c) = re_meta.captures(opf) else { return opf.to_string() };
    let version3 = Regex::new(r#"<(?:opf:)?package\b[^>]*\bversion="3"#).unwrap().is_match(opf);
    let unique = Regex::new(r#"unique-identifier="([^"]+)""#).unwrap().captures(opf).map(|c| c[1].to_string());
    let mut inner = c[2].to_string();

    // elements we manage, and any <meta refines="#id"> that pointed at them
    let mut removed_ids = vec![];
    for tag in ["title", "creator", "publisher", "date", "description", "language"] {
        let re = Regex::new(&format!(r"(?s)<dc:{tag}\b([^>]*?)(?:/>|>.*?</dc:{tag}>)")).unwrap();
        for m in re.captures_iter(&inner.clone()) {
            if let Some(id) = Regex::new(r#"\bid="([^"]+)""#).unwrap().captures(&m[1]) {
                removed_ids.push(id[1].to_string());
            }
        }
        inner = re.replace_all(&inner, "").into_owned();
    }
    // ISBN identifiers, except the package's own unique identifier
    let re_id = Regex::new(r"(?s)<dc:identifier\b([^>]*)>(.*?)</dc:identifier>").unwrap();
    inner = re_id
        .replace_all(&inner, |m: &regex::Captures| {
            let is_unique = unique.as_ref().is_some_and(|u| m[1].contains(&format!(r#"id="{u}""#)));
            let digits: String = m[2].chars().filter(|c| c.is_ascii_digit() || *c == 'X').collect();
            let isbn = m[1].to_lowercase().contains("isbn") || m[2].to_lowercase().contains("isbn") || (digits.len() == 13 && digits.starts_with("97"));
            if isbn && !is_unique { String::new() } else { m[0].to_string() }
        })
        .into_owned();
    inner = Regex::new(r#"<meta\b[^>]*name="calibre:series(?:_index)?"[^>]*/?>(?:</meta>)?"#).unwrap().replace_all(&inner, "").into_owned();
    let re_coll = Regex::new(r#"(?s)<meta\b([^>]*)property="belongs-to-collection"([^>]*)>.*?</meta>"#).unwrap();
    for m in re_coll.captures_iter(&inner.clone()) {
        if let Some(id) = Regex::new(r#"\bid="([^"]+)""#).unwrap().captures(&format!("{}{}", &m[1], &m[2])) {
            removed_ids.push(id[1].to_string());
        }
    }
    inner = re_coll.replace_all(&inner, "").into_owned();
    for id in &removed_ids {
        let re = Regex::new(&format!(r##"(?s)<meta\b[^>]*refines="#{}"[^>]*?(?:/>|>.*?</meta>)"##, regex::escape(id))).unwrap();
        inner = re.replace_all(&inner, "").into_owned();
    }
    // tidy the blank lines left behind
    inner = Regex::new(r"\n[ \t]*\n(?:[ \t]*\n)+").unwrap().replace_all(&inner, "\n").into_owned();

    let mut add = vec![format!("<dc:title>{}</dc:title>", esc(&d.title))];
    for a in &d.authors {
        add.push(format!("<dc:creator>{}</dc:creator>", esc(a)));
    }
    let opt = |tag: &str, v: &Option<String>| v.as_ref().filter(|v| !v.trim().is_empty()).map(|v| format!("<dc:{tag}>{}</dc:{tag}>", esc(v.trim())));
    add.extend(opt("language", &d.language));
    add.extend(opt("publisher", &d.publisher));
    add.extend(opt("date", &d.published));
    add.extend(opt("description", &d.description));
    if let Some(i) = d.isbn.as_ref().filter(|v| !v.trim().is_empty()) {
        add.push(format!("<dc:identifier>urn:isbn:{}</dc:identifier>", esc(i.trim())));
    }
    if let Some(s) = d.series.as_ref().filter(|v| !v.trim().is_empty()) {
        add.push(format!(r#"<meta name="calibre:series" content="{}"/>"#, esc(s.trim())));
        if let Some(n) = &d.series_index {
            add.push(format!(r#"<meta name="calibre:series_index" content="{}"/>"#, esc(n)));
        }
        if version3 {
            add.push(format!(r#"<meta property="belongs-to-collection" id="nightstand-series">{}</meta>"#, esc(s.trim())));
            add.push(r##"<meta refines="#nightstand-series" property="collection-type">series</meta>"##.into());
            if let Some(n) = &d.series_index {
                add.push(format!(r##"<meta refines="#nightstand-series" property="group-position">{}</meta>"##, esc(n)));
            }
        }
    }
    let new_inner = format!("\n    {}{}", add.join("\n    "), inner);
    format!("{}{}{}{}{}", &opf[..c.get(0).unwrap().start()], &c[1], new_inner, &c[3], &opf[c.get(0).unwrap().end()..])
}

/// A new copy of the EPUB with the details (and optionally a new cover image) written in.
pub fn rewrite(epub_bytes: &[u8], d: &FileDetails, cover: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let meta = epub::read(Cursor::new(epub_bytes))?;
    let mut zip = ZipArchive::new(Cursor::new(epub_bytes)).map_err(|e| e.to_string())?;
    let mut out = ZipWriter::new(Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    // the mimetype entry has to come first, uncompressed
    out.start_file("mimetype", stored).map_err(|e| e.to_string())?;
    out.write_all(b"application/epub+zip").map_err(|e| e.to_string())?;
    let new_cover = match (cover, &meta.cover_path) {
        (Some(img), Some(path)) => Some(encode_like(img, path)?),
        _ => None,
    };
    // a book without a cover gets one: a JPEG beside the package file, listed in the manifest
    let added_cover = match (cover, &meta.cover_path) {
        (Some(img), None) => {
            let dir = meta.opf_path.rfind('/').map(|i| &meta.opf_path[..=i]).unwrap_or("");
            Some((format!("{dir}nightstand-cover.jpg"), encode_like(img, "cover.jpg")?))
        }
        _ => None,
    };
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name == "mimetype" || f.is_dir() {
            continue;
        }
        let mut data = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut data).map_err(|e| e.to_string())?;
        if name == meta.opf_path {
            let mut opf = rewrite_opf(&String::from_utf8_lossy(&data), d);
            if added_cover.is_some() {
                opf = add_cover_item(&opf);
            }
            data = opf.into_bytes();
        } else if Some(&name) == meta.cover_path.as_ref() {
            if let Some(c) = &new_cover {
                data = c.clone();
            }
        }
        out.start_file(name, deflated).map_err(|e| e.to_string())?;
        out.write_all(&data).map_err(|e| e.to_string())?;
    }
    if let Some((name, img)) = added_cover {
        out.start_file(name, deflated).map_err(|e| e.to_string())?;
        out.write_all(&img).map_err(|e| e.to_string())?;
    }
    Ok(out.finish().map_err(|e| e.to_string())?.into_inner())
}

/// List nightstand-cover.jpg in the manifest, marked as the cover both the EPUB 3 and the EPUB 2 way.
fn add_cover_item(opf: &str) -> String {
    let version3 = Regex::new(r#"<(?:opf:)?package\b[^>]*\bversion="3"#).unwrap().is_match(opf);
    let props = if version3 { r#" properties="cover-image""# } else { "" };
    let item = format!(r#"<item id="nightstand-cover" href="nightstand-cover.jpg" media-type="image/jpeg"{props}/>"#);
    let re_manifest = Regex::new(r"(<(?:opf:)?manifest\b[^>]*>)").unwrap();
    let opf = re_manifest.replacen(opf, 1, |c: &regex::Captures| format!("{}\n    {item}", &c[1])).into_owned();
    let re_meta_end = Regex::new(r"(</(?:opf:)?metadata>)").unwrap();
    re_meta_end.replacen(&opf, 1, |c: &regex::Captures| format!("  <meta name=\"cover\" content=\"nightstand-cover\"/>\n  {}", &c[1])).into_owned()
}

/// The chosen image, re-encoded in the format the book's cover file already has (so its manifest entry stays right)
fn encode_like(img: &[u8], path: &str) -> Result<Vec<u8>, String> {
    let im = image::load_from_memory(img).map_err(|e| format!("not an image: {e}"))?;
    let fmt = match path.rsplit('.').next().map(|e| e.to_lowercase()).as_deref() {
        Some("png") => image::ImageFormat::Png,
        Some("gif") => image::ImageFormat::Gif,
        Some("webp") => image::ImageFormat::WebP,
        _ => image::ImageFormat::Jpeg,
    };
    let im = if fmt == image::ImageFormat::Jpeg { image::DynamicImage::ImageRgb8(im.to_rgb8()) } else { im };
    let mut out = Cursor::new(vec![]);
    im.write_to(&mut out, fmt).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_middlemarch() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spikes/azw3/books/pg145.epub");
        let Ok(bytes) = std::fs::read(p) else { return };
        let d = FileDetails {
            title: "Middlemarch: A Study of Provincial Life".into(),
            authors: vec!["George Eliot".into(), "Mary Ann Evans".into()],
            language: Some("en".into()),
            publisher: Some("Penguin Classics".into()),
            published: Some("1871".into()),
            description: Some("Dorothea & the \"town\" of Middlemarch.".into()),
            isbn: Some("9780141439549".into()),
            series: Some("Penguin Classics".into()),
            series_index: Some("3".into()),
        };
        let img = image::RgbImage::from_pixel(60, 90, image::Rgb([200, 30, 30]));
        let mut png = Cursor::new(vec![]);
        image::DynamicImage::ImageRgb8(img).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let out = rewrite(&bytes, &d, Some(&png.into_inner())).unwrap();
        let m = epub::read(Cursor::new(&out)).unwrap();
        assert_eq!(m.title, d.title);
        assert_eq!(m.authors, d.authors);
        assert_eq!(m.publisher.as_deref(), Some("Penguin Classics"));
        assert_eq!(m.date.as_deref(), Some("1871"));
        assert_eq!(m.description.as_deref(), Some("Dorothea & the \"town\" of Middlemarch."));
        assert_eq!(m.isbn.as_deref(), Some("9780141439549"));
        assert_eq!((m.series.as_deref(), m.series_index.as_deref()), (Some("Penguin Classics"), Some("3")));
        let cover = image::load_from_memory(m.cover.as_ref().unwrap()).unwrap();
        assert_eq!((cover.width(), cover.height()), (60, 90));
        // the package's unique identifier and the chapters are untouched, and the mimetype still comes first
        let mut z = ZipArchive::new(Cursor::new(&out)).unwrap();
        assert_eq!(z.by_index(0).unwrap().name(), "mimetype");
        let mut before = ZipArchive::new(Cursor::new(&bytes)).unwrap();
        for name in ["OEBPS/3952173561683538746_145-h-40.htm.xhtml", "META-INF/container.xml"] {
            let (mut a, mut b) = (vec![], vec![]);
            before.by_name(name).unwrap().read_to_end(&mut a).unwrap();
            z.by_name(name).unwrap().read_to_end(&mut b).unwrap();
            assert_eq!(a, b, "{name}");
        }
        let mut opf = String::new();
        z.by_name(&m.opf_path).unwrap().read_to_string(&mut opf).unwrap();
        assert!(opf.contains(r#"<dc:identifier id="id">http://www.gutenberg.org/145</dc:identifier>"#));
        assert!(!opf.contains("refines=\"#author_0\""), "dangling refines left behind");
        // and rewriting again doesn't pile up duplicates
        let twice = rewrite(&out, &d, None).unwrap();
        let mut z2 = ZipArchive::new(Cursor::new(&twice)).unwrap();
        let mut opf2 = String::new();
        z2.by_name(&m.opf_path).unwrap().read_to_string(&mut opf2).unwrap();
        assert_eq!(opf2.matches("<dc:title>").count(), 1);
        assert_eq!(opf2.matches("calibre:series\"").count(), 1);
    }

    #[test]
    fn gives_a_coverless_book_a_cover() {
        let mut z = ZipWriter::new(Cursor::new(Vec::new()));
        let o = SimpleFileOptions::default();
        z.start_file("mimetype", o).unwrap();
        z.write_all(b"application/epub+zip").unwrap();
        z.start_file("META-INF/container.xml", o).unwrap();
        z.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
        z.start_file("OPS/book.opf", o).unwrap();
        z.write_all(br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="u">x</dc:identifier><dc:title>Plain</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#).unwrap();
        z.start_file("OPS/c1.xhtml", o).unwrap();
        z.write_all(b"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Hi</p></body></html>").unwrap();
        let bytes = z.finish().unwrap().into_inner();
        assert!(epub::read(Cursor::new(&bytes)).unwrap().cover.is_none());
        let mut png = Cursor::new(vec![]);
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(40, 60, image::Rgb([10, 90, 10]))).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let d = FileDetails { title: "Plain".into(), authors: vec!["A. Writer".into()], ..Default::default() };
        let out = rewrite(&bytes, &d, Some(&png.into_inner())).unwrap();
        let m = epub::read(Cursor::new(&out)).unwrap();
        assert_eq!(m.cover_path.as_deref(), Some("OPS/nightstand-cover.jpg"));
        let c = image::load_from_memory(m.cover.as_ref().unwrap()).unwrap();
        assert_eq!((c.width(), c.height()), (40, 60));
        // a second cover replaces the first instead of adding another
        let again = rewrite(&out, &d, Some(m.cover.as_ref().unwrap())).unwrap();
        let mut opf = String::new();
        ZipArchive::new(Cursor::new(&again)).unwrap().by_name("OPS/book.opf").unwrap().read_to_string(&mut opf).unwrap();
        assert_eq!(opf.matches("nightstand-cover.jpg").count(), 1);
    }
}
