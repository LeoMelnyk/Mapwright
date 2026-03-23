// Custom theme editor — extracted from metadata.js
import state, { pushUndo, markDirty, notify } from '../state.js';
import { THEMES } from '../../../render/index.js';
import { renderThemePreview } from '../theme-catalog.js';

// Theme property labels for the custom editor
const THEME_PROPS = [
  ['background', 'Background'],
  ['gridLine', 'Grid Lines'],
  ['wallStroke', 'Wall Stroke'],
  ['wallFill', 'Wall Fill'],
  ['textColor', 'Text'],
  ['borderColor', 'Border'],
  ['doorFill', 'Door Fill'],
  ['doorStroke', 'Door Stroke'],
  ['trapColor', 'Trap'],
  ['secretDoorColor', 'Secret Door'],
  ['compassRoseFill', 'Compass Fill'],
  ['compassRoseStroke', 'Compass Stroke'],
];

function parseRgbaColor(color) {
  const m = color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
    const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
    return { hex, alpha };
  }
  return { hex: color || '#000000', alpha: 1 };
}

function hexAlphaToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Custom theme editor — collapsible section state
const CTE_COLLAPSED_KEY = 'mw-cte-collapsed';
function loadCteCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(CTE_COLLAPSED_KEY));
    if (Array.isArray(saved)) return new Set(saved);
  } catch {}
  // Default: Colors expanded, everything else collapsed
  return new Set(['Walls', 'Shading', 'Hatching', 'Textures', 'Water', 'Lava']);
}
const cteCollapsed = loadCteCollapsed();
function saveCteCollapsed() {
  localStorage.setItem(CTE_COLLAPSED_KEY, JSON.stringify([...cteCollapsed]));
}

// Use setTimeout instead of requestIdleCallback — rIC gets starved by the animated render loop
const idle = (cb) => setTimeout(cb, 0);

