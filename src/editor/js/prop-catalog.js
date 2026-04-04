// Prop Catalog Loader
// Fetches .prop files from the server and builds an in-memory catalog.
// Uses localStorage to cache parsed definitions on subsequent loads.

import { parsePropFile, generateHitbox } from '../../render/index.js';
import { loadTextureImages, getTextureCatalog } from './texture-catalog.js';
import { showToast } from './toast.js';

const MANIFEST_URL = '/props/manifest.json';
const PROPS_BASE_URL = '/props/';
const CACHE_KEY = 'prop-catalog';
const CACHE_VER_KEY = 'prop-catalog-ver';
const APP_VERSION = '0.9.0'; // bump when prop format or hitbox algorithm changes

let cachedCatalog = null;

/**
 * Build the catalog structure from a { name: def } map.
 */
function buildCatalog(props) {
  const byCategory = {};
  const categoryOrder = [];
  for (const [name, def] of Object.entries(props)) {
    // Always auto-generate the convex hull hitbox (used for selection fallback)
    if (!def.autoHitbox && def.commands?.length) {
      def.autoHitbox = generateHitbox(def.commands, def.footprint);
    }
    // Lighting hitbox: manual hitbox commands > auto-generated
    if (!def.hitbox) {
      def.hitbox = def.manualHitbox?.length
        ? manualHitboxToPolygon(def.manualHitbox)
        : def.autoHitbox;
    }
    // Build hitbox zones for z-height shadow projection.
    // Each zone has { polygon, zBottom, zTop } for height-based shadow casting.
    if (!def.hitboxZones && def.blocksLight) {
      def.hitboxZones = buildHitboxZones(def);
    }
    // Selection hitbox: manual selection commands only (falls back to autoHitbox at query time)
    if (!def.selectionHitbox && def.manualSelection?.length) {
      def.selectionHitbox = manualHitboxToPolygon(def.manualSelection);
    }
    if (!byCategory[def.category]) {
      byCategory[def.category] = [];
      categoryOrder.push(def.category);
    }
    byCategory[def.category].push(name);
  }
  return { categories: categoryOrder, props, byCategory };
}

/** Convert manual hitbox commands (rect/circle/poly) into a single polygon. */
function manualHitboxToPolygon(cmds) {
  const points = [];
  for (const cmd of cmds) {
    switch (cmd.subShape) {
      case 'rect':
        points.push(
          [cmd.x, cmd.y], [cmd.x + cmd.w, cmd.y],
          [cmd.x + cmd.w, cmd.y + cmd.h], [cmd.x, cmd.y + cmd.h],
        );
        break;
      case 'circle': {
        const N = 16;
        for (let i = 0; i < N; i++) {
          const angle = (i / N) * Math.PI * 2;
          points.push([cmd.cx + cmd.r * Math.cos(angle), cmd.cy + cmd.r * Math.sin(angle)]);
        }
        break;
      }
      case 'poly':
        if (cmd.points?.length) points.push(...cmd.points);
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
function buildHitboxZones(def) {
  // Check if any manual hitbox commands have z ranges
  const hasZRanges = def.manualHitbox?.some(cmd => cmd.zBottom != null);

  if (hasZRanges) {
    // Group commands by z range, build a polygon per group
    const groups = new Map();
    for (const cmd of def.manualHitbox) {
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

  const zTop = (def.height != null && isFinite(def.height)) ? def.height : Infinity;
  return [{ polygon, zBottom: 0, zTop }];
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
    const version = APP_VERSION + ':' + propNames.join(',');

    // Try localStorage cache (invalidates on app version bump or prop list change)
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
 * @returns {Object|null} The prop catalog or null.
 */
export function getPropCatalog() {
  return cachedCatalog;
}

/**
 * Clear the in-memory catalog cache so the next loadPropCatalog() re-fetches from server.
 * @returns {void}
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
