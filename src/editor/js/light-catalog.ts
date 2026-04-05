// Light Catalog — loads .light preset metadata for the lighting panel.
// Mirrors the pattern of texture-catalog.js (manifest + individual files + localStorage caching).

const BASE_URL = '/lights/';
const CACHE_KEY = 'light-catalog';
const CACHE_VER_KEY = 'light-catalog-ver';

let catalog: any = null; // { names, lights, byCategory, categoryOrder }

/**
 * A light preset entry in the catalog:
 * {
 *   id: string,
 *   displayName: string,
 *   category: string,
 *   description: string,
 *   type: 'point' | 'directional',
 *   color: string,       // hex #RRGGBB
 *   radius: number,      // feet
 *   intensity: number,   // 0.1–2.0
 *   falloff: string,     // 'smooth', 'linear', 'quadratic'
 *   spread?: number,     // degrees (directional only)
 * }
 */

function buildFromMetadata(entries: any) {
  const names = [];
  const lights = {};
  const byCategory = {};
  const categoryOrder = [];

  for (const data of entries) {
    const key = data.id;

    const entry = {
      id: key,
      displayName: data.displayName || key,
      category: data.category || 'Uncategorized',
      description: data.description || '',
      type: data.type || 'point',
      color: data.color || '#ff9944',
      radius: data.radius ?? 30,
      intensity: data.intensity ?? 1.0,
      falloff: data.falloff || 'smooth',
    };

    if (data.type === 'directional' && data.spread != null) {
      (entry as any).spread = data.spread;
    }
    if (data.dimRadius != null) (entry as any).dimRadius = data.dimRadius;
    if (data.z != null)          (entry as any).z = data.z;
    if (data.animation?.type)   (entry as any).animation = { ...data.animation };

    (lights as any)[key] = entry;
    names.push(key);

    if (!(byCategory as any)[entry.category]) {
      (byCategory as any)[entry.category] = [];
      categoryOrder.push(entry.category);
    }
    (byCategory as any)[entry.category].push(key);
  }

  return { names, lights, byCategory, categoryOrder };
}

/**
 * Load all light presets from server. Uses localStorage cache for subsequent loads.
 * @returns {Promise<Object>} The light catalog with names, lights, byCategory, categoryOrder.
 */
export async function loadLightCatalog(): Promise<any> {
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

    // Fresh fetch — load all .light files
    const results = await Promise.allSettled(
      keys.map(async (key: any) => {
        const r = await fetch(`${BASE_URL}${key}.light`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { key, data: await r.json() };
      })
    );

    const metadataEntries = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[light-catalog] Failed to load light preset:', result.reason);
        continue;
      }
      const { key, data } = result.value;
      metadataEntries.push({
        id: key,
        displayName: data.displayName || key,
        category: data.category || 'Uncategorized',
        description: data.description || '',
        type: data.type || 'point',
        color: data.color || '#ff9944',
        radius: data.radius ?? 30,
        intensity: data.intensity ?? 1.0,
        falloff: data.falloff || 'smooth',
        spread: data.spread ?? null,
        dimRadius: data.dimRadius ?? null,
        animation: data.animation ?? null,
      });
    }

    // Cache metadata to localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(metadataEntries));
      localStorage.setItem(CACHE_VER_KEY, version);
    } catch { /* localStorage full or unavailable — ignore */ }

    catalog = buildFromMetadata(metadataEntries);
  } catch (e) {
    console.warn('[light-catalog] Could not load light presets from server:', e);
    catalog = { names: [], lights: {}, byCategory: {}, categoryOrder: [] };
  }

  return catalog;
}

/**
 * Synchronous getter for the light catalog.
 * @returns {Object|null} The light catalog or null if not yet loaded.
 */
export function getLightCatalog(): any {
  return catalog;
}

/**
 * Clear the in-memory catalog cache so the next load re-fetches from server.
 * @returns {void}
 */
export function clearLightCatalogCache(): void {
  catalog = null;
}
