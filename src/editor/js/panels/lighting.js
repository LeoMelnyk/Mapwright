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

  // Type selector
  const typeRow = el('div', 'lighting-slider-row');
  typeRow.appendChild(labelEl('Type'));
  const typeSelect = document.createElement('select');
  typeSelect.className = 'lighting-select';
  for (const [val, label] of [['point', 'Point'], ['directional', 'Directional']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    opt.selected = state.lightType === val;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener('change', () => {
    state.lightType = typeSelect.value;
    notify();
  });
  typeRow.appendChild(typeSelect);
  defaultsSection.appendChild(typeRow);

  // Color picker
  const colorRow = el('div', 'lighting-color-row');
  colorRow.appendChild(labelEl('Color'));
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = state.lightColor;
  colorInput.addEventListener('input', () => {
    state.lightColor = colorInput.value;
  });
  colorRow.appendChild(colorInput);
  defaultsSection.appendChild(colorRow);

  // Radius slider
  defaultsSection.appendChild(
    sliderRow('Radius', state.lightRadius, 5, 100, 5, (v) => {
      state.lightRadius = v;
    }, (v) => `${v} ft`)
  );

  // Intensity slider
  defaultsSection.appendChild(
    sliderRow('Intensity', state.lightIntensity, 0.1, 2.0, 0.1, (v) => {
      state.lightIntensity = v;
    }, (v) => v.toFixed(1))
  );

  // Falloff selector
  const falloffRow = el('div', 'lighting-slider-row');
  falloffRow.appendChild(labelEl('Falloff'));
  const falloffSelect = document.createElement('select');
  falloffSelect.className = 'lighting-select';
  for (const val of ['smooth', 'linear', 'quadratic']) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
    opt.selected = state.lightFalloff === val;
    falloffSelect.appendChild(opt);
  }
  falloffSelect.addEventListener('change', () => {
    state.lightFalloff = falloffSelect.value;
  });
  falloffRow.appendChild(falloffSelect);
  defaultsSection.appendChild(falloffRow);

  // Directional-specific defaults
  if (state.lightType === 'directional') {
    defaultsSection.appendChild(
      sliderRow('Angle', state.lightAngle, 0, 359, 1, (v) => {
        state.lightAngle = v;
      }, (v) => `${v}°`)
    );
    defaultsSection.appendChild(
      sliderRow('Spread', state.lightSpread, 5, 90, 5, (v) => {
        state.lightSpread = v;
      }, (v) => `${v}°`)
    );
  }

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

    // Color
    const selColorRow = el('div', 'lighting-color-row');
    selColorRow.appendChild(labelEl('Color'));
    const selColorInput = document.createElement('input');
    selColorInput.type = 'color';
    selColorInput.value = selectedLight.color || '#ff9944';
    selColorInput.addEventListener('input', () => {
      selectedLight.color = selColorInput.value;
      invalidateLightmap();
      markDirty();
      requestRender();
    });
    selColorRow.appendChild(selColorInput);
    selSection.appendChild(selColorRow);

    // Radius / Range
    const radiusLabel = selectedLight.type === 'directional' ? 'Range' : 'Radius';
    const radiusValue = selectedLight.type === 'directional'
      ? (selectedLight.range || selectedLight.radius || 30)
      : (selectedLight.radius || 30);
    selSection.appendChild(
      sliderRow(radiusLabel, radiusValue, 5, 100, 5, (v) => {
        if (selectedLight.type === 'directional') {
          selectedLight.range = v;
        } else {
          selectedLight.radius = v;
        }
        invalidateLightmap();
        markDirty();
        requestRender();
      }, (v) => `${v} ft`)
    );

    // Intensity
    selSection.appendChild(
      sliderRow('Intensity', selectedLight.intensity ?? 1.0, 0.1, 2.0, 0.1, (v) => {
        selectedLight.intensity = v;
        markDirty();
        requestRender();
      }, (v) => v.toFixed(1))
    );

    // Falloff
    const selFalloffRow = el('div', 'lighting-slider-row');
    selFalloffRow.appendChild(labelEl('Falloff'));
    const selFalloffSelect = document.createElement('select');
    selFalloffSelect.className = 'lighting-select';
    for (const val of ['smooth', 'linear', 'quadratic']) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
      opt.selected = (selectedLight.falloff || 'smooth') === val;
      selFalloffSelect.appendChild(opt);
    }
    selFalloffSelect.addEventListener('change', () => {
      selectedLight.falloff = selFalloffSelect.value;
      markDirty();
      requestRender();
    });
    selFalloffRow.appendChild(selFalloffSelect);
    selSection.appendChild(selFalloffRow);

    // Directional-specific: angle and spread
    if (selectedLight.type === 'directional') {
      selSection.appendChild(
        sliderRow('Angle', selectedLight.angle || 0, 0, 359, 1, (v) => {
          selectedLight.angle = v;
          invalidateLightmap();
          markDirty();
          requestRender();
        }, (v) => `${v}°`)
      );
      selSection.appendChild(
        sliderRow('Spread', selectedLight.spread || 45, 5, 90, 5, (v) => {
          selectedLight.spread = v;
          markDirty();
          requestRender();
        }, (v) => `${v}°`)
      );
    }

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
