// Custom theme editor — extracted from metadata.js
import state, { pushUndo, markDirty, notify } from '../state.js';
import { THEMES } from '../../../render/index.js';
import { invalidateGridCache } from '../canvas-view.js';
import { renderThemePreview, saveUserTheme } from '../theme-catalog.js';

// Theme property labels for the custom editor
const THEME_PROPS = [
  ['background', 'Background'],
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

function parseRgbaColor(color: any) {
  const m = color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
    const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
    return { hex, alpha };
  }
  return { hex: color || '#000000', alpha: 1 };
}

function hexAlphaToRgba(hex: any, alpha: any) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Custom theme editor — collapsible section state
const CTE_COLLAPSED_KEY = 'mw-cte-collapsed';
function loadCteCollapsed() {
  try {
    // @ts-expect-error — strict-mode migration
    const saved = JSON.parse(localStorage.getItem(CTE_COLLAPSED_KEY));
    if (Array.isArray(saved)) return new Set(saved);
  } catch {}
  // Default: Colors expanded, everything else collapsed
  return new Set(['Walls', 'Shading', 'Hatching', 'Textures', 'Water', 'Lava', 'Labels']);
}
const cteCollapsed = loadCteCollapsed();
function saveCteCollapsed() {
  localStorage.setItem(CTE_COLLAPSED_KEY, JSON.stringify([...cteCollapsed]));
}

// Use setTimeout instead of requestIdleCallback — rIC gets starved by the animated render loop
const idle = (cb: any) => setTimeout(cb, 0);

