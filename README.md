# Nightstand

Design work for Nightstand, a desktop ebook app for Mac. It started from calibre but is a separate app, not a fork.

## Prototypes

Open `prototypes/index.html` in a browser. Each page is a standalone HTML file with no build step.

- `flow.html` is the place to start. It's one working window covering the library, the Reader, Notes, Devices, ⌘K and Settings.
- `stack.html` covers the decision to build it with Tauri 2, Mac first, and the risky parts tested before building.

## Spikes

These are small experiments that test the risky parts before the app is built.

- `spikes/azw3/` tests converting EPUB to AZW3 for Kindles without calibre. It's a Go converter with a patched copy of `leotaku/mobi`.
- `spikes/anchors/` tests keeping underlines on the right words when a book file is rewritten, and matching Kindle `My Clippings.txt` highlights back to the EPUB.

Each folder has a README with results and steps to rerun. The test books and the foliate-js download aren't in the repo:

- Books: Project Gutenberg EPUBs 145, 1342, 11 and 84, placed in `spikes/azw3/books/` and `spikes/anchors/books/`.
- foliate-js: https://github.com/johnfactotum/foliate-js, unzipped to `spikes/vendor-dl/foliate-js-main/`.
- KindleUnpack: `python3 -m venv spikes/azw3/.venv && spikes/azw3/.venv/bin/pip install mobi`.
