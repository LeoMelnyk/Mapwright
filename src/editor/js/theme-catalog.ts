// Theme Catalog — loads .theme files, registers them with the renderer, provides previews.
// Uses localStorage to cache theme data on subsequent loads.
import type { Theme } from '../../types.js';
import { THEMES, renderDungeonToCanvas, calculateCanvasSize } from '../../render/index.js';

const BASE_URL = '/themes/';
const CACHE_KEY = 'theme-catalog';
const CACHE_VER_KEY = 'theme-catalog-ver';

let catalog: {
  names: string[];
  themes: Record<string, Record<string, unknown>>;
  userNames: string[];
  userThemes: Record<string, Record<string, unknown>>;
} | null = null;

// Minimal dungeon used for preview renders — a plain 3×3 room
const PREVIEW_CELLS = [
  [{}, {}, {}],
  [{}, {}, {}],
  [{}, {}, {}],
];

/**
 * Register themes into the shared THEMES registry and build the catalog.
 */
function buildFromData(themeMap: Record<string, Record<string, unknown>>) {
  const names: string[] = [];
  const themes: Record<string, Record<string, unknown>> = {};
  for (const [key, data] of Object.entries(themeMap)) {
    const { displayName, ...themeProps } = data;
    themes[key] = { ...themeProps, displayName };
    names.push(key);
    THEMES[key] = themeProps as Theme;
  }
  return { names, themes };
}

/**
 * Load all themes from /themes/manifest.json + individual .theme files.
 * Also loads user-saved themes from /api/user-themes.
 * Caches parsed results in localStorage for fast subsequent loads.
 * @param {function} [onProgress] — called with (loaded, total) as theme files are fetched
 */
export async function loadThemeCatalog(onProgress?: (loaded: number, total: number) => void) {
  if (catalog) return catalog;

  try {
    const res = await fetch(`${BASE_URL}manifest.json`);
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const keys = await res.json();
    const version = keys.join(',');

    // Try localStorage cache
    const cachedVer = localStorage.getItem(CACHE_VER_KEY);
    if (cachedVer === version) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Record<string, Record<string, unknown>> | null;
        if (cached && Object.keys(cached).length) {
          if (onProgress) onProgress(keys.length, keys.length);
          catalog = { ...buildFromData(cached), userNames: [], userThemes: {} };
          // Still need to load user themes (not cached with built-ins)
          await _loadUserThemes();
          return catalog;
        }
      } catch {
        /* cache corrupt, fall through */
      }
    }

    // Fresh fetch
    let loaded = 0;
    if (onProgress) onProgress(0, keys.length);

    const results = await Promise.allSettled(
      keys.map(async (key: string) => {
        const r = await fetch(`${BASE_URL}${key}.theme`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        loaded++;
        if (onProgress) onProgress(loaded, keys.length);
        return { key, data };
      }),
    );

    const themeMap = {};
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[theme-catalog] Failed to load theme:', result.reason);
        continue;
      }
      (themeMap as Record<string, unknown>)[result.value.key] = result.value.data;
    }

    // Cache to localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(themeMap));
      localStorage.setItem(CACHE_VER_KEY, version);
    } catch {
      /* localStorage full or unavailable */
    }

    catalog = { ...buildFromData(themeMap as Record<string, Record<string, unknown>>), userNames: [], userThemes: {} };
  } catch (e) {
    console.warn('[theme-catalog] Could not load themes from server:', e);
    catalog = { names: [], themes: {}, userNames: [], userThemes: {} };
  }

  // Load user-saved themes
  await _loadUserThemes();

  return catalog;
}

/**
 * Fetch user-saved themes from the server and register them.
 */
async function _loadUserThemes() {
  if (!catalog) return;
  catalog.userNames = [];
  catalog.userThemes = {};
  try {
    const res = await fetch('/api/user-themes');
    if (!res.ok) return;
    const entries = await res.json();
    for (const entry of entries) {
      try {
        const r = await fetch(`/user-themes/${entry.filename}`);
        if (!r.ok) continue;
        const data = await r.json();
        const { displayName, ...themeProps } = data;
        const fullKey = `user:${entry.key}`;
        catalog.userNames.push(entry.key);
        catalog.userThemes[entry.key] = { ...themeProps, displayName: displayName ?? entry.key };
        THEMES[fullKey] = themeProps as Theme;
      } catch {
        /* skip individual failures */
      }
    }
  } catch {
    /* no user themes endpoint available */
  }
}

/**
 * Synchronous getter — returns null until loadThemeCatalog() has resolved.
 */
export function getThemeCatalog() {
  return catalog;
}

/** Clear the in-memory catalog cache so the next load re-fetches from server. */
export function clearThemeCatalogCache() {
  catalog = null;
}

// ── User theme CRUD wrappers ──────────────────────────────────────────────

/**
 * Save a new user theme. Returns the slug key.
 */
export async function saveUserTheme(name: string, themeObj: Record<string, unknown>) {
  const res = await fetch('/api/user-themes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, theme: themeObj }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Save failed (HTTP ${res.status})`);
  }
  const { key } = await res.json();
  // Register locally
  const fullKey = `user:${key}`;
  THEMES[fullKey] = { ...themeObj } as Theme;
  if (catalog) {
    catalog.userNames.push(key);
    catalog.userThemes[key] = { ...themeObj, displayName: name };
  }
  return key;
}

/**
 * Delete a user theme by slug key.
 */
export async function deleteUserTheme(key: string) {
  await fetch(`/api/user-themes/${key}`, { method: 'DELETE' });
  delete THEMES[`user:${key}`];
  if (catalog) {
    catalog.userNames = catalog.userNames.filter((k: string) => k !== key);
    delete catalog.userThemes[key];
  }
}

/**
 * Rename a user theme. Returns the new slug key.
 */
export async function renameUserTheme(oldKey: string, newName: string) {
  const res = await fetch(`/api/user-themes/${oldKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Rename failed (HTTP ${res.status})`);
  }
  const { key: newKey } = await res.json();
  // Update local registry
  const oldTheme = THEMES[`user:${oldKey}`];
  if (oldKey !== newKey) {
    delete THEMES[`user:${oldKey}`];
    if (oldTheme) THEMES[`user:${newKey}`] = oldTheme;
  }
  if (catalog) {
    const idx = catalog.userNames.indexOf(oldKey);
    if (idx >= 0) catalog.userNames[idx] = newKey;
    const themeData = catalog.userThemes[oldKey];
    delete catalog.userThemes[oldKey];
    catalog.userThemes[newKey] = { ...themeData, displayName: newName };
  }
  return newKey;
}

/**
 * Render a small offscreen canvas preview for a named theme.
 * Uses the full dungeon renderer on a minimal 3×3 room config.
 */
export function renderThemePreview(themeKey: string) {
  const config = {
    metadata: {
      dungeonName: '',
      gridSize: 5,
      theme: themeKey,
      features: { showGrid: false, compassRose: false, scale: false, border: false },
      levels: [{ name: '', startRow: 0, numRows: 3 }],
    },
    cells: PREVIEW_CELLS,
  };
  const { width, height } = calculateCanvasSize(config as Parameters<typeof calculateCanvasSize>[0]);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  renderDungeonToCanvas(canvas.getContext('2d')!, config as Parameters<typeof renderDungeonToCanvas>[1], width, height);
  return canvas;
}
