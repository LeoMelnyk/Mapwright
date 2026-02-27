#!/usr/bin/env node
/**
 * tools/polyhaven/download-polyhaven.js
 *
 * Downloads Polyhaven's free texture catalog into src/textures/polyhaven/.
 * For each texture, downloads PNG maps at the chosen resolution:
 *   DIFF    — diffuse/albedo color (used now for rendering)
 *   DISP    — displacement/height (used now for blend ordering)
 *   NOR_GL  — OpenGL normal map   (for future lighting engine)
 *   ARM     — AO + Roughness + Metalness packed (for future PBR lighting)
 *
 * Writes a .texture file for each asset and updates src/textures/manifest.json.
 * Throttled: one request at a time with a configurable delay between each.
 *
 * Usage:
 *   node tools/polyhaven/download-polyhaven.js [options]
 *
 * Options:
 *   --res 1k|2k|4k   Resolution (default: 1k)
 *   --delay MS        Milliseconds between requests (default: 300)
 *   --limit N         Only process the first N textures (useful for testing)
 *   --filter STR      Only process textures whose ID or categories include STR
 *   --dry-run         Print what would happen without downloading anything
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEXTURES_DIR  = join(__dirname, '../../src/textures');
const POLYHAVEN_DIR = join(TEXTURES_DIR, 'polyhaven');
const MANIFEST_PATH = join(TEXTURES_DIR, 'manifest.json');
const API           = 'https://api.polyhaven.com';

// Maps to download. Keys are our internal names; values are the Polyhaven API
// map-type keys (data[apiKey][resolution]['png'].url).
// nor_gl = OpenGL Y-up normal convention (what WebGL / three.js expects).
const MAPS = [
  { key: 'diff', apiKey: 'Diffuse',      label: 'DIFF   ' },
  { key: 'disp', apiKey: 'Displacement', label: 'DISP   ' },
  { key: 'nor',  apiKey: 'nor_gl',       label: 'NOR_GL ' },
  { key: 'arm',  apiKey: 'arm',          label: 'ARM    ' },
];

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flag(name)       { return argv.includes(name); }
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : fallback;
}

const DRY_RUN    = flag('--dry-run');
const RESOLUTION = opt('--res',    '1k');
const DELAY_MS   = parseInt(opt('--delay', '300'), 10);
const LIMIT      = opt('--limit') ? parseInt(opt('--limit'), 10) : null;
const FILTER     = opt('--filter', null);

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

function toTitleCase(str) {
  return str
    .split(/[\s_-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!DRY_RUN) {
    mkdirSync(POLYHAVEN_DIR, { recursive: true });
  }

  // 1. Fetch the full texture catalog
  console.log('Fetching Polyhaven texture catalog...');
  await sleep(DELAY_MS);
  const assets = await fetchJSON(`${API}/assets?type=textures`);

  let ids = Object.keys(assets);

  if (FILTER) {
    ids = ids.filter(id =>
      id.includes(FILTER) ||
      (assets[id].categories || []).some(c => c.includes(FILTER))
    );
    console.log(`  Filtered to ${ids.length} textures matching "${FILTER}"`);
  }

  if (LIMIT) {
    ids = ids.slice(0, LIMIT);
    console.log(`  Limited to first ${ids.length} textures`);
  }

  console.log(`\nProcessing ${ids.length} textures — ${DELAY_MS}ms delay per request\n`);

  let downloaded = 0, skipped = 0, failed = 0;
  const newManifestKeys = [];

  for (let i = 0; i < ids.length; i++) {
    const id    = ids[i];
    const asset = assets[id];

    const categories  = asset.categories || [];
    const category    = toTitleCase(categories[0] || 'Uncategorized');
    const subcategory = categories[1] ? toTitleCase(categories[1]) : null;
    const displayName = asset.name || toTitleCase(id);

    console.log(`[${i + 1}/${ids.length}] ${id}  (${category}${subcategory ? ' / ' + subcategory : ''})`);

    // 2. Fetch download file list for this texture
    let files;
    try {
      await sleep(DELAY_MS);
      files = await fetchJSON(`${API}/files/${id}`);
    } catch (e) {
      console.warn(`  ✗ Could not fetch file list: ${e.message}`);
      failed++;
      continue;
    }

    // 3. Download each map type
    // API structure: data[apiKey][resolution]['png'].url
    const mapPaths = {};

    for (const { key, apiKey, label } of MAPS) {
      const fileInfo = files?.[apiKey]?.[RESOLUTION]?.png;
      if (!fileInfo?.url) continue; // not available for this texture / resolution

      const filename  = fileInfo.url.split('/').pop();
      const localPath = join(POLYHAVEN_DIR, filename);
      const relPath   = `polyhaven/${filename}`;

      if (existsSync(localPath)) {
        process.stdout.write(`  ⏭  ${label} ${filename} (exists)\n`);
        mapPaths[key] = relPath;
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        process.stdout.write(`  [dry] ${label} ${filename}\n`);
        mapPaths[key] = relPath;
        continue;
      }

      try {
        await sleep(DELAY_MS);
        const bytes = await downloadFile(fileInfo.url, localPath);
        process.stdout.write(`  ✓  ${label} ${filename} (${(bytes / 1024).toFixed(0)} KB)\n`);
        mapPaths[key] = relPath;
        downloaded++;
      } catch (e) {
        process.stdout.write(`  ✗  ${label} ${filename}: ${e.message}\n`);
        failed++;
      }
    }

    // Skip if no diffuse map — nothing to render
    if (!mapPaths.diff) {
      console.warn(`  ✗ No Diffuse map at ${RESOLUTION} — skipping .texture\n`);
      continue;
    }

    // 4. Write .texture file
    const textureData = {
      displayName,
      category,
      ...(subcategory && { subcategory }),
      file: mapPaths.diff,
      maps: {
        ...(mapPaths.disp && { disp: mapPaths.disp }),
        ...(mapPaths.nor  && { nor:  mapPaths.nor  }),
        ...(mapPaths.arm  && { arm:  mapPaths.arm  }),
      },
      scale:  2.0,
      credit: 'Polyhaven (CC0)',
    };

    const texturePath = join(POLYHAVEN_DIR, `${id}.texture`);
    if (!DRY_RUN) {
      writeFileSync(texturePath, JSON.stringify(textureData, null, 2));
    }

    newManifestKeys.push(`polyhaven/${id}`);
    console.log(`  → polyhaven/${id}.texture\n`);
  }

  // 5. Merge into manifest.json (preserve existing hand-crafted entries)
  if (!DRY_RUN && newManifestKeys.length > 0) {
    const existing = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const merged   = [...new Set([...existing, ...newManifestKeys])].sort();
    writeFileSync(MANIFEST_PATH, JSON.stringify(merged, null, 2));
    console.log(`Manifest updated — ${merged.length} total entries (${newManifestKeys.length} added)`);
  }

  console.log(`\nDone.  Downloaded: ${downloaded}  Skipped (exist): ${skipped}  Failed: ${failed}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
