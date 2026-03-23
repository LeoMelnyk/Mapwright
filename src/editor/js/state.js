// Central state store
import { THEMES, invalidateVisibilityCache } from '../../render/index.js';
import { createEmptyDungeon } from './utils.js';
import { markPropSpatialDirty } from './prop-spatial.js';

const MAX_UNDO = 100;

const state = {
  dungeon: createEmptyDungeon('New Dungeon', 20, 30),
  currentLevel: 0,
  selectedCells: [],
  activeTool: 'paint',
  roomMode: 'room',    // 'room' (wall boundaries) or 'merge' (only wall void edges)
  paintMode: 'texture',   // 'texture', 'syringe', 'room', 'clear-texture'
  fillMode: 'water',      // 'water', 'pit', 'difficult-terrain', 'clear-fill'
  waterDepth: 1,           // 1 (shallow), 2 (medium), 3 (deep)
  lavaDepth: 1,            // 1 (shallow), 2 (medium), 3 (deep)
  doorType: 'd',       // 'd' (normal) or 's' (secret)
  trimCorner: 'auto',  // 'auto', 'nw', 'ne', 'sw', 'se'
  trimRound: false,
  trimInverted: false,
  trimOpen: false,
  labelMode: 'room',    // 'room' (auto-increment room labels) or 'dm' (free-text DM labels)
  stairsMode: 'place',  // 'place' or 'link'
  stairPlacement: { p1: null, p2: null }, // in-progress 3-click placement points
  bridgeType: 'wood',   // 'wood', 'stone', 'rope', 'dock'
  selectedBridgeId: null, // ID of currently selected bridge
  linkSource: null,     // stair ID for pending link source
  hoveredCorner: null,  // { row, col } — nearest grid corner when stairs tool active
  selectMode: 'select', // 'select' or 'inspect'
  clipboard: null,      // { cells: [...], anchorRow, anchorCol } — copy/paste buffer
  pasteMode: false,     // true when Ctrl+V pressed — paste preview follows cursor
  propClipboard: null,  // { anchorRow, anchorCol, props: [{dRow, dCol, prop}] } — prop copy buffer
  propPasteMode: false, // true when Ctrl+V pressed with prop clipboard — paste preview follows cursor
  selectedProp: null,  // string — prop type name from catalog (e.g. 'pillar')
  propRotation: 0,     // 0, 90, 180, 270 — current placement rotation
  propFlipped: false,  // whether the next placed prop is horizontally mirrored
  propCatalog: null,   // PropCatalog object, loaded at init (runtime only, not serialized)
  selectedPropAnchors: [], // array of {row, col} for selected props in select mode (legacy)
  selectedPropIds: [],     // array of overlay prop IDs for selected props (new system)
  activeTexture: null,    // string — texture ID from catalog (e.g. 'cobblestone')
  textureOpacity: 1.0,    // 0–1 — opacity applied when painting a texture
  paintSecondary: false,  // when true, texture paints write to textureSecondary slot
  textureCatalog: null, // TextureCatalog object, loaded at init (runtime only, not serialized)
  texturesVersion: 0,   // incremented when texture images finish loading; invalidates blend cache
  lightCatalog: null,   // LightCatalog object, loaded at init (runtime only, not serialized)
  // Lighting tool state
  selectedLightId: null,     // ID of currently selected light
  lightClipboard: null,      // deep-cloned light object for copy/cut/paste
  lightPasteMode: false,     // true when pasting a light — preview follows cursor
  lightPreset: null,         // string — selected preset ID from catalog (e.g. 'torch')
  lightType: 'point',        // default placement type: 'point' or 'directional'
  lightRadius: 30,           // default radius in feet
  lightColor: '#ff9944',     // default warm color
  lightIntensity: 1.0,       // default intensity
  lightFalloff: 'smooth',    // default falloff curve
  lightAngle: 0,             // default directional angle (degrees)
  lightSpread: 45,           // default cone spread (degrees)
  lightDimRadius: 0,         // default dim radius (0 = disabled)
  lightAnimation: null,      // default animation ({type,speed,amplitude,radiusVariation} or null)
  animClock: 0,              // elapsed seconds — updated by animation loop in canvas-view.js
  lightCoverageMode: false,  // when true, coverage heatmap is rendered over the lightmap
  zoom: 1.0,
  panX: 60,
  panY: 60,
  hoveredCell: null,
  hoveredEdge: null,
  undoStack: [],
  redoStack: [],
  dirty: true,
  listeners: [],
  fileHandle: null,     // File System Access API handle for save-in-place
  fileName: null,       // Display name of the current file (e.g. 'my_dungeon.mapwright')
  unsavedChanges: false, // true when edits exist since last file save
  // Player session (runtime only, not serialized)
  session: { active: false, playerCount: 0 },
  sessionToolsActive: false,  // true when session toolbar is shown (session panel open + session active)
  statusInstruction: null,    // string or null — shown in #status-center when set
};

