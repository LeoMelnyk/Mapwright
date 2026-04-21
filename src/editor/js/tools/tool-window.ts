// Window tool: click on cardinal cell edges to place/toggle windows with the
// currently selected gobo. Windows mark the edge as `'win'` (which blocks
// light like a wall) and record a metadata.windows entry so the lighting
// pipeline can project the gobo pattern through the window's aperture.
//
// When this tool is active, small stained-glass edit-icons float over every
// placed window. Clicking an icon opens a popover to change that window's
// gobo and tint color. The icon hit-test runs before placement, so clicking
// an icon never places a new window underneath.

import type { CardinalDirection, Direction, EdgeValue, RenderTransform, Window as WindowDef } from '../../../types.js';
import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { mutate } from '../state.js';
import {
  isInBounds,
  setEdgeReciprocal,
  deleteEdgeReciprocal,
  getEdge,
  CARDINAL_OFFSETS,
  OPPOSITE,
} from '../../../util/index.js';
import { markDirtyFullRebuild, WINDOW_Z_BOTTOM, WINDOW_Z_TOP } from '../../../render/index.js';
import { getTransform, requestRender, setCursor } from '../canvas-view.js';
import { getGoboCatalog, loadGoboCatalog } from '../gobo-catalog.js';

const CARDINALS: readonly CardinalDirection[] = ['north', 'south', 'east', 'west'];
const DIAGONALS = ['nw-se', 'ne-sw'] as const;
type WindowDir = WindowDef['direction'];

/** Pixel radius of the edit icon on the canvas. */
const ICON_RADIUS = 9;

/**
 * Normalize an edge to its canonical (row, col, direction) form. For
 * cardinals: south becomes north of (r+1, c), east becomes west of (r, c+1).
 * For diagonals: no canonicalization needed — diagonals live on a single
 * cell with no reciprocal, so the stored direction matches the edge.
 */
function canonicalizeEdge(
  row: number,
  col: number,
  direction: string,
): { row: number; col: number; direction: WindowDir } | null {
  if ((DIAGONALS as readonly string[]).includes(direction)) {
    return { row, col, direction: direction as WindowDir };
  }
  if (!CARDINALS.includes(direction as CardinalDirection)) return null;
  if (direction === 'north') return { row, col, direction: 'north' };
  if (direction === 'west') return { row, col, direction: 'west' };
  const offsets = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;
  const [dr, dc] = offsets[direction]!;
  const opp = OPPOSITE[direction as CardinalDirection] as 'north' | 'west';
  return { row: row + dr, col: col + dc, direction: opp };
}

/**
 * Compute the canvas-pixel center of a window's edit icon. For cardinals the
 * icon sits on the edge midpoint; for diagonals it sits on the cell center.
 */
function windowIconCenter(w: WindowDef, gridSize: number, transform: RenderTransform): { x: number; y: number } {
  const x = w.col * gridSize;
  const y = w.row * gridSize;
  let fx = x + gridSize / 2;
  let fy = y + gridSize / 2;
  if (w.direction === 'north') fy = y;
  else if (w.direction === 'west') fx = x;
  return {
    x: fx * transform.scale + transform.offsetX,
    y: fy * transform.scale + transform.offsetY,
  };
}

/**
 * Draw a small stained-glass tile icon — a rounded square whose fill matches
 * the window's `tintColor` so tinted windows are visible at a glance. When
 * `hovered` is true, the icon grows slightly and picks up a bright outline.
 */
function drawWindowEditIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tintColor: string | undefined,
  hovered: boolean,
): void {
  const scale = hovered ? 1.25 : 1;
  const r = ICON_RADIUS * scale;
  ctx.save();

  // Dark background disc so the icon reads against bright floors.
  ctx.beginPath();
  ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = hovered ? 'rgba(10,10,20,0.9)' : 'rgba(20,20,30,0.75)';
  ctx.fill();

  // Stained-glass square.
  const s = r * 0.85;
  ctx.fillStyle = tintColor?.length ? tintColor : '#d8d8d0';
  ctx.strokeStyle = hovered ? '#ffd866' : '#ffffff';
  ctx.lineWidth = hovered ? 2 : 1.25;
  ctx.beginPath();
  ctx.rect(x - s, y - s, s * 2, s * 2);
  ctx.fill();
  ctx.stroke();

  // Leaded-mullion cross so it reads as a window even without a tint.
  ctx.strokeStyle = hovered ? 'rgba(255, 216, 102, 0.9)' : 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - s, y);
  ctx.lineTo(x + s, y);
  ctx.moveTo(x, y - s);
  ctx.lineTo(x, y + s);
  ctx.stroke();

  ctx.restore();
}

/** Window tool: click an edge to place a window, click again to remove. */
export class WindowTool extends Tool {
  /** Popover DOM (lazy-created, reused). */
  private popover: HTMLDivElement | null = null;
  /** Cleanup handlers installed while popover is open. */
  private popoverCleanup: (() => void) | null = null;
  /** The window under the cursor, if any — drives the hover highlight. */
  private hoveredIconWin: WindowDef | null = null;
  /** The window whose popover is currently open — stays highlighted. */
  private popoverWin: WindowDef | null = null;

  constructor() {
    super('window', 'W', 'pointer');
  }

  onActivate() {
    state.statusInstruction = 'Click a wall to place window · Click the icon to edit gobo/tint · Right-click to remove';
  }

  onDeactivate() {
    state.statusInstruction = null;
    this.hoveredIconWin = null;
    this.closePopover();
  }

  onMouseMove(_row: number, _col: number, _edge: EdgeInfo | null, _event: MouseEvent | null, pos: CanvasPos | null) {
    const hit = pos ? this.hitTestIcon(pos) : null;
    const changed = hit !== this.hoveredIconWin;
    this.hoveredIconWin = hit;
    if (hit) {
      // Hovering an icon: suppress the wall-placement ghost and switch to a
      // click-pointer cursor so the icon reads as clickable.
      state.hoveredEdge = null;
      setCursor('pointer');
    } else {
      setCursor(this.cursor);
    }
    if (changed) requestRender();
  }

  onRightClick(row: number, col: number, edge: EdgeInfo | null) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;
    if (!isInBounds(cells, er, ec)) return;
    const cell = cells[er]?.[ec];
    if (!cell) return;
    if (getEdge(cell, direction as Direction) !== 'win') return;

    const canon = canonicalizeEdge(er, ec, direction);
    if (!canon) return;

    const coords: Array<{ row: number; col: number }> = [{ row: er, col: ec }];
    const offsets = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;
    const offset = offsets[direction];
    if (offset && isInBounds(cells, er + offset[0], ec + offset[1])) {
      coords.push({ row: er + offset[0], col: ec + offset[1] });
    }

