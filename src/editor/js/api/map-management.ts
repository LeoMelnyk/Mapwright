import {
  state, pushUndo, markDirty, notify, getApi,
  createEmptyDungeon, requestRender,
  collectTextureIds, ensureTexturesLoaded,
  migrateToLatest,
  CARDINAL_DIRS, OFFSETS, OPPOSITE, toDisp,
} from './_shared.js';

/**
 * Create a new empty map, replacing the current one.
 * @param {string} name - Map name
 * @param {number} rows - Number of rows
 * @param {number} cols - Number of columns
 * @param {number} [gridSize=5] - Grid size in feet
 * @param {string} [theme='stone-dungeon'] - Theme name
 * @returns {{ success: boolean }}
 */
export function newMap(name: string, rows: number, cols: number, gridSize: number = 5, theme: string = 'stone-dungeon'): { success: true } {
  pushUndo();
  state.dungeon = createEmptyDungeon(name, rows, cols, gridSize, theme);
  state.currentLevel = 0;
  state.selectedCells = [];
  markDirty();
  notify();
  return { success: true };
}

/**
 * Load a dungeon from a JSON object or string, replacing the current map.
 * @param {Object|string} json - Dungeon JSON data
 * @returns {{ success: boolean }}
 */
export function loadMap(json: any): { success: true } {
  if (typeof json === 'string') json = JSON.parse(json);
  if (!json.metadata || !json.cells) {
    throw new Error('Invalid dungeon JSON: missing metadata or cells');
  }
  pushUndo();
  state.dungeon = json;
  migrateToLatest(json);
  state.currentLevel = 0;
  state.selectedCells = [];
  markDirty();
  notify();

  const usedIds = collectTextureIds(json.cells);
  if (usedIds.size > 0) {
    ensureTexturesLoaded(usedIds).then(() => { requestRender(); });
  }

  return { success: true };
}

/**
 * Get a deep copy of the entire dungeon JSON.
 * @returns {{ success: boolean, dungeon: Object }}
 */
export function getMap(): { success: true; dungeon: any } {
  return { success: true, dungeon: JSON.parse(JSON.stringify(state.dungeon)) };
}

/**
 * Get a summary of the current map (dimensions, theme, feature flags, counts).
 * @returns {{ success: boolean, name: string, rows: number, cols: number, gridSize: number, theme: string, levels: Array, propCount: number, labelCount: number, lightCount: number }}
 */
export function getMapInfo(): any {
  const meta = state.dungeon.metadata;
  const cells = state.dungeon.cells;

  const propCount = meta.props ? meta.props.length : 0;
  let labelCount = 0;
  const textureIds = new Set();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      if (cell.center?.label != null) labelCount++;
      if (cell.texture?.id) textureIds.add(cell.texture.id);
    }
  }

  const res = meta.resolution || 1;
  return {
    success: true,
    name: meta.dungeonName,
    rows: toDisp(cells.length),
    cols: toDisp(cells[0]?.length || 0),
    gridSize: meta.gridSize * res, // display gridSize
    resolution: res,
    theme: typeof meta.theme === 'string' ? meta.theme : 'custom',
    labelStyle: meta.labelStyle || 'circled',
    features: { ...meta.features },
    levels: meta.levels ? meta.levels.map(l => ({
      ...l,
      startRow: toDisp(l.startRow),
      numRows: toDisp(l.numRows),
    })) : [],
    propCount,
    labelCount,
    textureIds: [...textureIds],
    lightCount: meta.lights?.length || 0,
    lightingEnabled: !!meta.lightingEnabled,
  };
}

/**
 * Get complete map info including rooms, props, doors, lights, stairs, and bridges.
 * @returns {{ success: boolean, rooms: Array, props: Array, doors: Array, lights: Array, stairs: Array, bridges: Array }}
 */
export function getFullMapInfo(): any {
  const base = getApi().getMapInfo();
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;

  const rooms = [];
  const seenLabels = new Set();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const label = cells[r]?.[c]?.center?.label;
      if (label != null && !seenLabels.has(String(label))) {
        seenLabels.add(String(label));
        const bounds = getApi().getRoomBounds(String(label));
        rooms.push({ label: String(label), labelRow: toDisp(r), labelCol: toDisp(c), bounds });
      }
    }
  }

  const props = [];
  const gs = meta.gridSize || 5;
  if (meta.props) {
    for (const op of meta.props) {
      props.push({ row: toDisp(Math.round(op.y / gs)), col: toDisp(Math.round(op.x / gs)), type: op.type, facing: op.rotation ?? 0, id: op.id });
    }
  }

  const doors = [];
  const seen = new Set();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        if (cell[dir] !== 'd' && cell[dir] !== 's') continue;
        const key = `${r},${c},${dir}`;
        const [dr, dc] = OFFSETS[dir];
        const recipKey = `${r + dr},${c + dc},${OPPOSITE[dir]}`;
        if (seen.has(recipKey)) continue;
        seen.add(key);
        doors.push({ row: toDisp(r), col: toDisp(c), direction: dir, type: cell[dir] });
      }
    }
  }

  return {
    success: true,
    ...base,
    rooms,
    props,
    doors,
    lights: meta.lights ? JSON.parse(JSON.stringify(meta.lights)) : [],
    stairs: meta.stairs ? JSON.parse(JSON.stringify(meta.stairs)) : [],
    bridges: meta.bridges ? JSON.parse(JSON.stringify(meta.bridges)) : [],
  };
}

/**
 * Set the dungeon name.
 * @param {string} name - New dungeon name
 * @returns {{ success: boolean }}
 */
export function setName(name: string): { success: true } {
  if (!name || typeof name !== 'string') {
    throw new Error('Name must be a non-empty string');
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
    throw new Error('Theme must be a non-empty string');
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
    throw new Error(`Invalid label style: ${style}. Use 'circled', 'plain', or 'bold'.`);
  }
  pushUndo();
  state.dungeon.metadata.labelStyle = style;
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
export function setFeature(feature: string, enabled: boolean): { success: true } {
  const validFeatures = ['grid', 'compass', 'scale', 'border'];
  if (!validFeatures.includes(feature)) {
    throw new Error(`Invalid feature: ${feature}. Use: ${validFeatures.join(', ')}`);
  }
  pushUndo();
  if (!state.dungeon.metadata.features) state.dungeon.metadata.features = {};
  state.dungeon.metadata.features[feature] = !!enabled;
  markDirty();
  notify();
  return { success: true };
}

