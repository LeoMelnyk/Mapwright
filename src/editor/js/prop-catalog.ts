// Prop Catalog Loader
// Fetches .prop files from the server and builds an in-memory catalog.
// Caching is handled by the HTTP layer: /props/bundle.json is served with an
// ETag, so repeat loads get a 304 with no body transfer.

import type { PropCatalog, PropDefinition, Dungeon } from '../../types.js';
import { parsePropFile, materializePropHitbox } from '../../render/index.js';
import { loadTextureImages, getTextureCatalog } from './texture-catalog.js';
import { showToast } from './toast.js';
import { allSettledWithLimit } from './async-batch.js';

const MANIFEST_URL = '/props/manifest.json';
const BUNDLE_URL = '/props/bundle.json';
const PROPS_BASE_URL = '/props/';

let cachedCatalog: PropCatalog | null = null;

// One-time cleanup of the localStorage cache used by earlier versions
// (the catalog is now HTTP-cached, not mirrored in localStorage).
try {
  localStorage.removeItem('prop-catalog');
  localStorage.removeItem('prop-catalog-ver');
} catch {
  /* storage unavailable */
}

/**
 * Build the catalog structure from a { name: def } map.
 * Hitbox materialization is deferred — see materializePropHitbox().
 */
function buildCatalog(props: Record<string, PropDefinition>) {
  const byCategory = {};
  const categoryOrder = [];
  for (const [name, def] of Object.entries(props)) {
    if (!(byCategory as Record<string, string[]>)[def.category]) {
      (byCategory as Record<string, string[]>)[def.category] = [];
      categoryOrder.push(def.category);
    }
    (byCategory as Record<string, string[]>)[def.category]!.push(name);
  }
  return { categories: categoryOrder, props, byCategory };
}

/**
 * Shape of a per-prop entry in the bundle. Old shape was the raw .prop text;
 * new shape carries baked hitbox polygons alongside the text so the client
 * avoids a 900ms startup storm of convex-hull rasterization.
 */
type BundlePropEntry =
  | string
  | {
      text: string;
      autoHitbox?: number[][];
      hitbox?: number[][];
      /** `zTop: null` in the bundle means "unbounded" — JSON can't carry Infinity. */
      hitboxZones?: { polygon: number[][]; zBottom: number; zTop: number | null }[];
      selectionHitbox?: number[][];
    };

/** Parse a bundle entry into a PropDefinition, applying any baked hitbox fields. */
function parseBundleEntry(entry: BundlePropEntry): PropDefinition {
  if (typeof entry === 'string') {
    const def = parsePropFile(entry);
    materializePropHitbox(def);
    return def;
  }
  const def = parsePropFile(entry.text);
  if (entry.autoHitbox) def.autoHitbox = entry.autoHitbox;
  if (entry.hitbox) def.hitbox = entry.hitbox;
  if (entry.hitboxZones) {
    def.hitboxZones = entry.hitboxZones.map((z) => ({
      polygon: z.polygon,
      zBottom: z.zBottom,
      zTop: z.zTop ?? Infinity,
    }));
  }
  if (entry.selectionHitbox) def.selectionHitbox = entry.selectionHitbox;
  materializePropHitbox(def);
  return def;
}

/**
 * Load all prop definitions from the server.
 * Fetches manifest.json, then loads each .prop file in parallel.
 * Caches parsed results in localStorage for fast subsequent loads.
 * @param {function} [onProgress] — called with (loaded, total) as prop files are fetched
 * @returns {Promise<PropCatalog>}
 */
