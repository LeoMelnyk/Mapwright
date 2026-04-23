// Weather panel: right-sidebar panel for creating and configuring weather
// groups. Selecting a group enters cell-assignment mode — the main toolbar
// dims, the weather tool becomes active, and the group-color overlay is
// forced on so the user can see membership as they paint.

import type { WeatherGroup, WeatherType } from '../../../types.js';
import state, { markDirty, mutate, notify, subscribe, invalidateLightmap } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { activateTool } from './toolbar.js';
import { getActiveRightPanel, setRightPanelChangeCallback } from './right-sidebar.js';
import { markWeatherFullRebuild, hasActiveWeatherLightning } from '../../../render/index.js';

/** Auto-assigned color palette for weather groups. 8 distinguishable hues. */
export const WEATHER_PALETTE: readonly string[] = [
  '#4a9eff', // blue — rain
  '#b080ff', // lavender
  '#4caf50', // green — leaves
  '#ff9944', // orange — embers
  '#ffd54a', // yellow — sandstorm
  '#e85858', // red — blood rain
  '#9ad0e8', // pale cyan — snow/fog
  '#ff6bc8', // pink
];

const WEATHER_TYPES: { value: WeatherType; label: string }[] = [
  { value: 'rain', label: 'Rain' },
  { value: 'snow', label: 'Snow' },
  { value: 'ash', label: 'Ash' },
  { value: 'embers', label: 'Embers' },
  { value: 'sandstorm', label: 'Sandstorm' },
  { value: 'fog', label: 'Fog' },
  { value: 'leaves', label: 'Leaves' },
];

let container: HTMLElement | null = null;
let savedTool: string | null = null;
let savedOverlayState: boolean | null = null;

export function initWeatherPanel(containerEl: HTMLElement): void {
  container = containerEl;
  render();
  subscribe(() => render(), 'weather');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedWeatherGroupId !== null) {
      exitAssignMode();
      notify();
    }
  });

  // When the user switches away from (or closes) the Weather panel, exit
  // any in-progress group assignment: the dimmed toolbar, forced overlay,
  // and selected tool must not leak out of this panel's context. The
  // `exitAssignMode()` helper restores the previously-active tool, falling
  // back to room if none was saved.
  setRightPanelChangeCallback((panel) => {
    if (panel !== 'weather' && state.selectedWeatherGroupId !== null) {
      exitAssignMode();
      notify();
    }
    requestRender();
  });
}

/** Returns the list of weather groups, initializing the array if needed. */
function getGroups(): WeatherGroup[] {
  const meta = state.dungeon.metadata;
  meta.weatherGroups ??= [];
  return meta.weatherGroups;
}

function paletteColor(idx: number): string {
  return WEATHER_PALETTE[idx % WEATHER_PALETTE.length]!;
}

function nextColorIndex(groups: WeatherGroup[]): number {
  const used = new Set(groups.map((g) => g.colorIndex));
  for (let i = 0; i < WEATHER_PALETTE.length; i++) if (!used.has(i)) return i;
  return groups.length % WEATHER_PALETTE.length;
}

function generateId(): string {
  return 'wg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function defaultGroup(name: string, colorIndex: number): WeatherGroup {
  return {
    id: generateId(),
    name,
    colorIndex,
    type: 'rain',
    intensity: 0.5,
    wind: { direction: 0, intensity: 0 },
    lightning: { enabled: false, intensity: 0.7, frequency: 0.15, color: '#c4d8ff' },
    hazeDensity: 0.2,
  };
}

function countCells(groupId: string): number {
  let n = 0;
  for (const row of state.dungeon.cells) {
    for (const cell of row) {
      if (cell?.weatherGroupId === groupId) n++;
    }
  }
  return n;
}

// ── Assign mode ────────────────────────────────────────────────────────────

