/**
 * texture-catalog-node.js
 * Node.js-only texture catalog loader for server-side PNG export.
 * Loads texture metadata from .texture files and images via @napi-rs/canvas.
 *
 * In Electron mode, textures live in MAPWRIGHT_TEXTURE_PATH (userData/textures/).
 */

import type { CellGrid, Metadata, PropCatalog, TextureCatalog } from '../types.js';
import fs from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { loadImage } from '@napi-rs/canvas';
import { BRIDGE_TEXTURE_IDS } from './bridges.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Electron sets MAPWRIGHT_TEXTURE_PATH before importing server.js, so this is
// resolved correctly at module load time.
const TEXTURES_DIR = process.env.MAPWRIGHT_TEXTURE_PATH ?? join(__dirname, '../textures');

type NodeTextureCatalog = { names: string[]; textures: Record<string, Record<string, unknown>> };
let catalogCache: NodeTextureCatalog | null = null;
const imageCache = new Map();

/**
 * Load texture metadata (not images) from .texture files on disk.
 * Cached after first call — call clearCatalogCache() to force a reload.
 */
export function loadTextureCatalogMetadata(): { names: string[]; textures: Record<string, Record<string, unknown>> } {
  if (catalogCache) return catalogCache;

  // Try manifest.json first (written by the downloader after each session).
  // Fall back to scanning .texture files directly so rendering works even
  // if the manifest hasn't been written yet.
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(join(TEXTURES_DIR, 'manifest.json'), 'utf-8'));
  } catch (manifestErr) {
    try {
      const polyDir = join(TEXTURES_DIR, 'polyhaven');
      manifest = fs.readdirSync(polyDir)
        .filter(f => f.endsWith('.texture'))
        .map(f => `polyhaven/${basename(f, '.texture')}`)
        .sort();
    } catch (scanErr) {
      console.warn(
        `[textures] No texture catalog found at ${TEXTURES_DIR} — textures will not render. ` +
        `manifest.json error: ${(manifestErr as Error).message}; scan error: ${(scanErr as Error).message}`,
      );
      catalogCache = { names: [], textures: {} };
      return catalogCache;
    }
  }

  const textures = {};
  for (const id of manifest) {
    try {
      const data = JSON.parse(fs.readFileSync(join(TEXTURES_DIR, `${id}.texture`), 'utf-8'));
      (textures as Record<string, unknown>)[id] = {
        id,
        displayName: data.displayName,
        category: data.category,
        subcategory: data.subcategory ?? null,
        file: data.file,
        dispFile: data.maps?.disp ?? null,
        scale: data.scale ?? 2,
        img: null,
        dispImg: null,
      };
    } catch (e) { console.warn(`[textures] Failed to load ${id}.texture: ${(e as Error).message}`); }
  }

  catalogCache = { names: manifest, textures: textures as Record<string, Record<string, unknown>> };
  console.log(`[textures] Loaded metadata for ${Object.keys(textures).length} textures`);
  return catalogCache;
}

/**
 * Clear the in-memory catalog and image caches so the next render call
 * reloads from disk. Call this after new textures are downloaded.
 */
export function clearCatalogCache(): void {
  catalogCache = null;
  imageCache.clear();
}

/**
 * Scan a cell grid and return a Set of all texture IDs referenced.
 */
function collectTextureIds(cells: CellGrid): Set<string> {
  const ids = new Set<string>();
  const KEYS = ['texture', 'textureSecondary'] as const;
  for (const row of cells) {
    for (const cell of row) {
      if (!cell) continue;
      for (const key of KEYS) {
        const val = cell[key];
        if (val) ids.add(val);
      }
    }
  }
  return ids;
}

/**
 * Ensure texture images are loaded for all IDs used by the given cells.
 * Also loads textures referenced by props.
 * Images are cached — subsequent calls for the same textures are instant.
 */
export async function ensureTexturesForConfig(catalog: TextureCatalog | null, config: { metadata: Metadata; cells: CellGrid }, propCatalog: PropCatalog | null): Promise<void> {
  const ids = collectTextureIds(config.cells);

  // Include bridge textures (canonical IDs in render/constants.ts)
  if (config.metadata.bridges.length) {
    const bridgeTexLookup = BRIDGE_TEXTURE_IDS as unknown as Record<string, string | undefined>;
    for (const b of config.metadata.bridges) {
      const texId = bridgeTexLookup[b.type] ?? BRIDGE_TEXTURE_IDS.wood;
      ids.add(texId);
    }
  }

  // Also include textures referenced by overlay props
  if (propCatalog?.props && config.metadata.props) {
    for (const op of config.metadata.props) {
      const propDef = propCatalog.props[op.type];
      for (const id of propDef.textures) ids.add(id);
    }
  }

  const promises = [];
  for (const id of ids) {
    const entry = catalog?.textures[id];
    if (!entry) continue;

    // Load diffuse image
    if (!entry.img && entry.file) {
      const filePath = join(TEXTURES_DIR, entry.file);
      if (imageCache.has(filePath)) {
        entry.img = imageCache.get(filePath);
      } else {
        promises.push(
          loadImage(filePath)
            .then(img => { entry.img = img as unknown as HTMLImageElement; imageCache.set(filePath, img); })
            .catch((e: Error) => { console.warn(`[textures] Failed to load diffuse for ${id}: ${e.message}`); })
        );
      }
    }

    // Load displacement image
    const dispFile = (entry.dispFile as string) || (entry.file as string).replace('_diff_', '_disp_');
    if (!entry.dispImg && dispFile) {
      const filePath = join(TEXTURES_DIR, dispFile);
      if (imageCache.has(filePath)) {
        entry.dispImg = imageCache.get(filePath);
      } else {
        promises.push(
          loadImage(filePath)
            .then(img => { entry.dispImg = img as unknown as HTMLImageElement; imageCache.set(filePath, img); })
            .catch(() => { /* displacement maps are optional */ })
        );
      }
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
  }
}
