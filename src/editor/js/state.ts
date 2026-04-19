// Central state store
import type { Dungeon, EditorState, Theme, CellGrid, Cell, UndoCellPatch, UndoMetaPatch } from '../../types.js';

interface AutosaveData {
  dungeon: Dungeon;
  currentLevel: number;
  activeTool: string;
  zoom: number;
  panX: number;
  panY: number;
}
import {
  THEMES,
  invalidateVisibilityCache,
  captureBeforeState,
  smartInvalidate,
  normalizeTheme as normalizeRenderTheme,
} from '../../render/index.js';
import { createEmptyDungeon } from './utils.js';
import { markPropSpatialDirty } from './prop-spatial.js';
import { log } from '../../util/index.js';

// ── Notify topics ─────────────────────────────────────────────────────────
export type NotifyTopic = 'cells' | 'metadata' | 'lighting' | 'props' | 'viewport' | 'ui';

// ── Invalidation flags for mutate() ─────────────────────────────────────
export type InvalidateFlag = 'geometry' | 'lighting' | 'lighting:props' | 'fluid' | 'props';

const MAX_UNDO = 100;
/** Every Nth undo entry is stored as a full JSON keyframe for bounded undo cost. */
const KEYFRAME_INTERVAL = 10;

const state: EditorState = {
  dungeon: createEmptyDungeon('New Dungeon', 20, 30),
  currentLevel: 0,
  selectedCells: [],
  activeTool: 'paint',
  roomMode: 'room', // 'room' (wall boundaries) or 'merge' (only wall void edges)
  paintMode: 'texture', // 'texture', 'syringe', 'room', 'clear-texture'
  fillMode: 'water', // 'water', 'pit', 'difficult-terrain', 'clear-fill'
  waterDepth: 1, // 1 (shallow), 2 (medium), 3 (deep)
  lavaDepth: 1, // 1 (shallow), 2 (medium), 3 (deep)
  doorType: 'd', // 'd' (normal) or 's' (secret)
  wallType: 'w', // 'w' (wall) or 'iw' (invisible wall)
  trimCorner: 'auto', // 'auto', 'nw', 'ne', 'sw', 'se'
  trimRound: false,
  trimInverted: false,
  trimOpen: false,
  labelMode: 'room', // 'room' (auto-increment room labels) or 'dm' (free-text DM labels)
  stairsMode: 'place', // 'place' or 'link'
  stairPlacement: { p1: null, p2: null }, // in-progress 3-click placement points
  bridgeType: 'wood', // 'wood', 'stone', 'rope', 'dock'
  selectedBridgeId: null, // ID of currently selected bridge
  linkSource: null, // stair ID for pending link source
  hoveredCorner: null, // { row, col } — nearest grid corner when stairs tool active
  selectMode: 'select', // 'select' or 'inspect'
  clipboard: null, // { cells: [...], anchorRow, anchorCol } — copy/paste buffer
  pasteMode: false, // true when Ctrl+V pressed — paste preview follows cursor
  propClipboard: null, // { anchorRow, anchorCol, props: [{dRow, dCol, prop}] } — prop copy buffer
  propPasteMode: false, // true when Ctrl+V pressed with prop clipboard — paste preview follows cursor
  selectedProp: null, // string — prop type name from catalog (e.g. 'pillar')
  propRotation: 0, // 0, 90, 180, 270 — current placement rotation
  propFlipped: false, // whether the next placed prop is horizontally mirrored
  propScale: 1.0, // scale for next placed prop
  propRandomRotation: false, // when true, stamp placement uses a random rotation (multiple of 15°)
  propRandomScale: false, // when true, stamp placement uses a random scale (0.8–3.0 in 0.05 steps)
  propCatalog: null, // PropCatalog object, loaded at init (runtime only, not serialized)
  selectedPropAnchors: [], // array of {row, col} for selected props in select mode (legacy)
  selectedPropIds: [], // array of overlay prop IDs for selected props (new system)
  activeTexture: null, // string — texture ID from catalog (e.g. 'cobblestone')
  textureOpacity: 1.0, // 0–1 — opacity applied when painting a texture
  paintSecondary: false, // when true, texture paints write to textureSecondary slot
  textureCatalog: null, // TextureCatalog object, loaded at init (runtime only, not serialized)
  texturesVersion: 0, // incremented when texture images finish loading; invalidates blend cache
  lightCatalog: null, // LightCatalog object, loaded at init (runtime only, not serialized)
  // Lighting tool state
  selectedLightId: null, // ID of currently selected light
  lightClipboard: null, // deep-cloned light object for copy/cut/paste
  lightPasteMode: false, // true when pasting a light — preview follows cursor
  lightPreset: null, // string — selected preset ID from catalog (e.g. 'torch')
  lightType: 'point', // default placement type: 'point' or 'directional'
  lightRadius: 30, // default radius in feet
  lightColor: '#ff9944', // default warm color
  lightIntensity: 1.0, // default intensity
  lightFalloff: 'smooth', // default falloff curve
  lightAngle: 0, // default directional angle (degrees)
  lightSpread: 45, // default cone spread (degrees)
  lightDimRadius: 0, // default dim radius (0 = disabled)
  lightAnimation: null, // default animation ({type,speed,amplitude,radiusVariation} or null)
  lightZ: 0, // default Z height for lights
  animClock: 0, // elapsed seconds — updated by animation loop in canvas-view.js
  lightCoverageMode: false, // when true, coverage heatmap is rendered over the lightmap
  zoom: 1.0,
  panX: 60,
  panY: 60,
  hoveredCell: null,
  hoveredEdge: null,
  undoStack: [],
  redoStack: [],
  dirty: true,
  listeners: [],
  fileHandle: null, // File System Access API handle for save-in-place
  fileName: null, // Display name of the current file (e.g. 'my_dungeon.mapwright')
  unsavedChanges: false, // true when edits exist since last file save
  // Player session (runtime only, not serialized)
  session: { active: false, playerCount: 0 },
  sessionToolsActive: false, // true when session toolbar is shown (session panel open + session active)
  statusInstruction: null, // string or null — shown in #status-center when set
  debugShowHitboxes: false, // when true, render prop hitbox outlines on the canvas
  debugShowSelectionBoxes: false, // when true, render prop selection boxes for every placed prop
  _lastPushUndoMs: null,
};

