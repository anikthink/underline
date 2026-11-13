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
    /// Series, publisher, shelves, rating and so on, as JSON (see details()); null until first edited
    pub details: Option<serde_json::Value>,
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
-- what was sent to which device, so its page can say which books came from the library
create table if not exists sent (device text not null, path text not null, book_id integer not null references books(id) on delete cascade, at integer not null, primary key (device, path));
-- highlights brought in from devices. underline_id is null once it's been taken back out, so it never comes back
create table if not exists imported (key text primary key, underline_id integer, batch integer not null);
";

// Columns added after the first version: (table, column, definition)
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("underlines", "page", "integer"),
    ("underlines", "chapter", "text"),
    // the AZW3 made for Kindles, kept so a book is only converted once, and its cover thumbnail
    ("books", "azw3", "text"),
    ("books", "azw3_thumb", "text"),
    ("books", "details", "text"),
];


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

    /// ~/Books/Nightstand, or NIGHTSTAND_LIBRARY for tests
    pub fn default_folder() -> PathBuf {
        std::env::var_os("NIGHTSTAND_LIBRARY").map(PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Books/Nightstand"))
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
            // the image's modified time is added to its address, so a new cover shows straight away
            cover: has_cover.then(|| {
                let p = self.cover_path(id);
                let v = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
                format!("{}#{v}", p.to_string_lossy())
            }),
            status: r.get(6)?,
            fraction: r.get(7)?,
            position: r.get(8)?,
            section_chars: r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()),
            largest_file: r.get::<_, i64>(10)? as u64,
            last_opened: r.get(11)?,
            details: r.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
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

    pub fn azw3(&self, id: i64) -> Option<(String, Option<String>)> {
        self.db.query_row("select azw3, azw3_thumb from books where id = ? and azw3 is not null", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten()
    }

    pub fn set_azw3(&self, id: i64, file: &str, thumb: Option<&str>) -> Result<(), String> {
        self.exec("update books set azw3 = ?, azw3_thumb = ? where id = ?", params![file, thumb, id])
    }

    pub fn record_sent(&self, device: &str, path: &str, book_id: i64) -> Result<(), String> {
        self.exec("insert or replace into sent (device, path, book_id, at) values (?, ?, ?, ?)", params![device, path, book_id, now()])
    }

    pub fn forget_sent(&self, device: &str, path: &str) -> Result<(), String> {
        self.exec("delete from sent where device = ? and path = ?", params![device, path])
    }

    /// (path on device, book id) for everything sent to this device
    pub fn sent_to(&self, device: &str) -> Result<Vec<(String, i64)>, String> {
        let mut st = self.db.prepare("select path, book_id from sent where device = ?").map_err(|e| e.to_string())?;
        let rows = st.query_map([device], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn imported_keys(&self) -> Result<std::collections::HashSet<String>, String> {
        let mut st = self.db.prepare("select key from imported").map_err(|e| e.to_string())?;
        let rows = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Add underlines brought in from a device as one batch, skipping any key already seen.
    pub fn import(&self, batch: i64, items: &[(String, Underline)]) -> Result<Vec<Underline>, String> {
        let seen = self.imported_keys()?;
        let mut out = vec![];
        for (key, u) in items {
            if seen.contains(key) {
                continue;
            }
            let u = self.add_underline(u)?;
            self.exec("insert into imported (key, underline_id, batch) values (?, ?, ?)", params![key, u.id, batch])?;
            out.push(u);
        }
        Ok(out)
    }

    /// Take a batch back out. The keys stay, so those highlights aren't brought in again.
    pub fn undo_import(&self, batch: i64) -> Result<Vec<i64>, String> {
        let mut st = self.db.prepare("select distinct u.book_id from imported i join underlines u on u.id = i.underline_id where i.batch = ?").map_err(|e| e.to_string())?;
        let books: Vec<i64> = st.query_map([batch], |r| r.get(0)).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        self.exec("delete from underlines where id in (select underline_id from imported where batch = ?)", params![batch])?;
        self.exec("update imported set underline_id = null where batch = ?", params![batch])?;
        Ok(books)
    }

    /// A Kobo's position only moves a book forward: further along, or Finished. Returns the new status if it changed.
    pub fn apply_progress(&self, id: i64, fraction: f64, finished: bool) -> Result<Option<String>, String> {
        let b = self.book(id)?;
        if finished && b.status != "Finished" {
            self.exec("update books set status = 'Finished', fraction = max(fraction, ?) where id = ?", params![fraction, id])?;
            return Ok(Some("Finished".into()));
        }
        if fraction > b.fraction + 0.001 && b.status != "Finished" {
            self.exec("update books set fraction = ?, status = 'Reading' where id = ?", params![fraction, id])?;
            return Ok((b.status != "Reading").then(|| "Reading".to_string()));
        }
        Ok(None)
    }

    // ---------- Edit details ----------

    /// A book's details, read from its file the first time
    pub fn details(&self, id: i64) -> Result<Book, String> {
        let b = self.book(id)?;
        if b.details.is_some() {
            return Ok(b);
        }
        let m = epub::read(std::fs::File::open(self.folder.join(&b.file)).map_err(|e| e.to_string())?)?;
        let d = serde_json::json!({
            "series": m.series, "seriesIndex": m.series_index, "published": m.date.map(|d| d.chars().take(10).collect::<String>()),
            "publisher": m.publisher, "language": m.language, "isbn": m.isbn, "description": m.description,
            "shelves": [], "rating": 0, "sources": {}, "pending": false,
        });
        self.exec("update books set details = ? where id = ?", params![d.to_string(), id])?;
        self.book(id)
    }

    /// Save as you type: the database now, the book's file when the panel lets go of it (commit_details).
    pub fn update_details(&self, id: i64, title: &str, authors: &[String], details: &serde_json::Value) -> Result<(), String> {
        let mut d = details.clone();
        d["pending"] = serde_json::Value::Bool(true);
        // a cover chosen since the window last read the details mustn't be forgotten by this save
        if self.book(id)?.details.is_some_and(|old| old["newCover"] == true) {
            d["newCover"] = true.into();
        }
        let title = if title.trim().is_empty() { "Untitled" } else { title.trim() };
        self.exec("update books set title = ?, authors = ?, details = ? where id = ?", params![title, serde_json::to_string(authors).unwrap(), d.to_string(), id])
    }

    /// Use an image as the book's cover: the thumbnail changes now, the file's cover on commit.
    pub fn set_cover(&self, id: i64, image: &Path) -> Result<(), String> {
        let bytes = std::fs::read(image).map_err(|e| e.to_string())?;
        save_thumbnail(&bytes, &self.cover_path(id))?;
        let pending = self.folder.join(format!(".nightstand/covers/{id}-new"));
        std::fs::write(&pending, &bytes).map_err(|e| e.to_string())?;
        let b = self.details(id)?;
        let mut d = b.details.unwrap_or_default();
        d["pending"] = true.into();
        d["newCover"] = true.into();
        self.exec("update books set has_cover = 1, details = ? where id = ?", params![d.to_string(), id])
    }

    /// Write pending details into the EPUB, move it to Author/Title.epub if those changed,
    /// and drop the Kindle copy so the next send has the new details.
    pub fn commit_details(&self, id: i64) -> Result<Book, String> {
        let b = self.book(id)?;
        let Some(mut d) = b.details.clone().filter(|d| d["pending"] == true) else { return Ok(b) };
        let s = |k: &str| d[k].as_str().map(str::to_string).filter(|v| !v.trim().is_empty());
        let fd = crate::opf::FileDetails {
            title: b.title.clone(),
            authors: b.authors.clone(),
            language: s("language"),
            publisher: s("publisher"),
            published: s("published"),
            description: s("description"),
            isbn: s("isbn"),
            series: s("series"),
            series_index: d["seriesIndex"].as_str().map(str::to_string).or_else(|| d["seriesIndex"].as_f64().map(|n| n.to_string())),
        };
        let old = self.folder.join(&b.file);
        let pending_cover = self.folder.join(format!(".nightstand/covers/{id}-new"));
        let cover = (d["newCover"] == true).then(|| std::fs::read(&pending_cover).ok()).flatten();
        let bytes = crate::opf::rewrite(&std::fs::read(&old).map_err(|e| e.to_string())?, &fd, cover.as_deref())?;
        // Author/Title.epub, moving it if the title or first author changed
        let author = b.authors.first().cloned().unwrap_or_else(|| "Unknown author".into());
        let dir = safe_name(&author);
        let mut rel = format!("{dir}/{}.epub", safe_name(&b.title));
        if rel != b.file {
            let mut n = 2;
            while self.folder.join(&rel).exists() {
                rel = format!("{dir}/{} ({n}).epub", safe_name(&b.title));
                n += 1;
            }
        }
        std::fs::create_dir_all(self.folder.join(&dir)).map_err(|e| e.to_string())?;
        let tmp = self.folder.join(format!("{rel}.saving"));
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, self.folder.join(&rel)).map_err(|e| e.to_string())?;
        if rel != b.file {
            let _ = std::fs::remove_file(&old);
            if let Some(parent) = old.parent() {
                let _ = std::fs::remove_dir(parent); // only if it's now empty
            }
        }
        if let Some((azw3, thumb)) = self.azw3(id) {
            let _ = std::fs::remove_file(self.folder.join(&azw3));
            if let Some(t) = thumb {
                let _ = std::fs::remove_file(self.folder.join(&azw3).with_file_name(t));
            }
        }
        let _ = std::fs::remove_file(&pending_cover);
        d["pending"] = false.into();
        d["newCover"] = false.into();
        self.exec(
            "update books set file = ?, details = ?, azw3 = null, azw3_thumb = null, section_chars = null where id = ?",
            params![rel, d.to_string(), id],
        )?;
        self.book(id)
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

const BOOK_SELECT: &str = "select id, title, authors, file, added, has_cover, status, fraction, position, section_chars, largest_file, last_opened, details from books";

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

#[cfg(test)]
mod details_tests {
    use super::*;

    #[test]
    fn edits_are_written_into_the_file_and_it_moves() {
        let books = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spikes/azw3/books"));
        if !books.exists() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let Added::Added { book } = lib.add(&books.join("pg11.epub")) else { panic!() };
        let b = lib.details(book.id).unwrap();
        let mut d = b.details.unwrap();
        assert_eq!(d["language"], "en");
        d["series"] = "Alice".into();
        d["seriesIndex"] = "1".into();
        d["shelves"] = serde_json::json!(["Childhood"]);
        lib.update_details(book.id, "Alice in Wonderland", &["Lewis Carroll".into()], &d).unwrap();
        let b = lib.commit_details(book.id).unwrap();
        assert_eq!(b.file, "Lewis Carroll/Alice in Wonderland.epub");
        assert!(!tmp.path().join(&book.file).exists());
        let m = epub::read(std::fs::File::open(tmp.path().join(&b.file)).unwrap()).unwrap();
        assert_eq!((m.title.as_str(), m.series.as_deref()), ("Alice in Wonderland", Some("Alice")));
        assert_eq!(b.details.unwrap()["pending"], false);
    }
}
