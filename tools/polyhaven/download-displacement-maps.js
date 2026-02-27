/**
 * download-displacement-maps.js
 * One-time script to download displacement maps from Polyhaven CDN for all textures.
 * Run from the project root: node tools/polyhaven/download-displacement-maps.js
 *
 * Polyhaven displacement maps provide per-pixel surface height data (bright = raised).
 * Average displacement luminance is used at runtime to determine blend layer order
 * (harder/raised materials blend into softer/flat ones, not vice versa).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const SRC = 'src/textures';
const CDN = 'https://dl.polyhaven.org/file/ph-assets/Textures/png/1k';

const manifest = JSON.parse(readFileSync(`${SRC}/manifest.json`, 'utf8'));

for (const id of manifest) {
  const tex = JSON.parse(readFileSync(`${SRC}/${id}.texture`, 'utf8'));

  // Derive Polyhaven asset name from diffuse filename
  // "cobblestone_floor_02_diff_1k.png" → "cobblestone_floor_02"
  const asset = tex.file.replace(/_diff_\dk\.png$/, '');
  const dispFile = `${asset}_disp_1k.png`;
  const outPath = `${SRC}/${dispFile}`;

  if (existsSync(outPath)) {
    console.log(`⏭  ${dispFile} already exists, skipping.`);
    continue;
  }

  const url = `${CDN}/${asset}/${dispFile}`;
  console.log(`⬇  Fetching ${url} ...`);

  try {
    const res = await fetch(url);
    if (res.ok) {
      writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
      console.log(`✓  Saved ${outPath}`);
    } else {
      console.warn(`✗  HTTP ${res.status} — no displacement map for "${id}" (${url})`);
    }
  } catch (err) {
    console.error(`✗  Network error for "${id}": ${err.message}`);
  }
}

console.log('\nDone.');
