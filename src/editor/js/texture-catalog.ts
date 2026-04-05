// Texture Catalog — loads .texture metadata and lazily loads PNG images on demand.
// Mirrors the pattern of theme-catalog.js and prop-catalog.js.

import { showToast } from './toast.js';

const BASE_URL = '/textures/';
const CACHE_KEY = 'texture-catalog';
const CACHE_VER_KEY = 'texture-catalog-ver';

let catalog: any = null; // { names, textures, byCategory, categoryOrder }

/**
 * A texture entry in the catalog:
 * {
 *   id: string,
 *   displayName: string,
 *   category: string,
 *   subcategory: string | null,
 *   file: string,           // diffuse PNG path relative to /textures/
 *   dispFile: string|null,  // displacement map path (or null for auto-derived)
 *   norFile: string|null,   // normal map path
 *   armFile: string|null,   // ARM map path
 *   scale: number,          // grid cells per texture tile (default 2.0)
 *   credit: string,
 *   img:     HTMLImageElement|null,  // diffuse — loaded on demand
 *   dispImg: HTMLImageElement|null,  // displacement — loaded on demand
 *   norImg:  HTMLImageElement|null,  // normal map — loaded on demand
 *   armImg:  HTMLImageElement|null,  // AO+Roughness+Metal — loaded on demand
 * }
 *
 * Image elements are null until loadTextureImages(id) is called.
 * The renderer gracefully skips entries with null/incomplete images.
 */

/**
 * Build catalog entries from raw metadata array (metadata only, no image loading).
 */
function buildFromMetadata(entries: any) {
  const names = [];
  const textures = {};
  const byCategory = {};
  const categoryOrder = [];

  for (const data of entries) {
    const key = data.id;

    const entry = {
      id: key,
      displayName: data.displayName || key,
      category: data.category || 'Uncategorized',
      subcategory: data.subcategory || null,
      file: data.file,
      dispFile: data.dispFile || null,
      norFile: data.norFile || null,
      armFile: data.armFile || null,
      scale: data.scale ?? 2.0,
      credit: data.credit || '',
      img: null,
      dispImg: null,
      norImg: null,
      armImg: null,
    };

    (textures as any)[key] = entry;
    names.push(key);

    if (!(byCategory as any)[entry.category]) {
      (byCategory as any)[entry.category] = [];
      categoryOrder.push(entry.category);
    }
    (byCategory as any)[entry.category].push(key);
  }

  return { names, textures, byCategory, categoryOrder };
}

/**
 * Load texture metadata from server. Uses localStorage cache for subsequent loads.
 * @returns {Promise<Object>} The texture catalog with names, textures, byCategory, categoryOrder.
 */
export async function loadTextureCatalog(): Promise<any> {
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
        // @ts-expect-error — strict-mode migration
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (cached?.length) {
          catalog = buildFromMetadata(cached);
          return catalog;
        }
      } catch { /* cache corrupt, fall through to fresh fetch */ }
    }

    // Fresh fetch — load all .texture files
    const results = await Promise.allSettled(
      keys.map(async (key: any) => {
        const r = await fetch(`${BASE_URL}${key}.texture`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { key, data: await r.json() };
      })
    );

    // Build serializable metadata array
    const metadataEntries = [];
    let textureFailCount = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        textureFailCount++;
        console.warn('[texture-catalog] Failed to load texture:', result.reason);
        continue;
      }
      const { key, data } = result.value;
      metadataEntries.push({
        id: key,
        displayName: data.displayName || key,
        category: data.category || 'Uncategorized',
        subcategory: data.subcategory || null,
        file: data.file,
        scale: data.scale ?? 2.0,
        credit: data.credit || '',
        dispFile: data.maps?.disp || null,
        norFile: data.maps?.nor || null,
        armFile: data.maps?.arm || null,
      });
    }

    if (textureFailCount > 0) {
      showToast(`Failed to load ${textureFailCount} texture(s) — some textures may not render`);
    }

    // Cache metadata to localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(metadataEntries));
      localStorage.setItem(CACHE_VER_KEY, version);
    } catch { /* localStorage full or unavailable — ignore */ }

    catalog = buildFromMetadata(metadataEntries);
  } catch (e) {
    console.warn('[texture-catalog] Could not load textures from server:', e);
    showToast('Could not load texture catalog — textures unavailable');
    catalog = { names: [], textures: {}, byCategory: {}, categoryOrder: [] };
  }

  return catalog;
}

