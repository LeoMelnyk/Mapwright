// operational.js — Operational, visualization, and AI helper methods.

import {
  getApi,
  state,
  undoFn,
  redoFn,
  requestRender,
  getThemeCatalog,
  getTextureCatalog,
  collectTextureIds,
  ensureTexturesLoaded,
  reloadAssets,
  calculateCanvasSize,
  renderDungeonToCanvas,
  cellKey,
  parseCellKey,
  roomBoundsFromKeys,
  toInt,
  toDisp,
  getContentVersion,
  getGeometryVersion,
  getLightingVersion,
  getPropsVersion,
  getDirtyRegion,
  renderTimings,
  ApiValidationError,
  getTransform,
} from './_shared.js';
import { isPropAt } from '../prop-spatial.js';

// ── Undo / Redo ──────────────────────────────────────────────────────────

/**
 * Undo the last action.
 * @returns {{ success: boolean }}
 */
export function undo(): { success: true } {
  undoFn();
  requestRender();
  return { success: true };
}

/**
 * Redo the last undone action.
 * @returns {{ success: boolean }}
 */
export function redo(): { success: true } {
  redoFn();
  requestRender();
  return { success: true };
}

// ── Visualization ────────────────────────────────────────────────────────

/**
 * Ensure all textures used in the current map have their images loaded,
 * then wait for them to finish. Call before getScreenshot() to guarantee
 * textures are rendered.
 * @param {number} [timeoutMs=8000] - Maximum wait time in milliseconds
 * @returns {Promise<{ success: boolean, count: number }>}
 */
export async function waitForTextures(timeoutMs: number = 8000): Promise<{ success: true; count: number }> {
  if (!state.textureCatalog?.textures) return { success: true, count: 0 };

  // Trigger loading for any map-used textures that haven't started yet
  const usedIds = collectTextureIds(state.dungeon.cells);

  // Also include textures referenced by overlay props
  if (state.propCatalog?.props && state.dungeon.metadata.props) {
    for (const op of state.dungeon.metadata.props) {
      const propDef = state.propCatalog.props[op.type];

      if (propDef?.textures) {
        for (const id of propDef.textures) usedIds.add(id);
      }
    }
  }

  await ensureTexturesLoaded(usedIds);

  // Wait for all in-flight images (map-used + any previously triggered)
  const entries = Object.values(state.textureCatalog.textures);
  const pending = entries.filter(
    (e) => (e as { img?: HTMLImageElement }).img && !(e as { img?: HTMLImageElement }).img!.complete,
  );
  if (!pending.length) {
    requestRender();
    return { success: true, count: entries.length };
  }

  const deadline = Date.now() + timeoutMs;
  await Promise.all(
    pending.map(
      (e) =>
        new Promise<void>((resolve) => {
          const img = (e as { img?: HTMLImageElement }).img!;
          if (img.complete) return resolve();
          const done = () => {
            img.removeEventListener('load', done);
            img.removeEventListener('error', done);
            resolve();
          };
          img.addEventListener('load', done);
          img.addEventListener('error', done);
          const check = () => {
            if (img.complete || Date.now() >= deadline) resolve();
            else setTimeout(check, 100);
          };
          check();
        }),
    ),
  );

  requestRender();
  return { success: true, count: entries.length };
}

/**
 * Capture the current editor canvas as a PNG data URL.
 * @returns {Promise<string>} Base64 PNG data URL
 */
export async function getScreenshot(): Promise<string> {
  // Ensure map-used textures are loaded before capturing
  await getApi().waitForTextures();
  requestRender();
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('editor-canvas')!;
      resolve((canvas as HTMLCanvasElement).toDataURL('image/png'));
    });
  });
}

interface Highlight {
  row: number;
  col: number;
  rows?: number; // span height in cells (default 1)
  cols?: number; // span width in cells (default 1)
  color?: string; // CSS color (default '#ff3030')
  label?: string; // text drawn at the corner
  shape?: 'box' | 'dot' | 'cross';
}

/**
 * Capture the editor canvas with overlay markers drawn on top of the
 * specified cells. Useful for visually verifying coordinates without
 * cluttering the saved map.
 *
 * Each highlight: { row, col, [rows=1], [cols=1], [color='#ff3030'],
 * [shape='box'], [label] }.
 */
export async function getScreenshotAnnotated(highlights: Highlight[]): Promise<string> {
  await getApi().waitForTextures();
  requestRender();
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);

      const transform = getTransform();
      const gs = state.dungeon.metadata.gridSize || 5;
      const list = Array.isArray(highlights) ? highlights : [];

      for (const h of list) {
        const rows = h.rows ?? 1;
        const cols = h.cols ?? 1;
        const x = h.col * gs * transform.scale + transform.offsetX;
        const y = h.row * gs * transform.scale + transform.offsetY;
        const w = cols * gs * transform.scale;
        const ht = rows * gs * transform.scale;
        const color = h.color ?? '#ff3030';
        const shape = h.shape ?? 'box';

        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 3;

        if (shape === 'dot') {
          ctx.beginPath();
          ctx.arc(x + w / 2, y + ht / 2, Math.min(w, ht) / 4, 0, Math.PI * 2);
          ctx.fill();
        } else if (shape === 'cross') {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + w, y + ht);
          ctx.moveTo(x + w, y);
          ctx.lineTo(x, y + ht);
          ctx.stroke();
        } else {
          ctx.strokeRect(x, y, w, ht);
        }

        if (h.label) {
          const fontSize = Math.max(11, Math.min(20, w * 0.35));
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textBaseline = 'top';
          // Draw a contrasting halo for readability
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.strokeText(h.label, x + 4, y + 4);
          ctx.fillStyle = color;
          ctx.fillText(h.label, x + 4, y + 4);
        }

        ctx.restore();
      }

      resolve(out.toDataURL('image/png'));
    });
  });
}

