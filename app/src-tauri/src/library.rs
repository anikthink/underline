//! The library: one folder of books, organised as Author/Title.epub, with Nightstand's own data
//! (a SQLite database and cover thumbnails) in a hidden `.nightstand` folder inside it.

use crate::epub;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Library {
    pub folder: PathBuf,
    db: Connection,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: i64,
    pub title: String,
    pub authors: Vec<String>,
    pub file: String,
    pub added: i64,
    pub cover: Option<String>,
    pub status: String,
    pub fraction: f64,
    pub position: Option<String>,
    pub section_chars: Option<Vec<u64>>,
    pub largest_file: u64,
    pub last_opened: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum Added {
    Added { book: Book },
    AlreadyThere { title: String },
    Failed { file: String, error: String },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Underline {
    #[serde(default)]
    pub id: i64,
    pub book_id: i64,
    /// EPUB CFI: the fast way back to the words
    pub cfi: String,
    /// The words themselves and a little on either side, to check the CFI and find them again (spikes/anchors)
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
    pub label: i64,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub created: i64,
    /// Page (2,000-character pages) and contents entry where it was made, for Notes and export
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub chapter: Option<String>,
}

/// An underline with the book it's in, for Notes
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(flatten)]
    pub underline: Underline,
    pub title: String,
    pub authors: Vec<String>,
    pub status: String,
    pub fraction: f64,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

const SCHEMA: &str = "
create table if not exists books (
  id integer primary key,
  title text not null,
  authors text not null,          -- JSON array
  language text,
  identifier text,
  file text not null,             -- relative to the library folder
  hash text not null unique,      -- SHA-256 of the file as added, to spot the same book twice
  added integer not null,
  largest_file integer not null default 0,
  has_cover integer not null default 0,
  status text not null default 'Not started',
  fraction real not null default 0,
  position text,                  -- CFI of the word being read
  section_chars text,             -- JSON array: characters of text in each spine item, for page numbers
  last_opened integer
);
create table if not exists underlines (
  id integer primary key,
  book_id integer not null references books(id) on delete cascade,
  cfi text not null,
  exact text not null,
  prefix text not null,
  suffix text not null,
  label integer not null,
  note text not null default '',
  created integer not null
);
create index if not exists underlines_book on underlines(book_id);
create table if not exists settings (key text primary key, value text not null);
-- Markdown files Nightstand wrote when exporting, so it never touches anyone else's
create table if not exists exported_files (book_id integer primary key, path text not null);
";

// Columns added after the first version: (table, column, definition)
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[("underlines", "page", "integer"), ("underlines", "chapter", "text")];


impl Library {
    pub fn open(folder: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(folder.join(".nightstand/covers")).map_err(|e| e.to_string())?;
        let db = Connection::open(folder.join(".nightstand/library.sqlite")).map_err(|e| e.to_string())?;
        db.execute_batch("pragma foreign_keys = on; pragma journal_mode = wal;").map_err(|e| e.to_string())?;
        db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        for (table, col, def) in ADDED_COLUMNS {
            let has: bool = db
                .query_row(&format!("select count(*) from pragma_table_info('{table}') where name = ?"), [col], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if !has {
                db.execute_batch(&format!("alter table {table} add column {col} {def}")).map_err(|e| e.to_string())?;
            }
        }
        Ok(Self { folder: folder.to_path_buf(), db })
    }

    pub fn default_folder() -> PathBuf {
        dirs::home_dir().unwrap_or_default().join("Books/Nightstand")
    }

    fn cover_path(&self, id: i64) -> PathBuf {
        self.folder.join(format!(".nightstand/covers/{id}.jpg"))
    }

    /// Copy a book into the library. The original is left where it was.
    pub fn add(&self, source: &Path) -> Added {
        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match self.try_add(source) {
            Ok(a) => a,
            Err(error) => Added::Failed { file: name, error },
        }
    }

    fn try_add(&self, source: &Path) -> Result<Added, String> {
        let bytes = std::fs::read(source).map_err(|e| e.to_string())?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if let Some(title) = self
            .db
            .query_row("select title from books where hash = ?", [&hash], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(Added::AlreadyThere { title });
        }
        let meta = epub::read(std::io::Cursor::new(&bytes))?;
        let stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let title = if meta.title.is_empty() { stem } else { meta.title.clone() };
        let author = meta.authors.first().cloned().unwrap_or_else(|| "Unknown author".into());

        // Author/Title.epub, with " (2)" and so on if that name is taken
        let dir = safe_name(&author);
        std::fs::create_dir_all(self.folder.join(&dir)).map_err(|e| e.to_string())?;
        let mut rel = format!("{dir}/{}.epub", safe_name(&title));
        let mut n = 2;
        while self.folder.join(&rel).exists() {
            rel = format!("{dir}/{} ({n}).epub", safe_name(&title));
            n += 1;
        }
        std::fs::write(self.folder.join(&rel), &bytes).map_err(|e| e.to_string())?;

        self.db
            .execute(
                "insert into books (title, authors, language, identifier, file, hash, added, largest_file)
                 values (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    title,
                    serde_json::to_string(&meta.authors).unwrap(),
                    meta.language,
                    meta.identifier,
                    rel,
                    hash,
                    now(),
                    meta.largest_file as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        let id = self.db.last_insert_rowid();
        if let Some(cover) = &meta.cover {
            if save_thumbnail(cover, &self.cover_path(id)).is_ok() {
                self.db.execute("update books set has_cover = 1 where id = ?", [id]).map_err(|e| e.to_string())?;
            }
        }
        Ok(Added::Added { book: self.book(id)? })
    }

    pub fn books(&self) -> Result<Vec<Book>, String> {
        let mut st = self.db.prepare(&format!("{BOOK_SELECT} order by coalesce(last_opened, added) desc")).map_err(|e| e.to_string())?;
        let rows = st.query_map([], |r| self.row_to_book(r)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn book(&self, id: i64) -> Result<Book, String> {
        self.db
            .query_row(&format!("{BOOK_SELECT} where id = ?"), [id], |r| self.row_to_book(r))
            .map_err(|e| e.to_string())
    }

    fn row_to_book(&self, r: &rusqlite::Row) -> rusqlite::Result<Book> {
        let id: i64 = r.get(0)?;
        let has_cover: bool = r.get(5)?;
        Ok(Book {
            id,
            title: r.get(1)?,
            authors: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
            file: r.get(3)?,
            added: r.get(4)?,
            cover: has_cover.then(|| self.cover_path(id).to_string_lossy().into_owned()),
            status: r.get(6)?,
            fraction: r.get(7)?,
            position: r.get(8)?,
            section_chars: r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()),
            largest_file: r.get::<_, i64>(10)? as u64,
            last_opened: r.get(11)?,
        })
    }

    pub fn file_of(&self, id: i64) -> Result<PathBuf, String> {
        Ok(self.folder.join(self.book(id)?.file))
    }

    /// Where the reader is. `turned` is true once they've turned a page in this sitting, which moves a
    /// book that hasn't been started to Reading; only opening it doesn't.
    pub fn set_position(&self, id: i64, cfi: &str, fraction: f64, turned: bool) -> Result<(), String> {
        self.db
            .execute(
                "update books set position = ?, fraction = ?, last_opened = ?,
                   status = case when status = 'Not started' and ? then 'Reading' else status end
                 where id = ?",
                params![cfi, fraction, now(), turned, id],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn set_status(&self, id: i64, status: &str) -> Result<(), String> {
        if !["Reading", "Not started", "Finished"].contains(&status) {
            return Err(format!("unknown status {status}"));
        }
        self.exec("update books set status = ? where id = ?", params![status, id])
    }

    pub fn settings(&self) -> Result<Vec<(String, String)>, String> {
        let mut st = self.db.prepare("select key, value from settings").map_err(|e| e.to_string())?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn set_section_chars(&self, id: i64, chars: &[u64]) -> Result<(), String> {
        self.db
            .execute("update books set section_chars = ? where id = ?", params![serde_json::to_string(chars).unwrap(), id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn underlines(&self, book_id: i64) -> Result<Vec<Underline>, String> {
        let mut st = self
            .db
            .prepare(&format!("{UNDERLINE_SELECT} where book_id = ? order by id"))
            .map_err(|e| e.to_string())?;
        let rows = st.query_map([book_id], row_to_underline).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Every underline in the library with its book, newest first
    pub fn notes(&self) -> Result<Vec<Note>, String> {
        let mut st = self
            .db
            .prepare(
                "select u.id, u.book_id, u.cfi, u.exact, u.prefix, u.suffix, u.label, u.note, u.created, u.page, u.chapter,
                        b.title, b.authors, b.status, b.fraction
                 from underlines u join books b on b.id = u.book_id order by u.created desc, u.id desc",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| {
                Ok(Note {
                    underline: row_to_underline(r)?,
                    title: r.get(11)?,
                    authors: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(),
                    status: r.get(13)?,
                    fraction: r.get(14)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn book_of_underline(&self, id: i64) -> Result<i64, String> {
        self.db.query_row("select book_id from underlines where id = ?", [id], |r| r.get(0)).map_err(|e| e.to_string())
    }

    pub fn setting(&self, key: &str) -> Option<String> {
        self.db.query_row("select value from settings where key = ?", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            Some(v) => self.exec("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", params![key, v]),
            None => self.exec("delete from settings where key = ?", params![key]),
        }
    }

    pub fn exported_file(&self, book_id: i64) -> Option<String> {
        self.db.query_row("select path from exported_files where book_id = ?", [book_id], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_exported_file(&self, book_id: i64, path: Option<&str>) -> Result<(), String> {
        match path {
            Some(p) => self.exec("insert into exported_files (book_id, path) values (?, ?) on conflict(book_id) do update set path = excluded.path", params![book_id, p]),
            None => self.exec("delete from exported_files where book_id = ?", params![book_id]),
        }
    }

    pub fn is_exported_path(&self, path: &str) -> bool {
        self.db.query_row("select 1 from exported_files where path = ?", [path], |_| Ok(())).optional().ok().flatten().is_some()
    }

    pub fn add_underline(&self, u: &Underline) -> Result<Underline, String> {
        let created = now();
        self.db
            .execute(
                "insert into underlines (book_id, cfi, exact, prefix, suffix, label, note, created, page, chapter) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![u.book_id, u.cfi, u.exact, u.prefix, u.suffix, u.label, u.note, created, u.page, u.chapter],
            )
            .map_err(|e| e.to_string())?;
        Ok(Underline { id: self.db.last_insert_rowid(), created, ..u.clone() })
    }

    pub fn relabel_underline(&self, id: i64, label: i64) -> Result<(), String> {
        self.exec("update underlines set label = ? where id = ?", params![label, id])
    }

    /// The words were found again somewhere else (the book file changed): store the new CFI and page.
    pub fn move_underline(&self, id: i64, cfi: &str, page: Option<i64>) -> Result<(), String> {
        self.exec("update underlines set cfi = ?, page = coalesce(?, page) where id = ?", params![cfi, page, id])
    }

    pub fn set_note(&self, id: i64, note: &str) -> Result<(), String> {
        self.exec("update underlines set note = ? where id = ?", params![note, id])
    }

    pub fn remove_underline(&self, id: i64) -> Result<(), String> {
        self.exec("delete from underlines where id = ?", params![id])
    }

    fn exec(&self, sql: &str, p: impl rusqlite::Params) -> Result<(), String> {
        self.db.execute(sql, p).map(|_| ()).map_err(|e| e.to_string())
    }
}

const UNDERLINE_SELECT: &str = "select id, book_id, cfi, exact, prefix, suffix, label, note, created, page, chapter from underlines";

fn row_to_underline(r: &rusqlite::Row) -> rusqlite::Result<Underline> {
    Ok(Underline {
        id: r.get(0)?,
        book_id: r.get(1)?,
        cfi: r.get(2)?,
        exact: r.get(3)?,
        prefix: r.get(4)?,
        suffix: r.get(5)?,
        label: r.get(6)?,
        note: r.get(7)?,
        created: r.get(8)?,
        page: r.get(9)?,
        chapter: r.get(10)?,
    })
}

const BOOK_SELECT: &str = "select id, title, authors, file, added, has_cover, status, fraction, position, section_chars, largest_file, last_opened from books";

/// A file or folder name that is safe on macOS and readable: no slashes or colons, not hidden, not too long.
fn safe_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if matches!(c, '/' | ':' | '\\') || c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    let cut: String = cleaned.chars().take(120).collect();
    if cut.is_empty() { "Untitled".into() } else { cut }
}

fn save_thumbnail(bytes: &[u8], to: &Path) -> Result<(), String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let img = if img.height() > 600 { img.resize(600, 600, image::imageops::FilterType::Lanczos3) } else { img };
    img.to_rgb8().save_with_format(to, image::ImageFormat::Jpeg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_name("Frankenstein; Or: The Modern/Prometheus"), "Frankenstein; Or The Modern Prometheus");
        assert_eq!(safe_name("..hidden"), "hidden");
        assert_eq!(safe_name("   "), "Untitled");
    }

    #[test]
    fn adds_books_and_keeps_underlines() {
        let books = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spikes/azw3/books"));
        if !books.exists() {
            return; // the test books aren't in the repo
        }
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let Added::Added { book } = lib.add(&books.join("pg145.epub")) else { panic!("not added") };
        assert_eq!(book.title, "Middlemarch");
        assert_eq!(book.file, "George Eliot/Middlemarch.epub");
        assert!(book.cover.as_ref().is_some_and(|c| Path::new(c).exists()));
        assert!(matches!(lib.add(&books.join("pg145.epub")), Added::AlreadyThere { .. }));
        assert!(matches!(lib.add(&tmp.path().join("nope.epub")), Added::Failed { .. }));

        lib.set_position(book.id, "epubcfi(/6/4!/4/2)", 0.0, false).unwrap();
        assert_eq!(lib.book(book.id).unwrap().status, "Not started");
        lib.set_position(book.id, "epubcfi(/6/76!/4/2)", 0.38, true).unwrap();
        assert_eq!(lib.book(book.id).unwrap().status, "Reading");
        let u = lib
            .add_underline(&Underline {
                id: 0,
                book_id: book.id,
                cfi: "epubcfi(/6/76!/4/2,/1:0,/1:10)".into(),
                exact: "When the a".into(),
                prefix: "".into(),
                suffix: "nimals".into(),
                label: 1,
                note: "".into(),
                created: 0,
                page: Some(350),
                chapter: Some("CHAPTER XXXV.".into()),
            })
            .unwrap();
        lib.relabel_underline(u.id, 3).unwrap();
        drop(lib);
        let lib = Library::open(tmp.path()).unwrap();
        let us = lib.underlines(book.id).unwrap();
        assert_eq!(us.len(), 1);
        assert_eq!(us[0].label, 3);
        assert_eq!(us[0].page, Some(350));
        let notes = lib.notes().unwrap();
        assert_eq!((notes[0].title.as_str(), notes[0].underline.id), ("Middlemarch", u.id));
        lib.remove_underline(u.id).unwrap();
        assert!(lib.underlines(book.id).unwrap().is_empty());
    }
}
