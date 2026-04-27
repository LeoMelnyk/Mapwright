import type { TextureCatalog, TextureRuntime } from '../../types.js';
// Texture Catalog — loads .texture metadata and lazily loads PNG images on demand.
// Metadata comes from /textures/bundle.json in one request (HTTP cached via ETag);
// PNG images stay per-file and load lazily through the browser's Image element.
// Mirrors the pattern of theme-catalog.ts and prop-catalog.ts.

import { showToast } from './toast.js';
import { allSettledWithLimit } from './async-batch.js';

/** Serializable metadata entry (no images). */
interface TextureMetadata {
  id: string;
  displayName: string;
  category: string;
  subcategory: string | null;
  file: string;
  dispFile: string | null;
  norFile: string | null;
  scale: number;
  credit: string;
}

/** Raw .texture file contents (what the server serves / writes). */
interface RawTextureFile {
  displayName?: string;
  category?: string;
  subcategory?: string | null;
  file: string;
  scale?: number;
  credit?: string;
  maps?: {
    disp?: string | null;
    nor?: string | null;
    arm?: string | null;
  };
}

// Note: `arm` (AO+Roughness+Metal) is kept in the file format for forward
// compatibility but is no longer loaded at runtime — no consumer reads it.

const BASE_URL = '/textures/';
const BUNDLE_URL = '/textures/bundle.json';

let catalog: TextureCatalog | null = null; // { names, textures, byCategory, categoryOrder }

// One-time cleanup of the localStorage cache used by earlier versions
// (metadata is now HTTP-cached, not mirrored in localStorage).
try {
  localStorage.removeItem('texture-catalog');
  localStorage.removeItem('texture-catalog-ver');
} catch {
  /* storage unavailable */
}

function normalizeMetadata(id: string, data: RawTextureFile): TextureMetadata {
  return {
    id,
    displayName: data.displayName ?? id,
    category: data.category ?? 'Uncategorized',
    subcategory: data.subcategory ?? null,
    file: data.file,
    scale: data.scale ?? 2.0,
    credit: data.credit ?? '',
    dispFile: data.maps?.disp ?? null,
    norFile: data.maps?.nor ?? null,
  };
}

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
 *   scale: number,          // grid cells per texture tile (default 2.0)
 *   credit: string,
 *   img:     HTMLImageElement|null,  // diffuse — loaded on demand
 *   dispImg: HTMLImageElement|null,  // displacement — loaded on demand
 *   norImg:  HTMLImageElement|null,  // normal map — loaded on demand
 * }
 *
 * Image elements are null until loadTextureImages(id) is called.
 * The renderer gracefully skips entries with null/incomplete images.
 */

/**
 * Build catalog entries from raw metadata array (metadata only, no image loading).
 */
function buildFromMetadata(entries: TextureMetadata[]): TextureCatalog {
  const names: string[] = [];
  const textures: Record<string, TextureRuntime> = {};
  const byCategory: Record<string, string[]> = {};
  const categoryOrder: string[] = [];

  for (const data of entries) {
    const key = data.id;

    const entry: TextureRuntime = {
      displayName: data.displayName || key,
      file: data.file,
      dispFile: (data.dispFile as string) || undefined,
      norFile: (data.norFile as string) || undefined,
      img: undefined,
      dispImg: null,
      norImg: null,
    };

    textures[key] = entry;
    names.push(key);

    const category = entry.displayName ? data.category || 'Uncategorized' : 'Uncategorized';

    if (!byCategory[category]) {
      byCategory[category] = [];
      categoryOrder.push(category);
    }
    byCategory[category].push(key);
  }

  return { entries: [], byId: {}, images: {}, names, textures, byCategory, categoryOrder };
}

/**
 * Load texture metadata from server. Uses localStorage cache for subsequent loads.
 * @returns {Promise<Object>} The texture catalog with names, textures, byCategory, categoryOrder.
 */
export async function loadTextureCatalog(): Promise<TextureCatalog | null> {
  if (catalog) return catalog;

  try {
    // Try the bundle first — one HTTP request for all texture metadata.
    // Browser HTTP cache + server ETag means subsequent loads get a 304
    // with no body transfer. Binary PNGs are not included in the bundle
    // (too large); they load lazily via loadTextureImages(id).
    const bundleRes = await fetch(BUNDLE_URL).catch(() => null);
    if (bundleRes?.ok) {
      const bundle = (await bundleRes.json()) as { version?: string; textures?: Record<string, RawTextureFile> };
      if (bundle.textures && typeof bundle.textures === 'object') {
        const entries: TextureMetadata[] = [];
        for (const [id, data] of Object.entries(bundle.textures)) {
          entries.push(normalizeMetadata(id, data));
        }
        catalog = buildFromMetadata(entries);
        return catalog;
      }
    }

    // Fallback: manifest + per-file fetch (bundle.json missing or malformed).
    console.warn('[texture-catalog] bundle.json unavailable, falling back to per-file fetch');
    const res = await fetch(`${BASE_URL}manifest.json`);
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const keys = await res.json();

    const results = await allSettledWithLimit(keys, 32, async (key: string) => {
      const r = await fetch(`${BASE_URL}${key}.texture`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { key, data: (await r.json()) as RawTextureFile };
    });

    const metadataEntries: TextureMetadata[] = [];
    let textureFailCount = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        textureFailCount++;
        console.warn('[texture-catalog] Failed to load texture:', result.reason);
        continue;
      }
      const { key, data } = result.value;
      metadataEntries.push(normalizeMetadata(key, data));
    }

    if (textureFailCount > 0) {
      showToast(`Failed to load ${textureFailCount} texture(s) — some textures may not render`);
    }

    catalog = buildFromMetadata(metadataEntries);
  } catch (e) {
    console.warn('[texture-catalog] Could not load textures from server:', e);
    showToast('Could not load texture catalog — textures unavailable');
    catalog = { entries: [], byId: {}, images: {}, names: [], textures: {}, byCategory: {}, categoryOrder: [] };
  }

  return catalog;
}