/**
 * Export the map as a PNG using the compile pipeline (HQ lighting).
 * @returns {Promise<string>} Base64 PNG data URL
 */
export async function exportPng(): Promise<string> {
  await getApi().waitForTextures();
  const config = state.dungeon;
  const { width, height } = calculateCanvasSize(config);
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');
  renderDungeonToCanvas(ctx!, config, width, height, state.propCatalog, state.textureCatalog);
  return offscreen.toDataURL('image/png');
}

/**
 * Clear all caches (props, textures, themes, lights) and reload from server.
 * @returns {Promise<{ success: boolean }>}
 */
export async function clearCaches(): Promise<{ success: true }> {
  await reloadAssets();
  return { success: true };
}

/**
 * Trigger a canvas re-render.
 * @returns {{ success: boolean }}
 */
export function render(): { success: true } {
  requestRender();
  return { success: true };
}

/**
 * Wait for any pending render work to complete by waiting until the lighting
 * version stops advancing for two consecutive frames. Useful after bulk light
 * placements before taking a screenshot.
 *
 * @param timeoutMs cap on total wait (default 3000)
 */
export async function waitForRender(timeoutMs: number = 3000): Promise<{ success: true; settledMs: number }> {
  const start = Date.now();
  let prev = getLightingVersion();
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    requestRender();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const cur = getLightingVersion();
    if (cur === prev) {
      stable++;
      if (stable >= 2) break;
    } else {
      stable = 0;
      prev = cur;
    }
  }
  return { success: true, settledMs: Date.now() - start };
}

/**
 * Wait for the editor to be fully initialized: all catalogs loaded,
 * canvas ready, and textures resolved. Useful as a first command in
 * Puppeteer scripts to ensure the editor is ready before interacting.
 * @param {number} [timeoutMs=15000] - Maximum wait time in milliseconds
 * @returns {Promise<{ success: boolean }>}
 */
export async function waitForEditor(timeoutMs: number = 15000): Promise<{ success: true }> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() >= deadline) return reject(new Error('waitForEditor timed out'));
      const ready = !!(document.getElementById('editor-canvas') && getThemeCatalog() !== null && state.propCatalog);
      if (ready) return resolve(undefined);
      setTimeout(check, 100);
    };
    check();
  });
  return { success: true };
}

/**
 * Evaluate arbitrary JS in the editor context.
 * The code string is wrapped in an async function with access to `state`, `editorAPI`, and `document`.
 * Use `return <value>` to send a result back.
 * Example: editorAPI.eval('return document.querySelector(".menu-trigger").textContent')
 * @param {string} code - JavaScript code to evaluate
 * @returns {Promise<{ success: boolean, result?: * }>}
 */
export async function eval_(
  code: string,
): Promise<{ success: boolean; result?: string | number | boolean | Record<string, unknown> | null }> {
  const fn = new Function('state', 'editorAPI', `return (async () => { ${code} })();`);
  const result = await fn(state, (window as unknown as Record<string, unknown>).editorAPI);
  if (result === undefined || result === null) return { success: true };
  if (typeof result === 'object' && result.success !== undefined) return result;
  return { success: true, result };
}

// ── Claude AI helpers ────────────────────────────────────────────────────

/**
 * Return current undo stack depth. Used by Claude chat to support "undo all" after a build.
 * @returns {{ success: boolean, depth: number }}
 */
export function getUndoDepth(): { success: true; depth: number } {
  return { success: true, depth: state.undoStack.length };
}

/**
 * Undo back to a previously recorded depth, reversing all changes made since then.
 * @param {number} targetDepth - Target undo stack depth
 * @returns {{ success: boolean, undid: number }}
 */
export function undoToDepth(targetDepth: number): { success: true; undid: number } {
  const depth = Math.max(0, targetDepth);
  let count = 0;
  while (state.undoStack.length > depth) {
    undoFn();
    count++;
  }
  return { success: true, undid: count };
}

// ── Interactive pause ────────────────────────────────────────────────────

/**
 * Block command execution for a fixed duration so the human can inspect the
 * map in a visible browser session. Use as a checkpoint in a multi-phase
 * build:
 *
 *   ["createRoom", ...], ..., ["pauseForReview", 30, "after layout"], ...
 *
 * The bridge keeps the browser open during the wait. Combine with
 * `--visible --slow-mo 200` for an interactive build session where you can
 * close the browser to abort or just watch each phase land.
 *
 * Note: this blocks the editor's command queue but does not pause rendering
 * or other ambient work. It is purely a synchronization point for the user.
 *
 * @param seconds Pause duration in seconds (1-600). Default 30.
 * @param message Optional label written to console for context.
 */