// Cache normalized themes by raw theme reference. Normalization is idempotent
// and pure, so the cached object is safe to reuse across frames; this also
// preserves reference stability for downstream caches that key on theme.
const _normalizedThemeCache = new WeakMap<Theme, Theme>();
let _lastRawThemeSeen: Theme | null = null;
function _resolveAndNormalize(rawTheme: Theme): Theme {
  if (rawTheme !== _lastRawThemeSeen) {
    log.devTrace(`getTheme: raw theme ref changed`, {
      prev: _lastRawThemeSeen,
      next: rawTheme,
      sameJson: JSON.stringify(_lastRawThemeSeen) === JSON.stringify(rawTheme),
    });
    _lastRawThemeSeen = rawTheme;
  }
  let cached = _normalizedThemeCache.get(rawTheme);
  if (!cached) {
    cached = normalizeRenderTheme(rawTheme);
    _normalizedThemeCache.set(rawTheme, cached);
  }
  return cached;
}

/**
 * Evict the cached normalized theme for the current raw theme object.
 * Call this after mutating theme properties in-place (e.g. theme panel sliders)
 * so the next getTheme() call re-normalizes with the updated values.
 */
export function invalidateThemeCache(): void {
  const t = state.dungeon.metadata.theme;
  if (typeof t === 'object') {
    _normalizedThemeCache.delete(t);
  }
}

/**
 * Get the resolved, normalized theme object for the current dungeon.
 * Downstream renderers can read theme color keys directly without
 * `?? defaults` fallbacks — see render/compile.ts:normalizeTheme.
 * @returns {Object} The active theme configuration.
 */