    mutate(
      'Remove window',
      coords,
      () => {
        deleteEdgeReciprocal(cells, er, ec, direction);
        removeWindowEntry(canon.row, canon.col, canon.direction);
      },
      { invalidate: ['lighting'], forceGeometry: true },
    );
    // Window changes have non-local lighting effects (sunpool/gobo projections
    // reach cells far from the edited edge). Force a full composite rebuild so
    // MapCache doesn't take the clipped-to-dirty-region fast path.
    markDirtyFullRebuild();
    this.closePopover();
  }

  onMouseDown(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent | null, pos: CanvasPos | null) {
    // Icon hit-test runs before placement. If the user clicked an edit icon
    // for a placed window, open its popover and swallow the click.
    if (pos) {
      const hit = this.hitTestIcon(pos);
      if (hit) {
        this.openPopover(hit, event ?? null);
        return;
      }
    }
    // Click landed off any icon — if a popover is open, treat this as
    // dismissal rather than a new placement.
    if (this.popover) {
      this.closePopover();
      return;
    }

    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;
    if (!isInBounds(cells, er, ec)) return;

    const canon = canonicalizeEdge(er, ec, direction);
    if (!canon) return;

    const cell = cells[er]![ec] ?? {};
    const currentlyWindow = (cell as Record<string, unknown>)[direction] === 'win';
    const goboId = state.windowGobo || 'window-mullions';

    const coords: Array<{ row: number; col: number }> = [{ row: er, col: ec }];
    const offsets = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;
    const offset = offsets[direction];
    if (offset && isInBounds(cells, er + offset[0], ec + offset[1])) {
      coords.push({ row: er + offset[0], col: ec + offset[1] });
    }

    if (currentlyWindow) {
      // Existing window: if the gobo matches, toggle off; otherwise swap gobo
      // in place. Feels natural when dragging across an existing run to
      // convert it to a different style, or clicking again to remove.
      const existing = findWindowEntry(canon.row, canon.col, canon.direction);
      if (existing?.goboId === goboId) {
        mutate(
          'Remove window',
          coords,
          () => {
            setEdgeReciprocal(cells, er, ec, direction, 'w');
            removeWindowEntry(canon.row, canon.col, canon.direction);
          },
          { invalidate: ['lighting'], forceGeometry: true },
        );
      } else {
        mutate(
          'Change window gobo',
          coords,
          () => {
            upsertWindowEntry(canon.row, canon.col, canon.direction, goboId);
          },
          { invalidate: ['lighting'], forceGeometry: true },
        );
      }
      markDirtyFullRebuild();
      return;
    }

    mutate(
      'Add window',
      coords,
      () => {
        cells[er]![ec] ??= {};
        setEdgeReciprocal(cells, er, ec, direction, 'win' as EdgeValue);
        upsertWindowEntry(canon.row, canon.col, canon.direction, goboId);
      },
      { invalidate: ['lighting'], forceGeometry: true },
    );
    markDirtyFullRebuild();
  }

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
    const windows = state.dungeon.metadata.windows;
    if (!windows?.length) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const hovered = this.hoveredIconWin;
    const active = this.popoverWin;
    for (const win of windows) {
      if (!isLiveWindow(win)) continue;
      const { x, y } = windowIconCenter(win, gridSize, transform);
      const margin = ICON_RADIUS * 2;
      if (x < -margin || x > w + margin || y < -margin || y > h + margin) continue;
      drawWindowEditIcon(ctx, x, y, win.tintColor, win === hovered || win === active);
    }
  }

  /** Return the window under the given canvas-pixel position, or null. */
  private hitTestIcon(pos: CanvasPos): WindowDef | null {
    const windows = state.dungeon.metadata.windows;
    if (!windows?.length) return null;
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const r2 = (ICON_RADIUS + 1) * (ICON_RADIUS + 1);
    for (const win of windows) {
      if (!isLiveWindow(win)) continue;
      const c = windowIconCenter(win, gridSize, transform);
      const dx = pos.x - c.x;
      const dy = pos.y - c.y;
      if (dx * dx + dy * dy <= r2) return win;
    }
    return null;
  }

  /** Build (or reuse) the popover and anchor it near the clicked icon. */
  private openPopover(win: WindowDef, event: MouseEvent | null) {
    this.closePopover();

    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const anchor = windowIconCenter(win, gridSize, transform);

    // Icon center is in canvas-pixel coordinates. To position a body-anchored
    // `position: fixed` element, add the canvas's viewport offset.
    const canvas = document.querySelector<HTMLCanvasElement>('canvas');
    const canvasRect = canvas?.getBoundingClientRect();
    const viewportX = anchor.x + (canvasRect?.left ?? 0);
    const viewportY = anchor.y + (canvasRect?.top ?? 0);

    const popover = document.createElement('div');
    popover.className = 'window-edit-popover';
    popover.setAttribute('role', 'dialog');
    popover.innerHTML = `
      <div class="window-edit-row">
        <label>Gobo</label>
        <select class="window-edit-gobo toolbar-select"></select>
      </div>
      <div class="window-edit-row">
        <label>Tint</label>
        <input type="color" class="window-edit-tint" />
        <button type="button" class="window-edit-clear" title="Remove tint">Clear</button>
      </div>
      <div class="window-edit-row">
        <label>Floor</label>
        <input type="number" class="window-edit-floor" min="0" max="20" step="1" />
        <span class="window-edit-unit">ft</span>
      </div>
      <div class="window-edit-row">
        <label>Ceiling</label>
        <input type="number" class="window-edit-ceiling" min="0" max="20" step="1" />
        <span class="window-edit-unit">ft</span>
      </div>
    `;

    // Use `fixed` so layout is independent of document scroll / ancestors.
    popover.style.position = 'fixed';
    popover.style.left = `${viewportX + ICON_RADIUS + 6}px`;
    popover.style.top = `${viewportY - ICON_RADIUS}px`;
    document.body.appendChild(popover);
    clampToViewport(popover);

    const select = popover.querySelector<HTMLSelectElement>('.window-edit-gobo')!;
    const tintInput = popover.querySelector<HTMLInputElement>('.window-edit-tint')!;
    const clearBtn = popover.querySelector<HTMLButtonElement>('.window-edit-clear')!;
    const floorInput = popover.querySelector<HTMLInputElement>('.window-edit-floor')!;
    const ceilingInput = popover.querySelector<HTMLInputElement>('.window-edit-ceiling')!;

    tintInput.value = win.tintColor?.length ? win.tintColor : '#ffffff';
    floorInput.value = String(win.floorHeight ?? WINDOW_Z_BOTTOM);
    ceilingInput.value = String(win.ceilingHeight ?? WINDOW_Z_TOP);

    // Populate gobo options (async if catalog isn't loaded yet).
    void populateGoboOptions(select, win.goboId);

    select.addEventListener('change', () => {
      updateWindow(win, { goboId: select.value });
    });
    tintInput.addEventListener('input', () => {
      updateWindow(win, { tintColor: tintInput.value });
    });
    clearBtn.addEventListener('click', () => {
      updateWindow(win, { tintColor: null });
      tintInput.value = '#ffffff';
    });

    // Floor/ceiling are commit-on-change (not every keystroke) so mid-typing
    // values like "1" on the way to "12" don't temporarily clamp the ceiling.
    const commitHeights = () => {
      const floor = clampHeight(parseFloat(floorInput.value));
      let ceiling = clampHeight(parseFloat(ceilingInput.value));
      // Ceiling can't be below floor — pull it up to match if the user tried.
      if (ceiling < floor) ceiling = floor;
      floorInput.value = String(floor);
      ceilingInput.value = String(ceiling);
      updateWindow(win, { floorHeight: floor, ceilingHeight: ceiling });
    };
    floorInput.addEventListener('change', commitHeights);
    ceilingInput.addEventListener('change', commitHeights);

    // Dismissal: click outside, Escape key, or canvas pan/zoom wheel.
    const onDocMouseDown = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node)) this.closePopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closePopover();
      }
    };
    // Defer the outside-click listener by one frame so the originating
    // mousedown (which opened the popover) doesn't immediately close it.
    setTimeout(() => document.addEventListener('mousedown', onDocMouseDown, true), 0);
    document.addEventListener('keydown', onKey, true);

    this.popover = popover;
    this.popoverWin = win;
    requestRender();
    this.popoverCleanup = () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
    };

    // Prevent the current event from bubbling further.
    event?.stopPropagation();
  }

  private closePopover() {
    if (this.popoverCleanup) {
      this.popoverCleanup();
      this.popoverCleanup = null;
    }
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
    }
    if (this.popoverWin) {
      this.popoverWin = null;
      requestRender();
    }
  }
}

