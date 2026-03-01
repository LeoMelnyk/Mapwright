// Lighting panel: toggle lighting, adjust ambient, configure light properties
import state, { markDirty, notify, subscribe, invalidateLightmap } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { getLightCatalog } from '../light-catalog.js';

let container = null;

export function initLightingPanel(el) {
  container = el;
  render();
  subscribe(() => render());
}

function render() {
  if (!container) return;

  const metadata = state.dungeon.metadata;
  const lights = metadata.lights || [];
  const selectedLight = state.selectedLightId != null
    ? lights.find(l => l.id === state.selectedLightId)
    : null;

  container.innerHTML = '';

  // ── Enable/Disable Toggle ──────────────────────────────────────────────
  const toggleSection = el('div', 'lighting-section');
  const toggleRow = el('label', 'lighting-toggle');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!metadata.lightingEnabled;
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
    sliderRow('Brightness', metadata.ambientLight ?? 0.15, 0, 1, 0.05, (v) => {
      metadata.ambientLight = v;
      markDirty();
      requestRender();
    }, (v) => `${Math.round(v * 100)}%`)
  );
  container.appendChild(ambientSection);

  // ── New Light Defaults ─────────────────────────────────────────────────
  const defaultsSection = el('div', 'lighting-section');
  defaultsSection.appendChild(sectionLabel('New Light Defaults'));

  // Preset dropdown
  defaultsSection.appendChild(presetDropdown(state.lightPreset, (preset) => {
    state.lightPreset = preset.id;
    state.lightType = preset.type;
    state.lightColor = preset.color;
    state.lightRadius = preset.radius;
    state.lightIntensity = preset.intensity;
    state.lightFalloff = preset.falloff;
    if (preset.type === 'directional' && preset.spread != null) {
      state.lightSpread = preset.spread;
    }
    notify();
  }));

  // Type selector (defaults only — selected light type is changed via preset)
  const typeRow = el('div', 'lighting-slider-row');
  typeRow.appendChild(labelEl('Type'));
  const typeSelect = document.createElement('select');
  typeSelect.className = 'lighting-select';
  for (const [val, lbl] of [['point', 'Point'], ['directional', 'Directional']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    opt.selected = state.lightType === val;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener('change', () => {
    state.lightType = typeSelect.value;
    notify();
  });
  typeRow.appendChild(typeSelect);
  defaultsSection.appendChild(typeRow);

  // Shared sliders wired to state defaults
  defaultsSection.appendChild(buildLightSliders(
    {
      type: state.lightType,
      color: state.lightColor,
      radius: state.lightRadius,
      intensity: state.lightIntensity,
      falloff: state.lightFalloff,
      angle: state.lightAngle,
      spread: state.lightSpread,
    },
    (field, value) => {
      const key = { color: 'lightColor', radius: 'lightRadius', range: 'lightRadius',
                    intensity: 'lightIntensity', falloff: 'lightFalloff',
                    angle: 'lightAngle', spread: 'lightSpread' }[field];
      if (key) state[key] = value;
    }
  ));

  container.appendChild(defaultsSection);

  // ── Selected Light Properties ──────────────────────────────────────────
  if (selectedLight) {
    const selSection = el('div', 'lighting-section');
    selSection.appendChild(sectionLabel(`Selected Light #${selectedLight.id}`));

    // Preset dropdown for selected light
    selSection.appendChild(presetDropdown(null, (preset) => {
      selectedLight.type = preset.type;
      selectedLight.color = preset.color;
      if (preset.type === 'directional') {
        selectedLight.range = preset.radius;
        selectedLight.spread = preset.spread || 45;
        delete selectedLight.radius;
      } else {
        selectedLight.radius = preset.radius;
        delete selectedLight.range;
        delete selectedLight.spread;
      }
      selectedLight.intensity = preset.intensity;
      selectedLight.falloff = preset.falloff;
      invalidateLightmap();
      markDirty();
      notify();
      requestRender();
    }));

    // Shared sliders wired to the selected light object
    const radiusValue = selectedLight.type === 'directional'
      ? (selectedLight.range || selectedLight.radius || 30)
      : (selectedLight.radius || 30);

    selSection.appendChild(buildLightSliders(
      {
        type: selectedLight.type,
        color: selectedLight.color || '#ff9944',
        radius: radiusValue,
        intensity: selectedLight.intensity ?? 1.0,
        falloff: selectedLight.falloff || 'smooth',
        angle: selectedLight.angle || 0,
        spread: selectedLight.spread || 45,
      },
      (field, value) => {
        if (field === 'color') selectedLight.color = value;
        else if (field === 'radius') selectedLight.radius = value;
        else if (field === 'range') selectedLight.range = value;
        else if (field === 'intensity') selectedLight.intensity = value;
        else if (field === 'falloff') selectedLight.falloff = value;
        else if (field === 'angle') selectedLight.angle = value;
        else if (field === 'spread') selectedLight.spread = value;
        invalidateLightmap();
        markDirty();
        requestRender();
      }
    ));

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'toolbar-btn lighting-delete-btn';
    deleteBtn.textContent = 'Delete Light';
    deleteBtn.addEventListener('click', () => {
      const lights = state.dungeon.metadata.lights;
      const idx = lights.findIndex(l => l.id === selectedLight.id);
      if (idx >= 0) {
        lights.splice(idx, 1);
        state.selectedLightId = null;
        invalidateLightmap();
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

      // Label
      const label = document.createTextNode(
        `#${light.id} ${light.type === 'directional' ? 'Dir' : 'Point'} (${Math.round(light.x)}, ${Math.round(light.y)})`
      );
      item.appendChild(label);

      item.addEventListener('click', () => {
        state.selectedLightId = light.id;
        notify();
        requestRender();
      });

      listSection.appendChild(item);
    }

    container.appendChild(listSection);
  }
}

// ── Shared Light Controls Builder ─────────────────────────────────────────────
//
// Builds Color, Radius/Range, Intensity, Falloff, and (if directional) Angle/Spread
// controls. `values` is the current light property values; `onFieldChange(field, value)`
// is called on every input event with the field name and new value.

function buildLightSliders(values, onFieldChange) {
  const { type, color, radius, intensity, falloff, angle, spread } = values;
  const frag = document.createDocumentFragment();

  // Color picker
  const colorRowEl = el('div', 'lighting-color-row');
  colorRowEl.appendChild(labelEl('Color'));
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = color || '#ff9944';
  colorInput.addEventListener('input', () => onFieldChange('color', colorInput.value));
  colorRowEl.appendChild(colorInput);
  frag.appendChild(colorRowEl);

  // Radius / Range slider
  const radiusLabel = type === 'directional' ? 'Range' : 'Radius';
  const radiusField = type === 'directional' ? 'range' : 'radius';
  frag.appendChild(
    sliderRow(radiusLabel, radius || 30, 5, 100, 5,
      (v) => onFieldChange(radiusField, v),
      (v) => `${v} ft`)
  );

  // Intensity slider
  frag.appendChild(
    sliderRow('Intensity', intensity ?? 1.0, 0.1, 2.0, 0.1,
      (v) => onFieldChange('intensity', v),
      (v) => `${v.toFixed(1)}×`)
  );

  // Falloff selector
  const falloffRowEl = el('div', 'lighting-slider-row');
  falloffRowEl.appendChild(labelEl('Falloff'));
  const falloffSelect = document.createElement('select');
  falloffSelect.className = 'lighting-select';
  for (const val of ['smooth', 'linear', 'quadratic']) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
    opt.selected = (falloff || 'smooth') === val;
    falloffSelect.appendChild(opt);
  }
  falloffSelect.addEventListener('change', () => onFieldChange('falloff', falloffSelect.value));
  falloffRowEl.appendChild(falloffSelect);
  frag.appendChild(falloffRowEl);

  // Angle + Spread (directional lights only)
  if (type === 'directional') {
    frag.appendChild(
      sliderRow('Angle', angle ?? 0, 0, 359, 1,
        (v) => onFieldChange('angle', v),
        (v) => `${v}°`)
    );
    frag.appendChild(
      sliderRow('Spread', spread ?? 45, 5, 90, 5,
        (v) => onFieldChange('spread', v),
        (v) => `${v}°`)
    );
  }

  return frag;
}

// ── DOM Helpers ──────────────────────────────────────────────────────────────

function presetDropdown(currentValue, onSelect) {
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
      for (const id of catalog.byCategory[category]) {
        const preset = catalog.lights[id];
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

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function sectionLabel(text) {
  const label = el('div', 'lighting-section-label');
  label.textContent = text;
  return label;
}

function labelEl(text) {
  const l = el('label');
  l.className = 'lighting-label';
  l.textContent = text;
  return l;
}

function sliderRow(label, value, min, max, step, onChange, formatValue) {
  const row = el('div', 'lighting-slider-row');
  row.appendChild(labelEl(label));

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = min;
  slider.max = max;
  slider.step = step;
  slider.value = value;

  const valueDisplay = el('span', 'lighting-value');
  valueDisplay.textContent = formatValue ? formatValue(value) : value;

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valueDisplay.textContent = formatValue ? formatValue(v) : v;
    onChange(v);
  });

  row.appendChild(slider);
  row.appendChild(valueDisplay);
  return row;
}
