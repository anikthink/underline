mod epub;
mod library;
mod notes;

use library::{Added, Book, Library, Note, Underline};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State, ipc::Response};

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
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("NIGHTSTAND_SELFTEST") {
                let mut js = std::fs::read_to_string(&path)?;
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
            list_notes,
            export_settings,
            set_export,
            dev_log,
            dev_exit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nightstand");
}