function clampToViewport(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const margin = 8;
  if (rect.right > window.innerWidth - margin) {
    el.style.left = `${window.innerWidth - rect.width - margin}px`;
  }
  if (rect.bottom > window.innerHeight - margin) {
    el.style.top = `${window.innerHeight - rect.height - margin}px`;
  }
  if (rect.left < margin) el.style.left = `${margin}px`;
  if (rect.top < margin) el.style.top = `${margin}px`;
}

async function populateGoboOptions(select: HTMLSelectElement, currentId: string) {
  let catalog = getGoboCatalog();
  catalog ??= await loadGoboCatalog();
  select.innerHTML = '';
  const ordered = catalog.names.includes('none')
    ? ['none', ...catalog.names.filter((id) => id !== 'none')]
    : catalog.names;
  for (const id of ordered) {
    const def = catalog.gobos[id];
    if (!def) continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = def.name || id;
    if (def.description) opt.title = def.description;
    select.appendChild(opt);
  }
  select.value = catalog.names.includes(currentId) ? currentId : (catalog.names[0] ?? 'window-mullions');
}

/**
 * Guard against stale metadata: only treat a window entry as "live" if the
 * underlying cell still has the stored edge marked as `'win'`. Prevents
 * phantom icons when a wall-tool overwrite or a failed undo leaves an orphan
 * entry in `metadata.windows`.
 */