export function getTheme(): Theme {
  const t = state.dungeon.metadata.theme;
  let raw: Theme | undefined;
  if (typeof t === 'string') {
    if (THEMES[t]) {
      raw = THEMES[t]!;
    } else if (t.startsWith('user:') && state.dungeon.metadata.savedThemeData?.theme) {
      raw = state.dungeon.metadata.savedThemeData.theme as Theme;
    } else {
      raw = THEMES['blue-parchment'];
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (typeof t === 'object' && t !== null) {
    raw = t;
  } else {
    raw = THEMES['blue-parchment'];
  }
  // Theme catalog loads asynchronously; a render can fire before THEMES is
  // populated. normalizeTheme fills in every color key, so `{}` is safe.
  return _resolveAndNormalize(raw ?? ({} as Theme));
}

/** Set to true to skip all undo stack pushes (for testing). */
export let undoDisabled = false;
/**
 * Enable or disable the undo stack (for testing).
 * @param {boolean} v - Whether to disable undo.
 * @returns {void}
 */
export function setUndoDisabled(v: boolean): void {
  undoDisabled = v;
}

/**
 * Push current dungeon state onto the undo stack.
 * @param {string} [label='Edit'] - Description shown in the history panel.
 * @param {string|null} [preSerializedJson=null] - Pre-serialized JSON to avoid double-serialization.
 * @returns {void}
 */
export function pushUndo(label: string = 'Edit', preSerializedJson: string | null = null): void {
  if (undoDisabled) return;
  const _t0 = performance.now();
  const json = preSerializedJson ?? JSON.stringify(state.dungeon);
  const _t1 = performance.now();
  state.undoStack.push({ json, label, timestamp: Date.now() });
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack.length = 0;
  markPropSpatialDirty();
  const _t2 = performance.now();
  state._lastPushUndoMs = { stringify: _t1 - _t0, total: _t2 - _t0 };
}

/**
 * Push a compact cell-patch undo entry (no full JSON serialization).
 * Used by tools that accumulate changes over a drag and want to push one entry at the end.
 * @param label - Description shown in the history panel.
 * @param cellPatches - Array of { row, col, before, after } for each changed cell.
 */
export function pushPatchUndo(label: string, cellPatches: UndoCellPatch[]): void {
  if (undoDisabled) return;
  const metaBefore = JSON.stringify(state.dungeon.metadata);
  const patchEntry = { cells: cellPatches, meta: null as UndoMetaPatch | null };
  // Check for metadata changes (e.g. wall tool doesn't change metadata, but future callers might)
  const metaAfter = JSON.stringify(state.dungeon.metadata);
  if (metaBefore !== metaAfter) {
    patchEntry.meta = { before: metaBefore, after: metaAfter };
  }
  state.undoStack.push({ patch: patchEntry, label, timestamp: Date.now() });
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack.length = 0;
  markPropSpatialDirty();
}

/**
 * Restore dungeon state from an undo/redo entry.
 * Handles both full JSON snapshots and compact cell patches.
 */
function applyEntry(
  entry: { json?: string; patch?: { cells: UndoCellPatch[]; meta: UndoMetaPatch | null } },
  direction: 'undo' | 'redo',
): void {
  if (entry.json) {
    // Full snapshot — replace entire dungeon
    state.dungeon = JSON.parse(entry.json);
  } else if (entry.patch) {
    // Compact patch — apply cell changes
    const cells = state.dungeon.cells;
    for (const cp of entry.patch.cells) {
      const value = direction === 'undo' ? cp.before : cp.after;
      if (cells[cp.row]) {
        cells[cp.row]![cp.col] = value ? JSON.parse(JSON.stringify(value)) : null;
      }
    }
    // Apply metadata changes
    if (entry.patch.meta) {
      const restored = direction === 'undo' ? entry.patch.meta.before : entry.patch.meta.after;
      Object.assign(state.dungeon.metadata, JSON.parse(restored));
    }
  }
}

/**
 * Create a redo entry that captures the inverse of what was just applied.
 * For patch entries, swap before/after. For snapshots, serialize current state.
 */
function createRedoEntry(
  appliedEntry: { json?: string; patch?: { cells: UndoCellPatch[]; meta: UndoMetaPatch | null } },
  label: string,
): typeof appliedEntry & { label: string; timestamp: number } {
  if (appliedEntry.patch) {
    // Swap before/after for the reverse direction
    return {
      patch: {
        cells: appliedEntry.patch.cells.map((cp) => ({ row: cp.row, col: cp.col, before: cp.after, after: cp.before })),
        meta: appliedEntry.patch.meta
          ? { before: appliedEntry.patch.meta.after, after: appliedEntry.patch.meta.before }
          : null,
      },
      label,
      timestamp: Date.now(),
    };
  }
  return { json: JSON.stringify(state.dungeon), label, timestamp: Date.now() };
}

/**
 * Diff two cell grids to find which cells changed.
 * Returns coords of changed cells, or null if too many changed (>30%) or dimensions differ.
 */
function diffCellsForUndo(oldCells: CellGrid, newCells: CellGrid): Array<{ row: number; col: number }> | null {
  if (oldCells.length !== newCells.length) return null;
  const rows = oldCells.length;
  const cols = oldCells[0]?.length ?? 0;
  if (cols !== (newCells[0]?.length ?? 0)) return null;

  const changed: Array<{ row: number; col: number }> = [];
  const maxChanged = Math.ceil(rows * cols * 0.3);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const oldCell = oldCells[r]![c];
      const newCell = newCells[r]![c];
      if (oldCell === newCell) continue; // both null
      if (!oldCell || !newCell || JSON.stringify(oldCell) !== JSON.stringify(newCell)) {
        changed.push({ row: r, col: c });
        if (changed.length > maxChanged) return null; // too many changes, full rebuild
      }
    }
  }
  return changed;
}