/**
 * Get the resolved theme object
 */
export function getTheme() {
  const t = state.dungeon.metadata.theme;
  if (typeof t === 'string') return THEMES[t] || THEMES['blue-parchment'];
  if (typeof t === 'object' && t !== null) return t;
  return THEMES['blue-parchment'];
}

/**
 * Push current dungeon state to undo stack.
 * @param {string} [label='Edit'] — description shown in the history panel.
 */
export function pushUndo(label = 'Edit') {
  const _t0 = performance.now();
  const json = JSON.stringify(state.dungeon);
  const _t1 = performance.now();
  state.undoStack.push({ json, label });
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack.length = 0;
  markPropSpatialDirty();
  const _t2 = performance.now();
  state._lastPushUndoMs = { stringify: _t1 - _t0, total: _t2 - _t0 };
}

/**
 * Undo last action
 */
export function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push({ json: JSON.stringify(state.dungeon), label: 'Current' });
  const entry = state.undoStack.pop();
  state.dungeon = JSON.parse(entry.json);
  markPropSpatialDirty();
  invalidateLightmap();
  markDirty();
  notify();
}

/**
 * Redo last undone action
 */
export function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push({ json: JSON.stringify(state.dungeon), label: 'Redo' });
  const entry = state.redoStack.pop();
  state.dungeon = JSON.parse(entry.json);
  markPropSpatialDirty();
  invalidateLightmap();
  markDirty();
  notify();
}

/**
 * Jump to a specific point in the undo stack.
 * Entries above targetIndex move to the redo stack.
 */
export function jumpToState(targetIndex) {
  if (targetIndex < 0 || targetIndex >= state.undoStack.length) return;
  // Push current state to redo
  state.redoStack.push({ json: JSON.stringify(state.dungeon), label: 'Current' });
  // Move entries above targetIndex to redo stack
  const toRedo = state.undoStack.splice(targetIndex + 1);
  for (const entry of toRedo) {
    state.redoStack.push(entry);
  }
  // Restore the target entry
  const entry = state.undoStack.pop();
  state.dungeon = JSON.parse(entry.json);
  markPropSpatialDirty();
  invalidateLightmap();
  markDirty();
  notify();
}

export function markDirty() {
  state.dirty = true;
  state.unsavedChanges = true;
}

/**
 * Invalidate the lighting visibility cache (call when walls change or on undo/redo).
 */
export function invalidateLightmap() {
  invalidateVisibilityCache();
}

export function clearDirty() {
  state.dirty = false;
}

export function subscribe(fn) {
  state.listeners.push(fn);
}

// ─── Auto-save ────────────────────────────────────────────────────────────

const AUTOSAVE_KEY = 'dungeon-editor-autosave';
let autosaveTimer = null;

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      const payload = JSON.stringify({
        dungeon: state.dungeon,
        currentLevel: state.currentLevel,
        activeTool: state.activeTool,
        zoom: state.zoom,
        panX: state.panX,
        panY: state.panY,
      });
      localStorage.setItem(AUTOSAVE_KEY, payload);
    } catch {
      // localStorage full or unavailable — silently ignore
    }
  }, 500);
}

export function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved.dungeon?.metadata || !saved.dungeon?.cells) return false;
    state.dungeon = saved.dungeon;
    state.currentLevel = saved.currentLevel || 0;
    state.activeTool = saved.activeTool || 'room';
    state.zoom = saved.zoom || 1.0;
    state.panX = saved.panX ?? 60;
    state.panY = saved.panY ?? 60;
    return true;
  } catch {
    return false;
  }
}

export function notify() {
  for (const fn of state.listeners) fn(state);
  scheduleAutosave();
}

export default state;