function isLiveWindow(win: WindowDef): boolean {
  const cells = state.dungeon.cells;
  if (!isInBounds(cells, win.row, win.col)) return false;
  const cell = cells[win.row]?.[win.col];
  if (!cell) return false;
  return (cell as Record<string, unknown>)[win.direction] === 'win';
}

function findWindowEntry(row: number, col: number, direction: WindowDir): WindowDef | null {
  const meta = state.dungeon.metadata;
  const list = meta.windows;
  if (!list) return null;
  return list.find((w) => w.row === row && w.col === col && w.direction === direction) ?? null;
}

function upsertWindowEntry(row: number, col: number, direction: WindowDir, goboId: string): void {
  const meta = state.dungeon.metadata;
  meta.windows ??= [];
  const existing = meta.windows.find((w) => w.row === row && w.col === col && w.direction === direction);
  if (existing) {
    existing.goboId = goboId;
  } else {
    meta.windows.push({ row, col, direction, goboId });
  }
}

function removeWindowEntry(row: number, col: number, direction: WindowDir): void {
  const meta = state.dungeon.metadata;
  const list = meta.windows;
  if (!list?.length) return;
  const idx = list.findIndex((w) => w.row === row && w.col === col && w.direction === direction);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) delete meta.windows;
}

/** Clamp a window height (floor or ceiling) to the valid [0, 20] ft range. */
function clampHeight(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 20) return 20;
  return n;
}

/** Mutate a specific window's gobo, tint color, and/or aperture heights. Passing `tintColor: null` removes the tint. */
function updateWindow(
  target: WindowDef,
  changes: {
    goboId?: string;
    tintColor?: string | null;
    floorHeight?: number;
    ceilingHeight?: number;
  },
): void {
  const { row, col, direction } = target;
  mutate(
    'Edit window',
    [{ row, col }],
    () => {
      const meta = state.dungeon.metadata;
      const entry = meta.windows?.find((w) => w.row === row && w.col === col && w.direction === direction);
      if (!entry) return;
      if (changes.goboId !== undefined) {
        entry.goboId = changes.goboId;
        target.goboId = changes.goboId;
      }
      if (changes.tintColor !== undefined) {
        if (changes.tintColor === null || changes.tintColor === '') {
          delete entry.tintColor;
          delete target.tintColor;
        } else {
          entry.tintColor = changes.tintColor;
          target.tintColor = changes.tintColor;
        }
      }
      if (changes.floorHeight !== undefined) {
        entry.floorHeight = changes.floorHeight;
        target.floorHeight = changes.floorHeight;
      }
      if (changes.ceilingHeight !== undefined) {
        entry.ceilingHeight = changes.ceilingHeight;
        target.ceilingHeight = changes.ceilingHeight;
      }
    },
    { invalidate: ['lighting'] },
  );
  markDirtyFullRebuild();
  requestRender();
}