/**
 * Undo the last action by restoring the previous dungeon state.
 */
export function undo(): void {
  if (!state.undoStack.length) return;
  const entry = state.undoStack.pop()!;
  state.redoStack.push(createRedoEntry(entry, 'Current'));

  if (entry.patch) {
    // Patch entry — we know exact cells. Use smart invalidation for partial rebuild.
    const cells = state.dungeon.cells;
    const coords = entry.patch.cells.map((cp) => ({ row: cp.row, col: cp.col }));
    const beforeState = coords.length > 0 ? captureBeforeState(cells, coords) : [];
    applyEntry(entry, 'undo');
    if (beforeState.length > 0) {
      smartInvalidate(beforeState, state.dungeon.cells);
    }
    // Always invalidate lightmap — cell changes (walls, doors) affect shadow casting
    invalidateLightmap();
  } else {
    // JSON snapshot — diff old vs new to find changed cells for partial rebuild
    const oldCells = state.dungeon.cells;
    applyEntry(entry, 'undo');
    const changedCoords = diffCellsForUndo(oldCells, state.dungeon.cells);
    if (changedCoords && changedCoords.length > 0) {
      // Compute before-state from the OLD cells (pre-undo) for the changed coordinates
      const beforeState = changedCoords.map(({ row, col }) => {
        const cell = oldCells[row]?.[col];
        if (!cell)
          return {
            row,
            col,
            wasVoid: true,
            fill: null,
            waterDepth: null,
            lavaDepth: null,
            hazard: false,
            texture: null,
            textureSecondary: null,
          };
        return {
          row,
          col,
          wasVoid: false,
          fill: (cell.fill as string | null) ?? null,
          waterDepth: (cell.waterDepth as number | null) ?? null,
          lavaDepth: (cell.lavaDepth as number | null) ?? null,
          hazard: !!cell.hazard,
          texture: (cell.texture as string | null) ?? null,
          textureSecondary: (cell.textureSecondary as string | null) ?? null,
        };
      });
      smartInvalidate(beforeState, state.dungeon.cells);
    }
    invalidateLightmap();
  }

  markPropSpatialDirty();
  markDirty();
  notify();
}

/**
 * Redo the last undone action.
 */
export function redo(): void {
  if (!state.redoStack.length) return;
  const entry = state.redoStack.pop()!;
  state.undoStack.push(createRedoEntry(entry, 'Redo'));

  if (entry.patch) {
    // Patch entry — use smart invalidation for partial rebuild
    const cells = state.dungeon.cells;
    const coords = entry.patch.cells.map((cp) => ({ row: cp.row, col: cp.col }));
    const beforeState = coords.length > 0 ? captureBeforeState(cells, coords) : [];
    applyEntry(entry, 'redo');
    if (beforeState.length > 0) {
      smartInvalidate(beforeState, state.dungeon.cells);
    }
    // Always invalidate lightmap — cell changes (walls, doors) affect shadow casting
    invalidateLightmap();
  } else {
    // JSON snapshot — diff old vs new for partial rebuild
    const oldCells = state.dungeon.cells;
    applyEntry(entry, 'redo');
    const changedCoords = diffCellsForUndo(oldCells, state.dungeon.cells);
    if (changedCoords && changedCoords.length > 0) {
      const beforeState = changedCoords.map(({ row, col }) => {
        const cell = oldCells[row]?.[col];
        if (!cell)
          return {
            row,
            col,
            wasVoid: true,
            fill: null,
            waterDepth: null,
            lavaDepth: null,
            hazard: false,
            texture: null,
            textureSecondary: null,
          };
        return {
          row,
          col,
          wasVoid: false,
          fill: (cell.fill as string | null) ?? null,
          waterDepth: (cell.waterDepth as number | null) ?? null,
          lavaDepth: (cell.lavaDepth as number | null) ?? null,
          hazard: !!cell.hazard,
          texture: (cell.texture as string | null) ?? null,
          textureSecondary: (cell.textureSecondary as string | null) ?? null,
        };
      });
      smartInvalidate(beforeState, state.dungeon.cells);
    }
    invalidateLightmap();
  }

  markPropSpatialDirty();
  markDirty();
  notify();
}

