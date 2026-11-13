//! Export to folder: one Markdown file per book with underlines, with frontmatter and labels as tags,
//! so the folder can sit inside an Obsidian vault (prototypes/notes.html, frame 04).
//! Nightstand only ever rewrites or deletes files it wrote itself.

use crate::library::{Library, Underline};
use serde::Serialize;
use std::path::Path;

pub const LABELS: [&str; 5] = ["", "quote", "idea", "question", "disagree"];

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub written: usize,
    pub removed: usize,
    /// Files that already existed and weren't made by Nightstand, so were left alone
    pub skipped: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub folder: Option<String>,
    pub keep: bool,
}

pub fn settings(lib: &Library) -> ExportSettings {
    ExportSettings { folder: lib.setting("export_folder"), keep: lib.setting("export_keep").as_deref() == Some("1") }
}

/// Choose the folder (or none, which turns export off) and whether to keep it up to date, then write every book.
pub fn configure(lib: &Library, folder: Option<&str>, keep: bool) -> Result<Report, String> {
    lib.set_setting("export_folder", folder)?;
    lib.set_setting("export_keep", Some(if keep { "1" } else { "0" }))?;
    if folder.is_none() {
        return Ok(Report::default());
    }
    export_all(lib)
}

pub fn export_all(lib: &Library) -> Result<Report, String> {
    let mut report = Report::default();
    for b in lib.books()? {
        write_book(lib, b.id, &mut report)?;
    }
    Ok(report)
}

/// After an underline changes: rewrite that book's file if "Keep up to date" is on.
pub fn after_change(lib: &Library, book_id: i64) {
    let s = settings(lib);
    if s.keep && s.folder.is_some() {
        if let Err(e) = write_book(lib, book_id, &mut Report::default()) {
            eprintln!("export of book {book_id} failed: {e}");
        }
    }
}

fn write_book(lib: &Library, book_id: i64, report: &mut Report) -> Result<(), String> {
    let Some(folder) = lib.setting("export_folder") else { return Ok(()) };
    let folder = Path::new(&folder);
    let book = lib.book(book_id)?;
    let items = lib.underlines(book_id)?;
    let previous = lib.exported_file(book_id);
    let remove_ours = |p: &str, report: &mut Report| {
        if lib.is_exported_path(p) && Path::new(p).exists() && std::fs::remove_file(p).is_ok() {
            report.removed += 1;
        }
    };
    if items.is_empty() {
        if let Some(p) = previous {
            remove_ours(&p, report);
            lib.set_exported_file(book_id, None)?;
        }
        return Ok(());
    }
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let path = folder.join(file_name(&book.title));
    let path_s = path.to_string_lossy().into_owned();
    if path.exists() && previous.as_deref() != Some(path_s.as_str()) && !lib.is_exported_path(&path_s) {
        report.skipped.push(path.file_name().unwrap().to_string_lossy().into_owned());
        return Ok(());
    }
    if let Some(p) = previous.as_deref().filter(|p| *p != path_s) {
        remove_ours(p, report); // the title changed since the last export
    }
    std::fs::write(&path, markdown(&book.title, &book.authors, &book.status, book.fraction, &items, today())).map_err(|e| e.to_string())?;
    lib.set_exported_file(book_id, Some(&path_s))?;
    report.written += 1;
    Ok(())
}

