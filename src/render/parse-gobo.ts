// .gobo file parser shared by the editor catalog and the Node-side render
// pipeline. Pure function — no I/O — so it can run in either environment.

import type { GoboDefinition, GoboPattern } from '../types.js';

export const VALID_GOBO_PATTERNS: readonly GoboPattern[] = [
  'plain',
  'grid',
  'slats',
  'slot',
  'mosaic',
  'sigil',
  'caustics',
  'dapple',
  'stained-glass',
  'diamond',
  'cross',
];

/**
 * Parse the contents of a `.gobo` file (YAML-like header) into a GoboDefinition.
 * Unknown patterns fall back to `'grid'`; missing density falls back to 6.
 */
export function parseGoboText(id: string, text: string): GoboDefinition {
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
  const pattern: GoboPattern = VALID_GOBO_PATTERNS.includes(rawPattern) ? rawPattern : 'grid';
  const density = Number.parseFloat(header.density ?? '');
  const orientation =
    header.orientation === 'horizontal' ? 'horizontal' : header.orientation === 'vertical' ? 'vertical' : undefined;
  const colors = parseGoboColorPalette(header.colors);

  return {
    id,
    name: header.name ?? id,
    description: header.description ?? '',
    pattern,
    density: Number.isFinite(density) && density > 0 ? density : 6,
    ...(orientation ? { orientation } : {}),
    ...(colors ? { colors } : {}),
  };
}

/** Parse a comma-separated list of hex colors (e.g. "#ff0000, #00ff00"). */
export function parseGoboColorPalette(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const colors = raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c));
  return colors.length > 0 ? colors : undefined;
}
