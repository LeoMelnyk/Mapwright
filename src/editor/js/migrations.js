// Format versioning and migration registry for .mapwright save files.

import { migrateHalfTextures } from './io.js';

export const CURRENT_FORMAT_VERSION = 1;

// Migration registry: each entry upgrades from one version to the next.
// Migrations are applied in sequence: 0→1, 1→2, etc.
const migrations = [
  // v0 → v1: half-texture format migration (pre-existing logic from io.js)
  { from: 0, to: 1, migrate: (json) => migrateHalfTextures(json) },
];

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
