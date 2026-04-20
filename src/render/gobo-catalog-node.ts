/**
 * gobo-catalog-node.ts
 * Node.js-only gobo catalog loader for the CLI render pipeline. Parses
 * every .gobo file in src/gobos/ and registers the result via
 * {@link setGoboDefinitions}. Safe to call multiple times (it re-registers).
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import type { GoboDefinition, GoboPattern } from '../types.js';
import { setGoboDefinitions } from './gobo-registry.js';

const VALID_PATTERNS: GoboPattern[] = ['grid', 'slats', 'sigil', 'caustics', 'dapple', 'stained-glass'];

const __dirname = (() => {
  const d = dirname(fileURLToPath(import.meta.url));
  return basename(d) === 'dist-electron' ? join(dirname(d), 'src', 'render') : d;
})();

function parseGoboText(id: string, text: string): GoboDefinition {
  const header: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();
    header[key] = value;
  }
  const rawPattern = (header.pattern ?? 'grid').toLowerCase() as GoboPattern;
  const pattern: GoboPattern = VALID_PATTERNS.includes(rawPattern) ? rawPattern : 'grid';
  const density = Number.parseFloat(header.density ?? '');
  const orientation =
    header.orientation === 'horizontal' ? 'horizontal' : header.orientation === 'vertical' ? 'vertical' : undefined;
  return {
    id,
    name: header.name ?? id,
    description: header.description ?? '',
    pattern,
    density: Number.isFinite(density) && density > 0 ? density : 6,
    ...(orientation ? { orientation } : {}),
  };
}

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