export async function loadPropCatalog(
  onProgress?: (loaded: number, total: number) => void,
): Promise<PropCatalog | null> {
  if (cachedCatalog) return cachedCatalog;

  try {
    // Try the bundle first — one HTTP request for the whole catalog.
    // Browser HTTP cache + server ETag means subsequent loads get a 304
    // with no body transfer, so no explicit app-level cache is needed.
    const bundleRes = await fetch(BUNDLE_URL).catch(() => null);
    if (bundleRes?.ok) {
      const bundle = (await bundleRes.json()) as { version?: string; props?: Record<string, BundlePropEntry> };
      if (bundle.props && typeof bundle.props === 'object') {
        const names = Object.keys(bundle.props);
        if (onProgress) onProgress(0, names.length);
        const props: Record<string, PropDefinition> = {};
        let parsed = 0;
        for (const name of names) {
          try {
            props[name] = parseBundleEntry(bundle.props[name]!);
          } catch (e) {
            console.warn('[prop-catalog] Failed to parse prop', name, e);
          }
          parsed++;
          if (onProgress) onProgress(parsed, names.length);
        }
        cachedCatalog = buildCatalog(props);
        return cachedCatalog;
      }
    }

    // Fallback: per-file fetch (used if bundle.json is missing or malformed —
    // e.g. a fresh checkout before update-manifest.js has run).
    console.warn('[prop-catalog] bundle.json unavailable, falling back to per-file fetch');
    const manifestRes = await fetch(MANIFEST_URL);
    if (!manifestRes.ok) {
      console.warn('[prop-catalog] Could not load manifest.json:', manifestRes.status);
      return buildEmptyCatalog();
    }
    const propNames = await manifestRes.json();
    let loaded = 0;
    if (onProgress) onProgress(0, propNames.length);

    const results = await allSettledWithLimit(propNames, 32, async (name: string) => {
      const res = await fetch(`${PROPS_BASE_URL}${name}.prop`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const def = parsePropFile(text);
      materializePropHitbox(def);
      loaded++;
      if (onProgress) onProgress(loaded, propNames.length);
      return { name, def };
    });

    const props: Record<string, PropDefinition> = {};
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

    cachedCatalog = buildCatalog(props);
    return cachedCatalog;
  } catch (e) {
    console.warn('[prop-catalog] Failed to load catalog:', e);
    showToast('Could not load prop catalog — props unavailable');
    return buildEmptyCatalog();
  }
}

/**
 * Get the cached catalog synchronously (null if not yet loaded).
 * @returns {Object|null} The prop catalog or null.
 */
export function getPropCatalog(): PropCatalog | null {
  return cachedCatalog;
}

/**
 * Clear the in-memory catalog cache so the next loadPropCatalog() re-fetches from server.
 * @returns {void}
 */
export function clearPropCatalogCache(): void {
  cachedCatalog = null;
}

function buildEmptyCatalog() {
  cachedCatalog = { categories: [], props: {}, byCategory: {} };
  return cachedCatalog;
}

/**
 * Kick off loads for textures referenced by a single prop.
 * Fire-and-forget — safe to call repeatedly (loadTextureImages is a no-op if already loading).
 */
export function ensurePropTextures(propType: string): void {
  const def = cachedCatalog?.props[propType];
  if (!def?.textures.length) return;
  if (!getTextureCatalog()) return;
  for (const id of def.textures) void loadTextureImages(id);
}

/**
 * Materialize hitboxes for a single prop type if the catalog is loaded.
 * Idempotent — safe to call at any point (placement, selection, render).
 */
export function ensurePropHitbox(propType: string): void {
  const def = cachedCatalog?.props[propType];
  if (def) materializePropHitbox(def);
}

/**
 * Materialize hitboxes for every prop type used by the given dungeon.
 * Walks cell props + metadata overlay props.
 */
export function ensurePropHitboxesForMap(dungeon: Dungeon): void {
  if (!cachedCatalog) return;
  const types = new Set<string>();
  for (const row of dungeon.cells) {
    for (const cell of row) {
      const t = cell?.prop?.type;
      if (t) types.add(t);
    }
  }
  const overlay = dungeon.metadata.props;
  if (overlay) {
    for (const op of overlay) types.add(op.type);
  }
  for (const t of types) {
    const def = cachedCatalog.props[t];
    if (def) materializePropHitbox(def);
  }
}
