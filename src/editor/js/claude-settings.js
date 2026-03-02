// Claude AI settings: stored in localStorage, persists across sessions.
const KEY = 'mw-claude-settings';

const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-4-6',
};

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(KEY);
    _cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    _cache = { ...DEFAULTS };
  }
  return _cache;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(_cache));
  } catch { /* localStorage unavailable */ }
}

export function getClaudeSettings() {
  return load();
}

export function setClaudeSetting(key, value) {
  load()[key] = value;
  save();
}
