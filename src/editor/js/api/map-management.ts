import type { Dungeon, LabelStyle } from '../../../types.js';
import {
  state,
  pushUndo,
  markDirty,
  notify,
  getApi,
  createEmptyDungeon,
  requestRender,
  collectTextureIds,
  ensureTexturesLoaded,
  migrateToLatest,
  CARDINAL_DIRS,
  OFFSETS,
  OPPOSITE,
  toDisp,
  ApiValidationError,
} from './_shared.js';
import { _clearCheckpoints } from './operational.js';

/**
 * Create a new empty map, replacing the current one.
 * @param {string} name - Map name
 * @param {number} rows - Number of rows
 * @param {number} cols - Number of columns
 * @param {number} [gridSize=5] - Grid size in feet
 * @param {string} [theme='stone-dungeon'] - Theme name
 * @returns {{ success: boolean }}
 */
export function newMap(
  name: string,
  rows: number,
  cols: number,
  gridSize: number = 5,
  theme: string = 'stone-dungeon',
): { success: true } {
  pushUndo();
  state.dungeon = createEmptyDungeon(name, rows, cols, gridSize, theme);
  state.currentLevel = 0;
  state.selectedCells = [];
  _clearCheckpoints();
  markDirty();
  notify();
  return { success: true };
}

/**
 * Load a dungeon from a JSON object or string, replacing the current map.
 * @param {Object|string} json - Dungeon JSON data
 * @returns {{ success: boolean }}
 */
export function loadMap(json: Record<string, unknown>): { success: true; info: Record<string, unknown> } {
  if (typeof json === 'string') json = JSON.parse(json);
  if (!json.metadata || !json.cells) {
    throw new ApiValidationError('INVALID_DUNGEON_JSON', 'Invalid dungeon JSON: missing metadata or cells', {
      hasMetadata: !!json.metadata,
      hasCells: !!json.cells,
    });
  }
  pushUndo();
  state.dungeon = json as unknown as Dungeon;
  migrateToLatest(json as Parameters<typeof migrateToLatest>[0]);
  state.currentLevel = 0;
  state.selectedCells = [];
  _clearCheckpoints();
  markDirty();
  notify();

  const usedIds = collectTextureIds(state.dungeon.cells);
  if (usedIds.size > 0) {
    void ensureTexturesLoaded(usedIds).then(() => {
      requestRender();
    });
  }

  // Return a getMapInfo-equivalent so callers don't need a second roundtrip.
  return { success: true, info: getApi().getMapInfo() as unknown as Record<string, unknown> };
}

/**
 * Get a deep copy of the entire dungeon JSON.
 * @returns {{ success: boolean, dungeon: Object }}
 */
export function getMap(): { success: true; dungeon: Record<string, unknown> } {
  return { success: true, dungeon: JSON.parse(JSON.stringify(state.dungeon)) };
}

/**
 * Get a summary of the current map (dimensions, theme, feature flags, counts).
 * @returns {{ success: boolean, name: string, rows: number, cols: number, gridSize: number, theme: string, levels: Array, propCount: number, labelCount: number, lightCount: number }}
 */
export function getMapInfo(): {
  rows: number;
  cols: number;
  gridSize: number;
  theme: string;
  name: string;
  [k: string]: unknown;
} {
  const meta = state.dungeon.metadata;
  const cells = state.dungeon.cells;

  const propCount = meta.props ? meta.props.length : 0;
  let labelCount = 0;
  const textureIds = new Set();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      if (cell.center?.label != null) labelCount++;
      if (cell.texture) textureIds.add(cell.texture);
    }
  }

  const res = meta.resolution || 1;
  return {
    success: true,
    name: meta.dungeonName,
    rows: toDisp(cells.length),
    cols: toDisp(cells[0]?.length ?? 0),
    gridSize: meta.gridSize * res, // display gridSize
    resolution: res,
    theme: typeof meta.theme === 'string' ? meta.theme : 'custom',
    labelStyle: meta.labelStyle,
    features: { ...meta.features },
    levels: meta.levels.map((l) => ({
      ...l,
      startRow: toDisp(l.startRow),
      numRows: toDisp(l.numRows),
    })),
    propCount,
    labelCount,
    textureIds: [...textureIds],
    lightCount: meta.lights.length,
    lightingEnabled: meta.lightingEnabled,
  };
}

/**
 * Get complete map info including rooms, props, doors, lights, stairs, and bridges.
 * @returns {{ success: boolean, rooms: Array, props: Array, doors: Array, lights: Array, stairs: Array, bridges: Array }}
 */
