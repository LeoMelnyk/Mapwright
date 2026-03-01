// Editor-level settings: persist across maps via localStorage.
// These are NOT map properties — they belong to the editor environment.
const EDITOR_SETTINGS_KEY = 'mw-editor-settings';

const DEFAULTS = {
  fpsCounter: false,
  memoryUsage: false,
  minimap: false,
};

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(EDITOR_SETTINGS_KEY);
    _cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    _cache = { ...DEFAULTS };
  }
  return _cache;
}

function save() {
  try {
    localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(_cache));
  } catch { /* localStorage unavailable */ }
}

export function getEditorSettings() {
  return load();
}

export function setEditorSetting(key, value) {
  load()[key] = value;
  save();
}
