/**
 * gobo-catalog-node.ts
 * Node.js-only gobo catalog loader for the CLI render pipeline. Parses
 * every .gobo file in src/gobos/ and registers the result via
 * {@link setGoboDefinitions}. Safe to call multiple times (it re-registers).
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import type { GoboDefinition } from '../types.js';
import { setGoboDefinitions } from './gobo-registry.js';
import { parseGoboText } from './parse-gobo.js';

const __dirname = (() => {
  const d = dirname(fileURLToPath(import.meta.url));
  return basename(d) === 'dist-electron' ? join(dirname(d), 'src', 'render') : d;
})();

/**
 * Load every .gobo file under src/gobos/ and populate the render-side gobo
 * registry. Called once from the CLI compile path before lightmap rendering.
 */
export function loadGoboCatalogSync(): GoboDefinition[] {
  const manifestPath = join(__dirname, '../gobos/manifest.json');
  let ids: string[];
  try {
    ids = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [];
  }
  const defs: GoboDefinition[] = [];
  for (const id of ids) {
    try {
      const text = fs.readFileSync(join(__dirname, `../gobos/${id}.gobo`), 'utf-8');
      defs.push(parseGoboText(id, text));
    } catch {
      /* skip unreadable gobos silently */
    }
  }
  setGoboDefinitions(defs);
  return defs;
}
