// Editor-level settings: persist across maps via localStorage.
// These are NOT map properties — they belong to the editor environment.
const EDITOR_SETTINGS_KEY = 'mw-editor-settings';

const DEFAULTS = {
  fpsCounter: false,
  memoryUsage: false,
  minimap: false,
  diagExpanded: true,
  renderQuality: 20,  // cache px/ft: 10=Low, 15=Medium, 20=High, 30=Ultra
  lightQuality: 10,   // lightmap px/ft: 5=Low, 10=Medium, 15=High, 20=Ultra
  debug: false,       // show debug panel in right sidebar
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
