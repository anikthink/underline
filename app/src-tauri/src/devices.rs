//! Kindles and Kobos over USB (prototypes/devices.html). A device is a mounted volume:
//! a Kindle has documents/ and system/, a Kobo has .kobo/KoboReader.sqlite.
//! Sending copies books on; on connect, highlights (and a Kobo's progress) are read back.
//! Nightstand only ever reads the Kobo database, and removing a book from a device never touches the library.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// The volume's folder name, which is how a device is recognised next time
    pub id: String,
    pub kind: String, // "kindle" | "kobo"
    pub name: String,
    pub path: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

/// Where volumes are mounted. Tests point this at a temporary folder.
pub fn volumes_root() -> PathBuf {
    std::env::var_os("NIGHTSTAND_VOLUMES").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/Volumes"))
}

pub fn detect() -> Vec<Device> {
    let Ok(entries) = std::fs::read_dir(volumes_root()) else { return vec![] };
    let mut out: Vec<Device> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let id = e.file_name().to_string_lossy().into_owned();
            let kind = if p.join(".kobo/KoboReader.sqlite").is_file() {
                "kobo"
            } else if p.join("documents").is_dir() && p.join("system").is_dir() {
                "kindle"
            } else {
                return None;
            };
            let (free_bytes, total_bytes) = space(&p);
            let name = if kind == "kindle" { "Kindle" } else { "Kobo" }.to_string();
            Some(Device { id, kind: kind.into(), name, path: p.to_string_lossy().into_owned(), free_bytes, total_bytes })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn space(p: &Path) -> (u64, u64) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return (0, 0) };
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return (0, 0);
    }
    let block = s.f_frsize as u64;
    (s.f_bavail as u64 * block, s.f_blocks as u64 * block)
}

// ---------- What's on a device ----------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OnDevice {
    /// Path relative to the device
    pub path: String,
    pub title: String,
    pub author: Option<String>,
    pub format: String,
    /// Bought from Amazon or Kobo: listed, but it can't be copied in
    pub protected: bool,
    pub bytes: u64,
    /// Kobo only: how far through, 0–1, and whether it's marked finished
    pub progress: Option<f64>,
    pub finished: bool,
}

pub fn contents(dev: &Device) -> Vec<OnDevice> {
    let root = Path::new(&dev.path);
    if dev.kind == "kindle" { kindle_contents(root) } else { kobo_contents(root) }
}

fn kindle_contents(root: &Path) -> Vec<OnDevice> {
    let mut out = vec![];
    let mut stack = vec![root.join("documents")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_dir() {
                // .sdr folders hold the Kindle's own notes for a book; Downloads etc. can hold books
                if !name.ends_with(".sdr") && !name.starts_with('.') && stack.len() < 50 {
                    stack.push(p);
                }
                continue;
            }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            // My Clippings.txt is the Kindle's own file of highlights, not a book
            if !["azw3", "azw", "mobi", "kfx", "pdf", "txt", "prc"].contains(&ext.as_str()) || name.starts_with('.') || name == "My Clippings.txt" {
                continue;
            }
            let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
            let meta = if ["azw3", "azw", "mobi", "prc"].contains(&ext.as_str()) { mobi_meta(&p) } else { None };
            let stem = p.file_stem().unwrap().to_string_lossy().replace('_', " ");
            let (title, author, encrypted) = meta.unwrap_or((stem, None, false));
            out.push(OnDevice {
                path: p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                title,
                author,
                protected: encrypted || ext == "kfx" || ext == "azw",
                format: ext.to_uppercase(),
                bytes,
                progress: None,
                finished: false,
            });
        }
    }
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    out
}

