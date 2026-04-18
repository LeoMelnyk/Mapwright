// prop-edit.ts — Floating, draggable dialog for editing a selected prop.
//
// Opens on double-click or Enter (via tool-prop.ts). Closes when the prop is
// deselected, the map changes, or the user clicks the × / Enter / Esc.
//
// Semantics:
//  - On open: captures a snapshot of the overlay's editable fields + any
//    linked lights, and pushes a single undo entry. Live field edits mutate
//    the overlay in place without pushing further undos, so the whole edit
//    session is one Ctrl+Z.
//  - On Apply (close button / Enter / click outside / deselect): changes
//    persist; the pushed undo entry lets the user revert in one step.
//  - On Revert (Esc): the snapshot is restored and our undo entry is popped,
//    leaving the undo stack untouched.
//
// The dialog is single-selection. If the user selects multiple props it
// auto-closes (applying any in-flight edits).
import type { Light, Metadata, OverlayProp, PropDefinition } from '../../../types.js';
import state, { invalidateLightmap, markDirty, notify, pushUndo, subscribe } from '../state.js';
import { markPropSpatialDirty } from '../prop-spatial.js';
import { refreshLinkedLights, visibleAnchorOf } from '../prop-overlay.js';
import { requestRender } from '../canvas-view.js';

// ─── Module state ────────────────────────────────────────────────────────────

interface LightSnapshot {
  id: number;
  x: number;
  y: number;
  radius: number;
  color: string;
  intensity: number;
}

interface PropSnapshot {
  id: number | string;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  zIndex: number;
  flipped: boolean;
  lights: LightSnapshot[];
}

let panel: HTMLDivElement | null = null;
let header: HTMLDivElement | null = null;
let body: HTMLDivElement | null = null;
let currentOverlay: OverlayProp | null = null;
let snapshot: PropSnapshot | null = null;
let undoDepthOnOpen = -1;
let isOpen = false;

// Draggable-header state
const drag = { active: false, offsetX: 0, offsetY: 0 };

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e;
}

function findLinkedLights(overlay: OverlayProp, meta: Metadata, propDef: PropDefinition | undefined): Light[] {
  const gs = meta.gridSize || 5;
  const anchor = visibleAnchorOf(overlay, propDef, gs);
  return meta.lights.filter((l) => l.propRef?.row === anchor.row && l.propRef.col === anchor.col);
}

function takeSnapshot(overlay: OverlayProp, lights: Light[]): PropSnapshot {
  return {
    id: overlay.id,
    x: overlay.x,
    y: overlay.y,
    rotation: overlay.rotation,
    scale: overlay.scale,
    zIndex: overlay.zIndex,
    flipped: overlay.flipped,
    lights: lights.map((l) => ({
      id: l.id,
      x: l.x,
      y: l.y,
      radius: l.radius,
      color: l.color,
      intensity: l.intensity,
    })),
  };
}

