// ── Constants ────────────────────────────────────────────────────────

import { CARDINAL_DIRS, OPPOSITE } from '../util/index.js';

// Compile-module shape: { name, opposite, dr, dc } derived from shared source.
const DIRECTIONS = CARDINAL_DIRS.map(d => ({
  name: d.dir, opposite: OPPOSITE[d.dir], dr: d.dr, dc: d.dc
}));

const RESERVED_CHARS = new Set(['.', '-', '#', '=']);
const OPEN_CORRIDOR_CHAR = '=';

// Trim corner → diagonal type
const TRIM_DIAGONALS = {
  'nw': 'ne-sw',
  'ne': 'nw-se',
  'sw': 'nw-se',
  'se': 'ne-sw'
};

// Walls cleared by each trim (diagonal replaces them)
const TRIM_CLEAR_WALLS = {
  'nw': ['north', 'west'],
  'ne': ['north', 'east'],
  'sw': ['south', 'west'],
  'se': ['south', 'east']
};

export { DIRECTIONS, RESERVED_CHARS, OPEN_CORRIDOR_CHAR, TRIM_DIAGONALS, TRIM_CLEAR_WALLS };
