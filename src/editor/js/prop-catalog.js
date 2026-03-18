// Prop Catalog Loader
// Fetches .prop files from the server and builds an in-memory catalog.
// Uses localStorage to cache parsed definitions on subsequent loads.

import { parsePropFile } from '../../render/index.js';
import { loadTextureImages, getTextureCatalog } from './texture-catalog.js';
import { showToast } from './toast.js';

const MANIFEST_URL = '/props/manifest.json';
const PROPS_BASE_URL = '/props/';
const CACHE_KEY = 'prop-catalog';
const CACHE_VER_KEY = 'prop-catalog-ver';

let cachedCatalog = null;

/**
 * Build the catalog structure from a { name: def } map.
 */
function buildCatalog(props) {
  const byCategory = {};
  const categoryOrder = [];
  for (const [name, def] of Object.entries(props)) {
    if (!byCategory[def.category]) {
      byCategory[def.category] = [];
      categoryOrder.push(def.category);
    }
    byCategory[def.category].push(name);
  }
  return { categories: categoryOrder, props, byCategory };
}

/**
 * Load all prop definitions from the server.
 * Fetches manifest.json, then loads each .prop file in parallel.
 * Caches parsed results in localStorage for fast subsequent loads.
 * @param {function} [onProgress] — called with (loaded, total) as prop files are fetched
 * @returns {Promise<PropCatalog>}
 */
export async function loadPropCatalog(onProgress) {
  if (cachedCatalog) return cachedCatalog;

  try {
    const manifestRes = await fetch(MANIFEST_URL);
    if (!manifestRes.ok) {
      console.warn('[prop-catalog] Could not load manifest.json:', manifestRes.status);
      return buildEmptyCatalog();
    }
    const propNames = await manifestRes.json();
    const version = propNames.join(',');

    // Try localStorage cache
    const cachedVer = localStorage.getItem(CACHE_VER_KEY);
    if (cachedVer === version) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (cached && Object.keys(cached).length) {
          if (onProgress) onProgress(propNames.length, propNames.length);
          cachedCatalog = buildCatalog(cached);
          preloadPropTextures(cachedCatalog);
          return cachedCatalog;
        }
      } catch { /* cache corrupt, fall through */ }
    }

    // Fresh fetch
    let loaded = 0;
    if (onProgress) onProgress(0, propNames.length);

    const results = await Promise.allSettled(
      propNames.map(async (name) => {
        const res = await fetch(`${PROPS_BASE_URL}${name}.prop`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const def = parsePropFile(text);
        loaded++;
        if (onProgress) onProgress(loaded, propNames.length);
        return { name, def };
      })
    );

    const props = {};
    let propFailCount = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        propFailCount++;
        console.warn('[prop-catalog] Failed to load prop:', result.reason);
        continue;
      }
      const { name, def } = result.value;
      props[name] = def;
    }
    if (propFailCount > 0) {
      showToast(`Failed to load ${propFailCount} prop(s) — some props may not be available`);
    }

    // Cache to localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(props));
      localStorage.setItem(CACHE_VER_KEY, version);
    } catch { /* localStorage full or unavailable */ }

    cachedCatalog = buildCatalog(props);
    preloadPropTextures(cachedCatalog);
    return cachedCatalog;
  } catch (e) {
    console.warn('[prop-catalog] Failed to load catalog:', e);
    showToast('Could not load prop catalog — props unavailable');
    return buildEmptyCatalog();
  }
}

/**
 * Get the cached catalog synchronously (null if not yet loaded).
 */
export function getPropCatalog() {
  return cachedCatalog;
}

/**
 * Clear the in-memory catalog cache so the next loadPropCatalog() re-fetches from server.
 */
export function clearPropCatalogCache() {
  cachedCatalog = null;
}

function buildEmptyCatalog() {
  cachedCatalog = { categories: [], props: {}, byCategory: {} };
  return cachedCatalog;
}

/**
 * Preload texture images referenced by any prop's texfill commands.
 * Fire-and-forget — textures load in the background.
 */
function preloadPropTextures(catalog) {
  const texCatalog = getTextureCatalog();
  if (!texCatalog) return;

  const ids = new Set();
  for (const propDef of Object.values(catalog.props)) {
    if (propDef.textures) {
      for (const id of propDef.textures) ids.add(id);
    }
  }

  for (const id of ids) {
    loadTextureImages(id);
  }
}
