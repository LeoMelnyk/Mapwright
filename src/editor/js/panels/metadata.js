// Metadata panel: dungeon name, gridSize, theme, features
import state, { pushUndo, markDirty, notify, subscribe } from '../state.js';
import { THEMES } from '../../../render/index.js';
import { getThemeCatalog, renderThemePreview } from '../theme-catalog.js';
import { getEditorSettings, setEditorSetting } from '../editor-settings.js';
import { requestRender } from '../canvas-view.js';

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

const idle = window.requestIdleCallback
  ? (cb) => window.requestIdleCallback(cb)
  : (cb) => setTimeout(cb, 0);

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

export function init() {
  const nameInput = document.getElementById('meta-name');
  const gridSizeSelect = document.getElementById('meta-gridsize');
  const labelStyleSelect = document.getElementById('meta-labelstyle');
  const customEditor = document.getElementById('custom-theme-editor');

  // ── Custom theme editor ──────────────────────────────────────────────────

  function buildCustomEditor() {
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
          <span class="cte-toggle-arrow">${isCollapsed ? '▶' : '▼'}</span>${name}
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
    customEditor.innerHTML = html;

    // Section collapse/expand toggle
    customEditor.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-cte-section]');
      if (!toggle) return;
      const name = toggle.dataset.cteSection;
      const body = toggle.nextElementSibling;
      const arrow = toggle.querySelector('.cte-toggle-arrow');
      if (cteCollapsed.has(name)) {
        cteCollapsed.delete(name);
        if (body) body.style.display = '';
        if (arrow) arrow.textContent = '▼';
      } else {
        cteCollapsed.add(name);
        if (body) body.style.display = 'none';
        if (arrow) arrow.textContent = '▶';
      }
      saveCteCollapsed();
    });

    // Color inputs (theme props)
    customEditor.querySelectorAll('input[data-theme-prop]').forEach(input => {
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
    const shadingColorInput = customEditor.querySelector('[data-shading-prop="color"]');
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
      const numInput = customEditor.querySelector(`[data-shading-prop="${prop}"]`);
      const rangeInput = customEditor.querySelector(`[data-shading-range="${prop}"]`);
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
      const numInput = customEditor.querySelector('[data-wall-prop="roughness"]');
      const rangeInput = customEditor.querySelector('[data-wall-range="roughness"]');
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
    const wShadowColorInput = customEditor.querySelector('[data-wshadow-prop="color"]');
    if (wShadowColorInput) {
      wShadowColorInput.addEventListener('input', () => {
        const t = ensureCustomThemeObject();
        if (!t.wallShadow) t.wallShadow = {};
        const opacityEl = customEditor.querySelector('[data-wshadow-prop="opacity"]');
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
      const numInput = customEditor.querySelector(`[data-wshadow-prop="${prop}"]`);
      const rangeInput = customEditor.querySelector(`[data-wshadow-range="${prop}"]`);
      if (!numInput || !rangeInput) continue;
      const sync = (value, source) => {
        const t = ensureCustomThemeObject();
        if (!t.wallShadow) t.wallShadow = {};
        if (prop === 'opacity') {
          const colorInput = customEditor.querySelector('[data-wshadow-prop="color"]');
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
      const numInput = customEditor.querySelector('[data-buf-prop="opacity"]');
      const rangeInput = customEditor.querySelector('[data-buf-range="opacity"]');
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
    const hatchStyleSelect = customEditor.querySelector('[data-hatch-prop="style"]');
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
    const hatchColorInput = customEditor.querySelector('[data-hatch-prop="color"]');
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
      const numInput = customEditor.querySelector(`[data-hatch-prop="${prop}"]`);
      const rangeInput = customEditor.querySelector(`[data-hatch-range="${prop}"]`);
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
      const numInput = customEditor.querySelector('[data-texblend-prop="blendWidth"]');
      const rangeInput = customEditor.querySelector('[data-texblend-range="blendWidth"]');
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
    const causticColorInput = customEditor.querySelector('[data-caustic-prop="color"]');
    if (causticColorInput) {
      causticColorInput.addEventListener('input', () => {
        const t = ensureCustomThemeObject();
        const opacityEl = customEditor.querySelector('[data-caustic-prop="opacity"]');
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
      const numInput = customEditor.querySelector('[data-caustic-prop="opacity"]');
      const rangeInput = customEditor.querySelector('[data-caustic-range="opacity"]');
      if (numInput && rangeInput) {
        const sync = (value, source) => {
          const t = ensureCustomThemeObject();
          const colorInput = customEditor.querySelector('[data-caustic-prop="color"]');
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
    const lavaCausticColorInput = customEditor.querySelector('[data-lava-caustic-prop="color"]');
    if (lavaCausticColorInput) {
      lavaCausticColorInput.addEventListener('input', () => {
        const t = ensureCustomThemeObject();
        const opacityEl = customEditor.querySelector('[data-lava-caustic-prop="opacity"]');
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
      const numInput = customEditor.querySelector('[data-lava-caustic-prop="opacity"]');
      const rangeInput = customEditor.querySelector('[data-lava-caustic-range="opacity"]');
      if (numInput && rangeInput) {
        const sync = (value, source) => {
          const t = ensureCustomThemeObject();
          const colorInput = customEditor.querySelector('[data-lava-caustic-prop="color"]');
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
      const numInput = customEditor.querySelector('[data-lava-light-prop="intensity"]');
      const rangeInput = customEditor.querySelector('[data-lava-light-range="intensity"]');
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

  // ── Theme picker grid ────────────────────────────────────────────────────

  function buildThemePicker() {
    const container = document.getElementById('theme-grid-container');
    if (!container) return;
    const catalog = getThemeCatalog();
    if (!catalog) return;

    const grid = document.createElement('div');
    grid.className = 'theme-grid';
    grid.id = 'theme-grid';

    // Custom saved theme — always first, hidden until a custom theme exists
    const customThumbItem = document.createElement('div');
    customThumbItem.className = 'theme-thumb';
    customThumbItem.id = 'theme-thumb-custom';
    customThumbItem.style.display = 'none';
    const customThumbCanvas = document.createElement('canvas');
    customThumbCanvas.width = 64;
    customThumbCanvas.height = 64;
    const customThumbLabel = document.createElement('span');
    customThumbLabel.textContent = 'Custom';
    const customThumbDelete = document.createElement('button');
    customThumbDelete.className = 'theme-thumb-delete';
    customThumbDelete.textContent = '×';
    customThumbDelete.title = 'Delete custom theme';
    customThumbItem.appendChild(customThumbCanvas);
    customThumbItem.appendChild(customThumbLabel);
    customThumbItem.appendChild(customThumbDelete);
    grid.appendChild(customThumbItem);
    customThumbItem.addEventListener('click', () => {
      const saved = state.dungeon.metadata.customTheme;
      if (!saved) return;
      pushUndo();
      state.dungeon.metadata.theme = saved;
      syncCustomEditorValues();
      markDirty();
      notify();
    });
    customThumbDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndo();
      const isCustomActive = typeof state.dungeon.metadata.theme === 'object' && state.dungeon.metadata.theme !== null;
      state.dungeon.metadata.customTheme = null;
      if (isCustomActive) {
        state.dungeon.metadata.theme = catalog.names[0];
        syncCustomEditorValues();
      }
      syncThemePicker();
      markDirty();
      notify();
    });

    for (const key of catalog.names) {
      const item = document.createElement('div');
      item.className = 'theme-thumb';
      item.dataset.themeKey = key;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 64;
      thumbCanvas.height = 64;

      const label = document.createElement('span');
      label.textContent = catalog.themes[key].displayName || key;

      item.appendChild(thumbCanvas);
      item.appendChild(label);
      grid.appendChild(item);

      item.addEventListener('click', () => {
        pushUndo();
        // Save the current custom theme before switching to a preset
        const current = state.dungeon.metadata.theme;
        if (typeof current === 'object' && current !== null) {
          state.dungeon.metadata.customTheme = current;
        }
        state.dungeon.metadata.theme = key;
        syncCustomEditorValues();
        markDirty();
        notify();
      });

      // Render preview asynchronously
      idle(() => {
        try {
          const preview = renderThemePreview(key);
          const ctx = thumbCanvas.getContext('2d');
          ctx.drawImage(preview, 0, 0, preview.width, preview.height, 0, 0, 64, 64);
        } catch (err) {
          console.warn('[theme-picker] Preview failed for', key, err);
        }
      });
    }

    container.innerHTML = '';
    container.appendChild(grid);
  }

  function syncThemePicker() {
    const grid = document.getElementById('theme-grid');
    if (!grid) return;
    const current = state.dungeon.metadata.theme;
    const savedCustom = state.dungeon.metadata.customTheme;
    const isCustom = typeof current === 'object' && current !== null;

    // Preset thumbs
    grid.querySelectorAll('.theme-thumb:not(#theme-thumb-custom)').forEach(item => {
      item.classList.toggle('active', !isCustom && item.dataset.themeKey === current);
    });

    // Custom thumb: show if there's a saved or active custom theme
    const customThumb = document.getElementById('theme-thumb-custom');
    if (customThumb) {
      const hasCustom = isCustom || savedCustom != null;
      customThumb.style.display = hasCustom ? '' : 'none';
      customThumb.classList.toggle('active', isCustom);
    }
  }

  // ── Sync UI ──────────────────────────────────────────────────────────────

  function syncUI() {
    const mapTitleEl = document.getElementById('map-title');
    if (mapTitleEl) {
      const name = state.dungeon.metadata.dungeonName || 'Untitled';
      mapTitleEl.textContent = state.unsavedChanges ? `${name} *` : name;
    }
    if (nameInput) nameInput.value = state.dungeon.metadata.dungeonName || '';
    gridSizeSelect.value = state.dungeon.metadata.gridSize || 5;

    syncThemePicker();
    syncCustomEditorValues();

    labelStyleSelect.value = state.dungeon.metadata.labelStyle || 'circled';

    const features = state.dungeon.metadata.features || {};
    document.getElementById('feat-grid').checked = features.showGrid !== false;
    document.getElementById('feat-compass').checked = features.compassRose !== false;
    document.getElementById('feat-scale').checked = features.scale !== false;
    document.getElementById('feat-border').checked = features.border !== false;
    const editorSettings = getEditorSettings();
    document.getElementById('feat-fps').checked = editorSettings.fpsCounter === true;
    document.getElementById('feat-memory').checked = editorSettings.memoryUsage === true;
    document.getElementById('feat-minimap').checked = editorSettings.minimap === true;
    document.getElementById('feat-claude').checked = editorSettings.claude === true;
  }
  syncUI();
  subscribe(syncUI);

  // Build theme picker and custom editor after syncUI
  buildThemePicker();
  syncThemePicker();
  buildCustomEditor();

  // On load: if theme is already a custom object, seed customTheme and render the thumb
  {
    const t = state.dungeon.metadata.theme;
    if (typeof t === 'object' && t !== null) {
      if (!state.dungeon.metadata.customTheme) state.dungeon.metadata.customTheme = t;
      syncThemePicker();
      renderCustomThumb();
    } else if (state.dungeon.metadata.customTheme) {
      // A saved custom exists but active theme is a preset — just show the thumb
      syncThemePicker();
      renderCustomThumb();
    }
  }

  // Customize section: collapsible, collapsed by default
  const themePanel = document.getElementById('panel-themes');
  const sectionDivider = themePanel?.querySelector('.theme-section-divider');
  sectionDivider?.addEventListener('click', () => {
    themePanel.classList.toggle('customize-open');
  });

  // ── Menubar title: click to rename ───────────────────────────────────────

  const mapTitleEl = document.getElementById('map-title');
  if (mapTitleEl) {
    mapTitleEl.addEventListener('click', () => {
      const currentName = state.dungeon.metadata.dungeonName || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'map-title-input';
      input.value = currentName;
      mapTitleEl.replaceWith(input);
      input.focus();
      input.select();

      function commit() {
        const newName = input.value.trim() || currentName;
        pushUndo();
        state.dungeon.metadata.dungeonName = newName;
        if (nameInput) nameInput.value = newName;
        markDirty();
        notify();
        input.replaceWith(mapTitleEl);
      }

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') {
          input.removeEventListener('blur', commit);
          input.replaceWith(mapTitleEl);
        }
      });
    });
  }

  // ── Event listeners ──────────────────────────────────────────────────────

  if (nameInput) {
    nameInput.addEventListener('change', () => {
      pushUndo();
      state.dungeon.metadata.dungeonName = nameInput.value;
      markDirty();
      notify();
    });
  }

  gridSizeSelect.addEventListener('change', () => {
    pushUndo();
    state.dungeon.metadata.gridSize = parseInt(gridSizeSelect.value);
    markDirty();
    notify();
  });

  labelStyleSelect.addEventListener('change', () => {
    pushUndo();
    state.dungeon.metadata.labelStyle = labelStyleSelect.value;
    markDirty();
    notify();
  });

  document.getElementById('btn-resize').addEventListener('click', () => {
    const cells = state.dungeon.cells;
    const oldRows = cells.length;
    const oldCols = cells[0]?.length || 0;

    const modal = document.getElementById('modal-resize-canvas');
    const rowInput = document.getElementById('modal-resize-rows');
    const colInput = document.getElementById('modal-resize-cols');
    const cancelBtn = document.getElementById('modal-resize-canvas-cancel');
    const okBtn = document.getElementById('modal-resize-canvas-ok');
    if (!modal || !rowInput || !colInput) return;

    rowInput.value = oldRows;
    colInput.value = oldCols;
    modal.style.display = 'flex';
    rowInput.focus();
    rowInput.select();

    function cleanup() {
      modal.style.display = 'none';
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      modal.removeEventListener('click', onOverlay);
    }

    function onCancel() { cleanup(); }

    function onOk() {
      const newRows = Math.max(1, parseInt(rowInput.value) || oldRows);
      const newCols = Math.max(1, parseInt(colInput.value) || oldCols);
      cleanup();
      if (newRows === oldRows && newCols === oldCols) return;

      pushUndo('Resize canvas');

      if (newCols > oldCols) {
        for (const row of cells) while (row.length < newCols) row.push(null);
      } else if (newCols < oldCols) {
        for (const row of cells) row.length = newCols;
      }

      if (newRows > oldRows) {
        while (cells.length < newRows) {
          const row = [];
          for (let c = 0; c < newCols; c++) row.push(null);
          cells.push(row);
        }
      } else if (newRows < oldRows) {
        cells.length = newRows;
      }

      const levels = state.dungeon.metadata.levels;
      if (levels && levels.length === 1) levels[0].numRows = newRows;

      markDirty();
      notify();
    }

    function onOverlay(e) { if (e.target === modal) cleanup(); }

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    modal.addEventListener('click', onOverlay);
  });

  // Map feature checkboxes (saved with the dungeon)
  for (const [id, key] of [
    ['feat-grid', 'showGrid'],
    ['feat-compass', 'compassRose'],
    ['feat-scale', 'scale'],
    ['feat-border', 'border'],
  ]) {
    document.getElementById(id).addEventListener('change', (e) => {
      pushUndo();
      if (!state.dungeon.metadata.features) state.dungeon.metadata.features = {};
      state.dungeon.metadata.features[key] = e.target.checked;
      markDirty();
      notify();
    });
  }

  // Editor setting checkboxes (persist across maps, not saved in dungeon)
  for (const [id, key] of [
    ['feat-fps', 'fpsCounter'],
    ['feat-memory', 'memoryUsage'],
    ['feat-minimap', 'minimap'],
  ]) {
    document.getElementById(id).addEventListener('change', (e) => {
      setEditorSetting(key, e.target.checked);
      requestRender();
    });
  }

  // Claude AI toggle — requires reload to add/remove UI elements
  // When enabling, show a warning modal first; disabling proceeds immediately.
  document.getElementById('feat-claude').addEventListener('change', (e) => {
    if (!e.target.checked) {
      setEditorSetting('claude', false);
      location.reload();
      return;
    }

    // Revert checkbox — only commit if the user confirms in the modal
    e.target.checked = false;

    const modal = document.getElementById('modal-claude-agent-warning');
    if (!modal) return;
    modal.style.display = 'flex';

    const onCancel = () => {
      modal.style.display = 'none';
      cleanup();
    };
    const onEnable = () => {
      modal.style.display = 'none';
      cleanup();
      setEditorSetting('claude', true);
      location.reload();
    };
    const onOverlay = (ev) => { if (ev.target === modal) onCancel(); };

    function cleanup() {
      document.getElementById('modal-claude-warning-cancel').removeEventListener('click', onCancel);
      document.getElementById('modal-claude-warning-enable').removeEventListener('click', onEnable);
      modal.removeEventListener('click', onOverlay);
    }

    document.getElementById('modal-claude-warning-cancel').addEventListener('click', onCancel);
    document.getElementById('modal-claude-warning-enable').addEventListener('click', onEnable);
    modal.addEventListener('click', onOverlay);
  });
}
