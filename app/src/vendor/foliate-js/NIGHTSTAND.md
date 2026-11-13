# foliate-js in Nightstand

Copied from https://github.com/johnfactotum/foliate-js (MIT, see LICENSE), main branch as downloaded on 29 October 2026. PDF support (vendor/pdfjs) is left out.

Changes:

- `view.js`: the `relocate` event includes `reason` (`page`, `snap`, `scroll`, `navigation`, `selection` or `anchor`), so the Reader can keep its place across layout changes (see spikes/pages).