/** Apply current overlay/lights state change to renderer/caches. */
function commitRenderChange(): void {
  markPropSpatialDirty();
  invalidateLightmap('props');
  markDirty();
  notify('props');
  requestRender();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderBody(overlay: OverlayProp, propDef: PropDefinition | undefined, lights: Light[]): void {
  if (!body) return;
  const gs = state.dungeon.metadata.gridSize || 5;
  const displayName = propDef?.name ?? overlay.type;

  // Derive visible-anchor row/col (sub-cell fractions preserved) so the user
  // sees the cell they'd expect; `x/y` are stored in world-feet.
  const fRows = propDef?.footprint[0] ?? 1;
  const fCols = propDef?.footprint[1] ?? 1;
  const rNorm = ((overlay.rotation % 360) + 360) % 360;
  const isR90 = rNorm === 90 || rNorm === 270;
  const eRows = isR90 ? fCols : fRows;
  const eCols = isR90 ? fRows : fCols;
  const visRow = overlay.y / gs + (fRows - eRows) / 2;
  const visCol = overlay.x / gs + (fCols - eCols) / 2;

  body.innerHTML = '';

  // Prop name + type (readonly header row)
  const titleEl = document.getElementById('pe-header-title');
  if (titleEl) titleEl.textContent = `Edit: ${displayName}`;

  addSection(body, 'Position');
  addNumberRow(body, 'Row', 'row', visRow, 0.25, (v) => setVisibleAnchor(v, null));
  addNumberRow(body, 'Col', 'col', visCol, 0.25, (v) => setVisibleAnchor(null, v));

  addSection(body, 'Transform');
  addNumberRow(body, 'Rotation', 'rotation', Math.round(overlay.rotation), 1, (v) => setRotation(v), {
    min: 0,
    max: 359,
    rightButton: {
      label: 'Snap 90°',
      onClick: () => {
        const snapped = Math.round(overlay.rotation / 90) * 90;
        setRotation(((snapped % 360) + 360) % 360);
        refreshFromState();
      },
    },
  });
  addNumberRow(body, 'Scale', 'scale', overlay.scale, 0.05, (v) => setScale(v), { min: 0.25, max: 4.0 });
  addCheckRow(body, 'Flipped', 'flipped', overlay.flipped, (v) => setFlipped(v));

  addSection(body, 'Layering');
  addZIndexRow(body, overlay.zIndex, (v) => setZIndex(v));

  if (lights.length) {
    addSection(body, lights.length === 1 ? 'Linked Light' : `Linked Lights (${lights.length})`);
    lights.forEach((light, idx) => {
      const prefix = lights.length > 1 ? `#${idx + 1} ` : '';
      addNumberRow(
        body!,
        `${prefix}Radius`,
        `light-${light.id}-radius`,
        light.radius,
        1,
        (v) => setLightField(light.id, 'radius', Math.max(0, v)),
        { min: 0, max: 100 },
      );
      addNumberRow(
        body!,
        `${prefix}Intensity`,
        `light-${light.id}-intensity`,
        light.intensity,
        0.05,
        (v) => setLightField(light.id, 'intensity', Math.max(0, Math.min(2, v))),
        { min: 0, max: 2 },
      );
      addColorRow(body!, `${prefix}Color`, `light-${light.id}-color`, light.color, (v) =>
        setLightField(light.id, 'color', v),
      );
    });
  }
}

function addSection(parent: HTMLElement, title: string): void {
  const h = document.createElement('div');
  h.className = 'pe-section-title';
  h.textContent = title;
  parent.appendChild(h);
}

interface NumberRowOptions {
  min?: number;
  max?: number;
  rightButton?: { label: string; onClick: () => void };
}

function addNumberRow(
  parent: HTMLElement,
  label: string,
  id: string,
  value: number,
  step: number,
  onChange: (v: number) => void,
  options: NumberRowOptions = {},
): void {
  const row = document.createElement('div');
  row.className = 'pe-row';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  lbl.htmlFor = `pe-${id}`;
  const input = document.createElement('input');
  input.type = 'number';
  input.id = `pe-${id}`;
  input.step = String(step);
  if (options.min != null) input.min = String(options.min);
  if (options.max != null) input.max = String(options.max);
  input.value = formatNumber(value);
  input.addEventListener('input', () => {
    const n = parseFloat(input.value);
    if (!Number.isFinite(n)) return;
    onChange(n);
  });
  row.appendChild(lbl);
  row.appendChild(input);
  if (options.rightButton) {
    const btn = document.createElement('button');
    btn.className = 'pe-btn';
    btn.type = 'button';
    btn.textContent = options.rightButton.label;
    btn.addEventListener('click', options.rightButton.onClick);
    row.appendChild(btn);
  } else {
    const spacer = document.createElement('span');
    row.appendChild(spacer);
  }
  parent.appendChild(row);
}

function addCheckRow(
  parent: HTMLElement,
  label: string,
  id: string,
  value: boolean,
  onChange: (v: boolean) => void,
): void {
  const row = document.createElement('div');
  row.className = 'pe-row';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  lbl.htmlFor = `pe-${id}`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `pe-${id}`;
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  row.appendChild(lbl);
  row.appendChild(input);
  row.appendChild(document.createElement('span'));
  parent.appendChild(row);
}

function addColorRow(
  parent: HTMLElement,
  label: string,
  id: string,
  value: string,
  onChange: (v: string) => void,
): void {
  const row = document.createElement('div');
  row.className = 'pe-row';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  lbl.htmlFor = `pe-${id}`;
  const input = document.createElement('input');
  input.type = 'color';
  input.id = `pe-${id}`;
  input.value = normalizeHexColor(value);
  input.addEventListener('input', () => onChange(input.value));
  row.appendChild(lbl);
  row.appendChild(input);
  row.appendChild(document.createElement('span'));
  parent.appendChild(row);
}

/** Z-index combines a named preset dropdown with a raw number input. */
function addZIndexRow(parent: HTMLElement, value: number, onChange: (v: number) => void): void {
  const row = document.createElement('div');
  row.className = 'pe-row';
  const lbl = document.createElement('label');
  lbl.textContent = 'Z-index';
  lbl.htmlFor = 'pe-zindex';

  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'pe-zindex';
  input.step = '1';
  input.min = '0';
  input.value = String(value);
  input.addEventListener('input', () => {
    const n = parseInt(input.value, 10);
    if (!Number.isFinite(n)) return;
    const v = Math.max(0, n);
    onChange(v);
    syncSelect();
  });

  const select = document.createElement('select');
  select.className = 'pe-btn';
  const presets: Array<[string, number]> = [
    ['Floor', 0],
    ['Furniture', 10],
    ['Tall', 20],
    ['Hanging', 30],
    ['Custom', -1],
  ];
  for (const [label, n] of presets) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = label;
    select.appendChild(opt);
  }
  const syncSelect = () => {
    const match = presets.find(([, n]) => n === parseInt(input.value, 10));
    select.value = match ? String(match[1]) : '-1';
  };
  syncSelect();
  select.addEventListener('change', () => {
    const n = parseInt(select.value, 10);
    if (n < 0) return; // "Custom" — no-op, user types in number
    input.value = String(n);
    onChange(n);
  });

  row.appendChild(lbl);
  row.appendChild(input);
  row.appendChild(select);
  parent.appendChild(row);
}