/**
 * Jump to a specific point in the undo stack. Entries above targetIndex move to redo.
 * For mixed patch/snapshot stacks, this rebuilds from the nearest keyframe.
 * @param {number} targetIndex - Index in the undo stack to restore.
 */
export function jumpToState(targetIndex: number): void {
  if (targetIndex < 0 || targetIndex >= state.undoStack.length) return;
  // Push current state to redo as a full snapshot (jumpToState is rare, simplicity wins)
  state.redoStack.push({ json: JSON.stringify(state.dungeon), label: 'Current', timestamp: Date.now() });
  // Move entries above targetIndex to redo stack
  const toRedo = state.undoStack.splice(targetIndex + 1);
  for (const entry of toRedo) {
    state.redoStack.push(entry);
  }
  // Restore the target entry
  const entry = state.undoStack.pop()!;
  if (entry.json) {
    state.dungeon = JSON.parse(entry.json);
  } else {
    // Patch entry — need to find the nearest keyframe and replay
    // For simplicity, serialize current state and apply patches backwards
    // from current position to target. Since jumpToState is rare (UI only),
    // this is acceptable.
    applyEntry(entry, 'undo');
  }
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
 * @param fn - Callback invoked with the state object on each notify().
 * @param labelOrOpts - Debug label string, or options with label and topic filter.
 */
export function subscribe(
  fn: (state: EditorState) => void,
  labelOrOpts?: string | { label?: string; topics?: NotifyTopic[] },
): void {
  const opts = typeof labelOrOpts === 'string' ? { label: labelOrOpts } : (labelOrOpts ?? {});
  state.listeners.push({
    fn,
    label: opts.label ?? 'unknown',
    topics: opts.topics,
  });
}

/** Latest per-subscriber timing data from the most recent notify() call. */
export const notifyTimings: { total: number; subscribers: { label: string; ms: number }[]; frame: number } = {
  total: 0,
  subscribers: [],
  frame: 0,
};
let _notifyFrame = 0;

// ─── Auto-save ────────────────────────────────────────────────────────────

// ── Autosave via IndexedDB (async, no main-thread blocking) ──────────────
const AUTOSAVE_DB = 'mapwright-autosave';
const AUTOSAVE_STORE = 'state';
const AUTOSAVE_KEY = 'current';
const AUTOSAVE_LEGACY_KEY = 'dungeon-editor-autosave';
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let _autosaveDb: IDBDatabase | null = null;

function _openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (_autosaveDb) {
      resolve(_autosaveDb);
      return;
    }
    const req = indexedDB.open(AUTOSAVE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(AUTOSAVE_STORE);
    };
    req.onsuccess = () => {
      _autosaveDb = req.result;
      resolve(_autosaveDb);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// Initialize DB early so it's ready when first autosave fires
if (typeof indexedDB !== 'undefined') {
  _openDb().catch(() => {
    /* IndexedDB unavailable — fallback to localStorage */
  });
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    void (async () => {
      const data = {
        dungeon: state.dungeon,
        currentLevel: state.currentLevel,
        activeTool: state.activeTool,
        zoom: state.zoom,
        panX: state.panX,
        panY: state.panY,
      };
      try {
        const db: IDBDatabase = await _openDb();
        const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
        tx.objectStore(AUTOSAVE_STORE).put(data, AUTOSAVE_KEY);
        // tx completes async — no main thread blocking
      } catch {
        // IndexedDB failed — fall back to localStorage (blocking but rare)
        try {
          localStorage.setItem(AUTOSAVE_LEGACY_KEY, JSON.stringify(data));
        } catch {}
      }
    })();
  }, 1000);
}

