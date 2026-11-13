mod devices;
mod epub;
mod library;
mod notes;
mod opf;

use library::{Added, Book, Library, Note, Underline};
use std::path::PathBuf;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State, ipc::Response};

type Lib<'a> = State<'a, Mutex<Library>>;

#[tauri::command]
fn library_folder(lib: Lib) -> String {
    lib.lock().unwrap().folder.to_string_lossy().into_owned()
}

#[tauri::command]
fn list_books(lib: Lib) -> Result<Vec<Book>, String> {
    lib.lock().unwrap().books()
}

/// Copy books into the library. Runs off the main thread so a big batch doesn't freeze the window.
#[tauri::command]
async fn add_books(lib: Lib<'_>, paths: Vec<PathBuf>) -> Result<Vec<Added>, String> {
    let lib = lib.lock().unwrap();
    Ok(paths.iter().map(|p| lib.add(p)).collect())
}

/// The book's bytes, sent as binary rather than JSON.
#[tauri::command]
fn read_book(lib: Lib, id: i64) -> Result<Response, String> {
    let path = lib.lock().unwrap().file_of(id)?;
    std::fs::read(&path).map(Response::new).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
fn save_position(lib: Lib, id: i64, cfi: String, fraction: f64, turned: bool) -> Result<(), String> {
    lib.lock().unwrap().set_position(id, &cfi, fraction, turned)
}

#[tauri::command]
fn save_section_chars(lib: Lib, id: i64, chars: Vec<u64>) -> Result<(), String> {
    lib.lock().unwrap().set_section_chars(id, &chars)
}

#[tauri::command]
fn list_underlines(lib: Lib, book_id: i64) -> Result<Vec<Underline>, String> {
    lib.lock().unwrap().underlines(book_id)
}

// Every change to an underline also refreshes the exported Markdown when "Keep up to date" is on.

#[tauri::command]
fn add_underline(lib: Lib, underline: Underline) -> Result<Underline, String> {
    let lib = lib.lock().unwrap();
    let u = lib.add_underline(&underline)?;
    notes::after_change(&lib, u.book_id);
    Ok(u)
}

#[tauri::command]
fn relabel_underline(lib: Lib, id: i64, label: i64) -> Result<(), String> {
    let lib = lib.lock().unwrap();
    lib.relabel_underline(id, label)?;
    notes::after_change(&lib, lib.book_of_underline(id)?);
    Ok(())
}

#[tauri::command]
fn set_note(lib: Lib, id: i64, note: String) -> Result<(), String> {
    let lib = lib.lock().unwrap();
    lib.set_note(id, &note)?;
    notes::after_change(&lib, lib.book_of_underline(id)?);
    Ok(())
}

#[tauri::command]
fn move_underline(lib: Lib, id: i64, cfi: String, page: Option<i64>) -> Result<(), String> {
    let lib = lib.lock().unwrap();
    lib.move_underline(id, &cfi, page)?;
    notes::after_change(&lib, lib.book_of_underline(id)?);
    Ok(())
}

#[tauri::command]
fn remove_underline(lib: Lib, id: i64) -> Result<(), String> {
    let lib = lib.lock().unwrap();
    let book = lib.book_of_underline(id)?;
    lib.remove_underline(id)?;
    notes::after_change(&lib, book);
    Ok(())
}

#[tauri::command]
fn set_status(lib: Lib, id: i64, status: String) -> Result<(), String> {
    lib.lock().unwrap().set_status(id, &status)
}

/// All settings as a map. Both windows read these; Settings changes them.
#[tauri::command]
fn get_settings(lib: Lib) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(lib.lock().unwrap().settings()?.into_iter().collect())
}

/// Change a setting (null removes it) and tell every window, so changes apply straight away.
#[tauri::command]
fn set_setting(app: tauri::AppHandle, lib: Lib, key: String, value: Option<String>) -> Result<(), String> {
    lib.lock().unwrap().set_setting(&key, value.as_deref())?;
    app.emit("setting-changed", (key, value)).map_err(|e| e.to_string())
}

