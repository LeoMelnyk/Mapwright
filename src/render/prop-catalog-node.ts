import type { PropDefinition } from '../types.js';
/**
 * prop-catalog-node.js
 * Node.js-only prop catalog loader for the CLI render pipeline.
 * NOT imported by the browser bundle — uses fs.readFileSync and Node.js path utilities.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import { parsePropFile, materializePropHitbox } from './props.js';

const __dirname = (() => {
  const d = dirname(fileURLToPath(import.meta.url));
  // In bundled mode (dist-electron/server.mjs), map back to the source location so
  // relative project paths like '../props/manifest.json' still resolve correctly.
  return basename(d) === 'dist-electron' ? join(dirname(d), 'src', 'render') : d;
})();

/**
 * Synchronously load the full prop catalog from .prop files on disk.
 * Returns { props: { [name]: PropDefinition }, categories: string[] }.
 */
export function loadPropCatalogSync(): { props: Record<string, PropDefinition>; categories: string[] } {
  const manifestPath = join(__dirname, '../props/manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    console.warn(
      `[props] Could not load prop manifest at ${manifestPath} — props will not render in CLI build: ${(e as Error).stack ?? (e as Error).message}`,
    );
    return { props: {}, categories: [] };
  }

  const props: Record<string, PropDefinition> = {};
  for (const name of manifest) {
    const propPath = join(__dirname, `../props/${name}.prop`);
    try {
      const text = fs.readFileSync(propPath, 'utf-8');
      const def = parsePropFile(text);
      materializePropHitbox(def);
      props[name] = def;
    } catch (e) {
      console.warn(`[props] Failed to load ${name}.prop: ${(e as Error).message}`);
    }
  }

  const categories = [...new Set(Object.values(props).map((p) => p.category))];
  return { props, categories };
}
