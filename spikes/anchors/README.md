# Test 2: keeping underlines on the right words

Run on 30 October 2026. This checks two things:

- underlines survive Nightstand rewriting a book file;
- highlights brought back from a Kindle land on the right words in the EPUB.

## Result

It works, with one change to the plan: **store each underline as a CFI and as a quote**. The quote is the underlined text plus about 48 characters on either side, the same idea as the W3C Web Annotation "text quote selector". The CFI is the fast path. The quote checks the CFI and recovers it when it fails.

### Underlines after the file is rewritten

There were 300 underlines in Middlemarch, made at random places with a fixed seed. They were 3 to 60 words long, and 113 of them crossed from one element into another, such as into italics.

| Rewrite | CFI found the same words | CFI failed | CFI gave other words, no error | Put back by the quote | Lost |
|---|---|---|---|---|---|
| **Edit details** (`details.epub`): new title, extra author, new subjects and series, new cover image, zip rebuilt in a different order | 300 | 0 | 0 | — | 0 |
| **New edition** (`edition.epub`): a new page at the start of the book, a new paragraph at the top of every chapter, "to-day" changed to "today" (59 places) | 0 | 290 | 10 | 300 | 0 |

The Edit details case is the one Nightstand causes itself, and CFIs alone are enough there, because the chapter files are left untouched. The new-edition case shows why the quote is needed. In 10 cases the old CFI pointed at different words and gave no error. Without a check against the quote, those underlines would sit on the wrong words.

### Highlights from a Kindle

`gen/clippings.py` writes a `My Clippings.txt` the way a Kindle does:

- a byte-order mark before every title;
- CRLF line endings;
- one location range per highlight;
- notes and bookmarks mixed in;
- a highlight that was later extended appearing twice;
- one book that isn't in the library.

The text comes from KindleUnpack's reading of **our converted AZW3s**, so the test covers the conversion as well.

It holds 291 entries: 263 highlights, 18 notes and 10 bookmarks across four books, plus Sapiens.

| | |
|---|---|
| Book not in the library | Sapiens, both entries set aside |
| Extended highlights dropped as duplicates | 11 of 11, nothing else dropped |
| Notes attached to their highlight | 18 of 18 |
| Highlights matched, by location only | 243 of 250, with 7 short ones on another copy of the same phrase |
| **Highlights matched, with context from the AZW3** | **250 of 250** |

How it matches:

1. **Fold the text.** Keep only letters and digits, in lower case, with accents removed. Curly or straight quotes, dashes, "to-day" or "today", and paragraph breaks all stop mattering. Highlights that cross paragraphs (30, some joined with no space) matched every time.
2. **On the Kindle side** (`gen/kindle_side.py`), find the highlight in the AZW3's own text near its location number. A location is roughly byte (n − 1) × 150. Then record the 40 folded characters on either side. Nightstand can do this because it made the AZW3, or can read it off the Kindle.
3. **In the EPUB**, find every place the folded highlight occurs and choose the one whose surroundings agree with the Kindle's. Location is the tie-break. Then make a CFI for it.

Short highlights are the hard case. 22 of the 261 appear more than once in their book, such as "said Mr.", "It was" and "she had". Location alone mapped 7 of them to the wrong copy, because a location counts markup bytes, not words. Step 2 fixes all 7.

The same positions are used to spot extended highlights. A later entry that covers the same stretch of the AZW3 replaces the earlier one. A simpler rule, "the text is contained in a nearby longer highlight", wrongly dropped a two-word highlight ("is a").

## Caveats

- **The clippings file is generated, not from a real Kindle.** Its format follows real files. Real location numbers come from the Kindle's own count, which may differ a little from (bytes / 150). Step 2 searches near the location rather than at it, so small differences shouldn't matter, but a real file is the check.
- Books the Kindle got from somewhere else, such as Amazon purchases, can't be matched by step 2, because Nightstand doesn't have that AZW3. Those fall back to location alone, which here was 97% right.
- Only Middlemarch was rewritten for part one. Its chapters are long single files; books with many tiny files should behave the same, because the quote search covers the whole book.

## For the app

- Each underline row stores `cfi`, `exact`, `prefix`, `suffix` and the section's manifest id.
- On open, resolve the CFI and compare its folded text with `exact`. If they differ or the CFI fails, search for the quote, store the new CFI, and keep the old one in history.
- For Kindle imports, the Rust core reads the AZW3 text (for books Nightstand sent) to get context, then matches in the EPUB as above.

## Files and rerunning

- `gen/variants.py` makes `details.epub` and `edition.epub` from Middlemarch.
- `gen/clippings.py` makes `My Clippings.txt` and `truth.json`, which records what each highlight really was.
- `gen/kindle_side.py` makes `kindle-context.json`.
- `check.html` runs both parts in a browser with foliate-js and prints the numbers.

```
python3 -I gen/variants.py books/pg145.epub books
../azw3/.venv/bin/python -I gen/clippings.py ../azw3/out books
../azw3/.venv/bin/python -I gen/kindle_side.py ../azw3/out "books/My Clippings.txt" books/kindle-context.json
cd .. && python3 -m http.server 8779   # then open http://127.0.0.1:8779/anchors/check.html
```
