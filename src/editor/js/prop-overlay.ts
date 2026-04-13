import type { Metadata, OverlayProp, PropDefinition } from '../../types.js';
// Overlay prop data types and utilities for the free-form prop system.
// Props are stored in metadata.props[] as world-feet positioned overlays
// instead of cell-locked grid entries.

/**
 * Z-index presets for semantic layer ordering.
 * API accepts either preset strings or raw numbers.
 */
export const Z_PRESETS = {
  floor: 0,       // carpets, rugs, floor markings
  furniture: 10,  // tables, chairs, beds
  tall: 20,       // bookshelves, pillars, statues
  hanging: 30,    // chandeliers, banners, hanging cages
};

/**
 * Resolve a z-index value from either a preset name or raw number.
 * @param {string|number} z - Preset name (e.g. "furniture") or number
 * @returns {number}
 */
export function resolveZIndex(z: string | number): number {
  if (typeof z === 'string') {
    return (Z_PRESETS as Record<string, number>)[z] ?? Z_PRESETS.furniture;
  }
  return typeof z === 'number' ? z : Z_PRESETS.furniture;
}

/**
 * Generate the next prop ID from metadata and increment the counter.
 * @param {object} metadata - dungeon metadata (mutated: nextPropId incremented)
 * @returns {string} e.g. "prop_1", "prop_2"
 */
export function nextPropId(metadata: Metadata): string {
  metadata.nextPropId ??= 1;
  return `prop_${metadata.nextPropId++}`;
}

/**
 * Convert grid cell coordinates to world-feet (cell origin = top-left).
 * Matches existing render anchor: x = col * gridSize, y = row * gridSize.
 * @param {number} row
 * @param {number} col
 * @param {number} gridSize
 * @returns {{ x: number, y: number }}
 */
export function gridToWorldFeet(row: number, col: number, gridSize: number): { x: number; y: number } {
  return { x: col * gridSize, y: row * gridSize };
}

/**
 * Convert world-feet coordinates back to grid cell coordinates.
 * @param {number} x - world-feet x
 * @param {number} y - world-feet y
 * @param {number} gridSize
 * @returns {{ row: number, col: number }}
 */
export function worldFeetToGrid(x: number, y: number, gridSize: number): { row: number; col: number } {
  return { row: Math.floor(y / gridSize), col: Math.floor(x / gridSize) };
}

/**
 * Check if a rotation value is grid-aligned (0, 90, 180, 270).
 * @param {number} rotation - degrees
 * @returns {boolean}
 */
export function isGridAlignedRotation(rotation: number): boolean {
  const r = ((rotation % 360) + 360) % 360;
  return r === 0 || r === 90 || r === 180 || r === 270;
}

/**
 * Get the effective span (rows, cols) of a prop at a given rotation.
 * For grid-aligned rotations, 90/270 swap the footprint dimensions.
 * For arbitrary rotations, returns the AABB of the rotated footprint.
 * @param {object} propDef - PropDefinition with footprint [rows, cols]
 * @param {number} rotation - degrees
 * @returns {[number, number]} [effectiveRows, effectiveCols]
 */
export function effectiveSpan(propDef: PropDefinition, rotation: number): [number, number] {
  const [fRows, fCols] = propDef.footprint;
  if (isGridAlignedRotation(rotation)) {
    const r = ((rotation % 360) + 360) % 360;
    return (r === 90 || r === 270) ? [fCols, fRows] : [fRows, fCols];
  }
  // Arbitrary rotation: compute AABB of rotated rectangle
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return [
    fRows * cos + fCols * sin,
    fRows * sin + fCols * cos,
  ];
}

/**
 * Compute the axis-aligned bounding box of an overlay prop in world-feet.
 * Accounts for rotation and scale.
 * @param {object} prop - overlay prop entry { x, y, rotation, scale, type, flipped }
 * @param {object} propDef - PropDefinition from catalog
 * @param {number} gridSize
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function getOverlayPropAABB(prop: OverlayProp, propDef: PropDefinition, gridSize: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const scale = prop.scale;
  const [eRows, eCols] = effectiveSpan(propDef, prop.rotation);
  const w = eCols * gridSize * scale;
  const h = eRows * gridSize * scale;

  if (isGridAlignedRotation(prop.rotation)) {
    // Grid-aligned: AABB is simply the scaled footprint at the anchor position
    return {
      minX: prop.x,
      minY: prop.y,
      maxX: prop.x + w,
      maxY: prop.y + h,
    };
  }

  // Arbitrary rotation: the prop rotates around its center, so offset from center
  const [fRows, fCols] = propDef.footprint;
  const cx = prop.x + (fCols * gridSize * scale) / 2;
  const cy = prop.y + (fRows * gridSize * scale) / 2;
  return {
    minX: cx - w / 2,
    minY: cy - h / 2,
    maxX: cx + w / 2,
    maxY: cy + h / 2,
  };
}

/**
 * Create a new overlay prop entry from grid coordinates.
 * @param {object} metadata - dungeon metadata (mutated: nextPropId incremented)
 * @param {string} propType - prop catalog key
 * @param {number} row - grid row
 * @param {number} col - grid col
 * @param {number} gridSize
 * @param {object} [options] - { rotation, scale, zIndex, flipped }
 * @returns {object} PropOverlayEntry
 */
export function createOverlayProp(metadata: Metadata, propType: string, row: number, col: number, gridSize: number, options: { rotation?: number; scale?: number; zIndex?: string | number; flipped?: boolean } = {}): OverlayProp {
  const { x, y } = gridToWorldFeet(row, col, gridSize);
  return {
    id: nextPropId(metadata),
    type: propType,
    x,
    y,
    rotation: options.rotation ?? 0,
    scale: options.scale ?? 1.0,
    zIndex: resolveZIndex(options.zIndex ?? 'furniture'),
    flipped: options.flipped ?? false,
  };
}