/**
 * Load PNG images for a single texture entry on demand.
 *
 * Uses `img.decode()` to pre-decode pixel data off the main thread. Without this,
 * the first `ctx.createPattern()` / `ctx.drawImage()` call for a newly-loaded
 * texture triggers a synchronous decode on the paint frame — visible as a
 * multi-hundred-millisecond GPU hitch on first use. `decode()` forces the decode
 * to happen now, so the image is in a GPU-ready state before the renderer touches it.
 *
 * @param {string} id - Texture catalog ID.
 * @returns {Promise<void>} Resolves when diffuse + displacement + normal are decoded and ready.
 */
export function loadTextureImages(id: string): Promise<void> {
  const entry = catalog?.textures[id];
  if (!entry) return Promise.resolve();

  // If already started, return the existing loading promise
  // (don't return Promise.resolve() — the images may still be loading)
  if (entry._loadPromise) return entry._loadPromise as Promise<void>;

  // Diffuse — always present. Floor pattern source.
  const img = new Image();
  img.src = `${BASE_URL}${entry.file}`;
  entry.img = img;

  // Displacement — used by blend.ts for edge blending between adjacent textures.
  const dispSrc = entry.dispFile
    ? `${BASE_URL}${entry.dispFile}`
    : `${BASE_URL}${entry.file!.replace('_diff_', '_disp_')}`;
  const dispImg = new Image();
  dispImg.src = dispSrc;
  entry.dispImg = dispImg;

  // Normal map — used by lighting.ts per-cell bump effect under lights.
  const norImg = new Image();
  if (entry.norFile) norImg.src = `${BASE_URL}${entry.norFile}`;
  entry.norImg = norImg;

  // Force decode now so the first paint doesn't stall. `decode()` also waits
  // for the underlying fetch, so this replaces the old 'load'-event wait.
  // `error` cases resolve too so a missing asset doesn't hang the promise.
  function decodeOrFallback(image: HTMLImageElement) {
    if (!image.src) return Promise.resolve();
    return image.decode().catch(() => {
      // Decode can reject if the image failed to load or is malformed.
      // Swallow — renderer skips incomplete images gracefully.
    });
  }

  // After the diffuse image decodes, promote it to an ImageBitmap for the
  // pattern path. An HTMLImageElement passed to `ctx.createPattern()` lazily
  // re-decodes on first raster, causing a multi-hundred-ms stall the first
  // time any cell using this texture is painted. An ImageBitmap is already
  // GPU-uploadable — the first pattern fill is a straight GPU op.
  // createImageBitmap runs off the main thread, so load latency is unaffected.
  const diffuseReady = decodeOrFallback(img).then(async () => {
    if (!img.naturalWidth) return;
    try {
      entry._patternBitmap = await createImageBitmap(img);
      // Drop any cached pattern that was built from the HTMLImageElement so the
      // next render rebuilds it from the bitmap instead.
      entry._pattern = null;
      entry._patternCtx = null;
    } catch {
      // If createImageBitmap fails (very old browser, CORS quirk), fall back
      // to the HTMLImageElement — createPattern still works, just with a stall.
    }
  });

  entry._loadPromise = Promise.all([diffuseReady, decodeOrFallback(dispImg), decodeOrFallback(norImg)]);
  return entry._loadPromise as Promise<void>;
}

/**
 * Batch-load images for multiple texture IDs.
 * @param {Iterable<string>} ids - Texture IDs to load.
 * @param {Function} [onProgress] - Called with (loaded, total) as images finish loading.
 * @returns {Promise<void>} Resolves when all diffuse + displacement images are ready.
 */
export function ensureTexturesLoaded(
  ids: Iterable<string>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void[]> {
  const promises = [];
  const pendingImages = [];

  for (const id of ids) {
    promises.push(loadTextureImages(id));
    // Track ALL images that aren't complete yet (including ones already started
    // by preloadPropTextures) — not just freshly kicked off ones
    const entry = catalog?.textures[id];
    if (entry?.img) {
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
          if (!img) {
            loaded++;
            continue;
          }
          if (img.complete) {
            loaded++;
            continue;
          }
          const bump = () => {
            loaded++;
            onProgress(loaded, total);
          };
          img.addEventListener('load', bump, { once: true });
          img.addEventListener('error', bump, { once: true });
        }
      }
      if (loaded > 0) onProgress(loaded, total);
    }
  }

  return Promise.all(promises);
}

// `collectTextureIds` lives in `src/util/grid.ts` so the player view and the
// Node-side render pipeline can share the same implementation. Re-exported
// here so editor-side importers don't need to update their import paths.
export { collectTextureIds } from '../../util/index.js';

/**
 * Synchronous getter for the texture catalog.
 * @returns {Object|null} The texture catalog or null if not yet loaded.
 */
export function getTextureCatalog(): TextureCatalog | null {
  return catalog;
}

/**
 * Clear the in-memory catalog cache so the next load re-fetches from server.
 * @returns {void}
 */
export function clearTextureCatalogCache(): void {
  catalog = null;
}
