#!/usr/bin/env node
/**
 * tools/download-textures.js
 *
 * Downloads Polyhaven textures for Mapwright.
 *
 * Usage:
 *   node tools/download-textures.js --required   Only textures used by built-in props
 *   node tools/download-textures.js --all        Full Polyhaven catalog (~700 textures)
 *   node tools/download-textures.js --check      Report missing required textures (no download)
 *
 * Options:
 *   --res 1k|2k|4k    Resolution (default: 1k)
 *   --delay MS        Milliseconds between requests (default: 300)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = join(__dirname, '..');
const TEXTURES_DIR = join(ROOT, 'src/textures');
const POLYHAVEN_DIR = join(TEXTURES_DIR, 'polyhaven');
const MANIFEST_PATH = join(TEXTURES_DIR, 'manifest.json');
const API          = 'https://api.polyhaven.com';

// Directories and file extensions to scan for polyhaven texture references.
// Add entries here when new source types are introduced.
const SCAN_SOURCES = [
  { dir: join(ROOT, 'src/props'),  exts: ['.prop'] },
  { dir: join(ROOT, 'examples'),   exts: ['.map', '.json'] },
];

const MAPS = [
  { key: 'diff', apiKey: 'Diffuse'      },
  { key: 'disp', apiKey: 'Displacement' },
  { key: 'nor',  apiKey: 'nor_gl'       },
  { key: 'arm',  apiKey: 'arm'          },
];

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const opt  = (name, def) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : def; };

const MODE       = flag('--all') ? 'all' : flag('--check') ? 'check' : 'required';
const RESOLUTION = opt('--res', '1k');
const DELAY_MS   = parseInt(opt('--delay', '300'), 10);

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function toTitleCase(str) {
  return str.split(/[\s_-]+/).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Scan all source files for polyhaven/<id> references */
function scanRequiredTextures() {
  const ids = new Set();
  for (const { dir, exts } of SCAN_SOURCES) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => exts.some(ext => f.endsWith(ext)));
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf8');
      for (const m of content.matchAll(/polyhaven\/([a-z0-9_]+)/g)) {
        ids.add(m[1]);
      }
    }
  }
  return [...ids].sort();
}

/** Render a progress bar to stdout in-place using \r */
function drawProgress(current, total, label) {
  const W      = 32;
  const pct    = total > 0 ? current / total : 1;
  const filled = Math.min(W, Math.round(pct * W));
  const arrow  = filled < W ? '>' : '';
  const empty  = W - filled - (arrow ? 1 : 0);
  const bar    = '='.repeat(filled) + arrow + ' '.repeat(Math.max(0, empty));
  const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
  const width  = String(total).length;
  const count  = `${String(current).padStart(width)}/${total}`;
  const name   = (label || '').slice(0, 36).padEnd(36);
  process.stdout.write(`\r  [${bar}] ${count}  ${pctStr}  ${name}`);
}

/** Download one texture and write its .texture metadata file. Returns manifest key or null. */
async function downloadOne(id, assetInfo) {
  let files;
  try {
    await sleep(DELAY_MS);
    files = await fetchJSON(`${API}/files/${id}`);
  } catch (e) {
    return null;
  }

  const mapPaths = {};
  for (const { key, apiKey } of MAPS) {
    const info = files?.[apiKey]?.[RESOLUTION]?.png;
    if (!info?.url) continue;

    const filename  = info.url.split('/').pop();
    const localPath = join(POLYHAVEN_DIR, filename);

    if (existsSync(localPath)) {
      mapPaths[key] = `polyhaven/${filename}`;
      continue;
    }

    try {
      await sleep(DELAY_MS);
      await downloadFile(info.url, localPath);
      mapPaths[key] = `polyhaven/${filename}`;
    } catch (_) { /* non-fatal — best effort per map */ }
  }

  if (!mapPaths.diff) return null;

  const cats = assetInfo?.categories || [];
  const textureData = {
    displayName: assetInfo?.name || toTitleCase(id),
    category:    toTitleCase(cats[0] || 'Uncategorized'),
    ...(cats[1] && { subcategory: toTitleCase(cats[1]) }),
    file: mapPaths.diff,
    maps: {
      ...(mapPaths.disp && { disp: mapPaths.disp }),
      ...(mapPaths.nor  && { nor:  mapPaths.nor  }),
      ...(mapPaths.arm  && { arm:  mapPaths.arm  }),
    },
    scale:  2.0,
    credit: 'Polyhaven (CC0)',
  };

  writeFileSync(join(POLYHAVEN_DIR, `${id}.texture`), JSON.stringify(textureData, null, 2));
  return `polyhaven/${id}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(POLYHAVEN_DIR, { recursive: true });

  // ── Check mode — local only, no network ──────────────────────────
  if (MODE === 'check') {
    const required = scanRequiredTextures();
    const missing  = required.filter(id => !existsSync(join(POLYHAVEN_DIR, `${id}.texture`)));
    if (missing.length === 0) {
      console.log(`All ${required.length} required textures are already downloaded.`);
    } else {
      console.log(`Missing ${missing.length} of ${required.length} required textures:`);
      for (const id of missing) console.log(`  polyhaven/${id}`);
    }
    return;
  }

  // ── Fetch catalog ─────────────────────────────────────────────────
  process.stdout.write('Fetching Polyhaven catalog...');
  await sleep(DELAY_MS);
  const catalog = await fetchJSON(`${API}/assets?type=textures`);
  process.stdout.write(` ${Object.keys(catalog).length} textures.\n`);

  // ── Build work list ───────────────────────────────────────────────
  let ids;
  if (MODE === 'all') {
    ids = Object.keys(catalog).sort();
  } else {
    ids = scanRequiredTextures().filter(id => {
      if (!catalog[id]) { console.warn(`  Warning: '${id}' not found in Polyhaven catalog`); return false; }
      return true;
    });
  }

  const todo = ids.filter(id => !existsSync(join(POLYHAVEN_DIR, `${id}.texture`)));
  console.log(`  Total: ${ids.length}  Already downloaded: ${ids.length - todo.length}  To download: ${todo.length}`);

  if (todo.length === 0) {
    console.log('\nAll textures already downloaded — nothing to do.\n');
    return;
  }

  console.log('');

  // ── Download loop ─────────────────────────────────────────────────
  let succeeded = 0, failed = 0;
  const newKeys = [];

  for (let i = 0; i < todo.length; i++) {
    const id = todo[i];
    drawProgress(i, todo.length, id);

    const key = await downloadOne(id, catalog[id]);
    if (key) { succeeded++; newKeys.push(key); }
    else      { failed++; }
  }

  drawProgress(todo.length, todo.length, 'Complete');
  process.stdout.write('\n\n');

  // ── Update manifest ───────────────────────────────────────────────
  if (newKeys.length > 0) {
    const existing = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const merged   = [...new Set([...existing, ...newKeys])].sort();
    writeFileSync(MANIFEST_PATH, JSON.stringify(merged, null, 2));
    console.log(`Manifest updated — ${merged.length} total entries.`);
  }

  console.log(`\nDownloaded: ${succeeded}  Failed: ${failed}`);
  if (failed > 0) {
    console.log('Some textures failed. Run again to retry.\n');
    process.exit(1);
  }
}

main().catch(e => { console.error('\nError:', e.message); process.exit(1); });
