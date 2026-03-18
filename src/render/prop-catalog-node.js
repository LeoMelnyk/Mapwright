/**
 * prop-catalog-node.js
 * Node.js-only prop catalog loader for the CLI render pipeline.
 * NOT imported by the browser bundle — uses fs.readFileSync and Node.js path utilities.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parsePropFile } from './props.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Synchronously load the full prop catalog from .prop files on disk.
 * Returns { props: { [name]: PropDefinition }, categories: string[] }.
 */
export function loadPropCatalogSync() {
  const manifestPath = join(__dirname, '../props/manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    console.warn('[props] Could not load prop manifest — props will not render in CLI build');
    return { props: {}, categories: [] };
  }

  const props = {};
  for (const name of manifest) {
    const propPath = join(__dirname, `../props/${name}.prop`);
    try {
      const text = fs.readFileSync(propPath, 'utf-8');
      props[name] = parsePropFile(text);
    } catch (e) {
      console.warn(`[props] Failed to load ${name}.prop: ${e.message}`);
    }
  }

  const categories = [...new Set(Object.values(props).map(p => p.category))];
  return { props, categories };
}