function enterAssignMode(groupId: string): void {
  if (state.selectedWeatherGroupId === groupId) return;
  if (state.selectedWeatherGroupId === null) {
    savedTool = state.activeTool;
    savedOverlayState = state.showWeatherOverlay;
  }
  state.selectedWeatherGroupId = groupId;
  state.showWeatherOverlay = true;
  document.body.classList.add('weather-assign-active');
  state.statusInstruction =
    'Assigning cells to weather group · Click to assign · Shift+click to flood fill · Right-click to remove · Esc to finish';
  activateTool('weather');
}

function exitAssignMode(): void {
  if (state.selectedWeatherGroupId === null) return;
  state.selectedWeatherGroupId = null;
  document.body.classList.remove('weather-assign-active');
  state.statusInstruction = null;
  if (savedOverlayState !== null) state.showWeatherOverlay = savedOverlayState;
  savedOverlayState = null;
  // Restore the tool that was active before entering assign mode. If nothing
  // sensible is saved (null, or 'weather' itself — which happens when the
  // autosaved activeTool was already 'weather'), fall back to the room tool.
  const restore = savedTool && savedTool !== 'weather' ? savedTool : 'room';
  savedTool = null;
  activateTool(restore);
  requestRender();
}

// ── Group CRUD ─────────────────────────────────────────────────────────────

function createGroup(): WeatherGroup {
  const groups = getGroups();
  const name = `Group ${groups.length + 1}`;
  const colorIndex = nextColorIndex(groups);
  const group = defaultGroup(name, colorIndex);
  mutate(
    'Add weather group',
    [],
    () => {
      getGroups().push(group);
    },
    { metaOnly: true, topic: 'metadata' },
  );
  markWeatherFullRebuild();
  return group;
}

function deleteGroup(groupId: string): void {
  const coords: { row: number; col: number }[] = [];
  const cells = state.dungeon.cells;
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r]!;
    for (let c = 0; c < row.length; c++) {
      if (row[c]?.weatherGroupId === groupId) coords.push({ row: r, col: c });
    }
  }

  if (state.selectedWeatherGroupId === groupId) exitAssignMode();

  mutate(
    'Delete weather group',
    coords,
    () => {
      const groups = getGroups();
      const idx = groups.findIndex((g) => g.id === groupId);
      if (idx >= 0) groups.splice(idx, 1);
      for (const { row, col } of coords) {
        const cell = cells[row]?.[col];
        if (cell) delete cell.weatherGroupId;
      }
    },
    { topic: 'cells' },
  );
  markWeatherFullRebuild();
}

function updateGroup(groupId: string, updater: (g: WeatherGroup) => void, label = 'Edit weather group'): void {
  const g = getGroups().find((x) => x.id === groupId);
  if (!g) return;
  const beforeActive = hasActiveWeatherLightning(state.dungeon.metadata);
  mutate(label, [], () => updater(g), { metaOnly: true, topic: 'metadata' });
  markWeatherFullRebuild();
  // When toggling lightning on/off, `hasAnimLights` flips — the mapCache's
  // composite has lighting baked when false and not when true, so we must
  // force a composite rebuild via `invalidateLightmap` on either transition.
  if (beforeActive !== hasActiveWeatherLightning(state.dungeon.metadata)) {
    invalidateLightmap();
  }
}

/**
 * Update a group field without triggering a panel re-render. Used for live
 * field edits (slider drag, name typing, color picker) so the active input
 * element doesn't get torn out from under the user. The mutation is still
 * pushed to undo and the canvas still re-renders; only the panel's
 * subscribe-driven rebuild is skipped.
 */
function updateGroupField(groupId: string, updater: (g: WeatherGroup) => void, label = 'Edit weather group'): void {
  const g = getGroups().find((x) => x.id === groupId);
  if (!g) return;
  const beforeActive = hasActiveWeatherLightning(state.dungeon.metadata);
  suppressRender = true;
  try {
    mutate(label, [], () => updater(g), { metaOnly: true, topic: 'metadata' });
  } finally {
    suppressRender = false;
  }
  markWeatherFullRebuild();
  // Slider drags can also flip hasActiveWeatherLightning (e.g. intensity
  // slides past 0) — keep the mapCache composite in sync with the current
  // hasAnimLights value when the transition happens.
  if (beforeActive !== hasActiveWeatherLightning(state.dungeon.metadata)) {
    invalidateLightmap();
  }
  requestRender();
}

