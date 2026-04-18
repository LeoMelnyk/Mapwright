// Prop Catalog Loader
// Fetches .prop files from the server and builds an in-memory catalog.
// Caching is handled by the HTTP layer: /props/bundle.json is served with an
// ETag, so repeat loads get a 304 with no body transfer.

import type { PropCatalog, PropDefinition, PropCommand, Dungeon } from '../../types.js';
import { parsePropFile, generateHitbox } from '../../render/index.js';
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
 * Populate a prop's hitbox fields (autoHitbox, hitbox, hitboxZones, selectionHitbox).
 * Idempotent — skips fields that are already set.
 */
function materializePropHitbox(def: PropDefinition): void {
  if (!def.autoHitbox && def.commands.length) {
    def.autoHitbox = generateHitbox(def.commands, def.footprint) ?? undefined;
  }
  def.hitbox ??= def.manualHitbox?.length ? (manualHitboxToPolygon(def.manualHitbox) ?? undefined) : def.autoHitbox;
  if (!def.hitboxZones && def.blocksLight) {
    def.hitboxZones = buildHitboxZones(def) ?? undefined;
  }
  if (!def.selectionHitbox && def.manualSelection?.length) {
    def.selectionHitbox = manualHitboxToPolygon(def.manualSelection) ?? undefined;
  }
}

/** Convert manual hitbox commands (rect/circle/poly) into a single polygon. */
function manualHitboxToPolygon(cmds: PropCommand[]) {
  const points = [];
  for (const cmd of cmds) {
    switch (cmd.subShape) {
      case 'rect':
        points.push(
          [cmd.x!, cmd.y!],
          [cmd.x! + cmd.w!, cmd.y!],
          [cmd.x! + cmd.w!, cmd.y! + cmd.h!],
          [cmd.x!, cmd.y! + cmd.h!],
        );
        break;
      case 'circle': {
        const N = 16;
        for (let i = 0; i < N; i++) {
          const angle = (i / N) * Math.PI * 2;
          points.push([cmd.cx! + cmd.r! * Math.cos(angle), cmd.cy! + cmd.r! * Math.sin(angle)]);
        }
        break;
      }
      case 'poly':
        if (cmd.points?.length) points.push(...cmd.points);
        break;
      case undefined:
      default:
        break;
    }
  }
  return points.length >= 3 ? points : null;
}

/**
 * Build hitbox zones for z-height shadow projection.
 * Groups hitbox commands by z-range. If manual hitbox commands have z ranges,
 * creates one zone per distinct range. Otherwise, creates a single zone using
 * the prop's height header (or Infinity if no height is set).
 */
function buildHitboxZones(def: PropDefinition) {
  // Check if any manual hitbox commands have z ranges
  const hasZRanges = def.manualHitbox?.some((cmd: PropCommand) => cmd.zBottom != null);

  if (hasZRanges) {
    // Group commands by z range, build a polygon per group
    const groups = new Map();
    for (const cmd of def.manualHitbox!) {
      const key = cmd.zBottom != null ? `${cmd.zBottom}-${cmd.zTop}` : 'default';
      if (!groups.has(key)) groups.set(key, { cmds: [], zBottom: cmd.zBottom ?? 0, zTop: cmd.zTop ?? Infinity });
      groups.get(key).cmds.push(cmd);
    }
    const zones = [];
    for (const { cmds, zBottom, zTop } of groups.values()) {
      const polygon = manualHitboxToPolygon(cmds);
      if (polygon) zones.push({ polygon, zBottom, zTop });
    }
    return zones.length > 0 ? zones : null;
  }

  // No z ranges on hitbox commands — use the single hitbox with prop height
  const polygon = def.hitbox;
  if (!polygon) return null;

  const zTop = def.height != null && isFinite(def.height) ? def.height : Infinity;
  return [{ polygon, zBottom: 0, zTop }];
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
      const bundle = (await bundleRes.json()) as { version?: string; props?: Record<string, string> };
      if (bundle.props && typeof bundle.props === 'object') {
        const names = Object.keys(bundle.props);
        if (onProgress) onProgress(0, names.length);
        const props: Record<string, PropDefinition> = {};
        let parsed = 0;
        for (const name of names) {
          try {
            props[name] = parsePropFile(bundle.props[name]!);
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
  backgroundHitboxScheduled = false;
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

let backgroundHitboxScheduled = false;

/**
 * Schedule background materialization of all remaining prop hitboxes.
 * Uses requestIdleCallback (setTimeout fallback) to chunk the work so it
 * doesn't block the main thread. Safe to call multiple times — runs once.
 */
export function scheduleBackgroundPropHitboxGen(): void {
  if (backgroundHitboxScheduled || !cachedCatalog) return;
  backgroundHitboxScheduled = true;

  const defs = Object.values(cachedCatalog.props);
  let i = 0;

  const ric: (cb: (deadline: { timeRemaining(): number }) => void) => void =
    (window as unknown as { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void) => void })
      .requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 16));

  function runChunk(deadline: { timeRemaining(): number }) {
    while (i < defs.length && deadline.timeRemaining() > 1) {
      materializePropHitbox(defs[i]!);
      i++;
    }
    if (i < defs.length) ric(runChunk);
  }

  ric(runChunk);
}