/**
 * Load the autosaved dungeon state from IndexedDB (or localStorage fallback).
 * @returns {Promise<boolean>} True if a valid autosave was restored.
 */
export async function loadAutosave(): Promise<boolean> {
  // Try IndexedDB first
  try {
    const db: IDBDatabase = await _openDb();
    const tx = db.transaction(AUTOSAVE_STORE, 'readonly');
    const saved = await new Promise<AutosaveData | undefined>((resolve, reject) => {
      const req = tx.objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY);
      req.onsuccess = () => resolve(req.result as AutosaveData | undefined);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
    if (saved?.dungeon?.metadata && saved?.dungeon?.cells) {
      state.dungeon = saved.dungeon;
      state.currentLevel = saved.currentLevel || 0;
      state.activeTool = saved.activeTool || 'room';
      state.zoom = saved.zoom || 1.0;
      state.panX = saved.panX ?? 60; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
      state.panY = saved.panY ?? 60; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
      return true;
    }
  } catch {}

  // Fall back to legacy localStorage
  try {
    const raw = localStorage.getItem(AUTOSAVE_LEGACY_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as AutosaveData;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
    if (!saved.dungeon?.metadata || !saved.dungeon?.cells) return false;
    state.dungeon = saved.dungeon;
    state.currentLevel = saved.currentLevel || 0;
    state.activeTool = saved.activeTool || 'room';
    state.zoom = saved.zoom || 1.0;
    state.panX = saved.panX ?? 60; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
    state.panY = saved.panY ?? 60; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
    return true;
  } catch {
    return false;
  }
}

// Re-entrancy guard. If a subscriber calls notify() while we're already
// inside notify(), we'd loop forever and trash the call stack. Instead, we
// coalesce nested calls: the inner call records the topic and returns
// immediately; the outer call drains the queue once its current pass finishes.
let _notifyInProgress = false;
let _pendingNotify: { any: boolean; topics: Set<NotifyTopic> } = { any: false, topics: new Set() };

/**
 * Notify subscribers of a state change and schedule autosave.
 * @param topic - Optional topic filter. When provided, only subscribers
 *   that either have no topic filter or include this topic are called.
 *   When omitted, all subscribers are called.
 */
export function notify(topic?: NotifyTopic): void {
  if (_notifyInProgress) {
    // Re-entrant call from inside a subscriber. Queue it and bail; the outer
    // notify will drain the queue once its pass finishes.
    if (topic === undefined) _pendingNotify.any = true;
    else _pendingNotify.topics.add(topic);
    return;
  }
  _notifyInProgress = true;
  try {
    _runNotifyPass(topic);
    // Drain any notifies queued by subscribers during the pass.
    while (_pendingNotify.any || _pendingNotify.topics.size > 0) {
      const pending = _pendingNotify;
      _pendingNotify = { any: false, topics: new Set() };
      if (pending.any) {
        _runNotifyPass(undefined);
      } else {
        for (const t of pending.topics) _runNotifyPass(t);
      }
    }
  } finally {
    _notifyInProgress = false;
  }
}

function _runNotifyPass(topic?: NotifyTopic): void {
  const t0 = performance.now();
  _notifyFrame++;
  const subs = [];
  for (const entry of state.listeners) {
    if (topic && entry.topics?.length && !entry.topics.includes(topic)) continue;
    const s = performance.now();
    entry.fn(state);
    subs.push({ label: entry.label, ms: performance.now() - s });
  }
  notifyTimings.total = performance.now() - t0;
  notifyTimings.subscribers = subs;
  notifyTimings.frame = _notifyFrame;
  scheduleAutosave();
}

// ── Transaction helper ─────────────────────────────────────────────���────

/**
 * Wrap a state mutation in the standard ceremony: pushUndo → mutate → invalidate → markDirty → notify.
 *
 * @param label - Description for the undo history panel.
 * @param coords - Cells that will be modified (for captureBeforeState / smartInvalidate).
 *   Pass an empty array for metadata-only changes.
 * @param fn - Callback that performs the actual mutation on state.dungeon.
 * @param options - Extra invalidation flags and notify topic.
 */
/** Count entries since the last full-snapshot keyframe. */
function _entriesSinceKeyframe(): number {
  for (let i = state.undoStack.length - 1; i >= 0; i--) {
    if (state.undoStack[i]!.json) return state.undoStack.length - 1 - i;
  }
  return state.undoStack.length;
}

export function mutate(
  label: string,
  coords: Array<{ row: number; col: number }>,
  fn: () => void,
  options: {
    invalidate?: InvalidateFlag[];
    forceGeometry?: boolean;
    forceFluid?: boolean;
    textureOnly?: boolean;
    topic?: NotifyTopic;
    metaOnly?: boolean;
  } = {},
): void {
  if (undoDisabled) {
    fn();
    markDirty();
    notify(options.topic);
    return;
  }

  const cells: CellGrid = state.dungeon.cells;
  const renderBefore = coords.length > 0 ? captureBeforeState(cells, coords) : [];

  // Metadata-only path: no cell changes, just snapshot metadata before/after
  if (options.metaOnly && coords.length === 0) {
    const metaBefore = JSON.stringify(state.dungeon.metadata);
    fn();
    const metaAfter = JSON.stringify(state.dungeon.metadata);
    const patchEntry = {
      cells: [] as UndoCellPatch[],
      meta: metaBefore !== metaAfter ? ({ before: metaBefore, after: metaAfter } as UndoMetaPatch) : null,
    };
    state.undoStack.push({ patch: patchEntry, label, timestamp: Date.now() });
    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
    state.redoStack.length = 0;
    const flags = options.invalidate;
    if (flags) {
      if (flags.includes('lighting')) invalidateLightmap(true);
      else if (flags.includes('lighting:props')) invalidateLightmap('props');
      if (flags.includes('props')) markPropSpatialDirty();
    }
    markDirty();
    notify(options.topic);
    return;
  }

  // Decide: compact patch or full keyframe snapshot
  const useKeyframe = coords.length === 0 || _entriesSinceKeyframe() >= KEYFRAME_INTERVAL;

  if (useKeyframe) {
    // Full snapshot (metadata-only changes without metaOnly flag, or periodic keyframe)
    pushUndo(label);
  } else {
    // Compact patch — capture cell state before mutation
    const cellsBefore: UndoCellPatch[] = coords.map(({ row, col }) => ({
      row,
      col,
      before: cells[row]?.[col] ? (JSON.parse(JSON.stringify(cells[row][col])) as Cell) : null,
      after: null, // filled after fn()
    }));
    const metaBefore = JSON.stringify(state.dungeon.metadata);

    // Push patch entry (no full JSON serialization)
    const patchEntry = { cells: cellsBefore, meta: null as UndoMetaPatch | null };
    state.undoStack.push({ patch: patchEntry, label, timestamp: Date.now() });
    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
    state.redoStack.length = 0;
    markPropSpatialDirty();

    // Execute mutation
    fn();

    // Capture after-state
    for (const cp of cellsBefore) {
      cp.after = cells[cp.row]?.[cp.col] ? (JSON.parse(JSON.stringify(cells[cp.row]![cp.col])) as Cell) : null;
    }
    const metaAfter = JSON.stringify(state.dungeon.metadata);
    if (metaBefore !== metaAfter) {
      patchEntry.meta = { before: metaBefore, after: metaAfter };
    }

    // Smart invalidation + finish
    if (renderBefore.length > 0) {
      smartInvalidate(renderBefore, cells, {
        forceGeometry: options.forceGeometry ?? false,
        forceFluid: options.forceFluid ?? false,
        textureOnly: options.textureOnly ?? false,
      });
    }
    const flags = options.invalidate;
    if (flags) {
      if (flags.includes('lighting')) invalidateLightmap(true);
      else if (flags.includes('lighting:props')) invalidateLightmap('props');
      if (flags.includes('props')) markPropSpatialDirty();
    }
    markDirty();
    notify(options.topic);
    return;
  }

  // Full snapshot path — fn() runs after pushUndo
  fn();
  if (renderBefore.length > 0) {
    smartInvalidate(renderBefore, cells, {
      forceGeometry: options.forceGeometry ?? false,
      forceFluid: options.forceFluid ?? false,
      textureOnly: options.textureOnly ?? false,
    });
  }
  const flags = options.invalidate;
  if (flags) {
    if (flags.includes('lighting')) invalidateLightmap(true);
    else if (flags.includes('lighting:props')) invalidateLightmap('props');
    if (flags.includes('props')) markPropSpatialDirty();
  }
  markDirty();
  notify(options.topic);
}

export default state;
