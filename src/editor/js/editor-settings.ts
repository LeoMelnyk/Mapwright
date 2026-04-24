import { setDevLogging } from '../../util/index.js';

// Editor-level settings: persist across maps via localStorage.
// These are NOT map properties — they belong to the editor environment.
const EDITOR_SETTINGS_KEY = 'mw-editor-settings';

const DEFAULTS = {
  fpsCounter: false,
  memoryUsage: false,
  minimap: false,
  diagExpanded: true,
  renderQuality: 20, // cache px/ft: 10=Low, 15=Medium, 20=High, 30=Ultra
  lightQuality: 10, // lightmap px/ft: 5=Low, 10=Medium, 15=High, 20=Ultra
  weatherMotion: 'animated', // 'animated' (particles + lightning) or 'static' (haze only)
  debug: false, // show debug panel in right sidebar
};

let _cache: Record<string, unknown> | null = null;

function load(): Record<string, unknown> {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(EDITOR_SETTINGS_KEY);
    _cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    _cache = { ...DEFAULTS };
  }
  return _cache!;
}

function save() {
  try {
    localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(_cache));
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Get the current editor settings (persisted in localStorage).
 * @returns {Object} Settings object with keys like fpsCounter, renderQuality, etc.
 */
export function getEditorSettings(): Record<string, unknown> {
  return load();
}

/**
 * Update a single editor setting and persist to localStorage.
 * @param {string} key - Setting key (e.g. 'fpsCounter', 'renderQuality').
 * @param {*} value - New value for the setting.
 * @returns {void}
 */
export function setEditorSetting(key: string, value: unknown): void {
  load()[key] = value;
  save();
  if (key === 'debug') setDevLogging(Boolean(value));
}
