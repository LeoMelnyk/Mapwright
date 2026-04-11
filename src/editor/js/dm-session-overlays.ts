// DM session overlays: door overlay and stair overlay (find, hit test, render), openStairs, dumpFogRegion.

import type { CardinalDirection, Cell, RenderTransform } from '../../types.js';
import { sessionState, send } from './dm-session-state.js';
import state, { notify } from './state.js';
import { requestRender, panToLevel } from './canvas-view.js';
import { CARDINAL_DIRS, OPPOSITE, cellKey, parseCellKey, isInBounds, CARDINAL_OFFSETS } from '../../util/index.js';
import { toCanvas } from './utils.js';
import { classifyStairShape, getOccupiedCells, stairBoundingBox } from './stair-geometry.js';
import { getEditorSettings } from './editor-settings.js';
import { revealRoom } from './dm-session-reveal.js';

// ── Door overlay (DM canvas) ────────────────────────────────────────────────

const DOOR_BUTTON_RADIUS = 10;

/**
 * Find all doors that border a revealed cell and face an unrevealed area.
 * Secret doors always show a button until explicitly opened (even if both sides are revealed).
 * Checks cardinal doors (north/south/east/west) and diagonal doors (nw-se/ne-sw).
 */
function findRevealableDoors() {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return [];

  const cells = state.dungeon.cells;
  const doors: { row: number; col: number; dir: string; type: string }[] = [];
  const seen = new Set();

  // Build opened-door set for fast lookup (include both sides of cardinal doors)
  const openedSet = new Set();
  for (const d of sessionState.openedDoors) {
    openedSet.add(`${d.row},${d.col},${d.dir}`);
    const offset = (CARDINAL_OFFSETS as Record<string, readonly [number, number] | undefined>)[d.dir];
    if (!offset) continue;
    const [dr, dc] = offset;
    openedSet.add(`${d.row + dr},${d.col + dc},${OPPOSITE[d.dir as CardinalDirection]}`);
  }

  for (const key of sessionState.revealedCells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;

    // Cardinal doors (normal, secret, and invisible)
    for (const dir of ['north', 'south', 'east', 'west']) {
      if (
        (cell as Record<string, unknown>)[dir] !== 'd' &&
        (cell as Record<string, unknown>)[dir] !== 's' &&
        (cell as Record<string, unknown>)[dir] !== 'id'
      )
        continue;

      const dkey = `${r},${c},${dir}`;
      if (seen.has(dkey)) continue;

      const isSecret = (cell as Record<string, unknown>)[dir] === 's';
      const isInvisible = (cell as Record<string, unknown>)[dir] === 'id';

      // Secret doors: always show button until opened
      if (isSecret) {
        if (openedSet.has(dkey)) continue;
        seen.add(dkey);
        doors.push({ row: r, col: c, dir, type: 's' });
        continue;
      }

      // Normal/invisible doors: only show if neighbor is unrevealed
      const [dr, dc] = CARDINAL_OFFSETS[dir as keyof typeof CARDINAL_OFFSETS];
      const nr = r + dr,
        nc = c + dc;
      const neighborKey = cellKey(nr, nc);
      if (sessionState.revealedCells.has(neighborKey)) continue;
      if (!isInBounds(cells, nr, nc)) continue;
      if (!cells[nr]?.[nc]) continue;

      seen.add(dkey);
      doors.push({ row: r, col: c, dir, type: isInvisible ? 'id' : 'd' });
    }

    // Diagonal doors (nw-se, ne-sw)
    for (const diagDir of ['nw-se', 'ne-sw']) {
      if (
        (cell as Record<string, unknown>)[diagDir] !== 'd' &&
        (cell as Record<string, unknown>)[diagDir] !== 's' &&
        (cell as Record<string, unknown>)[diagDir] !== 'id'
      )
        continue;

      const dkey = `${r},${c},${diagDir}`;
      if (seen.has(dkey)) continue;

      const isSecret = (cell as Record<string, unknown>)[diagDir] === 's';
      const isInvisible = (cell as Record<string, unknown>)[diagDir] === 'id';

      // Secret doors: always show button until opened
      if (isSecret) {
        if (openedSet.has(dkey)) continue;
        seen.add(dkey);
        doors.push({ row: r, col: c, dir: diagDir, type: 's' });
        continue;
      }

      // Normal/invisible doors: check if the OTHER half has unrevealed neighbor cells
      const otherSideDirs = getOtherSideDirs(cell, r, c, diagDir);
      if (!otherSideDirs) continue;

      let hasUnrevealed = false;
      for (const exitDir of otherSideDirs) {
        const { dr, dc } = CARDINAL_DIRS.find((d) => d.dir === exitDir)!;
        const nr = r + dr,
          nc = c + dc;
        if (!isInBounds(cells, nr, nc)) continue;
        if (!cells[nr]?.[nc]) continue;
        if (!sessionState.revealedCells.has(cellKey(nr, nc))) {
          hasUnrevealed = true;
          break;
        }
      }
      if (!hasUnrevealed) continue;

      seen.add(dkey);
      doors.push({ row: r, col: c, dir: diagDir, type: isInvisible ? 'id' : 'd' });
    }
  }
  return mergeDoorRuns(doors);
}

