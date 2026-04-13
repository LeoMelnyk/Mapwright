// Prop Preview API — renders a single prop to a data URL for agent self-correction.

import type { PropDefinition, RenderPropPreviewOptions, Theme } from '../../../types.js';
import { state, getThemeCatalog } from './_shared.js';
import { parsePropFile, renderProp } from '../../../render/props.js';

/**
 * Render a single prop to a data-URL image for visual inspection.
 *
 * @param {string} propTypeOrText - Either a prop catalog name (e.g. "pillar")
 *   or raw .prop file text (must contain '---').
 * @param {object} options
 * @param {number}  [options.rotation=0]      - Rotation in degrees (0, 90, 180, 270).
 * @param {boolean} [options.flipped=false]    - Mirror the prop horizontally.
 * @param {number}  [options.scale=128]        - Pixels per grid cell.
 * @param {string|null} [options.background=null] - Background CSS color, or null for theme floor.
 * @returns {{ success: boolean, dataUrl: string, name: string, footprint: number[], warnings: string[] }}
 */
export async function renderPropPreview(
  propTypeOrText: string,
  options: RenderPropPreviewOptions = {},
): Promise<Record<string, unknown>> {
  const { rotation = 0, flipped = false, scale = 128, background = null } = options;

  const warnings = [];

  // ── Resolve prop definition ───────────────────────────────────────────────

  let propDef: PropDefinition | undefined;

  if (typeof propTypeOrText === 'string' && propTypeOrText.includes('---')) {
    // Raw .prop file text
    try {
      propDef = parsePropFile(propTypeOrText);
    } catch (e) {
      return { success: false, dataUrl: null, name: null, footprint: null, warnings: [(e as Error).message] };
    }
  } else {
    // Catalog lookup
    const catalog = state.propCatalog;
    if (!catalog) {
      return {
        success: false,
        dataUrl: null,
        name: propTypeOrText,
        footprint: null,
        warnings: ['Prop catalog not loaded'],
      };
    }

    propDef = catalog.props[propTypeOrText];

    if (!propDef) {
      // Try case-insensitive search
      const key = Object.keys(catalog.props).find((k) => k.toLowerCase() === propTypeOrText.toLowerCase());
      if (key) propDef = catalog.props[key];
    }

    if (!propDef) {
      return {
        success: false,
        dataUrl: null,
        name: propTypeOrText,
        footprint: null,
        warnings: [`Prop type "${propTypeOrText}" not found in catalog`],
      };
    }
  }

  // ── Determine canvas size ─────────────────────────────────────────────────

  const [rows, cols] = propDef.footprint;
  // Account for rotation: 90/270 swaps rows and cols
  const rotated = rotation === 90 || rotation === 270;
  const canvasRows = rotated ? cols : rows;
  const canvasCols = rotated ? rows : cols;
  const width = canvasCols * scale;
  const height = canvasRows * scale;

  // ── Create canvas ─────────────────────────────────────────────────────────

  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');

  // ── Background ────────────────────────────────────────────────────────────

  const themeCatalog = getThemeCatalog() as Record<string, Record<string, unknown>> | null;
  const themeKey = typeof state.dungeon.metadata.theme === 'string' ? state.dungeon.metadata.theme : 'stone-dungeon';
  const theme = themeCatalog?.[themeKey] ?? themeCatalog?.['stone-dungeon'] ?? {};

  const drawCtx = ctx as OffscreenCanvasRenderingContext2D;
  if (background) {
    drawCtx.fillStyle = background;
    drawCtx.fillRect(0, 0, width, height);
  } else if (theme.floorColor) {
    drawCtx.fillStyle = theme.floorColor as string;
    drawCtx.fillRect(0, 0, width, height);
  }
  // else leave transparent

  // ── Grid lines ────────────────────────────────────────────────────────────

  drawCtx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  drawCtx.lineWidth = 1;
  for (let c = 1; c < canvasCols; c++) {
    drawCtx.beginPath();
    drawCtx.moveTo(c * scale, 0);
    drawCtx.lineTo(c * scale, height);
    drawCtx.stroke();
  }
  for (let r = 1; r < canvasRows; r++) {
    drawCtx.beginPath();
    drawCtx.moveTo(0, r * scale);
    drawCtx.lineTo(width, r * scale);
    drawCtx.stroke();
  }

  // ── Render the prop ───────────────────────────────────────────────────────

  // gridSize=1 means 1 "foot" per normalized unit; transform.scale=scale means
  // each normalized unit maps to `scale` pixels. So nx → nx * 1 * scale = nx * scale px.
  const gridSize = 1;
  const transform = { scale: scale, offsetX: 0, offsetY: 0 };
  const getTextureImage = state.textureCatalog?.getTextureImage ?? (() => null);

  try {
    renderProp(drawCtx, propDef, 0, 0, rotation, gridSize, theme as Theme, transform, flipped, getTextureImage);
  } catch (e) {
    warnings.push(`Render error: ${(e as Error).message}`);
  }

  // ── Convert to data URL ───────────────────────────────────────────────────

  let dataUrl;
  if (canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } else {
    dataUrl = canvas.toDataURL('image/png');
  }

  return {
    success: true,
    dataUrl,
    name: propDef.name || propTypeOrText,
    footprint: propDef.footprint,
    warnings,
  };
}

