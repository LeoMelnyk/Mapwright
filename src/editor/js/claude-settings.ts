// AI settings (Ollama): stored in localStorage, persists across sessions.
const KEY = 'mw-claude-settings';

const DEFAULTS = {
  ollamaBase: 'http://localhost:11434',
  model: 'qwen3.5:9b',
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

export function getClaudeSettings(): Record<string, unknown> {
  return load();
}

export function setClaudeSetting(key: string, value: unknown): void {
  load()[key] = value;
  save();
}
