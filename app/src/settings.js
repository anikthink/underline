// The Settings window (⌘,). Every change applies straight away; there's no Save button.
// Each setting's description changes with its value, so it says what will happen now.
import { loadSettings, setting, setSetting, onSetting } from './store.js'

const { invoke } = window.__TAURI__.core
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const home = p => String(p ?? '').replace(/^\/Users\/[^/]+/, '~')

const TABS = ['General', 'Library', 'Reader', 'Notes', 'Devices', 'Shortcuts']
let tab = 'General', folder = '', exp = { folder: null, keep: false }, preview = null

const FONTS = { Georgia: 'Georgia, serif', Charter: "Charter, 'Bitstream Charter', Georgia, serif", 'San Francisco': '-apple-system, system-ui, sans-serif' }
const SAMPLE = 'When the animals entered the Ark in pairs, one may imagine that allied species made much private remark on each other, and were tempted to think that so many forms feeding on the same store of fodder were eminently superfluous, as tending to diminish the rations.'

const row = (label, desc, control) => `<div class="row"><div class="l">${label}<div class="d">${desc}</div></div>${control}</div>`
const select = (key, opts) => `<select data-key="${key}">${opts.map(([v, n]) => `<option value="${v}" ${String(setting(key)) === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`

const PAGES = {
  General: () => `
    <h4>Appearance</h4><div class="sgrp">
      ${row('Theme', { match: 'Follows your Mac: light in the day, dark at night if you have that set.', light: 'Always light, whatever your Mac is set to.', dark: 'Always dark, whatever your Mac is set to.' }[setting('theme')],
        select('theme', [['match', 'Match Mac'], ['light', 'Light'], ['dark', 'Dark']]))}
    </div>
    <h4>Starting up</h4><div class="sgrp">
      ${row('Open with', setting('open_at') === 'book' ? 'The book you read last, where you left off.' : 'The library.',
        select('open_at', [['library', 'The library'], ['book', 'The last book']]))}
    </div>`,

  Library: () => `
    <h4>Library folder</h4><div class="sgrp">
      ${row('<span class="mono">' + esc(home(folder)) + '</span>', 'Every book, its cover and Nightstand\'s database live here. Back up this folder and you\'ve backed up everything.', '<button class="btn" data-act="reveal">Show in Finder</button>')}
      ${row('Where a book goes', `<span class="mono">${esc(home(folder))}/George Eliot/Middlemarch.epub</span>`, '')}
      ${row('Adding books', 'Books are copied in. The original file stays where it was, and the same file twice is spotted.', '')}
    </div>
    <div class="note-box">Moving the library somewhere else and watching Downloads come later.</div>`,

  Reader: () => `
    <h4>Defaults for every book</h4>
    <div class="preview" data-paper="${paper()}" style="font-family:${FONTS[setting('reader_font')] ?? FONTS.Georgia};font-size:${setting('reader_size')}pt">${SAMPLE}</div>
    <div class="sgrp">
      ${row('Font', setting('reader_font') === 'San Francisco' ? 'The Mac\'s own sans-serif.' : `${setting('reader_font')}, a serif made for reading.`, select('reader_font', Object.keys(FONTS).map(f => [f, f])))}
      ${row('Size', `${setting('reader_size')} pt. ⌘+ and ⌘− change it while reading.`, `<input type="range" min="12" max="28" step="1" value="${setting('reader_size')}" data-key="reader_size">`)}
      ${row('Paper', setting('reader_paper') === 'match' ? 'Day when the app is light, Night when it\'s dark.' : `Always ${setting('reader_paper')}, whatever the app's theme.`,
        select('reader_paper', [['match', 'Match app'], ['day', 'Day'], ['sepia', 'Sepia'], ['night', 'Night']]))}
    </div>
    <div class="note-box">For now, changing these in the Reader's toolbar changes the defaults too.</div>`,

  Notes: () => `
    <h4>Export to folder</h4><div class="sgrp">
      ${exp.folder
        ? row('<span class="mono">' + esc(home(exp.folder)) + '</span>', 'One Markdown file per book with underlines, with frontmatter and labels as tags. Nightstand never touches files it didn\'t create.', '<button class="btn" data-act="choose">Change…</button>')
          + row('Keep up to date', exp.keep ? 'A book\'s file is rewritten when you add or change an underline.' : 'Files are only written when you export from Notes.', `<input type="checkbox" data-act="keep" ${exp.keep ? 'checked' : ''}>`)
          + row('Stop exporting', 'Files already written stay where they are.', '<button class="btn" data-act="off">Turn off</button>')
        : row('No export folder', 'Nothing is written until you choose one, for example a folder in your Obsidian vault.', '<button class="btn pri" data-act="choose">Choose folder…</button>')}
    </div>
    <h4>Labels</h4><div class="sgrp">
      ${row('Quote, Idea, Question, Disagree', 'The four labels are fixed, so filters and exports mean the same thing in every book. Press 1–4 after selecting text.', '')}
    </div>
    ${preview ? `<h4>What gets written, for your most-underlined book</h4><div class="md">${esc(preview)}</div>` : ''}`,

  Devices: () => `
    <div class="sgrp"><div class="note-box">No devices yet. Kindle and Kobo over USB are the next part of the build: plug one in and it will show up here, with its own choice of Automatically, Ask first or Never for bringing highlights back.</div></div>`,

  Shortcuts: () => `
    <h4>Anywhere</h4><div class="sgrp"><table class="keys">${keys([['Search and commands', '⌘K'], ['Settings', '⌘,'], ['Add books', '⌘O']])}</table></div>
    <h4>Library</h4><div class="sgrp"><table class="keys">${keys([['All books, Reading, Not started, Finished', 'G then A, R, N, F'], ['Notes', 'G then U']])}</table></div>
    <h4>Reader</h4><div class="sgrp"><table class="keys">${keys([['Next or previous page', '→ ←  or  Space'], ['Underline the selection', '1 2 3 4'], ['Remove the clicked underline', '⌫'], ['Contents', '⌘T'], ['Bigger or smaller text', '⌘+ ⌘−'], ['Back to the library', 'Esc']])}</table></div>
    <h4>Notes</h4><div class="sgrp"><table class="keys">${keys([['Move', 'J K'], ['Open in the book', '↵'], ['Relabel', '1 2 3 4'], ['Write a note', 'N'], ['Copy', 'C'], ['Another Revisit', 'R'], ['Search', '/']])}</table></div>`,
}
const keys = list => list.map(([a, k]) => `<tr><td>${a}</td><td>${k}</td></tr>`).join('')
const paper = () => { const p = setting('reader_paper'); return p === 'match' ? (matchMedia('(prefers-color-scheme: dark)').matches && setting('theme') !== 'light' || setting('theme') === 'dark' ? 'night' : 'day') : p }

