# Nightstand app

Tauri 2, Mac first. A Rust core (`src-tauri/`) keeps the library; the window (`src/`) is plain HTML, CSS and ES modules with foliate-js for reading. There's no frontend build step.

## What works

- **Library** in `~/Books/Nightstand`, filed as `Author/Title.epub`. The database and cover thumbnails are in `.nightstand/` inside it.
- **Adding books:** drop EPUB files on the window or use Add books. Files are copied in, and the same file twice is spotted.
- **Grouping:** Reading, Not started and Finished. A book becomes Reading on its first page turn.
- **Reader:** pages layout, Contents (⌘T), A− / A+ (⌘− / ⌘+, 12–28 pt), Georgia / Charter / San Francisco, and Day / Sepia / Night paper.
- **Page numbers:** 2,000 characters of text a page, so they don't change with size or window (spikes/pages).
- **Keeping your place:** the Reader remembers the word you were reading and returns to it after any layout change, and reopens there next time.
- **Underlines:** select text, then press 1–4 or click the label: Quote, Idea, Question, Disagree. Click an underline to change its label or remove it (⌫).
- **Underline storage:** each one is stored as a CFI plus its quote, and checked when the book opens. If the words have moved, they're found by the quote and the CFI is updated (spikes/anchors).

- **Notes:** every underline from every book in one place.
  - **Revisit:** a passage from over a month ago, never the same one twice in a row. R picks another.
  - **Grouping and filters:** group by date, book (with a bar of each book's labels) or label; filter with the label chips and search (/).
  - **Keys:** J/K to move, ↵ to open in the book at that underline, 1–4 to relabel, N for a note, C to copy.
  - **Export:** Copy as Markdown copies what's on screen. Export to folder writes one Markdown file per book (frontmatter, chapters, labels as tags) and can keep it up to date. It's off until a folder is chosen, and it never touches files Nightstand didn't write.
  - **Empty states:** empty library views show a Revisit card.

- **⌘K:** one box for books, underlines and commands. Every typed word must begin a word in the result.
  - **In the library:** empty, it offers what you're reading, places and commands. Tab on a book lists what you can do with it (start or open, mark as Reading, Not started or Finished, see its underlines, Show in Finder).
  - **In the Reader:** it's scoped to the open book and searches its whole text. ⌫ removes the scope. ↵ on a match goes there.
  - **Opening an underline:** ↵ opens it in Notes; ⌘↵ opens the book at it.
  - **G then A, R, N, F or U:** go to All books, Reading, Not started, Finished or Notes.
- **Settings (⌘,):** a separate window with General (theme, what opens first), Library, Reader (defaults with a live preview), Notes (export folder and a preview of the file it writes), Devices and Shortcuts.
  - Changes apply straight away, in both windows. Settings are stored in the library database.
  - The four labels are fixed, and export is off until a folder is chosen.

- **Devices:** a Kindle or Kobo plugged in over USB shows in the sidebar.
  - **What's on it:** its page lists books from your library and books only on the device. Books bought from Amazon or Kobo are marked Protected.
  - **Sending:** Send books… sends only what you choose. Kindles get AZW3, converted once by the bundled converter (`converter/`, from spikes/azw3) and kept next to the EPUB, with the cover thumbnail copied to `system/thumbnails`. Kobos get the EPUB in a `Nightstand` folder.
  - **On connect, highlights come in as Quote underlines:** from a Kindle's My Clippings.txt (notes attached, extended highlights merged) or a Kobo's database (read from a copy, never written).
  - **A Kobo's progress** only moves books forward.
  - **What came in:** a banner says what arrived and can take it all back out; taken-out highlights don't come back. Each device can be set to Automatically, Ask first or Never.
  - **Removing a book from a device** never touches the library. Eject is on the device's page.

Not yet:
- Edit details.
- **Repeated short highlights:** on the generated test file, 240 of 250 Kindle highlights land on the right words. The 10 misses are two- or three-word phrases that occur more than once. Reading the words around each one from the AZW3 on the Kindle fixed this in spikes/anchors (250 of 250) and is the next step.
- **Kindle progress:** Kindles don't share reading positions for books sent over USB.
- **Real devices:** this has been tested against pretend Kindle and Kobo folders, not real hardware.
- Per-book Reader settings: the Reader's toolbar changes the defaults for now.
- Moving the library folder.
- Splitting very large book files. Books with a content file over 300 KB show a note that they may be slow.

## Running

Needs Rust (`rustup`), Node, pnpm and Go. Build the AZW3 converter once with `converter/build.sh` before running.

```
pnpm install
pnpm tauri dev                 # run with live reload
pnpm tauri build --bundles app # src-tauri/target/release/bundle/macos/Nightstand.app
```

- **Add books without the window:** `src-tauri/target/debug/nightstand --add a.epub b.epub`.

## Tests

- **Rust:** `cd src-tauri && cargo test` covers EPUB metadata, adding books, and underlines saved across reopening. The book tests use the Gutenberg files in `spikes/azw3/books` when they're there.
- **The window in a browser:** serve the repo root with `python3 -m http.server`, then open `/app/test/harness.html?fresh` (add `&page=settings` for the Settings window). A stand-in replaces the Rust side.
- **The real app:** `NIGHTSTAND_SELFTEST=test/selftest.js src-tauri/target/debug/nightstand` runs `test/selftest.js` in the window. It:
  - opens Middlemarch;
  - underlines with key 1;
  - changes the size there and back, then reopens the book;
  - checks Notes;
  - removes its underline, prints a JSON report and quits.

  `test/devices-selftest.js` does the same for Devices, with `NIGHTSTAND_VOLUMES` pointing at a folder of pretend devices (a `Kindle` folder with `documents/`, `system/` and a My Clippings.txt, and a `KOBOeReader` folder with `.kobo/KoboReader.sqlite`).

  With `NIGHTSTAND_EXPORT_TEST=/some/empty/folder`, it also exports there and checks that removing the underline removes the file.

  This only works in debug builds.

## Layout

- `src-tauri/src/epub.rs` reads title, authors, cover and file sizes from an EPUB.
- `src-tauri/src/library.rs` handles the library folder and the SQLite database.
- `src-tauri/src/lib.rs` holds the Tauri commands.
- `src/app.js` is the library window.
- `src/reader.js` is the Reader.
- `src/anchors.js` finds underlined words again.
- `src/notes.js` is Notes.
- `src/palette.js` is ⌘K.
- `src/settings.html` and `src/settings.js` are the Settings window.
- `src/store.js` holds settings shared between the windows.
- `src/devices.js` and `src-tauri/src/devices.rs` are Devices. `converter/` is the EPUB-to-AZW3 helper.
- `src-tauri/src/notes.rs` handles Markdown export.
- `src/vendor/foliate-js` is foliate-js (MIT), with one small patch described in its `NIGHTSTAND.md`.
