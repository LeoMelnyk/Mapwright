/**
 * Shared rect-operation helpers.
 *
 * Every rect-based API method (paintRect, eraseRect, setFillRect, setTextureRect, etc.)
 * needs the same 3-step preamble: toInt → min/max normalize → validateBounds.
 * This module extracts that pattern into one call.
 */

import { toInt, validateBounds } from './_shared.js';

export interface NormalizedRect {
  minR: number;
  maxR: number;
  minC: number;
  maxC: number;
}

/**
 * Normalize four rect coordinates: convert display coords to internal ints,
 * sort into min/max pairs, and validate both corners are in bounds.
 */
export function normalizeRect(r1: number, c1: number, r2: number, c2: number): NormalizedRect {
  r1 = toInt(r1);
  c1 = toInt(c1);
  r2 = toInt(r2);
  c2 = toInt(c2);
  const minR = Math.min(r1, r2),
    maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2),
    maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  return { minR, maxR, minC, maxC };
}