function render() {
  $('tabs').innerHTML = TABS.map(t => `<button class="${t === tab ? 'on' : ''}" data-tab="${t}">${t}</button>`).join('')
  $('page').innerHTML = PAGES[tab]()
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; if (tab === 'Notes') await loadExport(); return render() }
  const a = e.target.closest('[data-act]')?.dataset.act
  if (a === 'reveal') window.__TAURI__.opener.revealItemInDir(folder)
  if (a === 'choose') {
    const f = await window.__TAURI__.dialog.open({ directory: true, defaultPath: exp.folder ?? undefined })
    if (f) { await invoke('set_export', { folder: f, keep: exp.folder ? exp.keep : true }); await loadExport(); render() }
  }
  if (a === 'off') { await invoke('set_export', { folder: null, keep: false }); await loadExport(); render() }
})
document.addEventListener('change', async e => {
  if (e.target.dataset.act === 'keep') { await invoke('set_export', { folder: exp.folder, keep: e.target.checked }); await loadExport(); return render() }
  const k = e.target.dataset.key; if (!k) return
  await setSetting(k, e.target.value); render()
})
// the size slider updates the preview as it moves
document.addEventListener('input', e => { if (e.target.dataset.key === 'reader_size') { setSetting('reader_size', e.target.value); const p = document.querySelector('.preview'); if (p) p.style.fontSize = e.target.value + 'pt'; e.target.closest('.row').querySelector('.d').textContent = `${e.target.value} pt. ⌘+ and ⌘− change it while reading.` } })
document.addEventListener('keydown', e => { if (e.key === 'Escape' || (e.metaKey && e.key === 'w')) window.__TAURI__.window.getCurrentWindow().close() })

async function loadExport() { [exp, preview] = await Promise.all([invoke('export_settings'), invoke('export_preview')]) }

// changes made elsewhere (the Reader's toolbar) show here too
onSetting(() => { if (!document.activeElement?.matches('input[type=range]')) render() })

await loadSettings()
folder = await invoke('library_folder')
render()