// ── Prop thumbnail cache ─────────────────────────────────────────────────
//
// In-memory cache of small (32 px/cell) data-URL thumbnails for prop
// catalog entries. Cache key includes the prop name + a content hash of the
// catalog entry so changes invalidate automatically. Use for visual prop
// picking without paying a full screenshot per candidate.

// Cache key is `name:sizePxPerCell` so different sizes for the same prop don't
// evict each other.
const _thumbCache = new Map<string, { hash: string; dataUrl: string }>();

function _thumbKey(name: string, sizePxPerCell: number): string {
  return `${name}:${sizePxPerCell}`;
}

function _hashPropDef(def: unknown): string {
  // FNV-1a over JSON serialization. Cheap, no crypto dep needed.
  const s = JSON.stringify(def);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Return a small thumbnail PNG (data URL) for a prop catalog entry.
 *
 * Cached in memory — first call renders and caches; later calls are O(1).
 * Cache invalidates when the prop definition's content hash changes (new
 * `.prop` files or edits via clearCaches()).
 *
 * @param name Prop catalog name (e.g. "throne", "brazier")
 * @param sizePxPerCell Pixels per grid cell (default 32 — small enough to be cheap)
 */
export async function getPropThumbnail(
  name: string,
  sizePxPerCell: number = 32,
): Promise<{ success: true; name: string; dataUrl: string; cached: boolean }> {
  const catalog = state.propCatalog;
  if (!catalog?.props[name]) {
    return Promise.reject(new Error(`Unknown prop: ${name}`));
  }
  const def = catalog.props[name];
  const hash = _hashPropDef(def);
  const key = _thumbKey(name, sizePxPerCell);
  const cached = _thumbCache.get(key);
  if (cached?.hash === hash) {
    return { success: true, name, dataUrl: cached.dataUrl, cached: true };
  }
  const result = (await renderPropPreview(name, { scale: sizePxPerCell })) as { success: boolean; dataUrl: string };
  if (!result.success) {
    return Promise.reject(new Error(`Failed to render thumbnail for ${name}`));
  }
  _thumbCache.set(key, { hash, dataUrl: result.dataUrl });
  return { success: true, name, dataUrl: result.dataUrl, cached: false };
}

/**
 * Batch-fetch thumbnails for many props at once. Returns one entry per
 * requested name. Useful when comparing 5–10 candidates visually.
 *
 * @param names Prop catalog names
 * @param sizePxPerCell Pixels per cell (default 32)
 */
