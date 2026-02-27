#!/usr/bin/env node
/**
 * tools/texturecan/process-texturecan.js
 *
 * Processes TextureCan zip archives from src/textures/texturecan/process/
 * into the standard texture format used by the dungeon editor.
 *
 * For each zip, extracts and converts:
 *   color_1k.jpg     → <id>_diff_1k.png   (diffuse/albedo)
 *   height_1k.png    → <id>_disp_1k.png   (displacement)
 *   normal_opengl_1k → <id>_nor_gl_1k.png (normal map)
 *   ao + roughness   → <id>_arm_1k.png    (AO=R, Roughness=G, Metal=B packed)
 *
 * Creates .texture metadata files and updates manifest.json.
 *
 * Usage:
 *   node tools/texturecan/process-texturecan.js [options]
 *
 * Options:
 *   --dry-run    Print what would happen without writing anything
 *   --force      Re-process textures that already exist
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXTURES_DIR  = join(__dirname, '../../src/textures');
const TEXTURECAN_DIR = join(TEXTURES_DIR, 'texturecan');
const PROCESS_DIR   = join(TEXTURECAN_DIR, 'process');
const MANIFEST_PATH = join(TEXTURES_DIR, 'manifest.json');

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE   = argv.includes('--force');

// ─── Display name mappings ───────────────────────────────────────────────────
// TextureCan IDs → human-readable names and categories.
// Add entries here when processing new textures.

const TEXTURE_INFO = {
  'ground_0007': { displayName: 'Rocky Ground',       category: 'Earth',  subcategory: 'Rocky' },
  'ground_0008': { displayName: 'Gravel Path',        category: 'Earth',  subcategory: 'Gravel' },
  'ground_0014': { displayName: 'Forest Floor',       category: 'Earth',  subcategory: 'Forest' },
  'ground_0017': { displayName: 'Muddy Ground',       category: 'Earth',  subcategory: 'Mud' },
  'ground_0019': { displayName: 'Sandy Ground',       category: 'Earth',  subcategory: 'Sand' },
  'ground_0027': { displayName: 'Dried Earth',        category: 'Earth',  subcategory: 'Dirt' },
  'ground_0030': { displayName: 'Mossy Ground',       category: 'Earth',  subcategory: 'Moss' },
  'ground_0043': { displayName: 'Stony Soil',         category: 'Earth',  subcategory: 'Rocky' },
  'others_0002': { displayName: 'Rusted Metal',       category: 'Metal',  subcategory: 'Rusted' },
};

// ─── Processing ──────────────────────────────────────────────────────────────

async function processZip(zipPath) {
  const zipName = basename(zipPath, '.zip');
  // Extract texture ID: "ground_0007_1k_DPD3k5" → "ground_0007"
  const match = zipName.match(/^(\w+_\d+)_1k_/);
  if (!match) {
    console.warn(`  ⚠ Skipping ${zipName} — can't parse texture ID`);
    return null;
  }
  const id = match[1];
  const textureId = `texturecan/${id}`;

  // Check if already processed
  const textureFile = join(TEXTURECAN_DIR, `${id}.texture`);
  if (existsSync(textureFile) && !FORCE) {
    console.log(`  ✓ ${id} already processed (use --force to redo)`);
    return textureId;
  }

  console.log(`  → Processing ${id}...`);

  if (DRY_RUN) {
    console.log(`    [dry-run] Would extract, convert, and create ${id}.texture`);
    return textureId;
  }

  // Extract to temp directory
  const tmpDir = join(PROCESS_DIR, `_tmp_${id}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(`unzip -o -j "${zipPath}" -d "${tmpDir}" -x "__MACOSX/*"`, { stdio: 'pipe' });

    // Find source files
    const files = readdirSync(tmpDir);
    const colorFile   = files.find(f => f.includes('_color_1k'));
    const heightFile  = files.find(f => f.includes('_height_1k'));
    const normalFile  = files.find(f => f.includes('_normal_opengl_1k'));
    const aoFile      = files.find(f => f.includes('_ao_1k'));
    const roughFile   = files.find(f => f.includes('_roughness_1k'));

    if (!colorFile) {
      console.warn(`    ⚠ No color file found in ${zipName}`);
      return null;
    }

    // 1. Diffuse: convert color JPG → PNG
    const diffOut = join(TEXTURECAN_DIR, `${id}_diff_1k.png`);
    await sharp(join(tmpDir, colorFile)).png().toFile(diffOut);
    console.log(`    diff: ${colorFile} → ${id}_diff_1k.png`);

    // 2. Displacement: copy/convert height PNG
    const dispOut = join(TEXTURECAN_DIR, `${id}_disp_1k.png`);
    if (heightFile) {
      await sharp(join(tmpDir, heightFile)).png().toFile(dispOut);
      console.log(`    disp: ${heightFile} → ${id}_disp_1k.png`);
    } else {
      console.warn(`    ⚠ No height file — displacement map skipped`);
    }

    // 3. Normal: copy OpenGL normal PNG
    const norOut = join(TEXTURECAN_DIR, `${id}_nor_gl_1k.png`);
    if (normalFile) {
      await sharp(join(tmpDir, normalFile)).png().toFile(norOut);
      console.log(`    nor:  ${normalFile} → ${id}_nor_gl_1k.png`);
    } else {
      console.warn(`    ⚠ No normal file — normal map skipped`);
    }

    // 4. ARM: pack AO(R) + Roughness(G) + Metal(B=0) into single PNG
    const armOut = join(TEXTURECAN_DIR, `${id}_arm_1k.png`);
    if (aoFile && roughFile) {
      const aoData = await sharp(join(tmpDir, aoFile))
        .resize(1024, 1024)
        .greyscale()
        .raw()
        .toBuffer();
      const roughData = await sharp(join(tmpDir, roughFile))
        .resize(1024, 1024)
        .greyscale()
        .raw()
        .toBuffer();

      // Pack: R=AO, G=Roughness, B=0 (no metalness)
      const armPixels = Buffer.alloc(1024 * 1024 * 3);
      for (let i = 0; i < 1024 * 1024; i++) {
        armPixels[i * 3]     = aoData[i];       // R = AO
        armPixels[i * 3 + 1] = roughData[i];    // G = Roughness
        armPixels[i * 3 + 2] = 0;               // B = Metal (none)
      }
      await sharp(armPixels, { raw: { width: 1024, height: 1024, channels: 3 } })
        .png()
        .toFile(armOut);
      console.log(`    arm:  ${aoFile} + ${roughFile} → ${id}_arm_1k.png`);
    } else {
      console.warn(`    ⚠ Missing AO/roughness — ARM map skipped`);
    }

    // 5. Create .texture metadata
    const info = TEXTURE_INFO[id] || {
      displayName: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      category: 'Uncategorized',
      subcategory: null,
    };
    const maps = {};
    if (heightFile)  maps.disp = `texturecan/${id}_disp_1k.png`;
    if (normalFile)  maps.nor  = `texturecan/${id}_nor_gl_1k.png`;
    if (aoFile && roughFile) maps.arm = `texturecan/${id}_arm_1k.png`;

    const textureData = {
      displayName: info.displayName,
      category: info.category,
      ...(info.subcategory ? { subcategory: info.subcategory } : {}),
      file: `texturecan/${id}_diff_1k.png`,
      maps,
      scale: 2,
      credit: 'TextureCan (CC0)',
    };
    writeFileSync(textureFile, JSON.stringify(textureData, null, 2) + '\n');
    console.log(`    ✓ Created ${id}.texture`);

    return textureId;
  } finally {
    // Clean up temp directory
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`TextureCan processor`);
  console.log(`  Source: ${PROCESS_DIR}`);
  console.log(`  Output: ${TEXTURECAN_DIR}`);
  if (DRY_RUN) console.log(`  [DRY RUN]`);
  console.log('');

  // Find all zips
  const zips = readdirSync(PROCESS_DIR).filter(f => f.endsWith('.zip')).sort();
  if (zips.length === 0) {
    console.log('No zip files found in process directory.');
    return;
  }
  console.log(`Found ${zips.length} zip(s) to process:\n`);

  const processed = [];
  for (const zip of zips) {
    const id = await processZip(join(PROCESS_DIR, zip));
    if (id) processed.push(id);
  }

  if (processed.length === 0 || DRY_RUN) {
    console.log('\nDone.');
    return;
  }

  // Update manifest.json
  console.log('\nUpdating manifest.json...');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  let added = 0;
  for (const id of processed) {
    if (!manifest.includes(id)) {
      manifest.push(id);
      added++;
    }
  }
  manifest.sort();
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`  ${added} new texture(s) added to manifest (${manifest.length} total)`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