export async function pauseForReview(
  seconds: number = 30,
  message?: string,
): Promise<{ success: true; pausedSeconds: number; message?: string }> {
  const s = Math.max(
    1,
    Math.min(600, Math.floor((typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 30) || 30)),
  );
  if (message) console.log(`[pauseForReview] ${message} — waiting ${s}s`);
  await new Promise((r) => setTimeout(r, s * 1000));
  return { success: true, pausedSeconds: s, ...(message ? { message } : {}) };
}

// ── Named checkpoints ────────────────────────────────────────────────────
//
// In-memory map of checkpoint name -> undo depth at the time of capture.
// Cleared on newMap/loadMap (each map has its own undo stack identity).
// Names are stable strings the caller chooses, e.g. "after-rooms",
// "phase-2-textures". Replaces fragile getUndoDepth() integer tracking.

const checkpoints = new Map<string, number>();

/** Reset the checkpoint table. Called by newMap/loadMap. */
export function _clearCheckpoints(): void {
  checkpoints.clear();
}

/**
 * Record a named checkpoint at the current undo depth. Use `rollback(name)`
 * later to undo back to this point. Overwrites a checkpoint of the same name.
 * @returns `{ success, name, depth }`
 */
export function checkpoint(name: string): { success: true; name: string; depth: number } {
  if (typeof name !== 'string' || !name) {
    throw new ApiValidationError('INVALID_CHECKPOINT_NAME', 'Checkpoint name must be a non-empty string', { name });
  }
  const depth = state.undoStack.length;
  checkpoints.set(name, depth);
  return { success: true, name, depth };
}

/**
 * Undo back to the depth recorded by `checkpoint(name)`. The checkpoint itself
 * is preserved (you can rollback again until you call `clearCheckpoint`).
 * @returns `{ success, name, depth, undid }`
 */
export function rollback(name: string): { success: true; name: string; depth: number; undid: number } {
  if (!checkpoints.has(name)) {
    throw new ApiValidationError('CHECKPOINT_NOT_FOUND', `No checkpoint named "${name}"`, {
      name,
      available: [...checkpoints.keys()],
    });
  }
  const depth = checkpoints.get(name)!;
  let count = 0;
  while (state.undoStack.length > depth) {
    undoFn();
    count++;
  }
  return { success: true, name, depth, undid: count };
}

/** List all named checkpoints with their captured depth and current age (steps since). */
export function listCheckpoints(): {
  success: true;
  current: number;
  checkpoints: Array<{ name: string; depth: number; stepsAhead: number }>;
} {
  const cur = state.undoStack.length;
  const list = [...checkpoints.entries()].map(([name, depth]) => ({
    name,
    depth,
    stepsAhead: cur - depth,
  }));
  list.sort((a, b) => b.depth - a.depth);
  return { success: true, current: cur, checkpoints: list };
}

/** Delete a named checkpoint. No-op if it doesn't exist. */
export function clearCheckpoint(name: string): { success: true; existed: boolean } {
  return { success: true, existed: checkpoints.delete(name) };
}

// ── Checkpoint diff ──────────────────────────────────────────────────────

interface CheckpointDiffSummary {
  cellsModified: number;
  cellsPainted: number;
  cellsErased: number;
  propsAdded: number;
  propsRemoved: number;
  propsChanged: number;
  fillsAdded: number;
  fillsRemoved: number;
  fillsChanged: number;
  labelsAdded: number;
  labelsRemoved: number;
  labelsChanged: number;
  wallsAdded: number;
  wallsRemoved: number;
  doorsAdded: number;
  doorsRemoved: number;
  texturesChanged: number;
  hazardsToggled: number;
  // Metadata-level
  overlayPropsAdded: number;
  overlayPropsRemoved: number;
  lightsAdded: number;
  lightsRemoved: number;
  stairsAdded: number;
  stairsRemoved: number;
  bridgesAdded: number;
  bridgesRemoved: number;
  metaChanges: string[];
  // Keyframe entries: hard to diff exactly, so just count
  snapshotEntries: number;
}

const WALL_EDGES = ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'] as const;
const TEXTURE_KEYS = [
  'texture',
  'textureOpacity',
  'textureSecondary',
  'textureSecondaryOpacity',
  'textureNE',
  'textureSW',
  'textureNW',
  'textureSE',
  'textureNEOpacity',
  'textureSWOpacity',
  'textureNWOpacity',
  'textureSEOpacity',
] as const;

function isDoorEdge(v: unknown): boolean {
  return v === 'd' || v === 'id' || v === 's';
}
function isWallEdge(v: unknown): boolean {
  return v === 'w' || v === 'iw';
}