function buildCustomEditor(customEditorEl: any) {
  const theme = getCustomThemeBase();
  const shading = theme.outerShading || {};
  const hatchColor = theme.hatchColor || theme.wallStroke || '#000000';
  const hatchSize = theme.hatchSize ?? 0.5;
  const hatchOpacity = theme.hatchOpacity ?? 0;
  const hatchDistance = theme.hatchDistance ?? 1;
  const hatchStyle = theme.hatchStyle ?? 'lines';
  const gridStyle = theme.gridStyle ?? 'lines';
  const gridLineWidth = theme.gridLineWidth ?? 4;
  const gridCornerLength = theme.gridCornerLength ?? 0.3;
  const gridNoise = theme.gridNoise ?? 0;
  const gridOpacity = theme.gridOpacity ?? 0.5;
  const wallRoughness = theme.wallRoughness ?? 0;
  const wallShadow = theme.wallShadow || {};
  const parsedShadow = parseRgbaColor(wallShadow.color || 'rgba(0,0,0,0.2)');
  const bufferOpacity = theme.bufferShadingOpacity ?? 0;

  // ── HTML helpers ───────────────────────────────────────────────────────
  const colorRow = (label: any, attrName: any, attrVal: any, val: any) =>
    `<div class="cte-row">
      <span class="cte-label">${label}</span>
      <div class="cte-color-group">
        <input type="color" ${attrName}="${attrVal}" class="cte-color-swatch" value="${val}">
        <span class="cte-color-hex">${val}</span>
      </div>
    </div>`;

  const sliderRow = (label: any, numAttr: any, rangeAttr: any, key: any, val: any, min: any, max: any, step: any) =>
    `<div class="cte-slider-row">
      <div class="cte-slider-header">
        <span class="cte-label">${label}</span>
        <input type="number" ${numAttr}="${key}" class="cte-num" value="${val}" min="${min}" max="${max}" step="${step}">
      </div>
      <input type="range" ${rangeAttr}="${key}" class="cte-range" value="${val}" min="${min}" max="${max}" step="${step}">
    </div>`;

  const selectRow = (label: any, attrs: any, optionsHtml: any) =>
    `<div class="cte-row">
      <span class="cte-label">${label}</span>
      <select class="cte-select" ${attrs}>${optionsHtml}</select>
    </div>`;

  // ── Build HTML ─────────────────────────────────────────────────────────

  // Collapsible section wrapper
  const section = (name: any, contentHtml: any) => {
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

  // Grid section
  html += section('Grid', `
    ${colorRow('Color', 'data-grid-prop', 'color', theme.gridLine || '#000000')}
    ${selectRow('Style', 'data-grid-prop="style"', `
      <option value="lines" ${gridStyle === 'lines' ? 'selected' : ''}>Lines</option>
      <option value="dotted" ${gridStyle === 'dotted' ? 'selected' : ''}>Dotted Lines</option>
      <option value="corners-x" ${gridStyle === 'corners-x' ? 'selected' : ''}>Corner Crosses</option>
      <option value="corners-dot" ${gridStyle === 'corners-dot' ? 'selected' : ''}>Corner Dots</option>
    `)}
    ${sliderRow('Width', 'data-grid-prop', 'data-grid-range', 'lineWidth', gridLineWidth, 1, 8, 1)}
    ${sliderRow('Opacity', 'data-grid-prop', 'data-grid-range', 'opacity', gridOpacity, 0, 1, 0.05)}
    <div data-grid-cond="corners-x" style="${gridStyle === 'corners-x' ? '' : 'display:none'}">
      ${sliderRow('Corner Length', 'data-grid-prop', 'data-grid-range', 'cornerLength', gridCornerLength, 0.05, 0.5, 0.05)}
    </div>
    <div data-grid-cond="lines,dotted" style="${gridStyle === 'lines' || gridStyle === 'dotted' ? '' : 'display:none'}">
      ${sliderRow('Noise', 'data-grid-prop', 'data-grid-range', 'noise', gridNoise, 0, 1, 0.05)}
    </div>
  `);

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

  // Labels section
  const labels = theme.labels || {};
  html += section('Labels', `
    ${colorRow('Border', 'data-label-prop', 'borderColor', labels.borderColor || '#000000')}
    ${colorRow('Font', 'data-label-prop', 'fontColor', labels.fontColor || '#000000')}
    ${colorRow('Background', 'data-label-prop', 'backgroundColor', labels.backgroundColor || '#FFFFFF')}
  `);

  html += '<button id="btn-save-user-theme" class="cte-save-btn">Save as Theme</button>';

  html += '</div>';
  customEditorEl.innerHTML = html;

  // "Save as Theme" button — shows inline name input on click
  const saveBtn = customEditorEl.querySelector('#btn-save-user-theme');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      // Replace button with inline input
      const wrapper = document.createElement('div');
      wrapper.className = 'cte-save-inline';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cte-save-input';
      input.placeholder = 'Theme name…';
      const okBtn = document.createElement('button');
      okBtn.className = 'cte-save-ok';
      okBtn.textContent = '✓';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'cte-save-cancel';
      cancelBtn.textContent = '✕';
      wrapper.appendChild(input);
      wrapper.appendChild(okBtn);
      wrapper.appendChild(cancelBtn);
      saveBtn.replaceWith(wrapper);
      input.focus();

      function revert() {
        wrapper.replaceWith(saveBtn);
      }

      async function commit() {
        const name = input.value.trim();
        if (!name) { revert(); return; }
        const t = state.dungeon.metadata.theme;
        if (typeof t !== 'object' || t === null) { revert(); return; }
        try {
          // @ts-expect-error — strict-mode migration
          const themeObj = { ...t };
          delete themeObj.displayName;
          const key = await saveUserTheme(name, themeObj);
          pushUndo();
          state.dungeon.metadata.theme = `user:${key}`;
          // @ts-expect-error — strict-mode migration
          state.dungeon.metadata.savedThemeData = { name, theme: themeObj };
          markDirty();
          notify();
          window.dispatchEvent(new CustomEvent('user-themes-changed'));
          revert();
        } catch (err) {
          input.style.borderColor = '#a02030';
          input.value = (err as any).message;
          input.select();
        }
      }

      okBtn.addEventListener('click', commit);
      cancelBtn.addEventListener('click', revert);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); revert(); }
      });
    });
  }

  // Section collapse/expand toggle
  customEditorEl.addEventListener('click', (e: any) => {
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
  customEditorEl.querySelectorAll('input[data-theme-prop]').forEach((input: any) => {
    input.addEventListener('input', () => {
      const prop = input.dataset.themeProp;
      const theme = ensureCustomThemeObject();
      (theme as any)[prop] = input.value;
      const hex = input.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = input.value;
      markDirty();
    });
    input.addEventListener('change', () => {
      pushUndo();
      const prop = input.dataset.themeProp;
      const theme = ensureCustomThemeObject();
      (theme as any)[prop] = input.value;
      state.dungeon.metadata.customTheme = theme;
      markDirty();
      notify();
      renderCustomThumb();
    });
  });

  // Grid color picker
  const gridColorInput = customEditorEl.querySelector('[data-grid-prop="color"]');
  if (gridColorInput) {
    gridColorInput.addEventListener('input', () => {
      const t = ensureCustomThemeObject();
      (t as any).gridLine = gridColorInput.value;
      const hex = gridColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = gridColorInput.value;
      invalidateGridCache();
      markDirty();
      notify();
    });
    gridColorInput.addEventListener('change', () => {
      pushUndo();
      const t = ensureCustomThemeObject();
      (t as any).gridLine = gridColorInput.value;
      invalidateGridCache();
      markDirty();
      notify();
      renderCustomThumb();
    });
  }

  // Grid style selector
  const gridStyleSelect = customEditorEl.querySelector('[data-grid-prop="style"]');
  if (gridStyleSelect) {
    const syncGridConditions = (val: any) => {
      customEditorEl.querySelectorAll('[data-grid-cond]').forEach((el: any) => {
        const allowed = el.dataset.gridCond.split(',');
        el.style.display = allowed.includes(val) ? '' : 'none';
      });
    };
    gridStyleSelect.addEventListener('change', () => {
      pushUndo();
      const t = ensureCustomThemeObject();
      (t as any).gridStyle = gridStyleSelect.value;
      syncGridConditions(gridStyleSelect.value);
      invalidateGridCache();
      markDirty();
      notify();
      renderCustomThumb();
    });
  }

  // Grid numeric + range controls (lineWidth, cornerLength, noise)
  for (const prop of ['lineWidth', 'opacity', 'cornerLength', 'noise']) {
    const numInput = customEditorEl.querySelector(`[data-grid-prop="${prop}"]`);
    const rangeInput = customEditorEl.querySelector(`[data-grid-range="${prop}"]`);
    if (!numInput || !rangeInput) continue;
    const keyMap = { lineWidth: 'gridLineWidth', opacity: 'gridOpacity', cornerLength: 'gridCornerLength', noise: 'gridNoise' };
    const sync = (value: any, source: any) => {
      const t = ensureCustomThemeObject();
      // @ts-expect-error — strict-mode migration
      (t as any)[keyMap[prop]] = Number(value);
      if (numInput !== source) numInput.value = value;
      if (rangeInput !== source) rangeInput.value = value;
    };
    numInput.addEventListener('input', () => { sync(numInput.value, numInput); invalidateGridCache(); markDirty(); notify(); });
    numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); invalidateGridCache(); renderCustomThumb(); });
    rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); invalidateGridCache(); markDirty(); notify(); });
    rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); invalidateGridCache(); renderCustomThumb(); });
  }

  // Shading color picker
  const shadingColorInput = customEditorEl.querySelector('[data-shading-prop="color"]');
  if (shadingColorInput) {
    shadingColorInput.addEventListener('input', () => {
      const t = ensureCustomThemeObject();
      if (!(t as any).outerShading) (t as any).outerShading = {};
      (t as any).outerShading.color = shadingColorInput.value;
      const hex = shadingColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = shadingColorInput.value;
      markDirty();
      notify();
    });
    shadingColorInput.addEventListener('change', () => {
      pushUndo();
      const t = ensureCustomThemeObject();
      if (!(t as any).outerShading) (t as any).outerShading = {};
      (t as any).outerShading.color = shadingColorInput.value;
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

    const sync = (value: any, source: any) => {
      const t = ensureCustomThemeObject();
      if (!(t as any).outerShading) (t as any).outerShading = {};
      (t as any).outerShading[prop] = Number(value);
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
      const sync = (value: any, source: any) => {
        const t = ensureCustomThemeObject();
        (t as any).wallRoughness = Number(value);
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
      if (!(t as any).wallShadow) (t as any).wallShadow = {};
      const opacityEl = customEditorEl.querySelector('[data-wshadow-prop="opacity"]');
      const alpha = opacityEl ? Number(opacityEl.value) : 0.2;
      (t as any).wallShadow.color = hexAlphaToRgba(wShadowColorInput.value, alpha);
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
    const sync = (value: any, source: any) => {
      const t = ensureCustomThemeObject();
      if (!(t as any).wallShadow) (t as any).wallShadow = {};
      if (prop === 'opacity') {
        const colorInput = customEditorEl.querySelector('[data-wshadow-prop="color"]');
        (t as any).wallShadow.color = hexAlphaToRgba(colorInput?.value || '#000000', Number(value));
      } else {
        (t as any).wallShadow[prop] = Number(value);
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
      const sync = (value: any, source: any) => {
        const t = ensureCustomThemeObject();
        (t as any).bufferShadingOpacity = Number(value);
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
      (t as any).hatchStyle = hatchStyleSelect.value;
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
      (t as any).hatchColor = hatchColorInput.value;
      const hex = hatchColorInput.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = hatchColorInput.value;
      markDirty();
      notify();
    });
    hatchColorInput.addEventListener('change', () => {
      pushUndo();
      const t = ensureCustomThemeObject();
      (t as any).hatchColor = hatchColorInput.value;
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

    const sync = (value: any, source: any) => {
      const t = ensureCustomThemeObject();
      if (prop === 'opacity') {
        (t as any).hatchOpacity = Number(value);
      } else if (prop === 'distance') {
        (t as any).hatchDistance = Number(value);
      } else {
        (t as any).hatchSize = Number(value);
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
      const sync = (value: any, source: any) => {
        const t = ensureCustomThemeObject();
        (t as any).textureBlendWidth = Number(value);
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
      (t as any).waterCausticColor = hexAlphaToRgba(causticColorInput.value, alpha);
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
      const sync = (value: any, source: any) => {
        const t = ensureCustomThemeObject();
        const colorInput = customEditorEl.querySelector('[data-caustic-prop="color"]');
        (t as any).waterCausticColor = hexAlphaToRgba(colorInput?.value || '#a0d7ff', Number(value));
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
      (t as any).lavaCausticColor = hexAlphaToRgba(lavaCausticColorInput.value, alpha);
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
      const sync = (value: any, source: any) => {
        const t = ensureCustomThemeObject();
        const colorInput = customEditorEl.querySelector('[data-lava-caustic-prop="color"]');
        (t as any).lavaCausticColor = hexAlphaToRgba(colorInput?.value || '#ffa03c', Number(value));
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
      const sync = (value: any, source: any) => {
        const t = ensureCustomThemeObject();
        (t as any).lavaLightIntensity = Number(value);
        if (numInput !== source) numInput.value = value;
        if (rangeInput !== source) rangeInput.value = value;
      };
      numInput.addEventListener('input', () => { sync(numInput.value, numInput); markDirty(); notify(); });
      numInput.addEventListener('change', () => { pushUndo(); sync(numInput.value, numInput); renderCustomThumb(); });
      rangeInput.addEventListener('input', () => { sync(rangeInput.value, rangeInput); markDirty(); notify(); });
      rangeInput.addEventListener('change', () => { pushUndo(); sync(rangeInput.value, rangeInput); renderCustomThumb(); });
    }
  }

  // Label color pickers (borderColor, fontColor, backgroundColor)
  customEditorEl.querySelectorAll('input[data-label-prop]').forEach((input: any) => {
    input.addEventListener('input', () => {
      const prop = input.dataset.labelProp;
      const t = ensureCustomThemeObject();
      if (!(t as any).labels) (t as any).labels = {};
      (t as any).labels[prop] = input.value;
      const hex = input.parentElement?.querySelector('.cte-color-hex');
      if (hex) hex.textContent = input.value;
      markDirty();
      notify();
    });
    input.addEventListener('change', () => {
      pushUndo();
      const prop = input.dataset.labelProp;
      const t = ensureCustomThemeObject();
      if (!(t as any).labels) (t as any).labels = {};
      (t as any).labels[prop] = input.value;
      state.dungeon.metadata.customTheme = t;
      markDirty();
      notify();
      renderCustomThumb();
    });
  });
}

function getCustomThemeBase() {
  const t = state.dungeon.metadata.theme;
  if (typeof t === 'object' && t !== null) return t;
  const base = typeof t === 'string' ? THEMES[t] : THEMES['blue-parchment'];
  return JSON.parse(JSON.stringify(base));
}

/**
 * Returns a mutable theme object for the custom editor to modify.
 * - If the active theme is already an inline custom object, returns it directly.
 * - If it's a user-saved theme (user:xxx), returns the THEMES registry entry
 *   so edits mutate the saved theme in place (persisted via _persistUserTheme).
 * - If it's a built-in preset, clones it into an inline custom object.
 */
function ensureCustomThemeObject() {
  let t = state.dungeon.metadata.theme;
  // Inline custom object — edit directly
  if (typeof t === 'object' && t !== null) return t;
  // User-saved theme — edit the registry entry in place
  if (typeof t === 'string' && t.startsWith('user:') && THEMES[t]) {
    return THEMES[t];
  }
  // Built-in preset — clone into inline custom
  t = getCustomThemeBase();
  state.dungeon.metadata.theme = t;
  return t;
}

/** Debounced persist of a user theme to disk after edits. */
let _persistTimer: any = null;
function _persistUserTheme() {
  const t = state.dungeon.metadata.theme;
  if (typeof t !== 'string' || !t.startsWith('user:')) return;
  const key = t.slice(5);
  const themeObj = THEMES[t];
  if (!themeObj) return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    fetch(`/api/user-themes/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: themeObj }),
    }).catch(() => {});
  }, 500);
}

function syncCustomEditorValues() {
  const customEditor = document.getElementById('custom-theme-editor');
  const theme = getCustomThemeBase();

  // Only show "Save as Theme" when the active theme is a custom object (not a preset or saved user theme)
  const saveBtn = customEditor?.querySelector('#btn-save-user-theme');
  if (saveBtn) {
    const isCustomObj = typeof state.dungeon.metadata.theme === 'object' && state.dungeon.metadata.theme !== null;
    (saveBtn as HTMLElement).style.display = isCustomObj ? '' : 'none';
  }

  // Helper: set a color swatch input + its hex span
  const syncColor = (input: any, value: any) => {
    if (!input || !value) return;
    input.value = value;
    const hex = input.parentElement?.querySelector('.cte-color-hex');
    if (hex) hex.textContent = value;
  };

  // Theme color props
  customEditor!.querySelectorAll('input[data-theme-prop]').forEach(input => {
    const prop = (input as HTMLElement).dataset.themeProp;
    if (theme[prop!]) syncColor(input, theme[prop!]);
  });

  // Grid controls
  syncColor(customEditor!.querySelector('[data-grid-prop="color"]'), theme.gridLine || '#000000');
  const gridStyleSel = customEditor!.querySelector('[data-grid-prop="style"]');
  const gridStyleVal = theme.gridStyle ?? 'lines';
  if (gridStyleSel) (gridStyleSel as HTMLInputElement).value = gridStyleVal;
  customEditor!.querySelectorAll('[data-grid-cond]').forEach(el => {
    // @ts-expect-error — strict-mode migration
    const allowed = (el as HTMLElement).dataset.gridCond.split(',');
    (el as HTMLElement).style.display = allowed.includes(gridStyleVal) ? '' : 'none';
  });
  for (const [prop, val] of [
    ['lineWidth', theme.gridLineWidth ?? 4],
    ['opacity', theme.gridOpacity ?? 0.5],
    ['cornerLength', theme.gridCornerLength ?? 0.3],
    ['noise', theme.gridNoise ?? 0],
  ]) {
    const ni = customEditor!.querySelector(`[data-grid-prop="${prop}"]`);
    const ri = customEditor!.querySelector(`[data-grid-range="${prop}"]`);
    if (ni) (ni as HTMLInputElement).value = val;
    if (ri) (ri as HTMLInputElement).value = val;
  }

  // Wall controls
  const wrNum = customEditor!.querySelector('[data-wall-prop="roughness"]');
  const wrRange = customEditor!.querySelector('[data-wall-range="roughness"]');
  if (wrNum) (wrNum as HTMLInputElement).value = theme.wallRoughness ?? 0;
  if (wrRange) (wrRange as HTMLInputElement).value = theme.wallRoughness ?? 0;

  const ws = theme.wallShadow || {};
  const parsedWS = parseRgbaColor(ws.color || 'rgba(0,0,0,0.2)');
  syncColor(customEditor!.querySelector('[data-wshadow-prop="color"]'), parsedWS.hex);
  for (const [prop, fallback] of [
    ['opacity', parsedWS.alpha],
    ['blur', ws.blur ?? 8],
    ['offsetX', ws.offsetX ?? 4],
    ['offsetY', ws.offsetY ?? 4],
  ]) {
    const ni = customEditor!.querySelector(`[data-wshadow-prop="${prop}"]`);
    const ri = customEditor!.querySelector(`[data-wshadow-range="${prop}"]`);
    if (ni) (ni as HTMLInputElement).value = fallback;
    if (ri) (ri as HTMLInputElement).value = fallback;
  }

  // Buffer opacity
  const bufN = customEditor!.querySelector('[data-buf-prop="opacity"]');
  const bufR = customEditor!.querySelector('[data-buf-range="opacity"]');
  if (bufN) (bufN as HTMLInputElement).value = theme.bufferShadingOpacity ?? 0;
  if (bufR) (bufR as HTMLInputElement).value = theme.bufferShadingOpacity ?? 0;

  // Outer shading controls
  const shading = theme.outerShading || {};
  syncColor(customEditor!.querySelector('[data-shading-prop="color"]'), shading.color);
  for (const prop of ['size', 'roughness']) {
    const val = shading[prop] ?? 0;
    const numInput = customEditor!.querySelector(`[data-shading-prop="${prop}"]`);
    const rangeInput = customEditor!.querySelector(`[data-shading-range="${prop}"]`);
    if (numInput) (numInput as HTMLInputElement).value = val;
    if (rangeInput) (rangeInput as HTMLInputElement).value = val;
  }

  // Hatching controls
  const hatchStyleSel = customEditor!.querySelector('[data-hatch-prop="style"]');
  if (hatchStyleSel) (hatchStyleSel as HTMLInputElement).value = theme.hatchStyle ?? 'lines';

  syncColor(customEditor!.querySelector('[data-hatch-prop="color"]'), theme.hatchColor || theme.wallStroke || '#000000');

  const pairs = [
    ['size', theme.hatchSize ?? 0.5],
    ['opacity', theme.hatchOpacity ?? 0],
    ['distance', theme.hatchDistance ?? 1],
  ];
  for (const [prop, val] of pairs) {
    const numInput = customEditor!.querySelector(`[data-hatch-prop="${prop}"]`);
    const rangeInput = customEditor!.querySelector(`[data-hatch-range="${prop}"]`);
    if (numInput) (numInput as HTMLInputElement).value = val;
    if (rangeInput) (rangeInput as HTMLInputElement).value = val;
  }

  // Texture blend width
  const tbNum = customEditor!.querySelector('[data-texblend-prop="blendWidth"]');
  const tbRange = customEditor!.querySelector('[data-texblend-range="blendWidth"]');
  const tbVal = theme.textureBlendWidth ?? 0.35;
  if (tbNum) (tbNum as HTMLInputElement).value = tbVal;
  if (tbRange) (tbRange as HTMLInputElement).value = tbVal;

  // Water caustic
  const parsedCausticSync = parseRgbaColor(theme.waterCausticColor || 'rgba(160,215,255,0.55)');
  syncColor(customEditor!.querySelector('[data-caustic-prop="color"]'), parsedCausticSync.hex);
  const causticOpN = customEditor!.querySelector('[data-caustic-prop="opacity"]');
  const causticOpR = customEditor!.querySelector('[data-caustic-range="opacity"]');
  // @ts-expect-error — strict-mode migration
  if (causticOpN) (causticOpN as HTMLInputElement).value = parsedCausticSync.alpha;
  // @ts-expect-error — strict-mode migration
  if (causticOpR) (causticOpR as HTMLInputElement).value = parsedCausticSync.alpha;

  // Lava caustic
  const parsedLavaCausticSync = parseRgbaColor(theme.lavaCausticColor || 'rgba(255,160,60,0.55)');
  syncColor(customEditor!.querySelector('[data-lava-caustic-prop="color"]'), parsedLavaCausticSync.hex);
  const lavaCausticOpN = customEditor!.querySelector('[data-lava-caustic-prop="opacity"]');
  const lavaCausticOpR = customEditor!.querySelector('[data-lava-caustic-range="opacity"]');
  // @ts-expect-error — strict-mode migration
  if (lavaCausticOpN) (lavaCausticOpN as HTMLInputElement).value = parsedLavaCausticSync.alpha;
  // @ts-expect-error — strict-mode migration
  if (lavaCausticOpR) (lavaCausticOpR as HTMLInputElement).value = parsedLavaCausticSync.alpha;

  // Lava light intensity
  const lavaLightIntN = customEditor!.querySelector('[data-lava-light-prop="intensity"]');
  const lavaLightIntR = customEditor!.querySelector('[data-lava-light-range="intensity"]');
  const lavaLightIntVal = theme.lavaLightIntensity ?? 0.70;
  if (lavaLightIntN) (lavaLightIntN as HTMLInputElement).value = lavaLightIntVal;
  if (lavaLightIntR) (lavaLightIntR as HTMLInputElement).value = lavaLightIntVal;

  // Label colors
  const labelColors = theme.labels || {};
  syncColor(customEditor!.querySelector('[data-label-prop="borderColor"]'), labelColors.borderColor || '#000000');
  syncColor(customEditor!.querySelector('[data-label-prop="fontColor"]'), labelColors.fontColor || '#000000');
  syncColor(customEditor!.querySelector('[data-label-prop="backgroundColor"]'), labelColors.backgroundColor || '#FFFFFF');
}

function renderCustomThumb() {
  // If editing a user-saved theme, persist changes to disk (debounced)
  _persistUserTheme();

  const customThumb = document.getElementById('theme-thumb-custom');
  if (!customThumb) return;
  const isCustom = typeof state.dungeon.metadata.theme === 'object' && state.dungeon.metadata.theme !== null;
  const themeToRender = isCustom ? state.dungeon.metadata.theme : state.dungeon.metadata.customTheme;
  if (!themeToRender) return;
  idle(() => {
    try {
      const preview = renderThemePreview(themeToRender);
      // @ts-expect-error — strict-mode migration
      const ctx = customThumb!.querySelector('canvas').getContext('2d');
      ctx!.clearRect(0, 0, 64, 64);
      ctx!.drawImage(preview, 0, 0, preview.width, preview.height, 0, 0, 64, 64);
    } catch (err) {
      console.warn('[theme-picker] Custom preview failed:', err);
    }
  });
}

export { buildCustomEditor, getCustomThemeBase, ensureCustomThemeObject, syncCustomEditorValues, renderCustomThumb };