/**
 * When true, `render()` is a no-op. Set during field edits so the subscribe
 * callback doesn't rebuild the panel DOM mid-interaction.
 */
let suppressRender = false;

// ── Rendering ──────────────────────────────────────────────────────────────

function render(): void {
  if (!container || suppressRender) return;
  const groups = getGroups();
  const selectedId = state.selectedWeatherGroupId;

  container.innerHTML = '';

  // Show-overlay toggle
  const overlaySection = el('div', 'weather-section');
  const overlayRow = el('label', 'weather-toggle');
  const overlayCb = document.createElement('input');
  overlayCb.type = 'checkbox';
  overlayCb.checked = state.showWeatherOverlay;
  overlayCb.disabled = selectedId !== null;
  overlayCb.addEventListener('change', () => {
    state.showWeatherOverlay = overlayCb.checked;
    markDirty();
    notify();
    requestRender();
  });
  overlayRow.appendChild(overlayCb);
  overlayRow.appendChild(document.createTextNode(' Show weather groups'));
  overlaySection.appendChild(overlayRow);
  container.appendChild(overlaySection);

  // Group list
  const listSection = el('div', 'weather-section');
  listSection.appendChild(sectionLabel(`Groups (${groups.length})`));

  if (groups.length === 0) {
    const empty = el('div', 'weather-empty');
    empty.textContent = 'No weather groups yet.';
    listSection.appendChild(empty);
  }

  for (const group of groups) {
    const row = el('div', 'weather-group-row');
    if (group.id === selectedId) row.classList.add('active');
    row.addEventListener('click', () => {
      if (group.id === selectedId) exitAssignMode();
      else enterAssignMode(group.id);
      notify();
    });

    const swatch = el('span', 'weather-swatch');
    swatch.style.backgroundColor = paletteColor(group.colorIndex);
    row.appendChild(swatch);

    const name = el('span', 'weather-group-name');
    name.textContent = group.name;
    row.appendChild(name);

    const count = el('span', 'weather-group-count');
    count.textContent = `${countCells(group.id)} cells`;
    row.appendChild(count);

    const delBtn = document.createElement('button');
    delBtn.className = 'weather-group-delete';
    delBtn.textContent = '×';
    delBtn.title = 'Delete group';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteGroup(group.id);
      notify();
    });
    row.appendChild(delBtn);

    listSection.appendChild(row);

    if (group.id === selectedId) {
      listSection.appendChild(renderEditor(group));
    }
  }

  const newBtn = document.createElement('button');
  newBtn.className = 'weather-btn weather-btn-primary';
  newBtn.textContent = '+ New Group';
  newBtn.addEventListener('click', () => {
    const group = createGroup();
    enterAssignMode(group.id);
    notify();
  });
  listSection.appendChild(newBtn);

  container.appendChild(listSection);
}

