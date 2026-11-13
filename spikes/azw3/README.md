# Test 1: EPUB to AZW3 without calibre

Run on 29–30 October 2026. This checks whether Nightstand can make Kindle files itself, without bundling calibre.

## Result

The conversion works on a computer. The last check is on a real Kindle (see the end of this file).

| Book | Contents entries | Images | Size, EPUB → AZW3 | Time |
|---|---|---|---|---|
| Middlemarch | 103 | 1 (cover) | 1.1 → 2.4 MB | 0.25 s |
| Pride and Prejudice (illustrated) | 71 | 164 | 24.9 → 22.5 MB | 3.0 s |
| Alice's Adventures in Wonderland | 18 | 1 | 0.2 → 0.5 MB | 0.08 s |
| Frankenstein | 34 | 1 | 0.4 → 0.9 MB | 0.32 s |

Two readers checked the output. Neither shares any code with the converter.

- **KindleUnpack** (the `mobi` package on PyPI) unpacks all four books. Word counts are within 0.3% of the source EPUBs. Every image comes back, and the cover is marked as the cover.
- **foliate-js**, the renderer the app will use, opens all four with the right title, author, cover and contents. It renders chapters with their CSS and images (`check.html`).

## What it took

- **`conv/main.go`** is about 500 lines of Go. It reads the EPUB (OPF, spine, EPUB 3 nav or NCX, CSS, images) and passes HTML chapters to `github.com/leotaku/mobi` (MIT), which writes the KF8 file.
- **The library needed a patch** (`mobi-patched/`). Its contents index had no `pos_fid` tag, which is the KF8 pointer to where each chapter starts. Without it KindleUnpack crashed even on the library's own sample book, and Kindles are likely to need it too. The fix is four small edits. It should be sent upstream or kept in a fork.
- **Files with several chapters** are split at their contents anchors, cutting only between top-level elements. Without this, Pride and Prejudice had 9 contents entries instead of 71.
- **Covers on newer Kindles** come from `system/thumbnails`, not from the book file. The converter writes the thumbnail JPEG that has to be copied there, using the library's fake-ASIN filename.

## Known limits

1. **Links inside a book become plain text.** That covers footnotes and in-book contents pages. The library can't write `kindle:pos` links. The Kindle's own Go To menu still works.
2. **The contents list is flat.** Middlemarch's eight Books and their chapters become one list of 103 entries.
3. **Text isn't compressed,** so files come out about twice the EPUB's size, except for image-heavy books.
4. **Every image is re-encoded as JPEG,** so PNG transparency is lost. Images larger than the Paperwhite screen (1236×1648) are scaled down.
5. **Fonts and CSS `url()` references are removed,** so the Kindle's own fonts are used.

None of these stops the Devices design from working. 1 and 3 can be fixed later by extending the library.

## On your Kindle

1. Plug in the Paperwhite and copy `out/*.azw3` into its `documents` folder.
2. Copy `out/thumbnail_*.jpg` into `system/thumbnails`.
3. Eject it, then check each of these:
   - the four books appear in the library, with covers;
   - Go To lists the chapters, and choosing one jumps there;
   - Pride and Prejudice's illustrations show;
   - you can highlight a line and it appears in `documents/My Clippings.txt`;
   - the books are still there after a restart. Some reports say sideloaded books can disappear.

## Rerunning

```
cd conv && go build -o epub2azw3 . && cd ..
./conv/epub2azw3 books/pg145.epub out/pg145.azw3
.venv/bin/python -I ../check_unpack.py out
```
