# Test 3: the pages layout on a long book

Run on 13 November 2026. This checks that Middlemarch, about 320,000 words, turns pages instantly in the pages layout, and that its page number stays put when the font size changes. It was run in two engines:

- **WebKit:** `WKWebView`, the engine Tauri uses on macOS, driven by `gen/webkit.swift`.
- **Chromium:** for comparison.

## Result

It works for normal books, with two changes:

1. **Page numbers count characters, not screens.**
2. **The Reader remembers the word you're reading and returns to it after any layout change.**

Books stored as one huge file are slow to open in WebKit. Nightstand should split them when they're added.

### Page numbers

- **A page is 2,000 characters of text.** That gives Middlemarch **905 pages**, close to a printed paperback (Penguin's is about 880). Chapter 35 opens on p. 350.
- **The number is worked out from the first word on screen.** It doesn't depend on font size, window size or margins.
- **The text of every chapter is counted once, when the book is added.** That took 0.1 s for Middlemarch.
- **At 15 pt, a page is about 1.9 screens.** At 24 pt it's about 4.5 screens, so the number changes every few turns, like a Kindle's location.
- **Across 80 turns at each size**, the number never went backwards and never skipped.
- **If a book has its own print page list** (EPUB `page-list`), show those numbers instead. foliate-js already reads them. Middlemarch from Gutenberg doesn't have one.

### Font size 15 → 24 → 15 pt, at chapter 35 and 8 other places

| | Middlemarch, WebKit | Middlemarch, Chromium | One-file Middlemarch, WebKit | One-file Middlemarch, Chromium |
|---|---|---|---|---|
| Same page number before, during and after | 9 of 9 | 9 of 9 | 9 of 9 | 9 of 9 |
| Back to the same words at 15 pt | 9 of 9 | 9 of 9 | 9 of 9 | 9 of 9 |
| Word being read still on screen at 24 pt | 9 of 9 | 9 of 9 | 9 of 9 | 9 of 9 |
| Time per size change | 9–55 ms | 15–58 ms | 0.5–1.2 s | 0.7–1.1 s |

All of these used the fix below. **Without it**, foliate-js kept the page number right, but in 5 of 9 changes at 24 pt the screen no longer showed the words you'd been reading. At 24 pt, the text from one 15 pt screen spans two or three screens, and foliate-js keeps the whole range in view rather than its start.

The fix:
1. When the reader moves (turns a page, jumps, follows a link), remember a point about 12 characters into the first line.
2. After any layout change, go to that point.

Two details mattered:
- **Layout changes must not update the remembered point.** Otherwise the position creeps backwards with each change.
- **The very first character can sit exactly on the boundary between two screens**, which sent 3 of 9 back one screen. Starting a few characters in fixes that.

### Page turns, 80 at each size from chapter 35

| | Middlemarch, WebKit | Middlemarch, Chromium | One-file Middlemarch, WebKit | One-file Middlemarch, Chromium |
|---|---|---|---|---|
| Typical turn | 5 ms | 12–13 ms | 8–10 ms | 11–13 ms |
| Slowest turn | 12 ms | 33 ms | 31 ms | 470 ms |
| Into the next chapter (slowest) | 2 ms | 28 ms | — | — |
| File to first page | 0.18 s | 0.06 s | **8.7 s** | 0.8 s |

How these were timed:
- **WebKit:** until layout is done. **Chromium:** until the next frame is painted.
- **foliate-js waits 100 ms after each turn** before it accepts another one, to stop double-clicks skipping pages. That wait isn't counted, since the new page is already showing.

### The one-file problem

Some EPUBs keep the whole book in one XHTML file. Middlemarch as one 1.8 MB file is the worst case. In WebKit:

- **It takes 8.7 s to open** and about 1 s to change the font size. Page turns are still fast.
- **The host page stops getting animation frames** (`requestAnimationFrame` never fires) while this document is open, though the book itself still draws. foliate-js's animated page turn relies on those frames, so it would freeze.

Normal EPUBs split the book into chapter files. Gutenberg's Middlemarch has 90, and none of these problems happen.

**For the app:** when a book is added, check its largest content file. Above about 300 KB, make a split copy for reading, using the same top-level splitting as the AZW3 converter. Underlines keep their quote (test 2), so they move across even though the CFIs change.

## Caveats

- **The fonts were Georgia at 15 and 24 pt**, in a 900 × 680 reading area with one column. Two columns or other fonts change how many screens make a page, but not the page numbers.
- **Each engine was tested on one Mac.** An older Mac will be slower, but there's plenty of margin for normal books.
- **The WebKit window was transparent and not focused.** Numbers in a real Tauri window should be the same or better.

## Files and rerunning

- `gen/onefile.py` makes `books/onefile.epub` from Middlemarch.
- `check.html` runs the test.
  - Add `?book=pg145|onefile` to pick the book.
  - Add `keep=1` to use the remembered-word fix.
  - Add `frames=0` to time until layout is done rather than painted.
- `gen/webkit.swift` opens the page in WKWebView and prints the result.
- `results/` holds the WebKit results.

```
python3 -I gen/onefile.py ../azw3/books/pg145.epub books/onefile.epub && cp ../azw3/books/pg145.epub books/
cd .. && python3 -m http.server 8779 &
swiftc -O pages/gen/webkit.swift -o /tmp/wkrun
/tmp/wkrun "http://127.0.0.1:8779/pages/check.html?book=pg145&keep=1&frames=0" 0
```
