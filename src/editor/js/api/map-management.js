import {
  state, pushUndo, markDirty, notify, getApi,
  createEmptyDungeon, requestRender,
  collectTextureIds, ensureTexturesLoaded,
  migrateToLatest,
  CARDINAL_DIRS, OFFSETS, OPPOSITE,
} from './_shared.js';

export function newMap(name, rows, cols, gridSize = 5, theme = 'stone-dungeon') {
  pushUndo();
  state.dungeon = createEmptyDungeon(name, rows, cols, gridSize, theme);
  state.currentLevel = 0;
  state.selectedCells = [];
  markDirty();
  notify();
  return { success: true };
}

export function loadMap(json) {
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

export function getMap() {
  return { success: true, dungeon: JSON.parse(JSON.stringify(state.dungeon)) };
}

export function getMapInfo() {
  const meta = state.dungeon.metadata;
  const cells = state.dungeon.cells;

  let propCount = 0, labelCount = 0;
  const textureIds = new Set();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      if (cell.prop) propCount++;
      if (cell.center?.label != null) labelCount++;
      if (cell.texture?.id) textureIds.add(cell.texture.id);
    }
  }

  return {
    success: true,
    name: meta.dungeonName,
    rows: cells.length,
    cols: cells[0]?.length || 0,
    gridSize: meta.gridSize,
    theme: typeof meta.theme === 'string' ? meta.theme : 'custom',
    labelStyle: meta.labelStyle || 'circled',
    features: { ...meta.features },
    levels: meta.levels ? [...meta.levels] : [],
    propCount,
    labelCount,
    textureIds: [...textureIds],
    lightCount: meta.lights?.length || 0,
    lightingEnabled: !!meta.lightingEnabled,
  };
}

export function getFullMapInfo() {
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
        rooms.push({ label: String(label), labelRow: r, labelCol: c, bounds });
      }
    }
  }

  const props = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const prop = cells[r]?.[c]?.prop;
      if (prop) props.push({ row: r, col: c, type: prop.type, facing: prop.facing, span: [...prop.span] });
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
        doors.push({ row: r, col: c, direction: dir, type: cell[dir] });
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

export function setName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Name must be a non-empty string');
  }
  pushUndo();
  state.dungeon.metadata.dungeonName = name.trim();
  markDirty();
  notify();
  return { success: true };
}

export function setTheme(theme) {
  if (!theme || typeof theme !== 'string') {
    throw new Error('Theme must be a non-empty string');
  }
  pushUndo();
  state.dungeon.metadata.theme = theme;
  markDirty();
  notify();
  return { success: true };
}

export function setLabelStyle(style) {
  if (!['circled', 'plain', 'bold'].includes(style)) {
    throw new Error(`Invalid label style: ${style}. Use 'circled', 'plain', or 'bold'.`);
  }
  pushUndo();
  state.dungeon.metadata.labelStyle = style;
  markDirty();
  notify();
  return { success: true };
}

export function setFeature(feature, enabled) {
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