function buildCustomEditor(customEditorEl) {
  const theme = getCustomThemeBase();
  const shading = theme.outerShading || {};
  const hatchColor = theme.hatchColor || theme.wallStroke || '#000000';
  const hatchSize = theme.hatchSize ?? 0.5;
  const hatchOpacity = theme.hatchOpacity ?? 0;
  const hatchDistance = theme.hatchDistance ?? 1;
  const hatchStyle = theme.hatchStyle ?? 'lines';
  const wallRoughness = theme.wallRoughness ?? 0;
  const wallShadow = theme.wallShadow || {};
  const parsedShadow = parseRgbaColor(wallShadow.color || 'rgba(0,0,0,0.2)');
  const bufferOpacity = theme.bufferShadingOpacity ?? 0;

  // ── HTML helpers ───────────────────────────────────────────────────────
  const colorRow = (label, attrName, attrVal, val) =>
    `<div class="cte-row">
      <span class="cte-label">${label}</span>
      <div class="cte-color-group">
        <input type="color" ${attrName}="${attrVal}" class="cte-color-swatch" value="${val}">
        <span class="cte-color-hex">${val}</span>
      </div>
    </div>`;

  const sliderRow = (label, numAttr, rangeAttr, key, val, min, max, step) =>
    `<div class="cte-slider-row">
      <div class="cte-slider-header">
        <span class="cte-label">${label}</span>
        <input type="number" ${numAttr}="${key}" class="cte-num" value="${val}" min="${min}" max="${max}" step="${step}">
      </div>
      <input type="range" ${rangeAttr}="${key}" class="cte-range" value="${val}" min="${min}" max="${max}" step="${step}">
    </div>`;

  const selectRow = (label, attrs, optionsHtml) =>
    `<div class="cte-row">
      <span class="cte-label">${label}</span>
      <select class="cte-select" ${attrs}>${optionsHtml}</select>
    </div>`;

  // ── Build HTML ─────────────────────────────────────────────────────────

  // Collapsible section wrapper
  const section = (name, contentHtml) => {
    const isCollapsed = cteCollapsed.has(name);
    return `<div class="cte-section">
      <div class="cte-section-title cte-section-toggle" data-cte-section="${name}">
        <span class="cte-toggle-arrow">${isCollapsed ? '\u25B6' : '\u25BC'}</span>${name}
      </div>
      <div class="cte-section-body"${isCollapsed ? ' style="display:none"' : ''}>
        ${contentHtml}
      </div>
    </div>`;
  };

  let html = '<div>';

  // Colors section
  let colorsHtml = '';
  for (const [prop, label] of THEME_PROPS) {
    colorsHtml += colorRow(label, 'data-theme-prop', prop, theme[prop] || '#000000');
  }
  html += section('Colors', colorsHtml);

  // Walls section
  html += section('Walls', `
    ${sliderRow('Roughness', 'data-wall-prop', 'data-wall-range', 'roughness', wallRoughness, 0, 3, 0.1)}
    ${colorRow('Shadow Color', 'data-wshadow-prop', 'color', parsedShadow.hex)}
    ${sliderRow('Shadow Opacity', 'data-wshadow-prop', 'data-wshadow-range', 'opacity', parsedShadow.alpha, 0, 1, 0.01)}
    ${sliderRow('Shadow Blur', 'data-wshadow-prop', 'data-wshadow-range', 'blur', wallShadow.blur ?? 8, 0, 30, 1)}
    ${sliderRow('Shadow X', 'data-wshadow-prop', 'data-wshadow-range', 'offsetX', wallShadow.offsetX ?? 4, -20, 20, 1)}
    ${sliderRow('Shadow Y', 'data-wshadow-prop', 'data-wshadow-range', 'offsetY', wallShadow.offsetY ?? 4, -20, 20, 1)}
  `);

  // Shading section
  html += section('Shading', `
    ${sliderRow('Buffer Opacity', 'data-buf-prop', 'data-buf-range', 'opacity', bufferOpacity, 0, 1, 0.01)}
    ${colorRow('Outer Color', 'data-shading-prop', 'color', shading.color || '#c5b9ac')}
    ${sliderRow('Outer Size', 'data-shading-prop', 'data-shading-range', 'size', shading.size ?? 0, 0, 100, 1)}
    ${sliderRow('Outer Roughness', 'data-shading-prop', 'data-shading-range', 'roughness', shading.roughness ?? 0, 0, 10, 0.5)}
  `);

  // Hatching section
  html += section('Hatching', `
    ${selectRow('Style', 'data-hatch-prop="style"', `
      <option value="lines" ${hatchStyle === 'lines' ? 'selected' : ''}>Lines</option>
      <option value="rocks" ${hatchStyle === 'rocks' ? 'selected' : ''}>Rocks</option>
      <option value="both" ${hatchStyle === 'both' ? 'selected' : ''}>Both</option>
    `)}
    ${colorRow('Color', 'data-hatch-prop', 'color', hatchColor)}
    ${sliderRow('Size', 'data-hatch-prop', 'data-hatch-range', 'size', hatchSize, 0, 1, 0.05)}
    ${sliderRow('Opacity', 'data-hatch-prop', 'data-hatch-range', 'opacity', hatchOpacity, 0, 1, 0.01)}
    ${sliderRow('Distance', 'data-hatch-prop', 'data-hatch-range', 'distance', hatchDistance, 1, 8, 1)}
  `);

  // Textures section
  const blendWidth = theme.textureBlendWidth ?? 0.35;
  html += section('Textures', `
    ${sliderRow('Edge Blend', 'data-texblend-prop', 'data-texblend-range', 'blendWidth', blendWidth, 0, 1, 0.01)}
  `);

  // Water section
  const parsedCaustic = parseRgbaColor(theme.waterCausticColor || 'rgba(160,215,255,0.55)');
  html += section('Water', `
    ${colorRow('Shallow', 'data-theme-prop', 'waterShallowColor', theme.waterShallowColor || '#2d69a5')}
    ${colorRow('Medium', 'data-theme-prop', 'waterMediumColor', theme.waterMediumColor || '#1e4b8a')}
    ${colorRow('Deep', 'data-theme-prop', 'waterDeepColor', theme.waterDeepColor || '#0f2d6e')}
    ${colorRow('Caustic Color', 'data-caustic-prop', 'color', parsedCaustic.hex)}
    ${sliderRow('Caustic Opacity', 'data-caustic-prop', 'data-caustic-range', 'opacity', parsedCaustic.alpha, 0, 1, 0.01)}
  `);

  // Lava section
  const parsedLavaCaustic = parseRgbaColor(theme.lavaCausticColor || 'rgba(255,160,60,0.55)');
  html += section('Lava', `
    ${colorRow('Shallow', 'data-theme-prop', 'lavaShallowColor', theme.lavaShallowColor || '#cc4400')}
    ${colorRow('Medium', 'data-theme-prop', 'lavaMediumColor', theme.lavaMediumColor || '#992200')}
    ${colorRow('Deep', 'data-theme-prop', 'lavaDeepColor', theme.lavaDeepColor || '#661100')}
    ${colorRow('Caustic Color', 'data-lava-caustic-prop', 'color', parsedLavaCaustic.hex)}
    ${sliderRow('Caustic Opacity', 'data-lava-caustic-prop', 'data-lava-caustic-range', 'opacity', parsedLavaCaustic.alpha, 0, 1, 0.01)}
    ${colorRow('Light Color', 'data-theme-prop', 'lavaLightColor', theme.lavaLightColor || '#ff6600')}
    ${sliderRow('Light Strength', 'data-lava-light-prop', 'data-lava-light-range', 'intensity', theme.lavaLightIntensity ?? 0.70, 0, 1, 0.01)}
  `);

  html += '</div>';
  customEditorEl.innerHTML = html;

  // Section collapse/expand toggle
  customEditorEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-cte-section]');
    if (!toggle) return;
    const name = toggle.dataset.cteSection;
    const body = toggle.nextElementSibling;
    const arrow = toggle.querySelector('.cte-toggle-arrow');
    if (cteCollapsed.has(name)) {
      cteCollapsed.delete(name);
      if (body) body.style.display = '';
      if (arrow) arrow.textContent = '\u25BC';
    } else {
      cteCollapsed.add(name);
      if (body) body.style.display = 'none';
      if (arrow) arrow.textContent = '\u25B6';
    }
    saveCteCollapsed();
  });

  // Color inputs (theme props)
  customEditorEl.querySelectorAll('input[data-theme-prop]').forEach(input => {
    input.addEventListener('input', () => {
      const prop = input.dataset.themeProp;
      const theme = ensureCustomThemeObject();
      theme[prop] = input.value;
      const hex = input.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = input.value;
      markDirty();
    });
    input.addEventListener('change', () => {
      pushUndo();
      const prop = input.dataset.themeProp;
      const theme = ensureCustomThemeObject();
      theme[prop] = input.value;
      state.dungeon.metadata.customTheme = theme;
      markDirty();
      notify();
      renderCustomThumb();
    });
  });

  // Shading color picker
  const shadingColorInput = customEditorEl.querySelector('[data-shading-prop="color"]');
  if (shadingColorInput) {
    shadingColorInput.addEventListener('input', () => {
      const t = ensureCustomThemeObject();
      if (!t.outerShading) t.outerShading = {};
      t.outerShading.color = shadingColorInput.value;
      const hex = shadingColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = shadingColorInput.value;
      markDirty();
      notify();
    });
    shadingColorInput.addEventListener('change', () => {
      pushUndo();
      const t = ensureCustomThemeObject();
      if (!t.outerShading) t.outerShading = {};
      t.outerShading.color = shadingColorInput.value;
      markDirty();
      notify();
      renderCustomThumb();
    });
  }

  // Shading size + roughness (paired number + range inputs)
  for (const prop of ['size', 'roughness']) {
    const numInput = customEditorEl.querySelector(`[data-shading-prop="${prop}"]`);
    const rangeInput = customEditorEl.querySelector(`[data-shading-range="${prop}"]`);
    if (!numInput || !rangeInput) continue;

    const sync = (value, source) => {
      const t = ensureCustomThemeObject();
      if (!t.outerShading) t.outerShading = {};
      t.outerShading[prop] = Number(value);
      if (numInput !== source) numInput.value = value;
      if (rangeInput !== source) rangeInput.value = value;
    };

    numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
    numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
    rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
    rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
  }

  // Wall roughness
  {
    const numInput = customEditorEl.querySelector('[data-wall-prop="roughness"]');
    const rangeInput = customEditorEl.querySelector('[data-wall-range="roughness"]');
    if (numInput && rangeInput) {
      const sync = (value, source) => {
        const t = ensureCustomThemeObject();
        t.wallRoughness = Number(value);
        if (numInput !== source) numInput.value = value;
        if (rangeInput !== source) rangeInput.value = value;
      };
      numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
      numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
      rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
      rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
    }
  }

  // Wall shadow color
  const wShadowColorInput = customEditorEl.querySelector('[data-wshadow-prop="color"]');
  if (wShadowColorInput) {
    wShadowColorInput.addEventListener('input', () => {
      const t = ensureCustomThemeObject();
      if (!t.wallShadow) t.wallShadow = {};
      const opacityEl = customEditorEl.querySelector('[data-wshadow-prop="opacity"]');
      const alpha = opacityEl ? Number(opacityEl.value) : 0.2;
      t.wallShadow.color = hexAlphaToRgba(wShadowColorInput.value, alpha);
      const hex = wShadowColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = wShadowColorInput.value;
      markDirty(); notify();
    });
    wShadowColorInput.addEventListener('change', () => { pushUndo(); renderCustomThumb(); });
  }

  // Wall shadow numeric + range controls (opacity, blur, offsetX, offsetY)
  for (const prop of ['opacity', 'blur', 'offsetX', 'offsetY']) {
    const numInput = customEditorEl.querySelector(`[data-wshadow-prop="${prop}"]`);
    const rangeInput = customEditorEl.querySelector(`[data-wshadow-range="${prop}"]`);
    if (!numInput || !rangeInput) continue;
    const sync = (value, source) => {
      const t = ensureCustomThemeObject();
      if (!t.wallShadow) t.wallShadow = {};
      if (prop === 'opacity') {
        const colorInput = customEditorEl.querySelector('[data-wshadow-prop="color"]');
        t.wallShadow.color = hexAlphaToRgba(colorInput?.value || '#000000', Number(value));
      } else {
        t.wallShadow[prop] = Number(value);
      }
      if (numInput !== source) numInput.value = value;
      if (rangeInput !== source) rangeInput.value = value;
    };
    numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
    numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
    rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
    rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
  }

  // Buffer shading opacity
  {
    const numInput = customEditorEl.querySelector('[data-buf-prop="opacity"]');
    const rangeInput = customEditorEl.querySelector('[data-buf-range="opacity"]');
    if (numInput && rangeInput) {
      const sync = (value, source) => {
        const t = ensureCustomThemeObject();
        t.bufferShadingOpacity = Number(value);
        if (numInput !== source) numInput.value = value;
        if (rangeInput !== source) rangeInput.value = value;
      };
      numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
      numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
      rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
      rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
    }
  }

  // Hatch style selector
  const hatchStyleSelect = customEditorEl.querySelector('[data-hatch-prop="style"]');
  if (hatchStyleSelect) {
    hatchStyleSelect.addEventListener('change', () => {
      pushUndo();
      const t = ensureCustomThemeObject();
      t.hatchStyle = hatchStyleSelect.value;
      markDirty();
      notify();
      renderCustomThumb();
    });
  }

  // Hatch color picker
  const hatchColorInput = customEditorEl.querySelector('[data-hatch-prop="color"]');
  if (hatchColorInput) {
    hatchColorInput.addEventListener('input', () => {
      const t = ensureCustomThemeObject();
      t.hatchColor = hatchColorInput.value;
      const hex = hatchColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = hatchColorInput.value;
      markDirty();
      notify();
    });
    hatchColorInput.addEventListener('change', () => {
      pushUndo();
      const t = ensureCustomThemeObject();
      t.hatchColor = hatchColorInput.value;
      markDirty();
      notify();
      renderCustomThumb();
    });
  }

  // Hatch size + opacity + distance (paired number + range inputs)
  for (const prop of ['size', 'opacity', 'distance']) {
    const numInput = customEditorEl.querySelector(`[data-hatch-prop="${prop}"]`);
    const rangeInput = customEditorEl.querySelector(`[data-hatch-range="${prop}"]`);
    if (!numInput || !rangeInput) continue;

    const sync = (value, source) => {
      const t = ensureCustomThemeObject();
      if (prop === 'opacity') {
        t.hatchOpacity = Number(value);
      } else if (prop === 'distance') {
        t.hatchDistance = Number(value);
      } else {
        t.hatchSize = Number(value);
      }
      if (numInput !== source) numInput.value = value;
      if (rangeInput !== source) rangeInput.value = value;
    };

    numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
    numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
    rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
    rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
  }

  // Texture blend width
  {
    const numInput = customEditorEl.querySelector('[data-texblend-prop="blendWidth"]');
    const rangeInput = customEditorEl.querySelector('[data-texblend-range="blendWidth"]');
    if (numInput && rangeInput) {
      const sync = (value, source) => {
        const t = ensureCustomThemeObject();
        t.textureBlendWidth = Number(value);
        if (numInput !== source) numInput.value = value;
        if (rangeInput !== source) rangeInput.value = value;
      };
      numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
      numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
      rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
      rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
    }
  }

  // Water caustic color picker
  const causticColorInput = customEditorEl.querySelector('[data-caustic-prop="color"]');
  if (causticColorInput) {
    causticColorInput.addEventListener('input', () => {
      const t = ensureCustomThemeObject();
      const opacityEl = customEditorEl.querySelector('[data-caustic-prop="opacity"]');
      const alpha = opacityEl ? Number(opacityEl.value) : 0.55;
      t.waterCausticColor = hexAlphaToRgba(causticColorInput.value, alpha);
      const hex = causticColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = causticColorInput.value;
      markDirty(); notify();
    });
    causticColorInput.addEventListener('change', () => { pushUndo(); renderCustomThumb(); });
  }

  // Water caustic opacity (paired number + range)
  {
    const numInput = customEditorEl.querySelector('[data-caustic-prop="opacity"]');
    const rangeInput = customEditorEl.querySelector('[data-caustic-range="opacity"]');
    if (numInput && rangeInput) {
      const sync = (value, source) => {
        const t = ensureCustomThemeObject();
        const colorInput = customEditorEl.querySelector('[data-caustic-prop="color"]');
        t.waterCausticColor = hexAlphaToRgba(colorInput?.value || '#a0d7ff', Number(value));
        if (numInput !== source) numInput.value = value;
        if (rangeInput !== source) rangeInput.value = value;
      };
      numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
      numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
      rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
      rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
    }
  }

  // Lava caustic color picker
  const lavaCausticColorInput = customEditorEl.querySelector('[data-lava-caustic-prop="color"]');
  if (lavaCausticColorInput) {
    lavaCausticColorInput.addEventListener('input', () => {
      const t = ensureCustomThemeObject();
      const opacityEl = customEditorEl.querySelector('[data-lava-caustic-prop="opacity"]');
      const alpha = opacityEl ? Number(opacityEl.value) : 0.55;
      t.lavaCausticColor = hexAlphaToRgba(lavaCausticColorInput.value, alpha);
      const hex = lavaCausticColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = lavaCausticColorInput.value;
      markDirty(); notify();
    });
    lavaCausticColorInput.addEventListener('change', () => { pushUndo(); renderCustomThumb(); });
  }

  // Lava caustic opacity (paired number + range)
  {
    const numInput = customEditorEl.querySelector('[data-lava-caustic-prop="opacity"]');
    const rangeInput = customEditorEl.querySelector('[data-lava-caustic-range="opacity"]');
    if (numInput && rangeInput) {
      const sync = (value, source) => {
        const t = ensureCustomThemeObject();
        const colorInput = customEditorEl.querySelector('[data-lava-caustic-prop="color"]');
        t.lavaCausticColor = hexAlphaToRgba(colorInput?.value || '#ffa03c', Number(value));
        if (numInput !== source) numInput.value = value;
        if (rangeInput !== source) rangeInput.value = value;
      };
      numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
      numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
      rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
      rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
    }
  }

  // Lava light intensity (paired number + range)
  {
    const numInput = customEditorEl.querySelector('[data-lava-light-prop="intensity"]');
    const rangeInput = customEditorEl.querySelector('[data-lava-light-range="intensity"]');
    if (numInput && rangeInput) {
      const sync = (value, source) => {
        const t = ensureCustomThemeObject();
        t.lavaLightIntensity = Number(value);
        if (numInput !== source) numInput.value = value;
        if (rangeInput !== source) rangeInput.value = value;
      };
      numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
      numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
      rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
      rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
    }
  }
}

