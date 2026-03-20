// Format versioning and migration registry for .mapwright save files.

import { migrateHalfTextures } from './io.js';

export const CURRENT_FORMAT_VERSION = 2;

// Migration registry: each entry upgrades from one version to the next.
// Migrations are applied in sequence: 0→1, 1→2, etc.
const migrations = [
  // v0 → v1: half-texture format migration (pre-existing logic from io.js)
  { from: 0, to: 1, migrate: (json) => migrateHalfTextures(json) },
  // v1 → v2: extract cell.prop entries into metadata.props[] overlay array
  { from: 1, to: 2, migrate: (json) => migratePropsToOverlay(json) },
];

/**
 * Extract all cell.prop entries into metadata.props[] overlay format.
 * Cell.prop entries are deleted after copying — the overlay is the sole source of truth.
 */
function migratePropsToOverlay(json) {
  if (!json.metadata) return;
  if (json.metadata.props) return; // already migrated

  json.metadata.props = [];
  if (!json.metadata.nextPropId) json.metadata.nextPropId = 1;
  const gridSize = json.metadata.gridSize || 5;

  for (let row = 0; row < json.cells.length; row++) {
    const rowArr = json.cells[row];
    if (!rowArr) continue;
    for (let col = 0; col < rowArr.length; col++) {
      const cell = rowArr[col];
      if (!cell?.prop) continue;

      json.metadata.props.push({
        id: `prop_${json.metadata.nextPropId++}`,
        type: cell.prop.type,
        x: col * gridSize,
        y: row * gridSize,
        rotation: cell.prop.facing || 0,
        scale: 1.0,
        zIndex: 10, // default "furniture" layer
        flipped: !!cell.prop.flipped,
      });

      delete cell.prop;
    }
  }
}

/**
 * Apply all necessary migrations to bring a dungeon JSON up to the current format version.
 * Modifies the json object in-place and returns it.
 * @param {object} json - Dungeon JSON with metadata and cells
 * @returns {object} The same json object, migrated
 */
export function migrateToLatest(json) {
  if (!json.metadata) return json;
  let version = json.metadata.formatVersion ?? 0;

  // Warn if file is from a newer version than we support
  if (version > CURRENT_FORMAT_VERSION) {
    console.warn(
      `[migrations] File format version ${version} is newer than supported version ${CURRENT_FORMAT_VERSION}. ` +
      `Some features may not work correctly. Consider updating mapwright.`
    );
    return json;
  }

  // Apply migrations in sequence
  for (const m of migrations) {
    if (version === m.from) {
      m.migrate(json);
      version = m.to;
      json.metadata.formatVersion = version;
    }
  }

  // Stamp current version if not yet set
  if (json.metadata.formatVersion == null) {
    json.metadata.formatVersion = CURRENT_FORMAT_VERSION;
  }

  return json;
}