/// Title, author and whether it's encrypted, from a MOBI/KF8 file's header (PalmDOC record 0 and EXTH).
pub fn mobi_meta(p: &Path) -> Option<(String, Option<String>, bool)> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).ok()?;
    let mut head = vec![0u8; 64 * 1024];
    let n = f.read(&mut head).ok()?;
    head.truncate(n);
    let be32 = |b: &[u8], o: usize| -> Option<u32> { b.get(o..o + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]])) };
    let be16 = |b: &[u8], o: usize| -> Option<u16> { b.get(o..o + 2).map(|x| u16::from_be_bytes([x[0], x[1]])) };
    if head.get(60..68)? != b"BOOKMOBI" && head.get(60..68)? != b"TEXtREAd" {
        return None;
    }
    let r0 = be32(&head, 78)? as usize;
    let encrypted = be16(&head, r0 + 12)? != 0;
    let mut title = None;
    let mut author = None;
    if head.get(r0 + 16..r0 + 20)? == b"MOBI" {
        let mobi_len = be32(&head, r0 + 20)? as usize;
        let name_off = be32(&head, r0 + 84)? as usize;
        let name_len = be32(&head, r0 + 88)? as usize;
        if let Some(b) = head.get(r0 + name_off..r0 + name_off + name_len) {
            title = Some(String::from_utf8_lossy(b).into_owned());
        }
        let exth_flag = be32(&head, r0 + 128).unwrap_or(0);
        let x = r0 + 16 + mobi_len;
        if exth_flag & 0x40 != 0 && head.get(x..x + 4) == Some(b"EXTH") {
            let count = be32(&head, x + 8)? as usize;
            let mut o = x + 12;
            for _ in 0..count {
                let (Some(kind), Some(len)) = (be32(&head, o), be32(&head, o + 4)) else { break };
                let len = len as usize;
                if len < 8 {
                    break;
                }
                if let Some(v) = head.get(o + 8..o + len) {
                    let v = String::from_utf8_lossy(v).into_owned();
                    match kind {
                        100 => author = Some(v),
                        503 => title = Some(v), // updated title
                        _ => {}
                    }
                }
                o += len;
            }
        }
    }
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| String::from_utf8_lossy(&head[..32]).trim_end_matches('\0').replace('_', " "));
    Some((title, author, encrypted))
}

/// Kobo's database is copied before reading, so Nightstand never holds a lock on the device's own file.
fn open_kobo_db(root: &Path) -> Option<(rusqlite::Connection, tempfile::TempDir)> {
    let tmp = tempfile::tempdir().ok()?;
    for f in ["KoboReader.sqlite", "KoboReader.sqlite-wal", "KoboReader.sqlite-shm"] {
        let from = root.join(".kobo").join(f);
        if from.exists() {
            std::fs::copy(&from, tmp.path().join(f)).ok()?;
        }
    }
    let db = rusqlite::Connection::open_with_flags(tmp.path().join("KoboReader.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    Some((db, tmp))
}

/// file:///mnt/onboard/Nightstand/Middlemarch.epub -> Nightstand/Middlemarch.epub
fn kobo_path(content_id: &str) -> Option<String> {
    content_id.strip_prefix("file:///mnt/onboard/").map(|p| p.split('#').next().unwrap_or(p).to_string())
}

fn kobo_contents(root: &Path) -> Vec<OnDevice> {
    let Some((db, _tmp)) = open_kobo_db(root) else { return vec![] };
    let Ok(mut st) = db.prepare(
        "select ContentID, coalesce(Title, ''), Attribution, coalesce(___PercentRead, 0), coalesce(ReadStatus, 0)
         from content where ContentType = 6 order by Title",
    ) else {
        return vec![];
    };
    let rows = st.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, f64>(3)?, r.get::<_, i64>(4)?))
    });
    let Ok(rows) = rows else { return vec![] };
    rows.flatten()
        .map(|(id, title, author, pct, status)| {
            let local = kobo_path(&id);
            let bytes = local.as_ref().and_then(|p| std::fs::metadata(root.join(p)).ok()).map(|m| m.len()).unwrap_or(0);
            OnDevice {
                format: if id.ends_with(".kepub.epub") { "KEPUB".into() } else if local.is_some() { "EPUB".into() } else { "Kobo store".into() },
                protected: local.is_none(),
                path: local.unwrap_or(id),
                title,
                author,
                bytes,
                progress: Some((pct / 100.0).clamp(0.0, 1.0)),
                finished: status == 2,
            }
        })
        .collect()
}