/**
 * Load PNG images for a single texture entry on demand.
 * @param {string} id - Texture catalog ID.
 * @returns {Promise<void>} Resolves when diffuse + displacement images are ready.
 */
export function loadTextureImages(id: string): Promise<void> {
  const entry = catalog?.textures[id];
  if (!entry) return Promise.resolve();

  // If already started, return the existing loading promise
  // (don't return Promise.resolve() — the images may still be loading)
  if (entry._loadPromise) return entry._loadPromise;

  // Diffuse — always present
  const img = new Image();
  img.src = `${BASE_URL}${entry.file}`;
  entry.img = img;

  // Displacement
  const dispSrc = entry.dispFile
    ? `${BASE_URL}${entry.dispFile}`
    : `${BASE_URL}${entry.file.replace('_diff_', '_disp_')}`;
  const dispImg = new Image();
  dispImg.src = dispSrc;
  entry.dispImg = dispImg;

  // Normal map
  const norImg = new Image();
  if (entry.norFile) norImg.src = `${BASE_URL}${entry.norFile}`;
  entry.norImg = norImg;

  // ARM
  const armImg = new Image();
  if (entry.armFile) armImg.src = `${BASE_URL}${entry.armFile}`;
  entry.armImg = armImg;

  // Return promise that resolves when diffuse + displacement are ready
  // (both are needed for rendering — displacement drives edge blend ordering)
  function awaitImage(image: any) {
    if (!image.src || image.complete) return Promise.resolve();
    return new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    });
  }
  entry._loadPromise = Promise.all([awaitImage(img), awaitImage(dispImg)]);
  return entry._loadPromise;
}

/**
 * Batch-load images for multiple texture IDs.
 * @param {Iterable<string>} ids - Texture IDs to load.
 * @param {Function} [onProgress] - Called with (loaded, total) as images finish loading.
 * @returns {Promise<void>} Resolves when all diffuse + displacement images are ready.
 */
export function ensureTexturesLoaded(ids: Iterable<string>, onProgress?: (loaded: number, total: number) => void): Promise<void[]> {
  const promises = [];
  const pendingImages = [];

  for (const id of ids) {
    promises.push(loadTextureImages(id));
    // Track ALL images that aren't complete yet (including ones already started
    // by preloadPropTextures) — not just freshly kicked off ones
    const entry = catalog?.textures[id];
    if (entry && entry.img) {
      pendingImages.push(id);
    }
  }

  // Wire up progress tracking on all Image elements that need loading
  if (onProgress) {
    if (pendingImages.length === 0) {
      // Nothing to load — report complete immediately
      onProgress(1, 1);
    } else {
      let loaded = 0;
      // Count diffuse + disp per texture = 2 images each
      const total = pendingImages.length * 2;
      onProgress(0, total);
      for (const id of pendingImages) {
        const entry = catalog?.textures[id];
        if (!entry) continue;
        for (const img of [entry.img, entry.dispImg]) {
          if (!img) { loaded++; continue; }
          if (img.complete) { loaded++; continue; }
          const bump = () => { loaded++; onProgress(loaded, total); };
          img.addEventListener('load', bump, { once: true });
          img.addEventListener('error', bump, { once: true });
        }
      }
      if (loaded > 0) onProgress(loaded, total);
    }
  }

  return Promise.all(promises);
}

/**
 * Scan a cell grid and return a Set of all texture IDs referenced.
 * @param {Array<Array>} cells - The dungeon cells grid.
 * @returns {Set<string>} Set of texture IDs used in the grid.
 */
export function collectTextureIds(cells: any[][]): Set<string> {
  const ids = new Set();
  const KEYS = ['texture', 'textureSecondary'];
  for (const row of cells) {
    if (!row) continue;
    for (const cell of row) {
      if (!cell) continue;
      for (const key of KEYS) {
        if (cell[key]) ids.add(cell[key]);
      }
    }
  }
  // @ts-expect-error — strict-mode migration
  return ids;
}

/**
 * Synchronous getter for the texture catalog.
 * @returns {Object|null} The texture catalog or null if not yet loaded.
 */
export function getTextureCatalog(): any {
  return catalog;
}

/**
 * Clear the in-memory catalog cache so the next load re-fetches from server.
 * @returns {void}
 */
export function clearTextureCatalogCache(): void {
  catalog = null;
}
