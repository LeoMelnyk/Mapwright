// Gobo Catalog — loads .gobo metadata for the lighting/prop systems.
// Mirrors light-catalog.ts: bundle-first with per-file manifest fallback,
// localStorage-cached between sessions.

import type { GoboCatalog, GoboDefinition } from '../../types.js';
import { setGoboDefinitions } from '../../render/gobo-registry.js';
import { parseGoboText } from '../../render/parse-gobo.js';
import { allSettledWithLimit } from './async-batch.js';

const BASE_URL = '/gobos/';
const CACHE_KEY = 'gobo-catalog';
const CACHE_VER_KEY = 'gobo-catalog-ver';

let catalog: GoboCatalog | null = null;

function buildCatalog(entries: GoboDefinition[]): GoboCatalog {
  const names: string[] = [];
  const gobos: Record<string, GoboDefinition | undefined> = {};
  for (const g of entries) {
    gobos[g.id] = g;
    names.push(g.id);
  }
  names.sort();
  // Publish to the render-side registry so `extractGoboZones` can resolve ids.
  setGoboDefinitions(entries);
  return { names, gobos };
}

/**
 * Load the gobo catalog. Bundle-first — single request grabs every .gobo's
 * raw text keyed by id; falls back to manifest + per-file fetch. Cached in
 * localStorage between sessions.
 */
export async function loadGoboCatalog(): Promise<GoboCatalog> {
  if (catalog) return catalog;

  // Try bundle first
  try {
    const res = await fetch(`${BASE_URL}bundle.json`);
    if (res.ok) {
      const bundle = (await res.json()) as { version: string; gobos: Record<string, string> };
      const cachedVer = localStorage.getItem(CACHE_VER_KEY);
      if (cachedVer === bundle.version) {
        try {
          const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as GoboDefinition[] | null;
          if (cached?.length) {
            catalog = buildCatalog(cached);
            return catalog;
          }
        } catch {
          /* cache corrupt — fall through */
        }
      }
      const entries: GoboDefinition[] = [];
      for (const [id, text] of Object.entries(bundle.gobos)) {
        entries.push(parseGoboText(id, text));
      }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
        localStorage.setItem(CACHE_VER_KEY, bundle.version);
      } catch {
        /* localStorage full — ignore */
      }
      catalog = buildCatalog(entries);
      return catalog;
    }
  } catch (e) {
    console.warn('[gobo-catalog] Bundle fetch failed, falling back to manifest:', e);
  }

  // Fallback: manifest + per-file
  try {
    const res = await fetch(`${BASE_URL}manifest.json`);
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const ids = (await res.json()) as string[];
    const results = await allSettledWithLimit(ids, 16, async (id: string) => {
      const r = await fetch(`${BASE_URL}${id}.gobo`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { id, text: await r.text() };
    });
    const entries: GoboDefinition[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[gobo-catalog] Failed to load gobo:', result.reason);
        continue;
      }
      entries.push(parseGoboText(result.value.id, result.value.text));
    }
    catalog = buildCatalog(entries);
  } catch (e) {
    console.warn('[gobo-catalog] Could not load gobos:', e);
    catalog = { names: [], gobos: {} };
  }
  return catalog;
}

/** Synchronous getter — returns null if not yet loaded. */
export function getGoboCatalog(): GoboCatalog | null {
  return catalog;
}

/** Clear the in-memory cache so the next load re-fetches. */
export function clearGoboCatalogCache(): void {
  catalog = null;
}