// ---------- Highlights ----------

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// Stable key, so the same highlight is never brought in twice
    pub key: String,
    /// Title and author as the device shows them
    pub title: String,
    pub author: Option<String>,
    /// Path of the book on the device, when known (Kobo)
    pub path: Option<String>,
    pub text: String,
    pub note: String,
    /// Kindle location (start, end) and the highest location seen for the book; Kobo has none
    pub location: Option<(i64, i64)>,
    /// Kobo: the book's own file and chapter the highlight is in, e.g. "OEBPS/ch3.xhtml"
    pub chapter_file: Option<String>,
    pub added: String,
}

/// Highlights and notes from a Kindle's My Clippings.txt. Bookmarks are skipped; a note is attached to the
/// highlight it was written on (Kindle stores it as a separate entry at the highlight's last location).
pub fn kindle_clips(root: &Path) -> Vec<Clip> {
    let Ok(raw) = std::fs::read(root.join("documents/My Clippings.txt")) else { return vec![] };
    parse_clippings(&String::from_utf8_lossy(&raw))
}

pub fn parse_clippings(raw: &str) -> Vec<Clip> {
    let mut clips: Vec<Clip> = vec![];
    let mut notes: Vec<(String, i64, String)> = vec![];
    for entry in raw.split("==========") {
        let lines: Vec<&str> = entry.trim_matches(|c| c == '\r' || c == '\n').lines().map(|l| l.trim_end_matches('\r')).collect();
        if lines.len() < 2 {
            continue;
        }
        let head = lines[0].trim_start_matches('\u{feff}').trim();
        let meta = lines[1];
        let text = lines.get(3..).map(|l| l.join("\n")).unwrap_or_default().trim().to_string();
        let (title, author) = match head.rfind(" (") {
            Some(i) if head.ends_with(')') => (head[..i].trim().to_string(), Some(head[i + 2..head.len() - 1].to_string())),
            _ => (head.to_string(), None),
        };
        let loc = meta.split("Location ").nth(1).and_then(|s| {
            let s: String = s.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
            let mut it = s.split('-').filter_map(|x| x.parse::<i64>().ok());
            let a = it.next()?;
            Some((a, it.next().unwrap_or(a)))
        });
        let added = meta.split("Added on ").nth(1).unwrap_or("").trim().to_string();
        if meta.contains("Your Note") {
            if let Some((l, _)) = loc {
                notes.push((head.to_string(), l, text));
            }
            continue;
        }
        if !meta.contains("Your Highlight") || text.is_empty() {
            continue;
        }
        let key = format!("kindle:{}", short_hash(&format!("{head}|{loc:?}|{text}")));
        clips.push(Clip { key, title, author, path: None, text, note: String::new(), location: loc, chapter_file: None, added });
    }
    // a highlight that was extended shows up twice; keep only the later, longer one
    let mut keep = vec![true; clips.len()];
    for i in 0..clips.len() {
        for j in i + 1..clips.len() {
            let (a, b) = (&clips[i], &clips[j]);
            // extended at either end; text merely contained in a longer one ("is a") is a different highlight (spikes/anchors)
            if a.title == b.title && b.text.len() > a.text.len() && (b.text.starts_with(a.text.trim()) || b.text.ends_with(a.text.trim())) {
                if let (Some((la, _)), Some((lb, _))) = (a.location, b.location) {
                    if (la - lb).abs() <= 2 {
                        keep[i] = false;
                    }
                }
            }
        }
    }
    let mut clips: Vec<Clip> = clips.into_iter().zip(keep).filter(|(_, k)| *k).map(|(c, _)| c).collect();
    for (head, l, text) in notes {
        if let Some(c) = clips.iter_mut().find(|c| head.starts_with(&c.title) && c.location.is_some_and(|(a, b)| l >= a && l <= b + 1)) {
            c.note = text;
        }
    }
    clips
}