/// The file Export to folder would write for the book with the most underlines, for the Settings preview.
#[tauri::command]
fn export_preview(lib: Lib) -> Result<Option<String>, String> {
    let lib = lib.lock().unwrap();
    let mut best: Option<(usize, Book, Vec<Underline>)> = None;
    for b in lib.books()? {
        let us = lib.underlines(b.id)?;
        if !us.is_empty() && best.as_ref().is_none_or(|(n, ..)| us.len() > *n) {
            best = Some((us.len(), b, us));
        }
    }
    Ok(best.map(|(_, b, us)| notes::markdown(&b.title, &b.authors, &b.status, b.fraction, &us, "today".into())))
}

/// ⌘, : one Settings window, brought forward if it's already open
#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(760.0, 560.0)
        .resizable(false)
        .minimizable(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------- Devices ----------

fn device(id: &str) -> Result<devices::Device, String> {
    devices::detect().into_iter().find(|d| d.id == id).ok_or_else(|| format!("{id} isn't connected"))
}

fn fold(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

#[tauri::command]
fn list_devices() -> Vec<devices::Device> {
    devices::detect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceBook {
    #[serde(flatten)]
    on: devices::OnDevice,
    /// The library book it is, if any: sent from here, or the same title
    book_id: Option<i64>,
}

#[tauri::command]
async fn device_contents(lib: Lib<'_>, id: String) -> Result<Vec<DeviceBook>, String> {
    let dev = device(&id)?;
    let lib = lib.lock().unwrap();
    let sent = lib.sent_to(&dev.id)?;
    let books = lib.books()?;
    Ok(devices::contents(&dev)
        .into_iter()
        .map(|on| {
            let book_id = sent.iter().find(|(p, _)| *p == on.path).map(|(_, b)| *b).or_else(|| {
                let t = fold(&on.title);
                books.iter().find(|b| !t.is_empty() && (fold(&b.title) == t || (t.len() > 12 && fold(&b.title).starts_with(&t)))).map(|b| b.id)
            });
            DeviceBook { on, book_id }
        })
        .collect())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SendProgress {
    device: String,
    done: usize,
    total: usize,
    title: String,
    step: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Sent {
    book_id: i64,
    title: String,
    ok: bool,
    detail: String,
}

/// Send books: as they are to a Kobo; as AZW3 to a Kindle, converting once and keeping the copy in the library.
#[tauri::command]
async fn send_to_device(app: tauri::AppHandle, lib: Lib<'_>, id: String, book_ids: Vec<i64>) -> Result<Vec<Sent>, String> {
    let dev = device(&id)?;
    let root = PathBuf::from(&dev.path);
    let total = book_ids.len();
    let mut out = vec![];
    for (i, book_id) in book_ids.into_iter().enumerate() {
        let (book, folder, cached) = {
            let l = lib.lock().unwrap();
            (l.book(book_id)?, l.folder.clone(), l.azw3(book_id))
        };
        let progress = |step: &str| {
            let _ = app.emit("send-progress", SendProgress { device: dev.id.clone(), done: i, total, title: book.title.clone(), step: step.into() });
        };
        let res: Result<String, String> = (|| {
            let name = notes::file_name(&book.title).trim_end_matches(".md").to_string();
            if dev.kind == "kindle" {
                let epub = folder.join(&book.file);
                let mut have = cached.filter(|(f, _)| folder.join(f).is_file());
                if have.is_none() {
                    progress("Converting to AZW3");
                    let rel = book.file.trim_end_matches(".epub").to_string() + ".azw3";
                    let rep = devices::convert(&epub, &folder.join(&rel))?;
                    lib.lock().unwrap().set_azw3(book_id, &rel, rep.thumb_file.as_deref())?;
                    have = Some((rel, rep.thumb_file));
                }
                let (rel, thumb) = have.unwrap();
                progress("Copying");
                let dest = format!("documents/{name}.azw3");
                std::fs::copy(folder.join(&rel), root.join(&dest)).map_err(|e| e.to_string())?;
                // newer Kindles show a sideloaded book's cover only from system/thumbnails
                if let Some(t) = thumb {
                    let from = folder.join(&rel).parent().unwrap().join(&t);
                    if from.is_file() {
                        let _ = std::fs::create_dir_all(root.join("system/thumbnails"));
                        let _ = std::fs::copy(&from, root.join("system/thumbnails").join(&t));
                    }
                }
                lib.lock().unwrap().record_sent(&dev.id, &dest, book_id)?;
                Ok("AZW3".into())
            } else {
                progress("Copying");
                let dest = format!("Nightstand/{name}.epub");
                std::fs::create_dir_all(root.join("Nightstand")).map_err(|e| e.to_string())?;
                std::fs::copy(folder.join(&book.file), root.join(&dest)).map_err(|e| e.to_string())?;
                lib.lock().unwrap().record_sent(&dev.id, &dest, book_id)?;
                Ok("EPUB".into())
            }
        })();
        out.push(match res {
            Ok(detail) => Sent { book_id, title: book.title.clone(), ok: true, detail },
            Err(detail) => Sent { book_id, title: book.title.clone(), ok: false, detail },
        });
    }
    let _ = app.emit("send-progress", SendProgress { device: dev.id.clone(), done: total, total, title: String::new(), step: "Done".into() });
    Ok(out)
}

#[tauri::command]
fn remove_from_device(lib: Lib, id: String, path: String) -> Result<(), String> {
    let dev = device(&id)?;
    devices::remove(&dev, &path)?;
    lib.lock().unwrap().forget_sent(&dev.id, &path)
}

#[tauri::command]
fn eject_device(id: String) -> Result<(), String> {
    devices::eject(&device(&id)?)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceClip {
    #[serde(flatten)]
    clip: devices::Clip,
    book_id: Option<i64>,
    /// Kindle only, for books Nightstand converted: the folded words either side in the AZW3's own text
    context: Option<(String, String)>,
}

/// Highlights on the device that haven't been brought in before, each with the library book it belongs to
#[tauri::command]
async fn device_clips(lib: Lib<'_>, id: String) -> Result<Vec<DeviceClip>, String> {
    let dev = device(&id)?;
    let root = PathBuf::from(&dev.path);
    let clips = if dev.kind == "kindle" { devices::kindle_clips(&root) } else { devices::kobo_clips(&root) };
    let lib = lib.lock().unwrap();
    let seen = lib.imported_keys()?;
    let sent = lib.sent_to(&dev.id)?;
    let books = lib.books()?;
    let mut texts: std::collections::HashMap<i64, Option<(Vec<char>, Vec<usize>)>> = Default::default();
    Ok(clips
        .into_iter()
        .filter(|c| !seen.contains(&c.key))
        .map(|clip| {
            let by_path = clip.path.as_ref().and_then(|p| sent.iter().find(|(s, _)| s == p)).map(|(_, b)| *b);
            let t = fold(&clip.title);
            let by_title = || books.iter().find(|b| !t.is_empty() && (fold(&b.title) == t || fold(&b.title).starts_with(&t) || t.starts_with(&fold(&b.title)))).map(|b| b.id);
            let book_id = by_path.or_else(by_title);
            let context = match (book_id, clip.location) {
                (Some(b), Some((loc, _))) => texts
                    .entry(b)
                    .or_insert_with(|| lib.azw3(b).and_then(|(f, _)| devices::kindle_text(&lib.folder.join(f))).map(|raw| devices::fold_with_offsets(&raw)))
                    .as_ref()
                    .and_then(|text| devices::kindle_context(text, &clip.text, loc)),
                _ => None,
            };
            DeviceClip { book_id, clip, context }
        })
        .collect())
}

#[derive(serde::Deserialize)]
struct ImportItem {
    key: String,
    underline: Underline,
}

#[tauri::command]
fn import_underlines(lib: Lib, batch: i64, items: Vec<ImportItem>) -> Result<Vec<Underline>, String> {
    let lib = lib.lock().unwrap();
    let pairs: Vec<(String, Underline)> = items.into_iter().map(|i| (i.key, i.underline)).collect();
    let added = lib.import(batch, &pairs)?;
    let mut books: Vec<i64> = added.iter().map(|u| u.book_id).collect();
    books.dedup();
    for b in books {
        notes::after_change(&lib, b);
    }
    Ok(added)
}

#[tauri::command]
fn undo_import(lib: Lib, batch: i64) -> Result<(), String> {
    let lib = lib.lock().unwrap();
    for b in lib.undo_import(batch)? {
        notes::after_change(&lib, b);
    }
    Ok(())
}

#[tauri::command]
fn apply_progress(lib: Lib, id: i64, fraction: f64, finished: bool) -> Result<Option<String>, String> {
    lib.lock().unwrap().apply_progress(id, fraction, finished)
}

// ---------- Edit details ----------

#[tauri::command]
fn book_details(lib: Lib, id: i64) -> Result<Book, String> {
    lib.lock().unwrap().details(id)
}

#[tauri::command]
fn update_details(lib: Lib, id: i64, title: String, authors: Vec<String>, details: serde_json::Value) -> Result<(), String> {
    lib.lock().unwrap().update_details(id, &title, &authors, &details)
}

#[tauri::command]
fn set_cover(lib: Lib, id: i64, path: PathBuf) -> Result<(), String> {
    lib.lock().unwrap().set_cover(id, &path)
}

/// Write the details into the book's file. Runs off the main thread: a big EPUB takes a moment.
#[tauri::command]
async fn commit_details(lib: Lib<'_>, id: i64) -> Result<Book, String> {
    let lib = lib.lock().unwrap();
    let b = lib.commit_details(id)?;
    notes::after_change(&lib, id); // the exported file is named after the title
    Ok(b)
}

#[tauri::command]
fn list_notes(lib: Lib) -> Result<Vec<Note>, String> {
    lib.lock().unwrap().notes()
}

#[tauri::command]
fn export_settings(lib: Lib) -> notes::ExportSettings {
    notes::settings(&lib.lock().unwrap())
}

/// Set the export folder (null turns export off) and "Keep up to date", then write every book's file.
#[tauri::command]
fn set_export(lib: Lib, folder: Option<String>, keep: bool) -> Result<notes::Report, String> {
    notes::configure(&lib.lock().unwrap(), folder.as_deref(), keep)
}

/// Debug builds only: NIGHTSTAND_SELFTEST=path/to/test.js runs that script in the window
/// (see app/test/selftest.js), which reports with dev_log and quits with dev_exit.
#[tauri::command]
fn dev_log(msg: String) {
    println!("{msg}");
}

#[tauri::command]
fn dev_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `nightstand --add a.epub b.epub` adds books from the command line and quits, without opening a window
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--add") {
        let lib = Library::open(&Library::default_folder()).expect("can't open the library");
        for p in &args[i + 1..] {
            println!("{p}: {}", serde_json::to_string(&lib.add(std::path::Path::new(p))).unwrap());
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let folder = Library::default_folder();
            let lib = Library::open(&folder).map_err(|e| format!("can't open the library at {}: {e}", folder.display()))?;
            // covers are shown straight from the library folder
            app.asset_protocol_scope().allow_directory(folder.join(".nightstand/covers"), false)?;
            app.manage(Mutex::new(lib));
            // watch for Kindles and Kobos being plugged in or removed
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last = devices::detect();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let now = devices::detect();
                    let ids = |v: &Vec<devices::Device>| v.iter().map(|d| d.id.clone()).collect::<Vec<_>>();
                    if ids(&now) != ids(&last) {
                        let _ = handle.emit("devices-changed", &now);
                    }
                    last = now;
                }
            });
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("NIGHTSTAND_SELFTEST") {
                let mut js = std::fs::read_to_string(&path)?;
                if let Ok(img) = std::env::var("NIGHTSTAND_COVER_TEST") {
                    js = format!("window.COVER = {};\n{js}", serde_json::to_string(&img)?);
                }
                if let Ok(dir) = std::env::var("NIGHTSTAND_EXPORT_TEST") {
                    js = format!("window.EXPORT_TEST = {};\n{js}", serde_json::to_string(&dir)?);
                }
                let win = app.get_webview_window("main").ok_or("no main window")?;
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = win.eval(&js);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_folder,
            list_books,
            add_books,
            read_book,
            save_position,
            save_section_chars,
            list_underlines,
            add_underline,
            relabel_underline,
            move_underline,
            remove_underline,
            set_note,
            set_status,
            get_settings,
            set_setting,
            export_preview,
            open_settings,
            list_notes,
            book_details,
            update_details,
            set_cover,
            commit_details,
            list_devices,
            device_contents,
            send_to_device,
            remove_from_device,
            eject_device,
            device_clips,
            import_underlines,
            undo_import,
            apply_progress,
            export_settings,
            set_export,
            dev_log,
            dev_exit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nightstand");
}
