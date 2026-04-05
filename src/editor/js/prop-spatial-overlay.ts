// AABB-based spatial index for overlay props.
// Uses a bucket grid for fast spatial queries on metadata.props[].
// Also maintains a cell-grid map for backward compatibility with isPropAt(row, col).

import { getOverlayPropAABB } from './prop-overlay.js';

const DEFAULT_BUCKET_SIZE = 25; // world-feet per bucket (5 cells at gridSize=5)

export class PropSpatialIndex {
  [key: string]: any;
  constructor(bucketSize = DEFAULT_BUCKET_SIZE) {
    this._bucketSize = bucketSize;
    this._buckets = new Map();    // "bx,by" → Set<propId>
    this._propAABBs = new Map();  // propId → { minX, minY, maxX, maxY }
    this._propMap = new Map();    // propId → prop reference
    this._cellGrid = new Map();   // "row,col" → { propId, propType } (for backward compat)
    this._dirty = true;
    this._props = null;
    this._propCatalog = null;
    this._gridSize = 5;
  }

  /**
   * Full rebuild from metadata.props[].
   * @param {Array} props - metadata.props array
   * @param {object} propCatalog - { props: { [type]: PropDefinition } }
   * @param {number} gridSize
   */
  rebuild(props: any, propCatalog: any, gridSize: any) {
    this._buckets.clear();
    this._propAABBs.clear();
    this._propMap.clear();
    this._cellGrid.clear();
    this._props = props;
    this._propCatalog = propCatalog;
    this._gridSize = gridSize;

    if (!props || !propCatalog?.props) {
      this._dirty = false;
      return;
    }

    for (const prop of props) {
      this._insertInternal(prop);
    }

    this._dirty = false;
  }

  /**
   * Insert a single prop into the index.
   * @param {object} prop - overlay prop entry
   */
  _insertInternal(prop: any) {
    const propDef = this._propCatalog?.props?.[prop.type];
    if (!propDef) return;

    const aabb = getOverlayPropAABB(prop, propDef, this._gridSize);
    this._propAABBs.set(prop.id, aabb);
    this._propMap.set(prop.id, prop);

    // Insert into bucket grid
    const bMinX = Math.floor(aabb.minX / this._bucketSize);
    const bMinY = Math.floor(aabb.minY / this._bucketSize);
    const bMaxX = Math.floor(aabb.maxX / this._bucketSize);
    const bMaxY = Math.floor(aabb.maxY / this._bucketSize);

    for (let bx = bMinX; bx <= bMaxX; bx++) {
      for (let by = bMinY; by <= bMaxY; by++) {
        const key = `${bx},${by}`;
        let bucket = this._buckets.get(key);
        if (!bucket) {
          bucket = new Set();
          this._buckets.set(key, bucket);
        }
        bucket.add(prop.id);
      }
    }

    // Populate cell grid for backward compat (grid-aligned props only)
    const gridSize = this._gridSize;
    const rotation = prop.rotation ?? 0;
    const r = ((rotation % 360) + 360) % 360;
    if (r === 0 || r === 90 || r === 180 || r === 270) {
      const anchorRow = Math.round(prop.y / gridSize);
      const anchorCol = Math.round(prop.x / gridSize);
      const [fRows, fCols] = propDef.footprint;
      const spanRows = (r === 90 || r === 270) ? fCols : fRows;
      const spanCols = (r === 90 || r === 270) ? fRows : fCols;

      for (let dr = 0; dr < spanRows; dr++) {
        for (let dc = 0; dc < spanCols; dc++) {
          this._cellGrid.set(
            `${anchorRow + dr},${anchorCol + dc}`,
            { propId: prop.id, propType: prop.type, anchorRow, anchorCol }
          );
        }
      }
    }
  }

  /**
   * Mark the index as needing rebuild. Call on any prop mutation.
   */
  markDirty() {
    this._dirty = true;
  }

  /**
   * Ensure the index is built. Lazy rebuild on access if dirty.
   * @param {Array} props
   * @param {object} propCatalog
   * @param {number} gridSize
   */
  ensureBuilt(props: any, propCatalog: any, gridSize: any) {
    if (this._dirty || this._props !== props) {
      this.rebuild(props, propCatalog, gridSize);
    }
  }

  /**
   * Query all prop IDs whose AABB intersects the given rectangle.
   * @param {number} minX
   * @param {number} minY
   * @param {number} maxX
   * @param {number} maxY
   * @returns {string[]} array of prop IDs
   */
  query(minX: any, minY: any, maxX: any, maxY: any) {
    const results = new Set();
    const bMinX = Math.floor(minX / this._bucketSize);
    const bMinY = Math.floor(minY / this._bucketSize);
    const bMaxX = Math.floor(maxX / this._bucketSize);
    const bMaxY = Math.floor(maxY / this._bucketSize);

    for (let bx = bMinX; bx <= bMaxX; bx++) {
      for (let by = bMinY; by <= bMaxY; by++) {
        const bucket = this._buckets.get(`${bx},${by}`);
        if (!bucket) continue;
        for (const id of bucket) {
          if (results.has(id)) continue;
          const aabb = this._propAABBs.get(id);
          if (aabb && aabb.maxX > minX && aabb.minX < maxX && aabb.maxY > minY && aabb.minY < maxY) {
            results.add(id);
          }
        }
      }
    }

    return [...results];
  }

  /**
   * Query all prop IDs whose AABB contains the given point.
   * @param {number} x
   * @param {number} y
   * @returns {string[]} array of prop IDs (topmost last)
   */
  queryPoint(x: any, y: any) {
    return this.query(x, y, x, y);
  }

  /**
   * Get the prop reference by ID.
   * @param {string} propId
   * @returns {object|null}
   */
  getProp(propId: any) {
    return this._propMap.get(propId) ?? null;
  }

  /**
   * Get the AABB for a prop by ID.
   * @param {string} propId
   * @returns {{ minX, minY, maxX, maxY }|null}
   */
  getAABB(propId: any) {
    return this._propAABBs.get(propId) ?? null;
  }

  // ── Cell-grid backward compatibility ──────────────────────────────────────

  /**
   * Look up the prop covering (row, col) via the cell grid.
   * Returns { propId, propType, anchorRow, anchorCol } or null.
   */
  lookupPropAtCell(row: any, col: any) {
    return this._cellGrid.get(`${row},${col}`) ?? null;
  }

  /**
   * Check if (row, col) is covered by any prop. O(1).
   */
  isPropAtCell(row: any, col: any) {
    return this._cellGrid.has(`${row},${col}`);
  }

  /**
   * Find the overlay prop by matching grid position.
   * @param {number} row
   * @param {number} col
   * @param {number} gridSize
   * @returns {object|null} the overlay prop entry or null
   */
  findPropAtGrid(row: any, col: any, gridSize: any) {
    const x = col * gridSize;
    const y = row * gridSize;
    if (!this._props) return null;
    return this._props.find((p: any) =>
      Math.abs(p.x - x) < 0.01 && Math.abs(p.y - y) < 0.01
    ) ?? null;
  }
}
