/**
 * texture-catalog-node.js
 * Node.js-only texture catalog loader for server-side PNG export.
 * Loads texture metadata from .texture files and images via @napi-rs/canvas.
 */

import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadImage } from '@napi-rs/canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXTURES_DIR = join(__dirname, '../textures');

let catalogCache = null;
const imageCache = new Map();

/**
 * Load texture metadata (not images) from .texture files on disk.
 * Cached after first call.
 */
export function loadTextureCatalogMetadata() {
  if (catalogCache) return catalogCache;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(join(TEXTURES_DIR, 'manifest.json'), 'utf-8'));
  } catch {
    console.warn('[textures] Could not load texture manifest — textures will not render');
    catalogCache = { names: [], textures: {} };
    return catalogCache;
  }

  const textures = {};
  for (const id of manifest) {
    try {
      const data = JSON.parse(fs.readFileSync(join(TEXTURES_DIR, `${id}.texture`), 'utf-8'));
      textures[id] = {
        id,
        displayName: data.displayName,
        category: data.category,
        subcategory: data.subcategory || null,
        file: data.file,
        dispFile: data.maps?.disp || null,
        scale: data.scale || 2,
        img: null,
        dispImg: null,
      };
    } catch (e) { console.warn(`[textures] Failed to load ${id}.texture: ${e.message}`); }
  }

  catalogCache = { names: manifest, textures };
  console.log(`[textures] Loaded metadata for ${Object.keys(textures).length} textures`);
  return catalogCache;
}

/**
 * Scan a cell grid and return a Set of all texture IDs referenced.
 */
function collectTextureIds(cells) {
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
  return ids;
}

/**
 * Ensure texture images are loaded for all IDs used by the given cells.
 * Also loads textures referenced by props.
 * Images are cached — subsequent calls for the same textures are instant.
 */
export async function ensureTexturesForConfig(catalog, config, propCatalog) {
  const ids = collectTextureIds(config.cells);

  // Also include textures referenced by props
  if (propCatalog?.props) {
    for (const row of config.cells) {
      if (!row) continue;
      for (const cell of row) {
        if (!cell?.prop) continue;
        const propDef = propCatalog.props[cell.prop.type];
        if (propDef?.textures) {
          for (const id of propDef.textures) ids.add(id);
        }
      }
    }
  }

  const promises = [];
  for (const id of ids) {
    const entry = catalog.textures[id];
    if (!entry) continue;

    // Load diffuse image
    if (!entry.img && entry.file) {
      const filePath = join(TEXTURES_DIR, entry.file);
      if (imageCache.has(filePath)) {
        entry.img = imageCache.get(filePath);
      } else {
        promises.push(
          loadImage(filePath)
            .then(img => { entry.img = img; imageCache.set(filePath, img); })
            .catch((e) => { console.warn(`[textures] Failed to load diffuse for ${id}: ${e.message}`); })
        );
      }
    }

    // Load displacement image
    const dispFile = entry.dispFile || entry.file?.replace('_diff_', '_disp_');
    if (!entry.dispImg && dispFile) {
      const filePath = join(TEXTURES_DIR, dispFile);
      if (imageCache.has(filePath)) {
        entry.dispImg = imageCache.get(filePath);
      } else {
        promises.push(
          loadImage(filePath)
            .then(img => { entry.dispImg = img; imageCache.set(filePath, img); })
            .catch(() => { /* displacement maps are optional */ })
        );
      }
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
  }
}
