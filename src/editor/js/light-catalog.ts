// Light Catalog — loads .light preset metadata for the lighting panel.
// Mirrors the pattern of texture-catalog.js (manifest + individual files + localStorage caching).
import type { LightCatalog, LightPreset } from '../../types.js';
import { allSettledWithLimit } from './async-batch.js';

const BASE_URL = '/lights/';
const CACHE_KEY = 'light-catalog';
const CACHE_VER_KEY = 'light-catalog-ver';

let catalog: LightCatalog | null = null; // { names, lights, byCategory, categoryOrder }

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

function buildFromMetadata(entries: Record<string, unknown>[]): LightCatalog {
  const names: string[] = [];
  const lights: Record<string, LightPreset | undefined> = {};
  const byCategory: Record<string, string[]> = {};
  const categoryOrder: string[] = [];

  for (const data of entries) {
    const key = data.id as string;

    const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

    const entry: LightPreset = {
      id: key,
      displayName: str(data.displayName, key),
      category: str(data.category, 'Uncategorized'),
      description: str(data.description, ''),
      type: data.type === 'directional' ? 'directional' : 'point',
      color: str(data.color, '#ff9944'),
      radius: num(data.radius, 30),
      intensity: num(data.intensity, 1.0),
      falloff: str(data.falloff, 'smooth') as LightPreset['falloff'],
    };

    if (data.type === 'directional' && data.spread != null) {
      entry.spread = data.spread as number;
    }
    if (data.dimRadius != null) entry.dimRadius = data.dimRadius as number;
    if (data.z != null) entry.z = data.z as number;
    const animData = data.animation as Record<string, unknown> | null;
    if (animData?.type) {
      // Pass through every animation field. The renderer ignores fields it
      // doesn't recognize, so we don't need to gate per-type here — extension
      // points (strike/sweep/cookie/colorMode) get to the engine for free.
      entry.animation = {
        type: str(animData.type, ''),
        speed: num(animData.speed, 1),
        amplitude: num(animData.amplitude, 0.5),
        ...(animData.radiusVariation != null ? { radiusVariation: animData.radiusVariation as number } : {}),
        ...(animData.phase != null ? { phase: animData.phase as number } : {}),
        ...(animData.colorMode != null ? { colorMode: animData.colorMode as 'none' | 'auto' | 'secondary' } : {}),
        ...(animData.colorVariation != null ? { colorVariation: animData.colorVariation as number } : {}),
        ...(animData.colorSecondary != null ? { colorSecondary: animData.colorSecondary as string } : {}),
        ...(animData.pattern != null ? { pattern: animData.pattern as 'sine' | 'noise' } : {}),
        ...(animData.guttering != null ? { guttering: animData.guttering as number } : {}),
        ...(animData.frequency != null ? { frequency: animData.frequency as number } : {}),
        ...(animData.duration != null ? { duration: animData.duration as number } : {}),
        ...(animData.probability != null ? { probability: animData.probability as number } : {}),
        ...(animData.baseline != null ? { baseline: animData.baseline as number } : {}),
        ...(animData.angularSpeed != null ? { angularSpeed: animData.angularSpeed as number } : {}),
        ...(animData.arcRange != null ? { arcRange: animData.arcRange as number } : {}),
        ...(animData.arcCenter != null ? { arcCenter: animData.arcCenter as number } : {}),
      };
    }
    if (data.cookie && typeof data.cookie === 'object') {
      // Pass cookie through verbatim — renderer validates the `type` field.
      (entry as unknown as { cookie?: unknown }).cookie = data.cookie;
    }

    lights[key] = entry;
    names.push(key);

    const cat = entry.category;

    if (!byCategory[cat]) {
      byCategory[cat] = [];
      categoryOrder.push(cat);
    }
    byCategory[cat].push(key);
  }

  return { names, lights, byCategory, categoryOrder };
}

/**
 * Load all light presets from server. Uses localStorage cache for subsequent loads.
 * @returns {Promise<Object>} The light catalog with names, lights, byCategory, categoryOrder.
 */
export async function loadLightCatalog(): Promise<LightCatalog | null> {
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
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY)!);
        if (cached?.length) {
          catalog = buildFromMetadata(cached);
          return catalog;
        }
      } catch {
        /* cache corrupt, fall through to fresh fetch */
      }
    }

    // Fresh fetch — load all .light files
    const results = await allSettledWithLimit(keys, 32, async (key: string) => {
      const r = await fetch(`${BASE_URL}${key}.light`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { key, data: await r.json() };
    });

    const metadataEntries = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[light-catalog] Failed to load light preset:', result.reason);
        continue;
      }
      const { key, data } = result.value;
      metadataEntries.push({
        id: key,
        displayName: data.displayName ?? key,
        category: data.category ?? 'Uncategorized',
        description: data.description ?? '',
        type: data.type ?? 'point',
        color: data.color ?? '#ff9944',
        radius: data.radius ?? 30,
        intensity: data.intensity ?? 1.0,
        falloff: data.falloff ?? 'smooth',
        spread: data.spread ?? null,
        dimRadius: data.dimRadius ?? null,
        z: data.z ?? null,
        animation: data.animation ?? null,
        cookie: data.cookie ?? null,
      });
    }

    // Cache metadata to localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(metadataEntries));
      localStorage.setItem(CACHE_VER_KEY, version);
    } catch {
      /* localStorage full or unavailable — ignore */
    }

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
export function getLightCatalog(): LightCatalog | null {
  return catalog;
}

/**
 * Clear the in-memory catalog cache so the next load re-fetches from server.
 * @returns {void}
 */
export function clearLightCatalogCache(): void {
  catalog = null;
}