export async function getPropThumbnails(
  names: string[],
  sizePxPerCell: number = 32,
): Promise<{
  success: true;
  thumbnails: Array<{ name: string; dataUrl: string | null; error?: string }>;
}> {
  const out: Array<{ name: string; dataUrl: string | null; error?: string }> = [];
  for (const name of names) {
    try {
      const t = await getPropThumbnail(name, sizePxPerCell);
      out.push({ name, dataUrl: t.dataUrl });
    } catch (e) {
      out.push({ name, dataUrl: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { success: true, thumbnails: out };
}

/** Clear the thumbnail cache. Called automatically when prop catalog reloads. */
export function clearPropThumbnailCache(): { success: true; cleared: number } {
  const n = _thumbCache.size;
  _thumbCache.clear();
  return { success: true, cleared: n };
}

/**
 * Pre-render thumbnails for every prop in the catalog and seed the cache.
 *
 * Slow on first call (renders ~200 thumbnails serially) but fast on
 * subsequent thumbnail fetches. Useful at editor startup or before a
 * "show me 50 props side-by-side" batch.
 *
 * Yields the event loop between renders so the UI doesn't stall — this is
 * not strictly atomic, but other API calls won't be starved.
 *
 * @param options.sizePxPerCell Pixels per cell for the cached thumbnails (default 32)
 * @param options.onlyMissing Skip props already in cache (default true)
 * @param options.maxConcurrent Reserved for future use (currently serial). Default 1.
 */
export async function prewarmPropThumbnails(
  options: { sizePxPerCell?: number; onlyMissing?: boolean; maxConcurrent?: number } = {},
): Promise<{
  success: true;
  total: number;
  rendered: number;
  cached: number;
  failed: Array<{ name: string; error: string }>;
  durationMs: number;
}> {
  const sizePxPerCell = options.sizePxPerCell ?? 32;
  const onlyMissing = options.onlyMissing !== false;
  const start = Date.now();

  const catalog = state.propCatalog;
  if (!catalog) {
    return { success: true, total: 0, rendered: 0, cached: 0, failed: [], durationMs: 0 };
  }
  const names = Object.keys(catalog.props);
  const failed: Array<{ name: string; error: string }> = [];
  let rendered = 0;
  let cached = 0;
  for (const name of names) {
    const def = catalog.props[name];
    const hash = _hashPropDef(def);
    const key = _thumbKey(name, sizePxPerCell);
    const existing = _thumbCache.get(key);
    if (onlyMissing && existing?.hash === hash) {
      cached++;
      continue;
    }
    try {
      const result = (await renderPropPreview(name, { scale: sizePxPerCell })) as {
        success: boolean;
        dataUrl: string;
      };
      if (result.success) {
        _thumbCache.set(key, { hash, dataUrl: result.dataUrl });
        rendered++;
      } else {
        failed.push({ name, error: 'render returned success=false' });
      }
    } catch (e) {
      failed.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
    // Yield to the event loop — other API calls can interleave
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    success: true,
    total: names.length,
    rendered,
    cached,
    failed,
    durationMs: Date.now() - start,
  };
}

/**
 * Convenience: search props and inline-attach thumbnails for each result.
 * Shortcut for the common pattern of `searchProps(...)` → `getPropThumbnails(names)`.
 *
 * Same filter as `searchProps`. Returns the same shape plus a `dataUrl`
 * field on each prop entry. Cached thumbnails are returned synchronously
 * (per-prop); uncached ones render on demand.
 *
 * @param filter Same as searchProps
 * @param options.sizePxPerCell Thumbnail size (default 32)
 */
export async function searchPropsWithThumbnails(
  filter: Record<string, unknown> = {},
  options: { sizePxPerCell?: number } = {},
): Promise<{ success: true; count: number; props: Array<Record<string, unknown> & { dataUrl: string | null }> }> {
  // Lazy-import searchProps so this module doesn't hard-depend on inspect.ts
  const inspect = await import('./inspect.js');
  const searchProps = (inspect as { searchProps: (f: unknown) => { count: number; props: Array<{ name: string }> } })
    .searchProps;
  const sizePxPerCell = options.sizePxPerCell ?? 32;
  const found = searchProps(filter);
  const out: Array<Record<string, unknown> & { dataUrl: string | null }> = [];
  for (const p of found.props) {
    let dataUrl: string | null = null;
    try {
      const t = await getPropThumbnail(p.name, sizePxPerCell);
      dataUrl = t.dataUrl;
    } catch {
      dataUrl = null;
    }
    out.push({ ...p, dataUrl });
  }
  return { success: true, count: out.length, props: out };
}