pub fn file_name(title: &str) -> String {
    let t: String = title.chars().filter(|c| !r#"\/:*?"<>|"#.contains(*c) && !c.is_control()).collect();
    let t = t.trim().trim_start_matches('.');
    format!("{}.md", if t.is_empty() { "Untitled" } else { t })
}

pub fn markdown(title: &str, authors: &[String], status: &str, fraction: f64, items: &[Underline], updated: String) -> String {
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut out = vec![
        "---".to_string(),
        format!("title: \"{}\"", q(title)),
        format!("author: \"{}\"", q(&authors.join(", "))),
        format!("status: {}", status.to_lowercase()),
    ];
    if status == "Reading" {
        out.push(format!("progress: {}%", (fraction * 100.0).round()));
    }
    out.extend([format!("underlines: {}", items.len()), "tags: [book]".into(), format!("updated: {updated}"), "---".into(), String::new()]);
    out.push(format!("# {title}"));
    out.push(authors.join(", "));
    let mut sorted: Vec<&Underline> = items.iter().collect();
    sorted.sort_by_key(|u| (u.page.unwrap_or(i64::MAX), u.id));
    let mut chapter: Option<&str> = None;
    for u in sorted {
        let ch = u.chapter.as_deref().map(str::trim).filter(|c| !c.is_empty());
        if ch.is_some() && ch != chapter {
            out.push(String::new());
            out.push(format!("## {}", ch.unwrap()));
            chapter = ch;
        }
        out.push(String::new());
        for line in u.exact.split_whitespace().collect::<Vec<_>>().join(" ").lines() {
            out.push(format!("> {line}"));
        }
        out.push(String::new());
        if !u.note.trim().is_empty() {
            out.push(u.note.trim().to_string());
            out.push(String::new());
        }
        let mut meta = vec![format!("#{}", LABELS.get(u.label as usize).copied().unwrap_or("quote"))];
        if let Some(p) = u.page {
            meta.push(format!("p. {p}"));
        }
        meta.push(ymd(u.created));
        out.push(meta.join(" · "));
    }
    out.join("\n") + "\n"
}

fn today() -> String {
    ymd(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
}

/// Unix seconds to YYYY-MM-DD (UTC), using Howard Hinnant's civil-from-days.
fn ymd(secs: i64) -> String {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(id: i64, label: i64, page: i64, chapter: &str, exact: &str, note: &str) -> Underline {
        Underline {
            id,
            book_id: 1,
            cfi: String::new(),
            exact: exact.into(),
            prefix: String::new(),
            suffix: String::new(),
            label,
            note: note.into(),
            created: 1_794_528_000, // 2026-11-13
            page: Some(page),
            chapter: Some(chapter.into()),
        }
    }

    #[test]
    fn dates() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_794_528_000), "2026-11-13");
        assert_eq!(ymd(951_782_400), "2000-02-29");
    }

    #[test]
    fn file_names() {
        assert_eq!(file_name("Frankenstein; or: The Modern Prometheus"), "Frankenstein; or The Modern Prometheus.md");
        assert_eq!(file_name("???"), "Untitled.md");
    }

    #[test]
    fn markdown_matches_the_prototype() {
        let items = [
            u(2, 2, 352, "CHAPTER XXXV.", "We are all humiliated by the sudden discovery of a fact", "Confirmation bias, a century early."),
            u(1, 1, 350, "CHAPTER XXXV.", "When the animals entered\nthe Ark in pairs", ""),
            u(3, 4, 839, "CHAPTER LXXX.", "Say \"no\"", ""),
        ];
        let md = markdown("Middlemarch", &["George Eliot".into()], "Reading", 0.393, &items, "2026-11-13".into());
        assert_eq!(
            md,
            "---\ntitle: \"Middlemarch\"\nauthor: \"George Eliot\"\nstatus: reading\nprogress: 39%\nunderlines: 3\ntags: [book]\nupdated: 2026-11-13\n---\n\n# Middlemarch\nGeorge Eliot\n\n## CHAPTER XXXV.\n\n> When the animals entered the Ark in pairs\n\n#quote · p. 350 · 2026-11-13\n\n> We are all humiliated by the sudden discovery of a fact\n\nConfirmation bias, a century early.\n\n#idea · p. 352 · 2026-11-13\n\n## CHAPTER LXXX.\n\n> Say \"no\"\n\n#disagree · p. 839 · 2026-11-13\n"
        );
    }

    #[test]
    fn export_never_touches_other_files() {
        let books = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spikes/azw3/books"));
        if !books.exists() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(&tmp.path().join("lib")).unwrap();
        let crate::library::Added::Added { book: mm } = lib.add(&books.join("pg145.epub")) else { panic!() };
        let crate::library::Added::Added { book: alice } = lib.add(&books.join("pg11.epub")) else { panic!() };
        let out = tmp.path().join("vault");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("Alice's Adventures in Wonderland.md"), "mine").unwrap(); // someone else's file
        for b in [mm.id, alice.id] {
            lib.add_underline(&Underline { book_id: b, ..u(0, 1, 1, "I", "words", "") }).unwrap();
        }
        let r = configure(&lib, Some(out.to_str().unwrap()), true).unwrap();
        assert_eq!(r.written, 1);
        assert_eq!(r.skipped, vec!["Alice's Adventures in Wonderland.md"]);
        assert_eq!(std::fs::read_to_string(out.join("Alice's Adventures in Wonderland.md")).unwrap(), "mine");
        assert!(std::fs::read_to_string(out.join("Middlemarch.md")).unwrap().contains("> words"));

        // keep up to date: removing the last underline removes the file Nightstand wrote
        let id = lib.underlines(mm.id).unwrap()[0].id;
        lib.remove_underline(id).unwrap();
        after_change(&lib, mm.id);
        assert!(!out.join("Middlemarch.md").exists());
        assert_eq!(std::fs::read_to_string(out.join("Alice's Adventures in Wonderland.md")).unwrap(), "mine");
    }
}