/// Highlights and notes from a Kobo's database, for books sent over USB
pub fn kobo_clips(root: &Path) -> Vec<Clip> {
    let Some((db, _tmp)) = open_kobo_db(root) else { return vec![] };
    let Ok(mut st) = db.prepare(
        "select b.BookmarkID, b.VolumeID, coalesce(b.Text, ''), coalesce(b.Annotation, ''), coalesce(b.DateCreated, ''),
                coalesce(b.ContentID, ''), coalesce(c.Title, ''), c.Attribution
         from Bookmark b left join content c on c.ContentID = b.VolumeID and c.ContentType = 6
         where b.Text is not null and trim(b.Text) != ''",
    ) else {
        return vec![];
    };
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    });
    let Ok(rows) = rows else { return vec![] };
    rows.flatten()
        .map(|(id, volume, text, note, added, content, title, author)| Clip {
            key: format!("kobo:{id}"),
            title,
            author,
            path: kobo_path(&volume),
            text: text.trim().to_string(),
            note: note.trim().to_string(),
            location: None,
            // ContentID looks like file:///mnt/onboard/x.epub#(3)OEBPS/ch3.xhtml#point(...)
            chapter_file: content.split_once(")").map(|(_, rest)| rest.split('#').next().unwrap_or(rest).to_string()),
            added,
        })
        .collect()
}

fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(s.as_bytes()))[..16].to_string()
}

// ---------- Sending and removing ----------

/// Where the converter is: next to the app's own program, as Tauri bundles it (dev builds too).
pub fn converter() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    ["epub2azw3", &format!("epub2azw3-{}", std::env::consts::ARCH)]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file())
        .or_else(|| std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("epub2azw3"))))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ConvertReport {
    pub thumb_file: Option<String>,
}

/// EPUB -> AZW3 with the bundled converter (spikes/azw3). Returns the thumbnail's file name, if any.
pub fn convert(epub: &Path, out: &Path) -> Result<ConvertReport, String> {
    let exe = converter().ok_or("the AZW3 converter is missing from the app")?;
    let o = std::process::Command::new(exe).arg(epub).arg(out).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
    }
    serde_json::from_slice(&o.stdout).map_err(|e| format!("converter report: {e}"))
}

/// Remove a book from the device (and, on a Kindle, its .sdr folder of notes). Never touches the library.
pub fn remove(dev: &Device, rel: &str) -> Result<(), String> {
    let root = Path::new(&dev.path);
    let p = root.join(rel);
    if !p.starts_with(root) || rel.contains("..") || !p.is_file() {
        return Err(format!("{rel} isn't a book on this device"));
    }
    std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    let sdr = p.with_extension("sdr");
    if dev.kind == "kindle" && sdr.is_dir() {
        let _ = std::fs::remove_dir_all(sdr);
    }
    Ok(())
}