export function getFullMapInfo(): Record<string, unknown> {
  const base = getApi().getMapInfo();
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;

  const rooms = [];
  const seenLabels = new Set();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const label = cells[r]?.[c]?.center?.label;
      if (label != null && !seenLabels.has(label)) {
        seenLabels.add(label);
        const boundsResult = getApi().getRoomBounds(label);
        const bounds = boundsResult.success ? boundsResult : null;
        rooms.push({ label, labelRow: toDisp(r), labelCol: toDisp(c), bounds });
      }
    }
  }

  const props = [];
  const gs = meta.gridSize || 5;
  if (meta.props) {
    for (const op of meta.props) {
      props.push({
        row: toDisp(Math.round(op.y / gs)),
        col: toDisp(Math.round(op.x / gs)),
        type: op.type,
        facing: op.rotation,
        id: op.id,
      });
    }
  }

  const doors = [];
  const seen = new Set();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        if ((cell as Record<string, unknown>)[dir] !== 'd' && (cell as Record<string, unknown>)[dir] !== 's') continue;
        const key = `${r},${c},${dir}`;
        const [dr, dc] = OFFSETS[dir]!;
        const recipKey = `${r + dr},${c + dc},${OPPOSITE[dir as keyof typeof OPPOSITE]}`;
        if (seen.has(recipKey)) continue;
        seen.add(key);
        doors.push({ row: toDisp(r), col: toDisp(c), direction: dir, type: (cell as Record<string, unknown>)[dir] });
      }
    }
  }

  return {
    success: true,
    ...base,
    rooms,
    props,
    doors,
    lights: JSON.parse(JSON.stringify(meta.lights)),
    stairs: JSON.parse(JSON.stringify(meta.stairs)),
    bridges: JSON.parse(JSON.stringify(meta.bridges)),
  };
}

/**
 * Set the dungeon name.
 * @param {string} name - New dungeon name
 * @returns {{ success: boolean }}
 */
export function setName(name: string): { success: true } {
  if (!name || typeof name !== 'string') {
    throw new ApiValidationError('INVALID_NAME', 'Name must be a non-empty string', {
      received: name,
      type: typeof name,
    });
  }
  pushUndo();
  state.dungeon.metadata.dungeonName = name.trim();
  markDirty();
  notify();
  return { success: true };
}

/**
 * Set the map theme.
 * @param {string} theme - Theme name
 * @returns {{ success: boolean }}
 */
export function setTheme(theme: string): { success: true } {
  if (!theme || typeof theme !== 'string') {
    throw new ApiValidationError('INVALID_THEME', 'Theme must be a non-empty string', {
      received: theme,
      type: typeof theme,
    });
  }
  pushUndo();
  state.dungeon.metadata.theme = theme;
  markDirty();
  notify();
  return { success: true };
}

/**
 * Set the label rendering style.
 * @param {string} style - 'circled', 'plain', or 'bold'
 * @returns {{ success: boolean }}
 */
export function setLabelStyle(style: string): { success: true } {
  if (!['circled', 'plain', 'bold'].includes(style)) {
    throw new ApiValidationError(
      'INVALID_LABEL_STYLE',
      `Invalid label style: ${style}. Use 'circled', 'plain', or 'bold'.`,
      { style, validStyles: ['circled', 'plain', 'bold'] },
    );
  }
  pushUndo();
  state.dungeon.metadata.labelStyle = style as LabelStyle;
  markDirty();
  notify();
  return { success: true };
}

/**
 * Enable or disable a map display feature (grid, compass, scale, border).
 * @param {string} feature - Feature name
 * @param {boolean} enabled - Whether to enable the feature
 * @returns {{ success: boolean }}
 */
export function setFeature(feature: string, enabled: unknown): { success: true } {
  const validFeatures = ['grid', 'compass', 'scale', 'border'];
  if (!validFeatures.includes(feature)) {
    throw new ApiValidationError('INVALID_FEATURE', `Invalid feature: ${feature}. Use: ${validFeatures.join(', ')}`, {
      feature,
      validFeatures,
    });
  }
  pushUndo();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
  if (!state.dungeon.metadata.features)
    state.dungeon.metadata.features = { showGrid: false, compassRose: false, scale: false, border: false };
  (state.dungeon.metadata.features as unknown as Record<string, boolean>)[feature] = !!enabled;
  markDirty();
  notify();
  return { success: true };
}