/**
 * Group adjacent cardinal doors of the same direction and type into merged runs.
 * Each merged run produces a single door entry with a `cells` array.
 * Diagonal doors pass through unchanged.
 */
function mergeDoorRuns(doors: { row: number; col: number; dir: string; type: string }[]) {
  // Step direction for grouping: north/south doors run along columns, east/west along rows
  const STEP: Record<string, [number, number]> = { north: [0, 1], south: [0, 1], east: [1, 0], west: [1, 0] };

  type DoorEntry = { row: number; col: number; dir: string; type: string };
  const cardinalDoors: DoorEntry[] = [];
  const otherDoors: DoorEntry[] = [];
  for (const d of doors) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    if (STEP[d.dir]) cardinalDoors.push(d);
    else otherDoors.push(d);
  }

  // Group by direction + type + fixed coordinate (row for N/S, col for E/W)
  const groups: Record<string, DoorEntry[]> = {};
  for (const door of cardinalDoors) {
    const [dr] = STEP[door.dir];
    const fixedCoord = dr === 0 ? door.row : door.col;
    const key = `${door.dir}:${door.type}:${fixedCoord}`;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    if (!groups[key]) groups[key] = [];
    groups[key].push(door);
  }

  const merged = [];
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    const dir = group[0].dir;
    const [dr] = STEP[dir];

    // Sort by step coordinate
    group.sort((a, b) => (dr === 0 ? a.col - b.col : a.row - b.row));

    // Find consecutive runs
    let runStart = 0;
    for (let i = 1; i <= group.length; i++) {
      const prev = group[i - 1];
      const curr = group[i];
      const prevStep = dr === 0 ? prev.col : prev.row;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const currStep = curr ? (dr === 0 ? curr.col : curr.row) : -999;

      if (currStep !== prevStep + 1) {
        const run = group.slice(runStart, i);
        if (run.length === 1) {
          merged.push(run[0]);
        } else {
          merged.push({
            row: run[0].row,
            col: run[0].col,
            dir: run[0].dir,
            type: run[0].type,
            cells: run.map((d: { row: number; col: number }) => ({ row: d.row, col: d.col })),
          });
        }
        runStart = i;
      }
    }
  }

  merged.push(...otherDoors);
  return merged;
}

/**
 * For a diagonal door in a revealed cell, determine which cardinal exit directions
 * belong to the unrevealed (other) half.
 */
