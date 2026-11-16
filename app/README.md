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

- **Edit details:** the Edit button on a cover, ⌘I on the book under the pointer, or ⌘K's "Edit details" opens a panel beside the library.
  - **Fields:** title, authors, series and number, published, publisher, language, ISBN, shelves, description, status and rating. They're read from the book's file the first time.
  - **Saving:** changes save as you type and ⌘Z undoes. A pencil marks fields you've changed. J/K move to the next or previous book, Esc closes.
  - **Cover:** click it to choose an image.
  - **Writing the file:** when the panel lets go of a book, its EPUB is rewritten (`src-tauri/src/opf.rs`) and moved to Author/Title.epub if those changed. Only the package file and cover change; chapters are copied untouched, so underlines stay put. A book without a cover gets one added. The Kindle copy is dropped so the next send has the new details.
  - **Find details online:** compares the book with Open Library. Nothing is sent until you press it, and then only the title, first author and ISBN.
    - **Search:** an ISBN match comes first, then works ranked by how many editions they have, so one-off reprints sink.
    - **Comparing:** pick an edition (closest to yours first), and each field shows yours beside Open Library's. Take one field or all the differences. ⌘Z undoes. Taken fields are marked Open Library.
    - **Covers:** the work's covers and its editions' covers. Click one to use it.
    - **Refresh:** the book remembers which work and edition you took from, so the button becomes Refresh and goes straight to the comparison.
    - **What can be fetched:** only Open Library's read-only lookups and cover images (`src-tauri/src/online.rs`).
- **Editing several books together:** ⌘-click or Shift-click covers, then Edit together (⌘I).
  - **Fields:** status, rating, authors, series (optionally numbered 1, 2, 3… in the order shown), publisher, language and published date. You can also add books to shelves or take them off.
  - **Applying:** fields left alone stay as each book has them. Apply writes every file, and Undo puts them all back.
- **Repeated short highlights:** for books Nightstand converted, the words around each Kindle highlight are read from the AZW3's own text near its location, and they pick the right place in the EPUB. On the generated test file that's 247 of 250 on exactly the right words (240 by location alone).
  - The 3 misses are two-word phrases in Middlemarch. That file's locations drift up to 3,500 bytes from the AZW3's real text, because they were generated from KindleUnpack's rebuilt pages. A real Kindle counts the AZW3's own text, so a real My Clippings.txt is the check.
  - Highlights in books bought from Amazon still use location alone.
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
- **Open Library:** `node test/online-test.mjs` runs `src/online.js` against the live site: Middlemarch by title, Pride and Prejudice by ISBN, and a made-up book.
- **The window in a browser:** serve the repo root with `python3 -m http.server`, then open `/app/test/harness.html?fresh` (add `&page=settings` for the Settings window). A stand-in replaces the Rust side.
- **The real app:** `NIGHTSTAND_SELFTEST=test/selftest.js src-tauri/target/debug/nightstand` runs `test/selftest.js` in the window. It:
  - opens Middlemarch;
  - underlines with key 1;
  - changes the size there and back, then reopens the book;
  - checks Notes;
  - removes its underline, prints a JSON report and quits.

  `test/details-selftest.js` edits Middlemarch, sets a cover and checks the file is rewritten; run it with `NIGHTSTAND_LIBRARY` pointing at a copy of the library and `NIGHTSTAND_COVER_TEST` at an image.

  `test/online-selftest.js` finds Alice on Open Library through the Rust side, takes the publisher and a cover, and checks the file; `test/many-selftest.js` numbers two books as a series, applies and undoes. Both run on a copy of the library too.

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
- `src/details.js` is Edit details. `src/online.js` and `src-tauri/src/online.rs` are Find details online.
- `src/devices.js` and `src-tauri/src/devices.rs` are Devices. `converter/` is the EPUB-to-AZW3 helper.
- `src-tauri/src/notes.rs` handles Markdown export.
- `src/vendor/foliate-js` is foliate-js (MIT), with one small patch described in its `NIGHTSTAND.md`.