function formatNumber(n: number): string {
  // Keep output tidy: integers have no decimals, fractions trim trailing zeros.
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function normalizeHexColor(v: string): string {
  // <input type="color"> requires #rrggbb. Accept #rgb, #rrggbb, or any CSS
  // color — if we can't normalize, fall back to white so the picker still works.
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    const r = v[1]!,
      g = v[2]!,
      b = v[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return '#ffffff';
}

// ─── Mutations ───────────────────────────────────────────────────────────────

function setVisibleAnchor(row: number | null, col: number | null): void {
  if (!currentOverlay) return;
  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const propDef = state.propCatalog?.props[currentOverlay.type];
  const fRows = propDef?.footprint[0] ?? 1;
  const fCols = propDef?.footprint[1] ?? 1;
  const rNorm = ((currentOverlay.rotation % 360) + 360) % 360;
  const isR90 = rNorm === 90 || rNorm === 270;
  const eRows = isR90 ? fCols : fRows;
  const eCols = isR90 ? fRows : fCols;
  // visibleRow = y/gs + (fRows - eRows)/2  =>  y = (visibleRow - (fRows - eRows)/2) * gs
  const oldVisible = visibleAnchorOf(currentOverlay, propDef, gs);
  const newVisRow = row ?? oldVisible.row;
  const newVisCol = col ?? oldVisible.col;
  const newY = (newVisRow - (fRows - eRows) / 2) * gs;
  const newX = (newVisCol - (fCols - eCols) / 2) * gs;
  const dx = newX - currentOverlay.x;
  const dy = newY - currentOverlay.y;
  if (dx === 0 && dy === 0) return;
  currentOverlay.x = newX;
  currentOverlay.y = newY;
  refreshLinkedLights(state.dungeon.metadata, currentOverlay, propDef, oldVisible, dx, dy);
  commitRenderChange();
}

function setRotation(deg: number): void {
  if (!currentOverlay) return;
  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const propDef = state.propCatalog?.props[currentOverlay.type];
  const oldVisible = visibleAnchorOf(currentOverlay, propDef, gs);
  const clamped = ((Math.round(deg) % 360) + 360) % 360;
  currentOverlay.rotation = clamped;
  // Preserve the visible anchor across rotation (matches api.rotateProp fix).
  if (propDef) {
    const [fRows, fCols] = propDef.footprint;
    const isR90 = clamped === 90 || clamped === 270;
    const eRows = isR90 ? fCols : fRows;
    const eCols = isR90 ? fRows : fCols;
    const desiredShiftX = ((fCols - eCols) / 2) * gs;
    const desiredShiftY = ((fRows - eRows) / 2) * gs;
    const currentShiftX = oldVisible.col * gs - currentOverlay.x;
    const currentShiftY = oldVisible.row * gs - currentOverlay.y;
    currentOverlay.x += currentShiftX - desiredShiftX;
    currentOverlay.y += currentShiftY - desiredShiftY;
  }
  refreshLinkedLights(meta, currentOverlay, propDef, oldVisible, 0, 0);
  commitRenderChange();
}

function setScale(s: number): void {
  if (!currentOverlay) return;
  currentOverlay.scale = Math.max(0.25, Math.min(4.0, s));
  commitRenderChange();
}

function setFlipped(v: boolean): void {
  if (!currentOverlay) return;
  currentOverlay.flipped = v;
  commitRenderChange();
}

function setZIndex(v: number): void {
  if (!currentOverlay) return;
  currentOverlay.zIndex = Math.max(0, Math.floor(v));
  commitRenderChange();
}

function setLightField(id: number, field: 'radius' | 'color' | 'intensity', value: number | string): void {
  const light = state.dungeon.metadata.lights.find((l) => l.id === id);
  if (!light) return;
  if (field === 'color' && typeof value === 'string') light.color = value;
  else if (field === 'radius' && typeof value === 'number') light.radius = value;
  else if (field === 'intensity' && typeof value === 'number') light.intensity = value;
  commitRenderChange();
}

// ─── Open / Close ────────────────────────────────────────────────────────────

function refreshFromState(): void {
  if (!panel || !body || !currentOverlay) return;
  const meta = state.dungeon.metadata;
  const propDef = state.propCatalog?.props[currentOverlay.type];
  const lights = findLinkedLights(currentOverlay, meta, propDef);
  renderBody(currentOverlay, propDef, lights);
}

export function openPropEditDialog(overlay: OverlayProp): void {
  if (!panel || !body) return;
  // Different prop requested while already open → apply current, then reopen.
  if (isOpen && currentOverlay && currentOverlay.id !== overlay.id) {
    closePropEditDialog(false);
  }
  if (isOpen) return;
  const meta = state.dungeon.metadata;
  const propDef = state.propCatalog?.props[overlay.type];
  const lights = findLinkedLights(overlay, meta, propDef);

  currentOverlay = overlay;
  snapshot = takeSnapshot(overlay, lights);
  undoDepthOnOpen = state.undoStack.length;
  pushUndo('Edit prop');

  isOpen = true;
  panel.style.display = '';
  refreshFromState();
}

export function closePropEditDialog(revert: boolean): void {
  if (!isOpen || !panel) return;
  if (revert && snapshot) {
    const meta = state.dungeon.metadata;
    // Find overlay by id (reference may have been re-read elsewhere)
    const overlay = meta.props?.find((p) => p.id === snapshot!.id);
    if (overlay) {
      overlay.x = snapshot.x;
      overlay.y = snapshot.y;
      overlay.rotation = snapshot.rotation;
      overlay.scale = snapshot.scale;
      overlay.zIndex = snapshot.zIndex;
      overlay.flipped = snapshot.flipped;
    }
    for (const lsnap of snapshot.lights) {
      const light = meta.lights.find((l) => l.id === lsnap.id);
      if (light) {
        light.x = lsnap.x;
        light.y = lsnap.y;
        light.radius = lsnap.radius;
        light.color = lsnap.color;
        light.intensity = lsnap.intensity;
      }
    }
    // Drop the undo entry we pushed at open so the stack is unchanged overall.
    if (state.undoStack.length > undoDepthOnOpen) {
      state.undoStack.length = undoDepthOnOpen;
    }
    commitRenderChange();
  }
  panel.style.display = 'none';
  isOpen = false;
  currentOverlay = null;
  snapshot = null;
  undoDepthOnOpen = -1;
}

export function isPropEditDialogOpen(): boolean {
  return isOpen;
}

// ─── Drag (header) ───────────────────────────────────────────────────────────

function onDragStart(e: MouseEvent): void {
  if (e.button !== 0 || !panel) return;
  const target = e.target as HTMLElement;
  if (target.classList.contains('pe-close')) return; // let the close button handle it
  const rect = panel.getBoundingClientRect();
  drag.active = true;
  drag.offsetX = e.clientX - rect.left;
  drag.offsetY = e.clientY - rect.top;
  panel.classList.add('pe-dragging');
  e.preventDefault();
}

function onDragMove(e: MouseEvent): void {
  if (!drag.active || !panel) return;
  const x = e.clientX - drag.offsetX;
  const y = e.clientY - drag.offsetY;
  const maxX = window.innerWidth - panel.offsetWidth;
  const maxY = window.innerHeight - panel.offsetHeight;
  panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
  panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function onDragEnd(): void {
  if (!drag.active || !panel) return;
  drag.active = false;
  panel.classList.remove('pe-dragging');
}

// ─── Global keydown (Esc / Enter while open) ──────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  if (!isOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePropEditDialog(true);
  } else if (e.key === 'Enter') {
    const target = e.target as HTMLElement | null;
    // Enter commits (apply) only when focus is inside a dialog field;
    // outside the dialog, Enter remains a global key available to other tools.
    if (target && panel?.contains(target)) {
      e.preventDefault();
      closePropEditDialog(false);
    }
  }
}

// ─── Selection sync (auto-close on deselect / multi-select) ──────────────

function onStateChanged(): void {
  if (!isOpen || !currentOverlay) return;
  const anchors = state.selectedPropAnchors;
  if (anchors.length !== 1) {
    // Multi-select or no-select: apply and close.
    closePropEditDialog(false);
    return;
  }
  const sel = anchors[0]!;
  // If the selected prop's id no longer matches our overlay, apply and close.
  if (sel.propId != null && sel.propId !== currentOverlay.id) {
    closePropEditDialog(false);
    return;
  }
  // Our prop is still selected — re-read the overlay (it might have been
  // reassigned via an external mutation) and refresh the fields so external
  // edits (wheel rotate, arrow nudge) stay in sync with the dialog.
  const meta = state.dungeon.metadata;
  const fresh = meta.props?.find((p) => p.id === currentOverlay!.id);
  if (!fresh) {
    // Prop was deleted.
    closePropEditDialog(false);
    return;
  }
  currentOverlay = fresh;
  refreshFromState();
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initPropEditDialog(): void {
  panel = el('prop-edit-dialog') as HTMLDivElement;
  header = panel.querySelector('.pe-header');
  body = panel.querySelector('.pe-body');
  const titleSpan = panel.querySelector('.pe-header-title');
  if (titleSpan) titleSpan.id = 'pe-header-title';
  const closeBtn = panel.querySelector('.pe-close');

  closeBtn!.addEventListener('click', () => closePropEditDialog(false));
  header!.addEventListener('mousedown', onDragStart as EventListener);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  // Capture phase so Esc reaches us before the tool's own Esc handler.
  window.addEventListener('keydown', onKeyDown, true);

  subscribe(onStateChanged, { label: 'prop-edit-dialog', topics: ['props'] });
}