function classifyCellPatch(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  s: CheckpointDiffSummary,
): void {
  s.cellsModified++;
  if (!before && after) {
    s.cellsPainted++;
    return;
  }
  if (before && !after) {
    s.cellsErased++;
    return;
  }
  if (!before || !after) return;

  // Props
  const bp = before.prop as { type?: string } | undefined;
  const ap = after.prop as { type?: string } | undefined;
  if (!bp && ap) s.propsAdded++;
  else if (bp && !ap) s.propsRemoved++;
  else if (bp && ap && JSON.stringify(bp) !== JSON.stringify(ap)) s.propsChanged++;

  // Fills
  const bf = before.fill;
  const af = after.fill;
  if (!bf && af) s.fillsAdded++;
  else if (bf && !af) s.fillsRemoved++;
  else if (bf && af && bf !== af) s.fillsChanged++;

  // Labels
  const bl = (before.center as { label?: string } | undefined)?.label;
  const al = (after.center as { label?: string } | undefined)?.label;
  if (!bl && al) s.labelsAdded++;
  else if (bl && !al) s.labelsRemoved++;
  else if (bl && al && bl !== al) s.labelsChanged++;

  // Walls / doors
  for (const edge of WALL_EDGES) {
    const be = before[edge];
    const ae = after[edge];
    if (be === ae) continue;
    if (isWallEdge(ae) && !isWallEdge(be)) s.wallsAdded++;
    else if (isWallEdge(be) && !isWallEdge(ae)) s.wallsRemoved++;
    if (isDoorEdge(ae) && !isDoorEdge(be)) s.doorsAdded++;
    else if (isDoorEdge(be) && !isDoorEdge(ae)) s.doorsRemoved++;
  }

  // Textures
  for (const key of TEXTURE_KEYS) {
    if (before[key] !== after[key]) {
      s.texturesChanged++;
      break;
    }
  }

  // Hazards
  if (Boolean(before.hazard) !== Boolean(after.hazard)) s.hazardsToggled++;
}

