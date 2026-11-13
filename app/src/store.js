// Settings shared by the library window and the Settings window. Stored in the library database;
// a change in either window reaches the other through the "setting-changed" event.
const { invoke } = window.__TAURI__.core

export const DEFAULTS = {
  theme: 'match',          // match | light | dark: the app's own colours
  open_at: 'library',      // library | book: what opens first
  reader_font: 'Georgia',
  reader_size: '15',
  reader_paper: 'match',   // match | day | sepia | night; match follows the app's theme
}

let values = { ...DEFAULTS }
const listeners = new Set()

export async function loadSettings() {
  values = { ...DEFAULTS, ...(await invoke('get_settings')) }
  applyTheme()
  return values
}
export const setting = k => values[k] ?? DEFAULTS[k]
export async function setSetting(k, v) {
  values[k] = v
  await invoke('set_setting', { key: k, value: v == null ? null : String(v) })
}
export const onSetting = f => listeners.add(f)

window.__TAURI__.event.listen('setting-changed', ({ payload: [k, v] }) => {
  values[k] = v ?? DEFAULTS[k]
  if (k === 'theme') applyTheme()
  for (const f of listeners) f(k, values[k])
})

export const darkNow = () => setting('theme') === 'dark' || (setting('theme') === 'match' && matchMedia('(prefers-color-scheme: dark)').matches)
function applyTheme() {
  const t = setting('theme')
  if (t === 'match') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { for (const f of listeners) f('theme', setting('theme')) })