function getOtherSideDirs(cell: Cell | null, r: number, c: number, diagDir: string) {
  // Determine which half is revealed by checking which neighbors are revealed
  if (diagDir === 'nw-se') {
    // NE half exits: north, east. SW half exits: south, west.
    const neRevealed = ['north', 'east'].some((d) => {
      const { dr, dc } = CARDINAL_DIRS.find((cd) => cd.dir === d)!;
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return neRevealed ? ['south', 'west'] : ['north', 'east'];
  }
  if (diagDir === 'ne-sw') {
    // NW half exits: north, west. SE half exits: south, east.
    const nwRevealed = ['north', 'west'].some((d) => {
      const { dr, dc } = CARDINAL_DIRS.find((cd) => cd.dir === d)!;
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return nwRevealed ? ['south', 'east'] : ['north', 'west'];
  }
  return null;
}

/**
 * Get the canvas pixel position of a single cell's door midpoint.
 */
function getSingleDoorMidpoint(row: number, col: number, dir: string, gridSize: number, transform: RenderTransform) {
  const x = col * gridSize,
    y = row * gridSize;
  switch (dir) {
    case 'north':
      return toCanvas(x + gridSize / 2, y, transform);
    case 'south':
      return toCanvas(x + gridSize / 2, y + gridSize, transform);
    case 'east':
      return toCanvas(x + gridSize, y + gridSize / 2, transform);
    case 'west':
      return toCanvas(x, y + gridSize / 2, transform);
    case 'nw-se':
      return toCanvas(x + gridSize / 2, y + gridSize / 2, transform);
    case 'ne-sw':
      return toCanvas(x + gridSize / 2, y + gridSize / 2, transform);
  }
}

/**
 * Get the canvas pixel position of a door midpoint.
 * For merged doors (with a `cells` array), returns the center of the full run.
 */
function getDoorMidpoint(
  door: { row: number; col: number; dir: string; cells?: { row: number; col: number }[] },
  gridSize: number,
  transform: RenderTransform,
) {
  if (door.cells && door.cells.length > 1) {
    const first = door.cells[0];
    const last = door.cells[door.cells.length - 1];
    const p1 = getSingleDoorMidpoint(first.row, first.col, door.dir, gridSize, transform);
    const p2 = getSingleDoorMidpoint(last.row, last.col, door.dir, gridSize, transform);
    return { x: (p1!.x + p2!.x) / 2, y: (p1!.y + p2!.y) / 2 };
  }
  return getSingleDoorMidpoint(door.row, door.col, door.dir, gridSize, transform);
}

/**
 * Draw a small open-door icon using canvas paths.
 */
function drawDoorIcon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  const r = radius;

  // Background circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Open door icon: a door frame with an open door
  const s = r * 0.55;
  ctx.save();
  ctx.translate(x, y);

  // Door frame (rectangle)
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-s, -s, s * 2, s * 2);

  // Open door panel (angled line from left side)
  ctx.beginPath();
  ctx.moveTo(-s, -s);
  ctx.lineTo(-s * 0.2, -s * 0.3);
  ctx.lineTo(-s * 0.2, s * 0.3);
  ctx.lineTo(-s, s);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

/**
 * Render door-open and stair overlay buttons on the DM canvas.
 * @param {CanvasRenderingContext2D} ctx - The canvas 2D context.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @returns {void}
 */
export function renderSessionOverlay(
  ctx: CanvasRenderingContext2D,
  transform: RenderTransform,
  gridSize: number,
): void {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return;

  // Door buttons
  const doors = findRevealableDoors();
  for (const door of doors) {
    const p = getDoorMidpoint(door, gridSize, transform);
    const color =
      door.type === 's'
        ? 'rgba(220, 60, 60, 0.85)'
        : door.type === 'id'
          ? 'rgba(80, 130, 255, 0.85)'
          : 'rgba(60, 180, 170, 0.85)';
    drawDoorIcon(ctx, p!.x, p!.y, DOOR_BUTTON_RADIUS, color);
  }

  // Stair buttons
  const stairs = findRevealableStairs();
  for (const stair of stairs) {
    const p = getStairButtonPos(stair, transform);
    drawStairIcon(ctx, p.x, p.y, STAIR_BUTTON_RADIUS);
  }
}

/**
 * Test if a click hits a door overlay button.
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @returns {Object|null} The door object if hit, or null.
 */
export function hitTestDoorButton(
  px: number,
  py: number,
  transform: RenderTransform,
  gridSize: number,
): { row: number; col: number; dir: string; cells?: { row: number; col: number }[] } | null {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return null;

  const doors = findRevealableDoors();
  for (const door of doors) {
    const p = getDoorMidpoint(door, gridSize, transform);
    const dx = px - p!.x,
      dy = py - p!.y;
    if (dx * dx + dy * dy <= DOOR_BUTTON_RADIUS * DOOR_BUTTON_RADIUS) {
      return door;
    }
  }
  return null;
}

// ── Stair overlay (DM canvas) ─────────────────────────────────────────────

const STAIR_BUTTON_RADIUS = 10;

/**
 * Find all linked stairs where this end is revealed and the partner end is not.
 */
function findRevealableStairs() {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const stairs = state.dungeon.metadata.stairs || [];
  const gridSize = state.dungeon.metadata.gridSize;
  const result = [];
  const seen = new Set();

  for (const stairDef of stairs) {
    if (!stairDef.link) continue;
    if (sessionState.openedStairs.includes(stairDef.id)) continue;

    // Compute occupied cells
    const shape = classifyStairShape(stairDef.points[0], stairDef.points[1], stairDef.points[2]);
    const occupied = getOccupiedCells(shape.vertices);

    // At least one occupied cell must be revealed
    const hasRevealed = occupied.some(({ row, col }) => sessionState.revealedCells.has(cellKey(row, col)));
    if (!hasRevealed) continue;

    // Find linked partner
    const partner = stairs.find((s) => s.link === stairDef.link && s.id !== stairDef.id);
    if (!partner) continue;

    // Partner must have at least one unrevealed cell
    const partnerShape = classifyStairShape(partner.points[0], partner.points[1], partner.points[2]);
    const partnerCells = getOccupiedCells(partnerShape.vertices);
    const partnerHasUnrevealed = partnerCells.some(
      ({ row, col }) => !sessionState.revealedCells.has(cellKey(row, col)),
    );
    if (!partnerHasUnrevealed) continue;

    // Deduplicate pairs
    const pairKey = [stairDef.id, partner.id].sort().join(',');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    // Button position: NW corner of bounding box (matching label badge)
    const bbox = stairBoundingBox(stairDef.points);
    result.push({
      stairId: stairDef.id,
      partnerId: partner.id,
      link: stairDef.link,
      worldX: bbox.minCol * gridSize,
      worldY: bbox.minRow * gridSize,
    });
  }
  return result;
}

/**
 * Get canvas position for a stair button (offset from NW corner, matching label badge).
 */
function getStairButtonPos(stair: { worldX: number; worldY: number }, transform: RenderTransform) {
  const p = toCanvas(stair.worldX, stair.worldY, transform);
  const s = transform.scale / 10;
  return { x: p.x + 10 * s, y: p.y + 10 * s };
}

/**
 * Draw an amber stair-open button.
 */
function drawStairIcon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  const r = radius;

  // Background circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(220, 170, 50, 0.85)';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Stair steps icon: 3 staggered horizontal lines
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  const s = r * 0.5;
  for (let i = -1; i <= 1; i++) {
    const yy = i * s * 0.6;
    const xx = i * s * 0.3;
    ctx.beginPath();
    ctx.moveTo(xx - s * 0.5, yy);
    ctx.lineTo(xx + s * 0.5, yy);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Test if a click hits a stair overlay button.
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform.
 * @returns {Object|null} The stair object if hit, or null.
 */
export function hitTestStairButton(
  px: number,
  py: number,
  transform: RenderTransform,
): { stairId: number; partnerId: number; worldX: number; worldY: number } | null {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return null;

  const stairs = findRevealableStairs();
  for (const stair of stairs) {
    const p = getStairButtonPos(stair, transform);
    const dx = px - p.x,
      dy = py - p.y;
    if (dx * dx + dy * dy <= STAIR_BUTTON_RADIUS * STAIR_BUTTON_RADIUS) {
      return stair;
    }
  }
  return null;
}

/**
 * Open a linked stair pair and reveal the room at the partner's end.
 * @param {number} stairId - ID of the stair being opened.
 * @param {number} partnerId - ID of the linked partner stair.
 * @returns {void}
 */
export function openStairs(stairId: number, partnerId: number): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const stairs = state.dungeon.metadata.stairs || [];

  // Record both IDs as opened
  sessionState.openedStairs.push(stairId, partnerId);

  // BFS reveal from the partner stair's first occupied cell
  const partner = stairs.find((s) => s.id === partnerId);
  let allNewCells: string[] = [];
  let partnerRow = null;
  if (partner) {
    const partnerShape = classifyStairShape(partner.points[0], partner.points[1], partner.points[2]);
    const partnerCells = getOccupiedCells(partnerShape.vertices);
    if (partnerCells.length > 0) {
      partnerRow = partnerCells[0].row;
      allNewCells = revealRoom(partnerRow, partnerCells[0].col);
    }
  }

  // Broadcast
  send({ type: 'stairs:open', stairIds: [stairId, partnerId] });
  if (allNewCells.length > 0) {
    send({ type: 'fog:reveal', cells: allNewCells, duration: 500 });
  }

  // Auto-pan to the partner stair's level
  if (partnerRow !== null) {
    const levels = state.dungeon.metadata.levels;
    if (levels.length) {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (partnerRow >= levels[i].startRow) {
          state.currentLevel = i;
          panToLevel(levels[i].startRow, levels[i].numRows);
          break;
        }
      }
    }
  }

  requestRender();
  notify();
}

// ── Debug: dump cell data + fog state for a region ──────────────────────────

/**
 * Dump cell data and fog state for a rectangular region (debug helper).
 * @param {number} r1 - First corner row.
 * @param {number} c1 - First corner column.
 * @param {number} r2 - Second corner row.
 * @param {number} c2 - Second corner column.
 * @returns {Array|null} 2D array of cell debug info, or null if debug panel is disabled.
 */
export function dumpFogRegion(r1: number, c1: number, r2: number, c2: number): Record<string, unknown>[][] | null {
  if (!getEditorSettings().debug) {
    console.log('[dumpFogRegion] Enable the debug panel first (View > Developer > Debug Panel)');
    return null;
  }
  const cells = state.dungeon.cells;
  const minR = Math.min(r1, r2),
    maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2),
    maxC = Math.max(c1, c2);

  const result = [];
  for (let r = minR; r <= maxR; r++) {
    const row = [];
    for (let c = minC; c <= maxC; c++) {
      const cell = cells[r]?.[c];
      const revealed = sessionState.revealedCells.has(cellKey(r, c));
      if (!cell) {
        row.push({ r, c, type: 'null', revealed });
      } else {
        // Full deep clone of cell data — don't cherry-pick properties
        const entry = JSON.parse(JSON.stringify(cell));
        entry.r = r;
        entry.c = c;
        entry.revealed = revealed;
        entry.type = cell.trimClip ? 'trimArc' : 'floor';
        row.push(entry);
      }
    }
    result.push(row);
  }

  // Download as JSON file
  const json = JSON.stringify({ r1: minR, c1: minC, r2: maxR, c2: maxC, cells: result }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fog-debug-${minR}-${minC}-${maxR}-${maxC}.json`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`[dumpFogRegion] Downloaded fog-debug-${minR}-${minC}-${maxR}-${maxC}.json`);
  return result;
}

// Expose on window for console access
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).dumpFogRegion = dumpFogRegion;
}