function renderEditor(group: WeatherGroup): HTMLElement {
  const box = el('div', 'weather-editor');

  // Name
  const nameRow = el('div', 'weather-field');
  nameRow.appendChild(labelEl('Name'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = group.name;
  nameInput.addEventListener('change', () => {
    updateGroup(group.id, (g) => {
      g.name = nameInput.value || g.name;
    });
    notify();
  });
  nameRow.appendChild(nameInput);
  box.appendChild(nameRow);

  // Type
  const typeRow = el('div', 'weather-field');
  typeRow.appendChild(labelEl('Type'));
  const typeSelect = document.createElement('select');
  for (const t of WEATHER_TYPES) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    if (t.value === group.type) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener('change', () => {
    updateGroup(group.id, (g) => {
      g.type = typeSelect.value as WeatherType;
    });
    notify();
  });
  typeRow.appendChild(typeSelect);
  box.appendChild(typeRow);

  // Intensity
  box.appendChild(
    sliderRow('Intensity', group.intensity, 0, 1, 0.05, (v) => {
      updateGroupField(group.id, (g) => {
        g.intensity = v;
      });
    }),
  );

  // Haze
  box.appendChild(
    sliderRow('Haze', group.hazeDensity, 0, 1, 0.05, (v) => {
      updateGroupField(group.id, (g) => {
        g.hazeDensity = v;
      });
    }),
  );

  // Wind direction + intensity
  box.appendChild(
    sliderRow(
      'Wind dir',
      group.wind.direction,
      0,
      359,
      1,
      (v) => {
        updateGroupField(group.id, (g) => {
          g.wind.direction = v;
        });
      },
      (v) => `${Math.round(v)}°`,
    ),
  );
  box.appendChild(
    sliderRow('Wind str', group.wind.intensity, 0, 1, 0.05, (v) => {
      updateGroupField(group.id, (g) => {
        g.wind.intensity = v;
      });
    }),
  );

  // Particle color override
  const colorRow = el('div', 'weather-field');
  colorRow.appendChild(labelEl('Particle color'));
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = group.particleColor ?? '#ffffff';
  const colorClear = document.createElement('button');
  colorClear.className = 'weather-btn';
  colorClear.textContent = group.particleColor ? 'Auto' : '—';
  colorClear.title = 'Use default color for this weather type';
  colorClear.addEventListener('click', () => {
    updateGroup(group.id, (g) => {
      delete g.particleColor;
    });
    notify();
  });
  colorInput.addEventListener('change', () => {
    updateGroup(group.id, (g) => {
      g.particleColor = colorInput.value;
    });
    notify();
  });
  colorRow.appendChild(colorInput);
  colorRow.appendChild(colorClear);
  box.appendChild(colorRow);

  // Lightning — disabled when map-level lighting is off, since the flash
  // renders only when lighting is enabled. The checkbox still displays the
  // group's stored state so the user can see how it's configured.
  const lightingEnabled = state.dungeon.metadata.lightingEnabled;
  const lightningHeader = el('div', 'weather-field-header');
  const lightningCb = document.createElement('input');
  lightningCb.type = 'checkbox';
  lightningCb.checked = group.lightning.enabled;
  lightningCb.disabled = !lightingEnabled;
  lightningCb.addEventListener('change', () => {
    updateGroup(group.id, (g) => {
      g.lightning.enabled = lightningCb.checked;
    });
    notify();
  });
  lightningHeader.appendChild(lightningCb);
  lightningHeader.appendChild(document.createTextNode(' Lightning'));
  if (!lightingEnabled) {
    lightningHeader.classList.add('weather-field-disabled');
    lightningHeader.title = 'Enable lighting on the map to use lightning';
  }
  box.appendChild(lightningHeader);

  if (group.lightning.enabled) {
    box.appendChild(
      sliderRow('  Intensity', group.lightning.intensity, 0, 1, 0.05, (v) => {
        updateGroupField(group.id, (g) => {
          g.lightning.intensity = v;
        });
      }),
    );
    box.appendChild(
      sliderRow('  Frequency', group.lightning.frequency, 0, 1, 0.05, (v) => {
        updateGroupField(group.id, (g) => {
          g.lightning.frequency = v;
        });
      }),
    );

    // Lightning color — applies to the flash tint. Defaults to a pale
    // blue-white; no "Auto" button since the flash always needs a color.
    const lightningColorRow = el('div', 'weather-field');
    lightningColorRow.appendChild(labelEl('  Flash color'));
    const lightningColorInput = document.createElement('input');
    lightningColorInput.type = 'color';
    lightningColorInput.value = group.lightning.color ?? '#c4d8ff';
    lightningColorInput.addEventListener('change', () => {
      updateGroup(group.id, (g) => {
        g.lightning.color = lightningColorInput.value;
      });
      notify();
    });
    lightningColorRow.appendChild(lightningColorInput);
    box.appendChild(lightningColorRow);
  }

  return box;
}

// ── Overlay rendering (editor only) ────────────────────────────────────────

/**
 * Render a translucent color wash per cell, keyed to each cell's weather
 * group. Called per frame from canvas-view when `state.showWeatherOverlay`
 * is true. Skips entirely when the overlay is off, so there is no cost in
 * the normal case.
 */
export function renderWeatherGroupOverlay(
  ctx: CanvasRenderingContext2D,
  transform: { scale: number; offsetX: number; offsetY: number },
  gridSize: number,
): void {
  if (!state.showWeatherOverlay) return;
  // Only visible while the Weather panel is the active right-sidebar panel —
  // the overlay is a panel-specific authoring aid, not global map state.
  if (getActiveRightPanel() !== 'weather') return;
  const groups = state.dungeon.metadata.weatherGroups;
  if (!groups || groups.length === 0) return;

  const colorById = new Map<string, string>();
  for (const g of groups) colorById.set(g.id, paletteColor(g.colorIndex));

  const cellPx = gridSize * transform.scale;
  const cells = state.dungeon.cells;
  const selectedId = state.selectedWeatherGroupId;
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;

  // Pass 1: translucent fill per cell
  ctx.save();
  ctx.globalAlpha = 0.32;
  for (let r = 0; r < rows; r++) {
    const row = cells[r]!;
    for (let c = 0; c < row.length; c++) {
      const gid = row[c]?.weatherGroupId;
      if (!gid) continue;
      const color = colorById.get(gid);
      if (!color) continue;
      const x = c * gridSize * transform.scale + transform.offsetX;
      const y = r * gridSize * transform.scale + transform.offsetY;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, cellPx, cellPx);
    }
  }
  ctx.restore();

  // Pass 2: perimeter borders — only edges between cells of different groups
  // (or between a group cell and a non-group cell). This merges contiguous
  // regions so the border traces the outside of the region, not each cell.
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.lineCap = 'square';
  for (let r = 0; r < rows; r++) {
    const row = cells[r]!;
    for (let c = 0; c < row.length; c++) {
      const gid = row[c]?.weatherGroupId;
      if (!gid) continue;
      const color = colorById.get(gid);
      if (!color) continue;
      const isSelected = gid === selectedId;
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      const x = c * gridSize * transform.scale + transform.offsetX;
      const y = r * gridSize * transform.scale + transform.offsetY;
      const north = cells[r - 1]?.[c]?.weatherGroupId;
      const south = cells[r + 1]?.[c]?.weatherGroupId;
      const west = cells[r]?.[c - 1]?.weatherGroupId;
      const east = cells[r]?.[c + 1]?.weatherGroupId;
      if (north !== gid) edge(ctx, x, y, x + cellPx, y);
      if (south !== gid) edge(ctx, x, y + cellPx, x + cellPx, y + cellPx);
      if (west !== gid) edge(ctx, x, y, x, y + cellPx);
      if (east !== gid) edge(ctx, x + cellPx, y, x + cellPx, y + cellPx);
    }
  }
  ctx.restore();
}

function edge(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function sectionLabel(text: string): HTMLElement {
  const lbl = el('div', 'weather-section-label');
  lbl.textContent = text;
  return lbl;
}

function labelEl(text: string): HTMLElement {
  const l = el('label', 'weather-label');
  l.textContent = text;
  return l;
}

function sliderRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  formatValue?: (v: number) => string,
): HTMLElement {
  const row = el('div', 'weather-slider-row');
  row.appendChild(labelEl(label));
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  const vd = el('span', 'weather-value');
  const fmt = formatValue ?? ((v: number) => `${Math.round(v * 100)}%`);
  vd.textContent = fmt(value);
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    vd.textContent = fmt(v);
    onChange(v);
    requestRender();
  });
  row.appendChild(slider);
  row.appendChild(vd);
  return row;
}
