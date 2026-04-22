// Lighting panel: toggle lighting, adjust ambient, browse/activate lights,
// manage groups and preset resync. Per-light editing lives in the floating
// light-edit dialog (see panels/light-edit.ts), opened by double-clicking a
// light on the canvas, pressing Enter on a selected light, or clicking an
// entry in the Lights list below.
import type { Light } from '../../../types.js';
import state, { markDirty, notify, subscribe, invalidateLightmap } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { getLightCatalog } from '../light-catalog.js';
import { kelvinToRgb, beginGroupTransition } from '../../../render/index.js';
import { openLightEditDialog } from './light-edit.js';

let container: HTMLElement | null = null;

/**
 * Initialize the lighting panel: toggle lighting, adjust ambient, browse lights.
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

  // Bloom intensity — Gaussian-blurred additive overlay on bright lightmap areas.
  ambientSection.appendChild(
    sliderRow(
      'Bloom',
      metadata.bloomIntensity ?? 0,
      0,
      1,
      0.05,
      (v: number) => {
        if (v > 0) metadata.bloomIntensity = v;
        else delete metadata.bloomIntensity;
        markDirty();
        requestRender();
      },
      (v: number) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`),
    ),
  );

  // Ambient animation — currently a Storm toggle (lightning strike across the
  // whole canvas at irregular intervals). Strike color follows ambientColor,
  // so set ambientColor to a pale blue (#bbccff) for a thunderstorm.
  const stormCfg = metadata.ambientAnimation;
  const stormRow = el('label', 'lighting-toggle');
  const stormCb = document.createElement('input');
  stormCb.type = 'checkbox';
  stormCb.checked = stormCfg?.type === 'strike';
  stormCb.addEventListener('change', () => {
    if (stormCb.checked) {
      metadata.ambientAnimation = {
        type: 'strike',
        speed: 1,
        amplitude: 0.7,
        frequency: 0.08,
        duration: 0.18,
        probability: 0.5,
        baseline: 0,
      };
    } else {
      delete metadata.ambientAnimation;
    }
    invalidateLightmap('lights');
    markDirty();
    notify();
    requestRender();
  });
  stormRow.appendChild(stormCb);
  stormRow.appendChild(document.createTextNode(' Storm (ambient lightning flashes)'));
  ambientSection.appendChild(stormRow);

  container.appendChild(ambientSection);

  // ── Light List ─────────────────────────────────────────────────────────
  // Clicking an entry opens the floating light-edit dialog for that light.
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
        openLightEditDialog(light.id);
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
    // Per-group fade-envelope picker (applies on the next toggle).
    const envChoiceByGroup = new Map<string, 'instant' | 'simple-fade' | 'ignite' | 'extinguish'>();
    for (const name of [...groupNames].sort((a, b) => a.localeCompare(b))) {
      const count = lights.filter((l) => l.group === name).length;
      const row = el('div', 'lighting-slider-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !disabled.has(name);
      cb.style.marginRight = '6px';
      const envSelect = document.createElement('select');
      envSelect.className = 'lighting-select';
      envSelect.style.marginLeft = '4px';
      for (const [val, lbl] of [
        ['instant', 'Instant'],
        ['simple-fade', 'Fade'],
        ['ignite', 'Ignite'],
        ['extinguish', 'Extinguish'],
      ] as const) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = lbl;
        if (val === 'instant') opt.selected = true;
        envSelect.appendChild(opt);
      }
      envSelect.addEventListener('change', () => {
        envChoiceByGroup.set(name, envSelect.value as 'instant' | 'simple-fade' | 'ignite' | 'extinguish');
      });
      cb.addEventListener('change', () => {
        const next = new Set(metadata.disabledLightGroups ?? []);
        if (cb.checked) next.delete(name);
        else next.add(name);
        metadata.disabledLightGroups = next.size > 0 ? [...next] : undefined;
        const envelope = envChoiceByGroup.get(name) ?? 'instant';
        if (envelope !== 'instant') {
          // Pick a sensible default envelope based on direction if user left
          // it on Fade — Ignite reads better on enable, Extinguish on disable.
          const eff = envelope === 'simple-fade' ? (cb.checked ? 'ignite' : 'extinguish') : envelope;
          beginGroupTransition(name, cb.checked, eff, 700);
        }
        invalidateLightmap('lights');
        markDirty();
        notify();
        requestRender();
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(` ${name} (${count}) `));
      row.appendChild(envSelect);
      groupsSection.appendChild(row);
    }
    container.appendChild(groupsSection);
  }
}

// ── DOM Helpers ──────────────────────────────────────────────────────────────

function el(tag: string, className?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
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
