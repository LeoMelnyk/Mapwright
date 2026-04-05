// Central state store
import type { Dungeon, UndoEntry } from '../../types.js';
import { THEMES, invalidateVisibilityCache } from '../../render/index.js';
import { createEmptyDungeon } from './utils.js';
import { markPropSpatialDirty } from './prop-spatial.js';

const MAX_UNDO = 100;

const state: {
  dungeon: Dungeon;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  listeners: { fn: (s: any) => void; label: string }[];
  [key: string]: any;
} = {
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
  propScale: 1.0,      // scale for next placed prop
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
  debugShowHitboxes: false,  // when true, render prop hitbox outlines on the canvas
};

/**
 * Get the resolved theme object for the current dungeon.
 * @returns {Object} The active theme configuration.
 */
export function getTheme(): Record<string, unknown> {
  const t = state.dungeon.metadata.theme;
  if (typeof t === 'string') {
    if (THEMES[t]) return THEMES[t];
    // Fallback: user theme not installed locally — use embedded data
    if (t.startsWith('user:') && state.dungeon.metadata.savedThemeData?.theme) {
      return state.dungeon.metadata.savedThemeData.theme;
    }
    return THEMES['blue-parchment'];
  }
  if (typeof t === 'object' && t !== null) return t;
  return THEMES['blue-parchment'];
}

/** Set to true to skip all undo stack pushes (for testing). */
export let undoDisabled = false;
/**
 * Enable or disable the undo stack (for testing).
 * @param {boolean} v - Whether to disable undo.
 * @returns {void}
 */
export function setUndoDisabled(v: boolean): void { undoDisabled = v; }

/**
 * Push current dungeon state onto the undo stack.
 * @param {string} [label='Edit'] - Description shown in the history panel.
 * @param {string|null} [preSerializedJson=null] - Pre-serialized JSON to avoid double-serialization.
 * @returns {void}
 */
export function pushUndo(label: string = 'Edit', preSerializedJson: string | null = null): void {
  if (undoDisabled) return;
  const _t0 = performance.now();
  const json = preSerializedJson || JSON.stringify(state.dungeon);
  const _t1 = performance.now();
  state.undoStack.push({ json, label });
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack.length = 0;
  markPropSpatialDirty();
  const _t2 = performance.now();
  state._lastPushUndoMs = { stringify: _t1 - _t0, total: _t2 - _t0 };
}

/**
 * Undo the last action by restoring the previous dungeon state.
 * @returns {void}
 */
export function undo(): void {
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
 * Redo the last undone action.
 * @returns {void}
 */
export function redo(): void {
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
 * Jump to a specific point in the undo stack. Entries above targetIndex move to redo.
 * @param {number} targetIndex - Index in the undo stack to restore.
 * @returns {void}
 */
export function jumpToState(targetIndex: number): void {
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

/**
 * Mark the dungeon state as dirty (needs re-render and has unsaved changes).
 * @returns {void}
 */
export function markDirty(): void {
  state.dirty = true;
  state.unsavedChanges = true;
}

/**
 * Invalidate the lighting visibility cache (call when walls change or on undo/redo).
 * @param {boolean|'props'} [structuralChange=true] - Pass false for light-only changes,
 *   'props' to clear prop shadow zones but keep cached wall segments.
 * @returns {void}
 */
export function invalidateLightmap(structuralChange: boolean | 'props' = true): void {
  invalidateVisibilityCache(structuralChange);
}

/**
 * Clear the dirty flag (called after a render pass).
 * @returns {void}
 */
export function clearDirty(): void {
  state.dirty = false;
}

/**
 * Subscribe to state change notifications.
 * @param {Function} fn - Callback invoked with the state object on each notify().
 * @param {string} [label] - Debug label for timing diagnostics.
 * @returns {void}
 */
export function subscribe(fn: (state: any) => void, label?: string): void {
  state.listeners.push({ fn, label: label || 'unknown' });
}

/** Latest per-subscriber timing data from the most recent notify() call. */
export const notifyTimings = { total: 0, subscribers: [], frame: 0 };
let _notifyFrame = 0;

// ─── Auto-save ────────────────────────────────────────────────────────────

// ── Autosave via IndexedDB (async, no main-thread blocking) ──────────────
const AUTOSAVE_DB = 'mapwright-autosave';
const AUTOSAVE_STORE = 'state';
const AUTOSAVE_KEY = 'current';
const AUTOSAVE_LEGACY_KEY = 'dungeon-editor-autosave';
let autosaveTimer = null;
let _autosaveDb = null;

function _openDb() {
  return new Promise((resolve, reject) => {
    if (_autosaveDb) { resolve(_autosaveDb); return; }
    const req = indexedDB.open(AUTOSAVE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(AUTOSAVE_STORE);
    };
    req.onsuccess = () => {
      _autosaveDb = req.result;
      resolve(_autosaveDb);
    };
    req.onerror = () => reject(req.error);
  });
}

// Initialize DB early so it's ready when first autosave fires
if (typeof indexedDB !== 'undefined') {
  _openDb().catch(() => { /* IndexedDB unavailable — fallback to localStorage */ });
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    const data = {
      dungeon: state.dungeon,
      currentLevel: state.currentLevel,
      activeTool: state.activeTool,
      zoom: state.zoom,
      panX: state.panX,
      panY: state.panY,
    };
    try {
      const db = await _openDb();
      const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
      tx.objectStore(AUTOSAVE_STORE).put(data, AUTOSAVE_KEY);
      // tx completes async — no main thread blocking
    } catch {
      // IndexedDB failed — fall back to localStorage (blocking but rare)
      try { localStorage.setItem(AUTOSAVE_LEGACY_KEY, JSON.stringify(data)); } catch {}
    }
  }, 1000);
}

/**
 * Load the autosaved dungeon state from IndexedDB (or localStorage fallback).
 * @returns {Promise<boolean>} True if a valid autosave was restored.
 */
export async function loadAutosave(): Promise<boolean> {
  // Try IndexedDB first
  try {
    const db = await _openDb();
    const tx = db.transaction(AUTOSAVE_STORE, 'readonly');
    const saved = await new Promise((resolve, reject) => {
      const req = tx.objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (saved?.dungeon?.metadata && saved?.dungeon?.cells) {
      state.dungeon = saved.dungeon;
      state.currentLevel = saved.currentLevel || 0;
      state.activeTool = saved.activeTool || 'room';
      state.zoom = saved.zoom || 1.0;
      state.panX = saved.panX ?? 60;
      state.panY = saved.panY ?? 60;
      return true;
    }
  } catch {}

  // Fall back to legacy localStorage
  try {
    const raw = localStorage.getItem(AUTOSAVE_LEGACY_KEY);
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

/**
 * Notify all subscribers of a state change and schedule autosave.
 * @returns {void}
 */
export function notify(): void {
  const t0 = performance.now();
  _notifyFrame++;
  const subs = [];
  for (const entry of state.listeners) {
    const s = performance.now();
    entry.fn(state);
    subs.push({ label: entry.label, ms: performance.now() - s });
  }
  notifyTimings.total = performance.now() - t0;
  notifyTimings.subscribers = subs;
  notifyTimings.frame = _notifyFrame;
  scheduleAutosave();
}

export default state;