pub fn eject(dev: &Device) -> Result<(), String> {
    let o = std::process::Command::new("diskutil").arg("eject").arg(&dev.path).output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLIPS: &str = "\u{feff}Middlemarch (George Eliot)\r\n- Your Highlight on Location 4850-4851 | Added on Thursday, 30 October 2026 10:12:03\r\n\r\nWhen the animals entered\r\n==========\r\n\u{feff}Middlemarch (George Eliot)\r\n- Your Highlight on Location 4850-4852 | Added on Thursday, 30 October 2026 10:13:03\r\n\r\nWhen the animals entered the Ark in pairs\r\n==========\r\n\u{feff}Middlemarch (George Eliot)\r\n- Your Note on Location 4852 | Added on Thursday, 30 October 2026 10:14:00\r\n\r\nso true\r\n==========\r\n\u{feff}Middlemarch (George Eliot)\r\n- Your Bookmark on Location 5000 | Added on Thursday, 30 October 2026 10:15:00\r\n\r\n\r\n==========\r\n\u{feff}Frankenstein; or, The modern Prometheus (Mary Wollstonecraft Shelley)\r\n- Your Highlight on page 12 | Location 180-181 | Added on Friday, 31 October 2026 09:00:00\r\n\r\nYou seek for knowledge and wisdom\r\n==========\r\n";

    #[test]
    fn parses_my_clippings() {
        let c = parse_clippings(CLIPS);
        assert_eq!(c.len(), 2, "{c:#?}");
        assert_eq!(c[0].title, "Middlemarch");
        assert_eq!(c[0].author.as_deref(), Some("George Eliot"));
        assert_eq!(c[0].text, "When the animals entered the Ark in pairs");
        assert_eq!(c[0].location, Some((4850, 4852)));
        assert_eq!(c[0].note, "so true");
        assert_eq!(c[1].title, "Frankenstein; or, The modern Prometheus");
        assert_eq!(c[1].location, Some((180, 181)));
        assert_eq!(parse_clippings(CLIPS)[0].key, c[0].key, "keys are stable");
    }

    #[test]
    fn parses_the_generated_clippings_file() {
        let p = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spikes/anchors/books/My Clippings.txt"));
        let Ok(raw) = std::fs::read_to_string(p) else { return };
        let c = parse_clippings(&raw);
        // 263 highlights, 11 of them extended later (spikes/anchors), 2 from a book not in the library
        assert_eq!(c.len(), 263 - 11, "{}", c.len());
        assert!(c.iter().filter(|c| !c.note.is_empty()).count() >= 15);
    }

    #[test]
    fn reads_titles_from_kindle_files() {
        let out = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spikes/azw3/out/pg145.azw3"));
        if !out.exists() {
            return;
        }
        let (title, author, enc) = mobi_meta(out).unwrap();
        assert_eq!((title.as_str(), author.as_deref(), enc), ("Middlemarch", Some("George Eliot"), false));
    }

    #[test]
    fn detects_devices_and_reads_kobo() {
        let tmp = tempfile::tempdir().unwrap();
        let k = tmp.path().join("Kindle");
        std::fs::create_dir_all(k.join("documents")).unwrap();
        std::fs::create_dir_all(k.join("system")).unwrap();
        std::fs::write(k.join("documents/My Clippings.txt"), CLIPS).unwrap();
        let ko = tmp.path().join("KOBOeReader");
        std::fs::create_dir_all(ko.join(".kobo")).unwrap();
        std::fs::create_dir_all(ko.join("Nightstand")).unwrap();
        std::fs::write(ko.join("Nightstand/Middlemarch.epub"), b"x").unwrap();
        std::fs::create_dir_all(tmp.path().join("Untitled")).unwrap(); // a USB stick
        let db = rusqlite::Connection::open(ko.join(".kobo/KoboReader.sqlite")).unwrap();
        db.execute_batch(
            "create table content (ContentID text, ContentType int, Title text, Attribution text, ___PercentRead int, ReadStatus int);
             create table Bookmark (BookmarkID text, VolumeID text, ContentID text, Text text, Annotation text, DateCreated text);
             insert into content values ('file:///mnt/onboard/Nightstand/Middlemarch.epub', 6, 'Middlemarch', 'George Eliot', 38, 1);
             insert into content values ('abc-store-id', 6, 'A Bought Book', 'Someone', 100, 2);
             insert into Bookmark values ('b1', 'file:///mnt/onboard/Nightstand/Middlemarch.epub',
               'file:///mnt/onboard/Nightstand/Middlemarch.epub#(37)OEBPS/ch35.xhtml#point(/1/4/2:0)', ' When the animals entered the Ark in pairs ', 'so true', '2026-11-01T10:00:00Z');",
        )
        .unwrap();
        drop(db);
        unsafe { std::env::set_var("NIGHTSTAND_VOLUMES", tmp.path()) };
        let devs = detect();
        unsafe { std::env::remove_var("NIGHTSTAND_VOLUMES") };
        assert_eq!(devs.iter().map(|d| d.kind.as_str()).collect::<Vec<_>>(), vec!["kobo", "kindle"]);
        let kobo = &devs[0];
        let books = contents(kobo);
        assert_eq!(books.len(), 2);
        let mm = books.iter().find(|b| b.title == "Middlemarch").unwrap();
        assert_eq!((mm.path.as_str(), mm.progress, mm.protected), ("Nightstand/Middlemarch.epub", Some(0.38), false));
        assert!(books.iter().find(|b| b.title == "A Bought Book").unwrap().protected);
        let clips = kobo_clips(Path::new(&kobo.path));
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].text, "When the animals entered the Ark in pairs");
        assert_eq!(clips[0].chapter_file.as_deref(), Some("OEBPS/ch35.xhtml"));
        assert_eq!(clips[0].path.as_deref(), Some("Nightstand/Middlemarch.epub"));
        assert_eq!(kindle_clips(Path::new(&devs[1].path)).len(), 2);
    }
}
