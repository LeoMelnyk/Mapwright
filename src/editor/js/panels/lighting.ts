// Lighting panel: toggle lighting, adjust ambient, configure light properties
import type { FalloffType, Light, LightAnimationConfig, LightPreset } from '../../../types.js';
import state, { markDirty, notify, subscribe, invalidateLightmap } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { getLightCatalog } from '../light-catalog.js';
import { kelvinToRgb, falloffMultiplier } from '../../../render/index.js';

let container: HTMLElement | null = null;

/**
 * Initialize the lighting panel: toggle lighting, adjust ambient, configure light properties.
 * @param {HTMLElement} el - Container element for the panel
 */
export function initLightingPanel(containerEl: HTMLElement): void {
  container = containerEl;
  render();
  subscribe(() => render(), 'lighting');
}

let _lastLights: Light[] | null = null;
let _lastSelectedLightId: number | null = null;
let _lastLightingEnabled: boolean | null = null;
function render() {
  if (!container) return;

  const metadata = state.dungeon.metadata;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const lights = metadata.lights || [];
  const selectedLight = state.selectedLightId != null ? lights.find((l) => l.id === state.selectedLightId) : null;

  // Skip rebuild if nothing relevant changed and DOM is still populated
  if (
    lights === _lastLights &&
    state.selectedLightId === _lastSelectedLightId &&
    metadata.lightingEnabled === _lastLightingEnabled &&
    container.children.length > 0
  )
    return;
  _lastLights = lights;
  _lastSelectedLightId = state.selectedLightId;
  _lastLightingEnabled = metadata.lightingEnabled;

  container.innerHTML = '';

  // ── Enable/Disable Toggle ──────────────────────────────────────────────
  const toggleSection = el('div', 'lighting-section');
  const toggleRow = el('label', 'lighting-toggle');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = metadata.lightingEnabled;
  checkbox.addEventListener('change', () => {
    metadata.lightingEnabled = checkbox.checked;
    markDirty();
    notify();
  });
  toggleRow.appendChild(checkbox);
  toggleRow.appendChild(document.createTextNode('Enable Lighting'));
  toggleSection.appendChild(toggleRow);
  container.appendChild(toggleSection);

  if (!metadata.lightingEnabled) return; // Hide rest when disabled

  // ── Ambient Light Slider ───────────────────────────────────────────────
  const ambientSection = el('div', 'lighting-section');
  ambientSection.appendChild(sectionLabel('Ambient'));
  ambientSection.appendChild(
    sliderRow(
      'Brightness',
      metadata.ambientLight,
      0,
      1,
      0.05,
      (v: number) => {
        metadata.ambientLight = v;
        invalidateLightmap(false);
        markDirty();
        requestRender();
      },
      (v: number) => `${Math.round(v * 100)}%`,
    ),
  );
  // Ambient color picker
  const ambColorRow = el('div', 'lighting-color-row');
  ambColorRow.appendChild(labelEl('Ambient Color'));
  const ambColorInput = document.createElement('input');
  ambColorInput.type = 'color';
  ambColorInput.value = metadata.ambientColor ?? '#ffffff';
  ambColorInput.addEventListener('input', () => {
    metadata.ambientColor = ambColorInput.value;
    invalidateLightmap(false);
    markDirty();
    requestRender();
  });
  ambColorRow.appendChild(ambColorInput);
  ambientSection.appendChild(ambColorRow);

  // Kelvin color-temperature slider — recomputes ambientColor from the chosen
  // Kelvin. Artists and DMs usually think in "warm / cool", not hex.
  ambientSection.appendChild(
    sliderRow(
      'Temp (K)',
      2700,
      1500,
      10000,
      100,
      (v: number) => {
        const hex = kelvinToRgb(v);
        metadata.ambientColor = hex;
        ambColorInput.value = hex;
        invalidateLightmap('lights');
        markDirty();
        requestRender();
      },
      (v: number) => `${v}K`,
    ),
  );
  container.appendChild(ambientSection);

  // ── Selected Light Properties ──────────────────────────────────────────
  if (selectedLight) {
    const selSection = el('div', 'lighting-section');
    selSection.appendChild(
      sectionLabel(selectedLight.name ? `Selected — ${selectedLight.name}` : `Selected Light #${selectedLight.id}`),
    );

    // Preview thumbnail — updates on any field change via re-render().
    const previewRow = el('div', 'lighting-slider-row');
    previewRow.appendChild(labelEl('Preview'));
    const previewImg = document.createElement('img');
    previewImg.src = buildLightPreview(
      selectedLight.color || '#ff9944',
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      selectedLight.falloff || 'smooth',
      !!selectedLight.darkness,
    );
    previewImg.width = PREVIEW_SIZE;
    previewImg.height = PREVIEW_SIZE;
    previewImg.style.border = '1px solid #444';
    previewImg.style.borderRadius = '4px';
    previewRow.appendChild(previewImg);
    selSection.appendChild(previewRow);

    // Name input
    const nameRow = el('div', 'lighting-slider-row');
    nameRow.appendChild(labelEl('Name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'lighting-name-input';
    nameInput.value = selectedLight.name ?? '';
    nameInput.placeholder = 'Optional label…';
    nameInput.addEventListener('input', () => {
      selectedLight.name = nameInput.value || undefined;
      markDirty();
      notify();
    });
    nameRow.appendChild(nameInput);
    selSection.appendChild(nameRow);

    // Group input — free-text; leaves lights unassigned when blank.
    // Used with the Groups section at the bottom of the panel to toggle
    // entire sets of lights (e.g. "torches", "traps", "magic auras").
    const groupRow = el('div', 'lighting-slider-row');
    groupRow.appendChild(labelEl('Group'));
    const groupInput = document.createElement('input');
    groupInput.type = 'text';
    groupInput.className = 'lighting-name-input';
    groupInput.value = selectedLight.group ?? '';
    groupInput.placeholder = 'e.g. torches, traps…';
    groupInput.addEventListener('change', () => {
      const v = groupInput.value.trim();
      if (v) selectedLight.group = v;
      else delete selectedLight.group;
      invalidateLightmap('lights');
      markDirty();
      notify();
      requestRender();
    });
    groupRow.appendChild(groupInput);
    selSection.appendChild(groupRow);

    // Darkness / anti-light toggle — subtracts illumination instead of adding.
    const darknessRow = el('label', 'lighting-toggle');
    const darknessCb = document.createElement('input');
    darknessCb.type = 'checkbox';
    darknessCb.checked = !!selectedLight.darkness;
    darknessCb.addEventListener('change', () => {
      if (darknessCb.checked) selectedLight.darkness = true;
      else delete selectedLight.darkness;
      invalidateLightmap('lights');
      markDirty();
      notify();
      requestRender();
    });
    darknessRow.appendChild(darknessCb);
    darknessRow.appendChild(document.createTextNode(' Darkness (subtract light)'));
    selSection.appendChild(darknessRow);

    // Soft-shadow radius — 0 disables (hard shadows). Even small values
    // (0.5–1.5 ft) give a noticeable penumbra at wall corners.
    selSection.appendChild(
      sliderRow(
        'Soft Shadow',
        selectedLight.softShadowRadius ?? 0,
        0,
        4,
        0.25,
        (v: number) => {
          if (v > 0) selectedLight.softShadowRadius = v;
          else delete selectedLight.softShadowRadius;
          invalidateLightmap('lights');
          markDirty();
          requestRender();
        },
        (v: number) => (v === 0 ? 'Off' : `${v.toFixed(2)} ft`),
      ),
    );

    // Preset dropdown for selected light — re-applies a preset and restores the presetId link
    selSection.appendChild(
      presetDropdown(selectedLight.presetId ?? null, (preset: LightPreset) => {
        selectedLight.type = preset.type;
        selectedLight.color = preset.color;
        if (preset.type === 'directional') {
          selectedLight.range = preset.radius;
          selectedLight.spread = preset.spread ?? 45;
          delete (selectedLight as unknown as Record<string, unknown>).radius;
        } else {
          selectedLight.radius = preset.radius;
          delete (selectedLight as unknown as Record<string, unknown>).range;
          delete (selectedLight as unknown as Record<string, unknown>).spread;
        }
        selectedLight.intensity = preset.intensity;
        selectedLight.falloff = preset.falloff;
        if (preset.dimRadius) selectedLight.dimRadius = preset.dimRadius;
        else delete selectedLight.dimRadius;
        if (preset.animation) selectedLight.animation = { ...preset.animation };
        else delete selectedLight.animation;
        if (preset.z != null) selectedLight.z = preset.z;
        else delete selectedLight.z;
        selectedLight.presetId = preset.id; // restore link
        invalidateLightmap(false);
        markDirty();
        notify();
        requestRender();
      }),
    );

    // Shared sliders wired to the selected light object
    const radiusValue =
      selectedLight.type === 'directional'
        ? (selectedLight.range ?? selectedLight.radius) || 30
        : selectedLight.radius || 30;

    selSection.appendChild(
      buildLightSliders(
        {
          type: selectedLight.type,
          color: selectedLight.color || '#ff9944',
          radius: radiusValue,
          intensity: selectedLight.intensity,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          falloff: selectedLight.falloff || 'smooth',
          angle: selectedLight.angle ?? 0,
          spread: selectedLight.spread ?? 45,
          dimRadius: selectedLight.dimRadius ?? 0,
        },
        (field: string, value: string | number) => {
          if (field === 'color') selectedLight.color = value as string;
          else if (field === 'radius') selectedLight.radius = Number(value);
          else if (field === 'range') selectedLight.range = Number(value);
          else if (field === 'intensity') selectedLight.intensity = Number(value);
          else if (field === 'falloff') selectedLight.falloff = value as FalloffType;
          else if (field === 'angle') selectedLight.angle = Number(value);
          else if (field === 'spread') selectedLight.spread = Number(value);
          else if (field === 'dimRadius') {
            if (Number(value) > 0) selectedLight.dimRadius = Number(value);
            else delete selectedLight.dimRadius;
          }
          delete selectedLight.presetId; // sever preset link on manual edit
          // Live-update the preview thumbnail so color/falloff changes reflect
          // immediately — the panel's top-level render() skips rebuilds when
          // only a Light field mutates.
          if (field === 'color' || field === 'falloff') {
            previewImg.src = buildLightPreview(
              selectedLight.color || '#ff9944',
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
              selectedLight.falloff || 'smooth',
              !!selectedLight.darkness,
            );
          }
          invalidateLightmap(false);
          markDirty();
          requestRender();
        },
      ),
    );

    // Z-Height slider (height above floor in feet)
    selSection.appendChild(
      sliderRow(
        'Height (ft)',
        selectedLight.z ?? 8,
        0.5,
        20,
        0.5,
        (v: number) => {
          selectedLight.z = v;
          delete selectedLight.presetId;
          invalidateLightmap(false);
          markDirty();
          requestRender();
        },
        (v: number) => `${v}ft`,
      ),
    );

    // Animation controls
    selSection.appendChild(sectionLabel('Animation'));
    const animTypeRow = el('div', 'lighting-slider-row');
    animTypeRow.appendChild(labelEl('Type'));
    const animTypeSelect = document.createElement('select');
    animTypeSelect.className = 'lighting-select';
    for (const [val, lbl] of [
      ['none', 'None'],
      ['flicker', 'Flicker'],
      ['pulse', 'Pulse'],
      ['strobe', 'Strobe'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      opt.selected = (selectedLight.animation?.type ?? 'none') === val;
      animTypeSelect.appendChild(opt);
    }
    animTypeRow.appendChild(animTypeSelect);
    selSection.appendChild(animTypeRow);

    const existingAnim = selectedLight.animation ?? ({} as Partial<LightAnimationConfig>);
    const animSpeedRow = sliderRow(
      'Speed',
      existingAnim.speed ?? 1.0,
      0.1,
      5.0,
      0.1,
      () => applyAnim(),
      (v: number) => `${v.toFixed(1)}×`,
    );
    const animAmpRow = sliderRow(
      'Amplitude',
      existingAnim.amplitude ?? 0.3,
      0.0,
      1.0,
      0.05,
      () => applyAnim(),
      (v: number) => v.toFixed(2),
    );
    const animRadRow = sliderRow(
      'Radius Var',
      existingAnim.radiusVariation ?? 0,
      0.0,
      0.5,
      0.05,
      () => applyAnim(),
      (v: number) => v.toFixed(2),
    );
    selSection.appendChild(animSpeedRow);
    selSection.appendChild(animAmpRow);
    selSection.appendChild(animRadRow);

    function applyAnim() {
      const animType = animTypeSelect.value;
      if (animType === 'none') {
        delete selectedLight!.animation;
      } else {
        selectedLight!.animation = {
          type: animType,
          speed: parseFloat(animSpeedRow.querySelector('input')!.value),
          amplitude: parseFloat(animAmpRow.querySelector('input')!.value),
          radiusVariation: parseFloat(animRadRow.querySelector('input')!.value),
        };
      }
      delete selectedLight!.presetId; // sever preset link on manual animation edit
      updateAnimRows();
      invalidateLightmap(false);
      markDirty();
      requestRender();
    }
    animTypeSelect.addEventListener('change', applyAnim);

    function updateAnimRows() {
      const show = animTypeSelect.value !== 'none';
      animSpeedRow.style.display = show ? '' : 'none';
      animAmpRow.style.display = show ? '' : 'none';
      animRadRow.style.display = show ? '' : 'none';
    }
    updateAnimRows();

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'toolbar-btn lighting-delete-btn';
    deleteBtn.textContent = 'Delete Light';
    deleteBtn.addEventListener('click', () => {
      const allLights = state.dungeon.metadata.lights;
      const idx = allLights.findIndex((l) => l.id === selectedLight.id);
      if (idx >= 0) {
        allLights.splice(idx, 1);
        state.selectedLightId = null;
        invalidateLightmap(false);
        markDirty();
        notify();
      }
    });
    selSection.appendChild(deleteBtn);

    container.appendChild(selSection);
  }

  // ── Light List ─────────────────────────────────────────────────────────
  if (lights.length > 0) {
    const listSection = el('div', 'lighting-section');
    listSection.appendChild(sectionLabel(`Lights (${lights.length})`));

    for (const light of lights) {
      const item = el('div', 'light-list-item');
      if (light.id === state.selectedLightId) item.classList.add('active');

      // Color swatch
      const swatch = el('span', 'light-swatch');
      swatch.style.backgroundColor = light.color || '#ff9944';
      item.appendChild(swatch);

      // Label — show name if set, otherwise auto description
      const labelText =
        light.name ??
        `#${light.id} ${light.type === 'directional' ? 'Dir' : 'Point'} (${Math.round(light.x)}, ${Math.round(light.y)})`;
      item.appendChild(document.createTextNode(labelText));
      if (light.presetId) {
        const tag = el('span', 'light-preset-tag');
        tag.textContent = light.presetId;
        item.appendChild(tag);
      }

      item.addEventListener('click', () => {
        state.selectedLightId = light.id;
        notify();
        requestRender();
      });

      listSection.appendChild(item);
    }

    container.appendChild(listSection);
  }

  // ── Resync Preset Lights ───────────────────────────────────────────────
  const presetLightCount = lights.filter((l) => l.presetId).length;
  if (presetLightCount > 0) {
    const resyncSection = el('div', 'lighting-section');
    resyncSection.appendChild(sectionLabel('Presets'));
    const resyncBtn = document.createElement('button');
    resyncBtn.className = 'toolbar-btn';
    resyncBtn.textContent = `Resync ${presetLightCount} Preset Light${presetLightCount !== 1 ? 's' : ''}`;
    resyncBtn.title =
      'Update all preset-based lights to reflect the current state of their source preset (color, radius, dimRadius, animation, etc.)';
    resyncBtn.addEventListener('click', () => {
      const catalog = getLightCatalog();
      if (!catalog) return;
      let count = 0;
      for (const light of lights) {
        if (!light.presetId) continue;
        const preset = catalog.lights[light.presetId];
        if (!preset) continue;
        light.type = preset.type;
        light.color = preset.color;
        light.intensity = preset.intensity;
        light.falloff = preset.falloff;
        if (preset.type === 'directional') {
          light.range = preset.radius;
          light.spread = preset.spread ?? 45;
          delete (light as unknown as Record<string, unknown>).radius;
        } else {
          light.radius = preset.radius;
          delete (light as unknown as Record<string, unknown>).range;
          delete (light as unknown as Record<string, unknown>).spread;
        }
        if (preset.dimRadius) light.dimRadius = preset.dimRadius;
        else delete light.dimRadius;
        if (preset.animation?.type) light.animation = { ...preset.animation };
        else delete light.animation;
        count++;
      }
      if (count > 0) {
        invalidateLightmap(false);
        markDirty();
        notify();
      }
    });
    resyncSection.appendChild(resyncBtn);
    container.appendChild(resyncSection);
  }

  // ── Coverage Map Toggle ────────────────────────────────────────────────
  const coverageSection = el('div', 'lighting-section');
  coverageSection.appendChild(sectionLabel('Coverage Map'));
  const coverageBtn = document.createElement('button');
  coverageBtn.className = 'toolbar-btn' + (state.lightCoverageMode ? ' active' : '');
  coverageBtn.textContent = state.lightCoverageMode ? 'Hide Coverage Map' : 'Show Coverage Map';
  coverageBtn.addEventListener('click', () => {
    state.lightCoverageMode = !state.lightCoverageMode;
    requestRender();
    notify();
  });
  coverageSection.appendChild(coverageBtn);
  container.appendChild(coverageSection);

  // ── Groups ──────────────────────────────────────────────────────────────
  // Summarize every group on the map with a count + on/off checkbox.
  // Flipping a group toggle invalidates lights-only cache so the re-render
  // is cheap (no wall-segment rebuild).
  const groupNames = new Set<string>();
  for (const l of lights) if (l.group) groupNames.add(l.group);
  if (groupNames.size > 0) {
    const disabled = new Set(metadata.disabledLightGroups ?? []);
    const groupsSection = el('div', 'lighting-section');
    groupsSection.appendChild(sectionLabel('Groups'));
    for (const name of [...groupNames].sort((a, b) => a.localeCompare(b))) {
      const count = lights.filter((l) => l.group === name).length;
      const row = el('label', 'lighting-toggle');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !disabled.has(name);
      cb.addEventListener('change', () => {
        const next = new Set(metadata.disabledLightGroups ?? []);
        if (cb.checked) next.delete(name);
        else next.add(name);
        metadata.disabledLightGroups = next.size > 0 ? [...next] : undefined;
        invalidateLightmap('lights');
        markDirty();
        notify();
        requestRender();
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(` ${name} (${count})`));
      groupsSection.appendChild(row);
    }
    container.appendChild(groupsSection);
  }
}

// ── Shared Light Controls Builder ─────────────────────────────────────────────
//
// Builds Color, Radius/Range, Intensity, Falloff, and (if directional) Angle/Spread
// controls. `values` is the current light property values; `onFieldChange(field, value)`
// is called on every input event with the field name and new value.

function buildLightSliders(
  values: Record<string, number | string | boolean>,
  onFieldChange: (field: string, value: number | string) => void,
) {
  const vals = values as Record<string, number | string>;
  const type = vals.type ?? 'point';
  const color = vals.color ?? '#ff9944';
  const radius = vals.radius ?? 30;
  const intensity = vals.intensity ?? 1;
  const falloff = vals.falloff ?? 'smooth';
  const angle = vals.angle ?? 0;
  const spread = vals.spread ?? 90;
  const dimRadius = vals.dimRadius ?? 0;
  const frag = document.createDocumentFragment();

  // Color picker
  const colorRowEl = el('div', 'lighting-color-row');
  colorRowEl.appendChild(labelEl('Color'));
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = (color as string) || '#ff9944';
  colorInput.addEventListener('input', () => onFieldChange('color', colorInput.value));
  colorRowEl.appendChild(colorInput);
  frag.appendChild(colorRowEl);

  // Kelvin color-temperature slider — reads+writes the same field as the
  // color picker above, so flipping between them always stays consistent.
  frag.appendChild(
    sliderRow(
      'Temp (K)',
      2700,
      1500,
      10000,
      100,
      (v: number) => {
        const hex = kelvinToRgb(v);
        colorInput.value = hex;
        onFieldChange('color', hex);
      },
      (v: number) => `${v}K`,
    ),
  );

  // Radius / Range slider
  const radiusLabel = type === 'directional' ? 'Range' : 'Radius';
  const radiusField = type === 'directional' ? 'range' : 'radius';
  frag.appendChild(
    sliderRow(
      radiusLabel,
      radius || 30,
      5,
      100,
      5,
      (v: number) => onFieldChange(radiusField, v),
      (v: number) => `${v} ft`,
    ),
  );

  // Intensity slider
  frag.appendChild(
    sliderRow(
      'Intensity',
      intensity,
      0.1,
      2.0,
      0.1,
      (v: number) => onFieldChange('intensity', v),
      (v: number) => `${v.toFixed(1)}×`,
    ),
  );

  // Falloff selector
  const falloffRowEl = el('div', 'lighting-slider-row');
  falloffRowEl.appendChild(labelEl('Falloff'));
  const falloffSelect = document.createElement('select');
  falloffSelect.className = 'lighting-select';
  for (const [val, lbl] of [
    ['smooth', 'Smooth'],
    ['linear', 'Linear'],
    ['quadratic', 'Quadratic'],
    ['inverse-square', 'Inverse Square'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    opt.selected = (falloff || 'smooth') === val;
    falloffSelect.appendChild(opt);
  }
  falloffSelect.addEventListener('change', () => onFieldChange('falloff', falloffSelect.value));
  falloffRowEl.appendChild(falloffSelect);
  frag.appendChild(falloffRowEl);

  // Dim Radius slider (point lights only)
  if (type !== 'directional') {
    frag.appendChild(
      sliderRow(
        'Dim Radius',
        dimRadius,
        0,
        120,
        5,
        (v: number) => onFieldChange('dimRadius', v),
        (v: number) => (v === 0 ? 'Off' : `${v} ft`),
      ),
    );
  }

  // Angle + Spread (directional lights only)
  if (type === 'directional') {
    frag.appendChild(
      sliderRow(
        'Angle',
        angle,
        0,
        359,
        1,
        (v: number) => onFieldChange('angle', v),
        (v: number) => `${v}°`,
      ),
    );
    frag.appendChild(
      sliderRow(
        'Spread',
        spread,
        5,
        90,
        5,
        (v: number) => onFieldChange('spread', v),
        (v: number) => `${v}°`,
      ),
    );
  }

  return frag;
}

// ── DOM Helpers ──────────────────────────────────────────────────────────────

function presetDropdown(currentValue: string | null, onSelect: (preset: LightPreset) => void) {
  const catalog = getLightCatalog();
  const row = el('div', 'lighting-slider-row');
  row.appendChild(labelEl('Preset'));

  const select = document.createElement('select');
  select.className = 'lighting-select';

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '\u2014 Select preset \u2014';
  select.appendChild(emptyOpt);

  if (catalog) {
    for (const category of catalog.categoryOrder) {
      const group = document.createElement('optgroup');
      group.label = category;
      for (const id of catalog.byCategory[category] ?? []) {
        const preset = catalog.lights[id];
        if (!preset) continue;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = preset.displayName;
        if (id === currentValue) opt.selected = true;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
  }

  select.addEventListener('change', () => {
    if (!select.value) return;
    const preset = catalog?.lights[select.value];
    if (preset) onSelect(preset);
  });

  row.appendChild(select);
  return row;
}

function el(tag: string, className?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/**
 * Render a circular light thumbnail (hex color + falloff curve) to a data URI.
 * Used for the selected-light preview tile and cached per light spec so
 * sliders get live feedback without redrawing every pixel each tick.
 */
const PREVIEW_SIZE = 64;
const _previewCache = new Map<string, string>();
function buildLightPreview(color: string, falloff: FalloffType, darkness: boolean): string {
  const key = `${color}|${falloff}|${darkness ? '1' : '0'}`;
  const cached = _previewCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PREVIEW_SIZE;
  const ctx = canvas.getContext('2d')!;
  // Dark-slate backdrop so light colors read correctly against it.
  ctx.fillStyle = darkness ? '#e8e8e8' : '#1a1a1a';
  ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);

  const cx = PREVIEW_SIZE / 2;
  const cy = PREVIEW_SIZE / 2;
  const r = PREVIEW_SIZE / 2 - 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  const hex = color.replace('#', '');
  const hi = darkness ? '000000' : hex.length === 6 ? hex : 'ffffff';
  // Sample the falloff curve into gradient stops so preview matches render.
  const stops = 12;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    const a = Math.max(0, Math.min(1, falloffMultiplier(t * 20, 20, falloff)));
    grad.addColorStop(
      t,
      `#${hi}${Math.round(a * 255)
        .toString(16)
        .padStart(2, '0')}`,
    );
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);

  const url = canvas.toDataURL();
  _previewCache.set(key, url);
  return url;
}

function sectionLabel(text: string) {
  const label = el('div', 'lighting-section-label');
  label.textContent = text;
  return label;
}

function labelEl(text: string) {
  const l = el('label');
  l.className = 'lighting-label';
  l.textContent = text;
  return l;
}

function sliderRow(
  label: string,
  value: number | string,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  formatValue: (v: number) => string,
) {
  const row = el('div', 'lighting-slider-row');
  row.appendChild(labelEl(label));

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);

  const valueDisplay = el('span', 'lighting-value');
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  valueDisplay.textContent = formatValue ? formatValue(Number(value)) : String(value);

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    valueDisplay.textContent = formatValue ? formatValue(v) : String(v);
    onChange(v);
  });

  row.appendChild(slider);
  row.appendChild(valueDisplay);
  return row;
}