function classifyMetaDiff(beforeStr: string, afterStr: string, s: CheckpointDiffSummary): void {
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = JSON.parse(beforeStr);
    after = JSON.parse(afterStr);
  } catch {
    s.metaChanges.push('unparseable');
    return;
  }

  // Lights — diff by id set
  const bLights = ((before.lights as Array<{ id: number }> | undefined) ?? []).map((l) => l.id);
  const aLights = ((after.lights as Array<{ id: number }> | undefined) ?? []).map((l) => l.id);
  const bLightSet = new Set(bLights);
  const aLightSet = new Set(aLights);
  for (const id of aLightSet) if (!bLightSet.has(id)) s.lightsAdded++;
  for (const id of bLightSet) if (!aLightSet.has(id)) s.lightsRemoved++;

  // Stairs
  const bStairs = ((before.stairs as Array<{ id: number }> | undefined) ?? []).map((x) => x.id);
  const aStairs = ((after.stairs as Array<{ id: number }> | undefined) ?? []).map((x) => x.id);
  const bStairsSet = new Set(bStairs);
  const aStairsSet = new Set(aStairs);
  for (const id of aStairsSet) if (!bStairsSet.has(id)) s.stairsAdded++;
  for (const id of bStairsSet) if (!aStairsSet.has(id)) s.stairsRemoved++;

  // Bridges
  const bBridges = ((before.bridges as Array<{ id: number }> | undefined) ?? []).map((x) => x.id);
  const aBridges = ((after.bridges as Array<{ id: number }> | undefined) ?? []).map((x) => x.id);
  const bBridgeSet = new Set(bBridges);
  const aBridgeSet = new Set(aBridges);
  for (const id of aBridgeSet) if (!bBridgeSet.has(id)) s.bridgesAdded++;
  for (const id of bBridgeSet) if (!aBridgeSet.has(id)) s.bridgesRemoved++;

  // Overlay props (placed on metadata)
  const bOverlay = ((before.props as Array<{ id: number | string }> | undefined) ?? []).map((x) => String(x.id));
  const aOverlay = ((after.props as Array<{ id: number | string }> | undefined) ?? []).map((x) => String(x.id));
  const bOverlaySet = new Set(bOverlay);
  const aOverlaySet = new Set(aOverlay);
  for (const id of aOverlaySet) if (!bOverlaySet.has(id)) s.overlayPropsAdded++;
  for (const id of bOverlaySet) if (!aOverlaySet.has(id)) s.overlayPropsRemoved++;

  // Scalar metadata fields worth flagging
  const SCALAR_KEYS = ['dungeonName', 'theme', 'labelStyle', 'gridSize', 'ambientLight', 'lightingEnabled'];
  for (const key of SCALAR_KEYS) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      s.metaChanges.push(`${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
    }
  }
}

/**
 * Summarize what would be undone if `rollback(name)` were called now.
 *
 * Walks the undo stack from the checkpoint depth to the current depth and
 * aggregates changes by category: cells, props, fills, walls, doors, lights,
 * etc. Use this before rollback to know what work is on the line.
 *
 * Cell-patch entries are classified precisely. Snapshot (keyframe) entries
 * count as `snapshotEntries` and surface their label in `entryLabels` —
 * their internal cell-by-cell diff is not computed (would require replaying
 * the stack).
 *
 * @param name - Checkpoint name from a prior `checkpoint(name)` call.
 * @returns Aggregated summary plus per-entry labels and counts.
 */
export function diffFromCheckpoint(name: string): {
  success: true;
  name: string;
  fromDepth: number;
  toDepth: number;
  entriesAhead: number;
  summary: CheckpointDiffSummary;
  entryLabels: Array<{ label: string; type: 'patch' | 'snapshot'; cellCount: number; hasMeta: boolean }>;
} {
  if (!checkpoints.has(name)) {
    throw new ApiValidationError('CHECKPOINT_NOT_FOUND', `No checkpoint named "${name}"`, {
      name,
      available: [...checkpoints.keys()],
    });
  }
  const fromDepth = checkpoints.get(name)!;
  const toDepth = state.undoStack.length;

  const summary: CheckpointDiffSummary = {
    cellsModified: 0,
    cellsPainted: 0,
    cellsErased: 0,
    propsAdded: 0,
    propsRemoved: 0,
    propsChanged: 0,
    fillsAdded: 0,
    fillsRemoved: 0,
    fillsChanged: 0,
    labelsAdded: 0,
    labelsRemoved: 0,
    labelsChanged: 0,
    wallsAdded: 0,
    wallsRemoved: 0,
    doorsAdded: 0,
    doorsRemoved: 0,
    texturesChanged: 0,
    hazardsToggled: 0,
    overlayPropsAdded: 0,
    overlayPropsRemoved: 0,
    lightsAdded: 0,
    lightsRemoved: 0,
    stairsAdded: 0,
    stairsRemoved: 0,
    bridgesAdded: 0,
    bridgesRemoved: 0,
    metaChanges: [],
    snapshotEntries: 0,
  };
  const entryLabels: Array<{ label: string; type: 'patch' | 'snapshot'; cellCount: number; hasMeta: boolean }> = [];

  for (let i = fromDepth; i < toDepth; i++) {
    const entry = state.undoStack[i] as {
      json?: string;
      patch?: {
        cells: Array<{
          row: number;
          col: number;
          before: Record<string, unknown> | null;
          after: Record<string, unknown> | null;
        }>;
        meta: { before: string; after: string } | null;
      };
      label: string;
    };
    if (entry.patch) {
      for (const cp of entry.patch.cells) {
        classifyCellPatch(cp.before, cp.after, summary);
      }
      if (entry.patch.meta) {
        classifyMetaDiff(entry.patch.meta.before, entry.patch.meta.after, summary);
      }
      entryLabels.push({
        label: entry.label,
        type: 'patch',
        cellCount: entry.patch.cells.length,
        hasMeta: !!entry.patch.meta,
      });
    } else if (entry.json) {
      summary.snapshotEntries++;
      entryLabels.push({ label: entry.label, type: 'snapshot', cellCount: 0, hasMeta: false });
    }
  }

  return {
    success: true,
    name,
    fromDepth,
    toDepth,
    entriesAhead: toDepth - fromDepth,
    summary,
    entryLabels,
  };
}

// ── Transactional batches ────────────────────────────────────────────────

interface TxnResult {
  index: number;
  method: string;
  ok: boolean;
  error?: string;
  code?: string;
  context?: Record<string, unknown>;
  result?: unknown;
}

function txnErrorFields(e: unknown): { error: string; code?: string; context?: Record<string, unknown> } {
  if (e instanceof ApiValidationError) return { error: e.message, code: e.code, context: e.context };
  if (e instanceof Error) return { error: e.message };
  return { error: String(e) };
}

/**
 * Run a batch of commands as an all-or-nothing transaction. If any command
 * throws, every preceding command in the batch is undone and the transaction
 * returns the failure. On full success, all commands remain applied (one
 * cumulative state change in the undo stack from the caller's perspective).
 *
 * Differs from `validateCommands` (which always rolls back) and
 * `--continue-on-error` (which leaves partial state).
 */
export async function transaction(
  commands: unknown[][],
): Promise<{ success: boolean; committed: boolean; results: TxnResult[]; failedAt?: number }> {
  const startDepth = state.undoStack.length;
  const results: TxnResult[] = [];
  const api = getApi() as unknown as Record<string, (...a: unknown[]) => unknown>;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (!Array.isArray(cmd) || cmd.length === 0) {
      // Roll back everything done so far.
      while (state.undoStack.length > startDepth) undoFn();
      results.push({
        index: i,
        method: '',
        ok: false,
        error: 'Command must be a non-empty array',
        code: 'INVALID_COMMAND',
      });
      return { success: false, committed: false, results, failedAt: i };
    }
    const [method, ...args] = cmd as [string, ...unknown[]];
    try {
      const fn = api[method];
      if (typeof fn !== 'function') {
        throw new ApiValidationError('UNKNOWN_METHOD', `unknown method: ${method}`, { method });
      }
      const result = await fn.apply(api, args);
      results.push({ index: i, method, ok: true, result });
    } catch (e) {
      while (state.undoStack.length > startDepth) undoFn();
      results.push({ index: i, method, ok: false, ...txnErrorFields(e) });
      return { success: false, committed: false, results, failedAt: i };
    }
  }

  return { success: true, committed: true, results };
}

// ── Session info ─────────────────────────────────────────────────────────

/**
 * Rich session-state snapshot for sanity checks between Puppeteer calls.
 * Tells the caller what map is loaded, whether it's dirty, what catalogs
 * are ready, and what named checkpoints exist.
 *
 * Cheaper to call than `getMapInfo` and includes the things you actually
 * need to decide "is this session safe to use?".
 */
export function getSessionInfo(): {
  success: true;
  mapName: string;
  rows: number;
  cols: number;
  currentLevel: number;
  undoDepth: number;
  redoDepth: number;
  dirty: boolean;
  unsavedChanges: boolean;
  lightingEnabled: boolean;
  catalogsLoaded: { props: boolean; textures: boolean; theme: boolean; lights: boolean };
  checkpoints: Array<{ name: string; depth: number; stepsAhead: number }>;
  counts: { rooms: number; props: number; lights: number; stairs: number; bridges: number; levels: number };
} {
  const meta = state.dungeon.metadata;
  const cells = state.dungeon.cells;
  const roomLabels = new Set<string>();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const lbl = cells[r]?.[c]?.center?.label;
      if (lbl != null) roomLabels.add(lbl);
    }
  }
  const checkpointList = [...checkpoints.entries()].map(([name, depth]) => ({
    name,
    depth,
    stepsAhead: state.undoStack.length - depth,
  }));

  return {
    success: true,
    mapName: meta.dungeonName,
    rows: cells.length,
    cols: cells[0]?.length ?? 0,
    currentLevel: state.currentLevel,
    undoDepth: state.undoStack.length,
    redoDepth: state.redoStack.length,
    dirty: state.dirty,
    unsavedChanges: state.unsavedChanges,
    lightingEnabled: meta.lightingEnabled,
    catalogsLoaded: {
      props: state.propCatalog != null,
      textures: state.textureCatalog != null,
      theme: getThemeCatalog() != null,
      lights: state.lightCatalog != null,
    },
    checkpoints: checkpointList,
    counts: {
      rooms: roomLabels.size,
      props: meta.props?.length ?? 0,
      lights: meta.lights.length,
      stairs: meta.stairs.length,
      bridges: meta.bridges.length,
      levels: meta.levels.length,
    },
  };
}

/**
 * Return the contents of a labeled room: props, fills, doors, textures.
 * @param {string} label - Room label
 * @returns {{ label: string, bounds: Object, props: Array, fills: Array, doors: Array, textures: Array }}
 */
export function getRoomContents(label: string): {
  success?: boolean;
  error?: string;
  label?: string;
  bounds?: { r1: number; c1: number; r2: number; c2: number };
  props: { row: number; col: number; type: string; facing: number }[];
  fills: { row: number; col: number; type: string; depth: number }[];
  doors: { row: number; col: number; direction: string; type: string }[];
  textures: { row: number; col: number; id: string; opacity: number }[];
} {
  const boundsResult = getApi().getRoomBounds(label);
  if (!boundsResult.success)
    return { success: false, error: `Room "${label}" not found`, props: [], fills: [], doors: [], textures: [] };
  const bounds = boundsResult;
  const result: {
    label: string;
    bounds: typeof bounds;
    props: { row: number; col: number; type: string; facing: number }[];
    fills: { row: number; col: number; type: string; depth: number }[];
    doors: { row: number; col: number; direction: string; type: string }[];
    textures: { row: number; col: number; id: string; opacity: number }[];
  } = { label, bounds, props: [], fills: [], doors: [], textures: [] };
  const gs = state.dungeon.metadata.gridSize || 5;
  // Convert display bounds to internal for iteration
  const ir1 = toInt(bounds.r1),
    ic1 = toInt(bounds.c1);
  const ir2 = toInt(bounds.r2),
    ic2 = toInt(bounds.c2);
  for (let r = ir1; r <= ir2; r++) {
    for (let c = ic1; c <= ic2; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (!cell) continue;
      if (cell.fill)
        result.fills.push({ row: toDisp(r), col: toDisp(c), type: cell.fill as string, depth: cell.fillDepth ?? 1 });
      if (cell.texture)
        result.textures.push({ row: toDisp(r), col: toDisp(c), id: cell.texture, opacity: cell.textureOpacity ?? 1 });
      for (const dir of ['north', 'south', 'east', 'west']) {
        if ((cell as Record<string, unknown>)[dir] === 'd' || (cell as Record<string, unknown>)[dir] === 's')
          result.doors.push({
            row: toDisp(r),
            col: toDisp(c),
            direction: dir,
            type: (cell as Record<string, unknown>)[dir] as string,
          });
      }
    }
  }
  // Collect props from metadata.props[] that fall within room bounds
  if (state.dungeon.metadata.props) {
    for (const op of state.dungeon.metadata.props) {
      const propRow = Math.round(op.y / gs);
      const propCol = Math.round(op.x / gs);
      if (propRow >= ir1 && propRow <= ir2 && propCol >= ic1 && propCol <= ic2) {
        result.props.push({ row: toDisp(propRow), col: toDisp(propCol), type: op.type, facing: op.rotation });
      }
    }
  }
  return result;
}

/**
 * Find a free rectangular area of the given size, optionally adjacent to an existing room.
 * @param {number} rows - Desired room height in cells
 * @param {number} cols - Desired room width in cells
 * @param {string|null} [adjacentTo=null] - Room label to try placing adjacent to
 * @returns {{ r1: number, c1: number, r2: number, c2: number } | { success: boolean, error: string }}
 */
export function suggestPlacement(
  rows: number,
  cols: number,
  adjacentTo: string | null = null,
): { success?: boolean; error?: string; r1?: number; c1?: number; r2?: number; c2?: number } {
  const info = getApi().getMapInfo();
  if (!info) return { success: false, error: 'Map not available' };
  const { rows: gridRows, cols: gridCols } = info;
  const margin = 1;

  const isFree = (r1: number, c1: number, r2: number, c2: number) => {
    if (r1 < margin || c1 < margin) return false;
    if (r2 > gridRows - 1 - margin || c2 > gridCols - 1 - margin) return false;
    // Convert display coords to internal for cell access
    const ir1 = toInt(r1),
      ic1 = toInt(c1),
      ir2 = toInt(r2),
      ic2 = toInt(c2);
    for (let r = ir1; r <= ir2; r++) {
      for (let c = ic1; c <= ic2; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell !== null) return false;
      }
    }
    return true;
  };

  // Try positions adjacent to a reference room first
  if (adjacentTo) {
    const bResult = getApi().getRoomBounds(adjacentTo);
    if (bResult.success) {
      const b = bResult;
      const hc = b.centerCol - Math.floor(cols / 2);
      const hr = b.centerRow - Math.floor(rows / 2);
      for (const [r, c] of [
        [b.r2 + 2, hc], // south
        [b.r1 - rows - 1, hc], // north
        [hr, b.c2 + 2], // east
        [hr, b.c1 - cols - 1], // west
      ] as [number, number][]) {
        if (isFree(r, c, r + rows - 1, c + cols - 1)) return { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 };
      }
    }
  }

  // Systematic left-to-right, top-to-bottom scan
  for (let r = margin; r <= gridRows - rows - margin; r++) {
    for (let c = margin; c <= gridCols - cols - margin; c++) {
      if (isFree(r, c, r + rows - 1, c + cols - 1)) return { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 };
    }
  }
  return { success: false, error: `No space found for a ${rows}×${cols} room. Map may be full.` };
}

// ── Catalog queries ──────────────────────────────────────────────────────

/**
 * List all available floor textures from the catalog.
 * @returns {{ success: boolean, textures: Array<{ id: string, displayName: string, category: string }> }}
 */
export function listTextures(): {
  success: true;
  textures: Array<{ id: string; displayName: string; category: string }>;
} {
  const catalog = getTextureCatalog();
  if (!catalog) return { success: true, textures: [] };
  return {
    success: true,
    textures: Object.values(catalog.textures)
      .filter((t) => t != null)
      .map((t) => ({
        id: (t as Record<string, unknown>).id as string,
        displayName: t.displayName ?? '',
        category: (t as Record<string, unknown>).category as string,
      })),
  };
}

/**
 * Return all available theme names.
 * @returns {{ success: boolean, themes: Array<string> }}
 */
export function listThemes(): { success: true; themes: string[] } {
  const catalog = getThemeCatalog();
  if (!catalog) return { success: true, themes: [] };
  return { success: true, themes: catalog.names };
}

// ── Room queries ─────────────────────────────────────────────────────────

/**
 * Return all labeled rooms with bounding boxes and centers.
 * @returns {{ success: boolean, rooms: Array<Object> }}
 */
export function listRooms(): {
  success: true;
  rooms: { label: string; r1: number; c1: number; r2: number; c2: number; center: { row: number; col: number } }[];
} {
  const cells = state.dungeon.cells;
  const labels = new Map();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const lbl = cells[r]?.[c]?.center?.label;
      if (lbl) labels.set(lbl, { row: r, col: c });
    }
  }
  const rooms = [];
  for (const [label] of labels) {
    const roomCells = getApi()._collectRoomCells(label);
    if (!roomCells) continue;
    const b = roomBoundsFromKeys(roomCells);
    if (b)
      rooms.push({
        label,
        r1: toDisp(b.r1),
        c1: toDisp(b.c1),
        r2: toDisp(b.r2),
        c2: toDisp(b.c2),
        center: { row: toDisp(b.centerRow), col: toDisp(b.centerCol) },
      });
  }
  rooms.sort((a, b) => a.label.localeCompare(b.label));
  return { success: true, rooms };
}

/** Return all floor cells belonging to a labeled room as sorted [[row, col], ...]. */
/**
 * Return all floor cells belonging to a labeled room as sorted [[row, col], ...].
 * @param {string} label - Room label (e.g. "A1")
 * @returns {{ success: boolean, cells: Array<[number, number]> }}
 */
export function listRoomCells(label: string): { success: boolean; cells?: [number, number][]; error?: string } {
  const roomCells = getApi()._collectRoomCells(label);
  if (!roomCells?.size) return { success: false, error: `Room "${label}" not found or empty` };
  const cellList: [number, number][] = [];
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    cellList.push([toDisp(r), toDisp(c)]);
  }
  cellList.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { success: true, cells: cellList };
}

/**
 * Return the cells a prop occupies relative to its anchor at [0,0] for a given facing.
 * Footprint is R×C (rows × cols). At 90°/270° the dimensions swap.
 * Returns { success, spanRows, spanCols, cells: [[dr, dc], ...] }.
 */
export function getPropFootprint(
  propType: string,
  facing: number = 0,
): { success: boolean; spanRows?: number; spanCols?: number; cells?: [number, number][]; error?: string } {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    return { success: false, error: `Unknown prop type: ${propType}` };
  }
  if (![0, 90, 180, 270].includes(facing)) {
    return { success: false, error: `Invalid facing: ${facing}. Use 0, 90, 180, or 270.` };
  }
  const def = catalog.props[propType];
  const [spanRows, spanCols] =
    facing === 90 || facing === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];
  const cells: [number, number][] = [];
  for (let r = 0; r < spanRows; r++) {
    for (let c = 0; c < spanCols; c++) cells.push([r, c]);
  }
  return { success: true, spanRows, spanCols, cells };
}

/**
 * Return all valid anchor positions where propType can be placed in a labeled room.
 * Checks that the full footprint fits within the room and doesn't overlap existing props.
 * Returns { success, positions: [[row, col], ...] }.
 */
export function getValidPropPositions(
  label: string,
  propType: string,
  facing: number = 0,
): { success: boolean; positions?: [number, number][]; error?: string } {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    throw new ApiValidationError('UNKNOWN_PROP', `Unknown prop type: ${propType}`, {
      propType,
      available: Object.keys(catalog?.props ?? {}),
    });
  }
  if (![0, 90, 180, 270].includes(facing)) {
    throw new ApiValidationError('INVALID_FACING', `Invalid facing: ${facing}. Use 0, 90, 180, or 270.`, {
      facing,
      validFacings: [0, 90, 180, 270],
    });
  }

  const def = catalog.props[propType];
  const [spanRows, spanCols] =
    facing === 90 || facing === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];

  const roomCellSet = getApi()._collectRoomCells(label);
  if (!roomCellSet?.size) return { success: false, error: `Room "${label}" not found` };

  const positions: [number, number][] = [];
  for (const key of roomCellSet) {
    const [r, c] = parseCellKey(key);
    let valid = true;
    outer: for (let dr = 0; dr < spanRows; dr++) {
      for (let dc = 0; dc < spanCols; dc++) {
        if (!roomCellSet.has(cellKey(r + dr, c + dc))) {
          valid = false;
          break outer;
        }
        if (isPropAt(r + dr, c + dc)) {
          valid = false;
          break outer;
        }
      }
    }
    if (valid) positions.push([toDisp(r), toDisp(c)]);
  }

  positions.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { success: true, positions };
}

// ── Render Diagnostics ──────────────────────────────────────────────────

/**
 * Aggregate current render state into a diagnostic summary.
 * Useful for debugging render pipeline stalls and cache invalidation.
 * @returns Render version counters, dirty region, and per-phase timings.
 */
export function getRenderDiagnostics(): {
  success: true;
  contentVersion: number;
  geometryVersion: number;
  lightingVersion: number;
  propsVersion: number;
  dirtyRegion: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;
  timings: Record<string, number>;
} {
  const dirty = getDirtyRegion();
  const timings: Record<string, number> = {};
  for (const [key, entry] of Object.entries(renderTimings)) {
    timings[key] = entry.ms;
  }
  return {
    success: true,
    contentVersion: getContentVersion(),
    geometryVersion: getGeometryVersion(),
    lightingVersion: getLightingVersion(),
    propsVersion: getPropsVersion(),
    dirtyRegion: dirty
      ? { minRow: dirty.minRow, maxRow: dirty.maxRow, minCol: dirty.minCol, maxCol: dirty.maxCol }
      : null,
    timings,
  };
}

// ── State Digest ────────────────────────────────────────────────────────

/**
 * Return a lightweight summary of the current editor state.
 * Useful for verifying state after a batch of commands without serializing the full dungeon.
 */
export function getStateDigest(): {
  success: true;
  rooms: number;
  totalCells: number;
  props: number;
  lights: number;
  stairs: number;
  bridges: number;
  currentLevel: number;
  levels: number;
  undoDepth: number;
  dirty: boolean;
  unsavedChanges: boolean;
} {
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;
  let totalCells = 0;
  const roomLabels = new Set<string>();

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (cell != null) {
        totalCells++;
        if (cell.center?.label) roomLabels.add(cell.center.label);
      }
    }
  }

  return {
    success: true,
    rooms: roomLabels.size,
    totalCells,
    props: meta.props?.length ?? 0,
    lights: meta.lights.length,
    stairs: meta.stairs.length,
    bridges: meta.bridges.length,
    currentLevel: state.currentLevel,
    levels: meta.levels.length,
    undoDepth: state.undoStack.length,
    dirty: state.dirty,
    unsavedChanges: state.unsavedChanges,
  };
}