function getCustomThemeBase() {
  const t = state.dungeon.metadata.theme;
  if (typeof t === 'object' && t !== null) return t;
  const base = typeof t === 'string' ? THEMES[t] : THEMES['blue-parchment'];
  return JSON.parse(JSON.stringify(base));
}

function ensureCustomThemeObject() {
  let t = state.dungeon.metadata.theme;
  if (typeof t !== 'object' || t === null) {
    t = getCustomThemeBase();
    state.dungeon.metadata.theme = t;
  }
  return t;
}

function syncCustomEditorValues() {
  const customEditor = document.getElementById('custom-theme-editor');
  const theme = getCustomThemeBase();

  // Helper: set a color swatch input + its hex span
  const syncColor = (input, value) => {
    if (!input || !value) return;
    input.value = value;
    const hex = input.parentElement?.querySelector('.cte-color-hex');
    if (hex) hex.textContent = value;
  };

  // Theme color props
  customEditor.querySelectorAll('input[data-theme-prop]').forEach(input => {
    const prop = input.dataset.themeProp;
    if (theme[prop]) syncColor(input, theme[prop]);
  });

  // Wall controls
  const wrNum = customEditor.querySelector('[data-wall-prop="roughness"]');
  const wrRange = customEditor.querySelector('[data-wall-range="roughness"]');
  if (wrNum) wrNum.value = theme.wallRoughness ?? 0;
  if (wrRange) wrRange.value = theme.wallRoughness ?? 0;

  const ws = theme.wallShadow || {};
  const parsedWS = parseRgbaColor(ws.color || 'rgba(0,0,0,0.2)');
  syncColor(customEditor.querySelector('[data-wshadow-prop="color"]'), parsedWS.hex);
  for (const [prop, fallback] of [
    ['opacity', parsedWS.alpha],
    ['blur', ws.blur ?? 8],
    ['offsetX', ws.offsetX ?? 4],
    ['offsetY', ws.offsetY ?? 4],
  ]) {
    const ni = customEditor.querySelector(`[data-wshadow-prop="${prop}"]`);
    const ri = customEditor.querySelector(`[data-wshadow-range="${prop}"]`);
    if (ni) ni.value = fallback;
    if (ri) ri.value = fallback;
  }

  // Buffer opacity
  const bufN = customEditor.querySelector('[data-buf-prop="opacity"]');
  const bufR = customEditor.querySelector('[data-buf-range="opacity"]');
  if (bufN) bufN.value = theme.bufferShadingOpacity ?? 0;
  if (bufR) bufR.value = theme.bufferShadingOpacity ?? 0;

  // Outer shading controls
  const shading = theme.outerShading || {};
  syncColor(customEditor.querySelector('[data-shading-prop="color"]'), shading.color);
  for (const prop of ['size', 'roughness']) {
    const val = shading[prop] ?? 0;
    const numInput = customEditor.querySelector(`[data-shading-prop="${prop}"]`);
    const rangeInput = customEditor.querySelector(`[data-shading-range="${prop}"]`);
    if (numInput) numInput.value = val;
    if (rangeInput) rangeInput.value = val;
  }

  // Hatching controls
  const hatchStyleSel = customEditor.querySelector('[data-hatch-prop="style"]');
  if (hatchStyleSel) hatchStyleSel.value = theme.hatchStyle ?? 'lines';

  syncColor(customEditor.querySelector('[data-hatch-prop="color"]'), theme.hatchColor || theme.wallStroke || '#000000');

  const pairs = [
    ['size', theme.hatchSize ?? 0.5],
    ['opacity', theme.hatchOpacity ?? 0],
    ['distance', theme.hatchDistance ?? 1],
  ];
  for (const [prop, val] of pairs) {
    const numInput = customEditor.querySelector(`[data-hatch-prop="${prop}"]`);
    const rangeInput = customEditor.querySelector(`[data-hatch-range="${prop}"]`);
    if (numInput) numInput.value = val;
    if (rangeInput) rangeInput.value = val;
  }

  // Texture blend width
  const tbNum = customEditor.querySelector('[data-texblend-prop="blendWidth"]');
  const tbRange = customEditor.querySelector('[data-texblend-range="blendWidth"]');
  const tbVal = theme.textureBlendWidth ?? 0.35;
  if (tbNum) tbNum.value = tbVal;
  if (tbRange) tbRange.value = tbVal;

  // Water caustic
  const parsedCausticSync = parseRgbaColor(theme.waterCausticColor || 'rgba(160,215,255,0.55)');
  syncColor(customEditor.querySelector('[data-caustic-prop="color"]'), parsedCausticSync.hex);
  const causticOpN = customEditor.querySelector('[data-caustic-prop="opacity"]');
  const causticOpR = customEditor.querySelector('[data-caustic-range="opacity"]');
  if (causticOpN) causticOpN.value = parsedCausticSync.alpha;
  if (causticOpR) causticOpR.value = parsedCausticSync.alpha;

  // Lava caustic
  const parsedLavaCausticSync = parseRgbaColor(theme.lavaCausticColor || 'rgba(255,160,60,0.55)');
  syncColor(customEditor.querySelector('[data-lava-caustic-prop="color"]'), parsedLavaCausticSync.hex);
  const lavaCausticOpN = customEditor.querySelector('[data-lava-caustic-prop="opacity"]');
  const lavaCausticOpR = customEditor.querySelector('[data-lava-caustic-range="opacity"]');
  if (lavaCausticOpN) lavaCausticOpN.value = parsedLavaCausticSync.alpha;
  if (lavaCausticOpR) lavaCausticOpR.value = parsedLavaCausticSync.alpha;

  // Lava light intensity
  const lavaLightIntN = customEditor.querySelector('[data-lava-light-prop="intensity"]');
  const lavaLightIntR = customEditor.querySelector('[data-lava-light-range="intensity"]');
  const lavaLightIntVal = theme.lavaLightIntensity ?? 0.70;
  if (lavaLightIntN) lavaLightIntN.value = lavaLightIntVal;
  if (lavaLightIntR) lavaLightIntR.value = lavaLightIntVal;
}

function renderCustomThumb() {
  const customThumb = document.getElementById('theme-thumb-custom');
  if (!customThumb) return;
  const isCustom = typeof state.dungeon.metadata.theme === 'object' && state.dungeon.metadata.theme !== null;
  const themeToRender = isCustom ? state.dungeon.metadata.theme : state.dungeon.metadata.customTheme;
  if (!themeToRender) return;
  idle(() => {
    try {
      const preview = renderThemePreview(themeToRender);
      const ctx = customThumb.querySelector('canvas').getContext('2d');
      ctx.clearRect(0, 0, 64, 64);
      ctx.drawImage(preview, 0, 0, preview.width, preview.height, 0, 0, 64, 64);
    } catch (err) {
      console.warn('[theme-picker] Custom preview failed:', err);
    }
  });
}

export { buildCustomEditor, getCustomThemeBase, ensureCustomThemeObject, syncCustomEditorValues, renderCustomThumb };
