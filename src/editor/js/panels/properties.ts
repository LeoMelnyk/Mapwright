// Properties panel: Prop Explorer + Cell Info floating panel
import type { FillType, PropCatalog } from '../../../types.js';
import state, { getTheme, pushUndo, markDirty, subscribe, notify } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { renderProp } from '../../../render/index.js';
import { getTextureCatalog } from '../texture-catalog.js';
import { getEl, getCtx } from '../utils.js';

const panel = () => getEl('properties-content');

let explorerBuilt = false;
let onSelectProp: ((propType: string) => void) | null = null;
const collapsedCategories = new Set();

/**
 * Register a callback invoked when a prop is selected in the explorer.
 * @param {Function} fn - Callback receiving the prop type key
 */
export function setSelectPropCallback(fn: (propType: string) => void): void { onSelectProp = fn; }

/**
 * Initialize the properties panel: subscribe to state changes and render initial content.
 */
export function init(): void {
  subscribe(update, 'properties');
  update();
}

// ── Update (called on every state change) ───────────────────────────────────

let _lastSelectedProp: string | null = null;
let _lastSelectedCells: string | null = null;
let _lastSelectMode: string | null = null;
function update() {
  const el = panel();

  // Build prop explorer once when catalog becomes available
  if (!explorerBuilt && state.propCatalog) {
    buildPropExplorer(el);
  }

  // Update selected thumbnail highlight only when selectedProp changes
  if (state.selectedProp !== _lastSelectedProp) {
    _lastSelectedProp = state.selectedProp;
    updateSelectedThumb();
  }

  // Rebuild cell info only when selected cells or inspect mode changes
  const cellsSig = state.selectedCells.length > 0 ? `${state.selectedCells[0].row},${state.selectedCells[0].col}` : '';
  const modeSig = state.activeTool + ':' + state.selectMode;
  if (cellsSig !== _lastSelectedCells || modeSig !== _lastSelectMode) {
    _lastSelectedCells = cellsSig;
    _lastSelectMode = modeSig;
    updateCellInfo();
  }
}

// ── Prop Explorer ───────────────────────────────────────────────────────────

function buildPropExplorer(container: HTMLElement) {
  explorerBuilt = true;
  const catalog = state.propCatalog;
  if (!catalog?.categories) return;

  // Ensure the explorer wrapper exists (insert at top)
  let explorer = container.querySelector<HTMLElement>('#prop-explorer');
  if (!explorer) {
    explorer = document.createElement('div');
    explorer.id = 'prop-explorer';
    container.prepend(explorer);
  }
  explorer.innerHTML = '';

  // ── Pinned search bar ────────────────────────────────────────────────────
  const searchWrap = document.createElement('div');
  searchWrap.className = 'prop-search-wrap';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.id = 'prop-search-input';
  searchInput.placeholder = 'Search props…';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'search-clear-btn';
  clearBtn.title = 'Clear search';
  clearBtn.textContent = '×';
  clearBtn.style.display = 'none';

  searchInput.addEventListener('input', () => {
    clearBtn.style.display = searchInput.value ? '' : 'none';
    filterProps(searchInput.value.trim().toLowerCase());
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    filterProps('');
    searchInput.focus();
  });

  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(clearBtn);

  // ── Collapse / Expand all (VS Code-style panel actions) ──────────────────
  const actionSep = document.createElement('span');
  actionSep.className = 'texture-action-sep';

  const collapseAllBtn = document.createElement('button');
  collapseAllBtn.className = 'texture-action-btn';
  collapseAllBtn.title = 'Collapse All';
  collapseAllBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/></svg>`;
  collapseAllBtn.addEventListener('click', () => {
    catalog.categories.forEach((cat: string) => collapsedCategories.add(cat));
    scrollArea.querySelectorAll<HTMLElement>('.prop-category-title').forEach(t => t.classList.remove('open'));
    scrollArea.querySelectorAll<HTMLElement>('.prop-grid').forEach(g => { g.style.display = 'none'; });
  });

  const expandAllBtn = document.createElement('button');
  expandAllBtn.className = 'texture-action-btn';
  expandAllBtn.title = 'Expand All';
  expandAllBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>`;
  expandAllBtn.addEventListener('click', () => {
    collapsedCategories.clear();
    scrollArea.querySelectorAll<HTMLElement>('.prop-category-title').forEach(t => t.classList.add('open'));
    scrollArea.querySelectorAll<HTMLElement>('.prop-grid').forEach(g => { g.style.display = ''; });
  });

  searchWrap.appendChild(actionSep);
  searchWrap.appendChild(collapseAllBtn);
  searchWrap.appendChild(expandAllBtn);

  explorer.appendChild(searchWrap);

  // ── Scrollable categories area ───────────────────────────────────────────
  const scrollArea = document.createElement('div');
  scrollArea.className = 'prop-scroll-area';

  let html = '';
  for (const category of catalog.categories) {
    const propNames = catalog.byCategory?.[category];
    if (!propNames || propNames.length === 0) continue;

    html += `<div class="prop-category-title open" data-category="${category}">${category} <span class="collapse-arrow">&#9654;</span></div>`;
    html += `<div class="prop-grid" data-cat-grid="${category}">`;

    for (const propType of propNames) {
      const def = catalog.props[propType];
      const displayName = def.name || propType;
      html += `<div class="prop-thumb" data-prop="${propType}">`;
      html += '<div class="prop-thumb-shimmer"></div>';
      html += `<span>${displayName}</span>`;
      html += '</div>';
    }

    html += '</div>';
  }

  scrollArea.innerHTML = html;
  explorer.appendChild(scrollArea);

  // Bind click on category titles (collapse/expand) and thumbnails
  scrollArea.addEventListener('click', (e) => {
    const catTitle = (e.target as HTMLElement).closest<HTMLElement>('.prop-category-title');
    if (catTitle) {
      const cat = catTitle.dataset.category;
      const grid = scrollArea.querySelector<HTMLElement>(`.prop-grid[data-cat-grid="${cat}"]`);
      if (collapsedCategories.has(cat)) {
        collapsedCategories.delete(cat);
        catTitle.classList.add('open');
        if (grid) grid.style.display = '';
      } else {
        collapsedCategories.add(cat);
        catTitle.classList.remove('open');
        if (grid) grid.style.display = 'none';
      }
      return;
    }

    const thumb = (e.target as HTMLElement).closest<HTMLElement>('.prop-thumb');
    if (!thumb) return;
    const propType = thumb.dataset.prop;
    if (!propType) return;

    if (onSelectProp) {
      onSelectProp(propType);
    }
  });

  // Kick off async thumbnail rendering
  renderThumbnails(catalog);
}

function filterProps(query: string) {
  const el = panel();
  const explorer = el.querySelector<HTMLElement>('#prop-explorer');
  if (!explorer) return;

  const thumbs = explorer.querySelectorAll<HTMLElement>('.prop-thumb');
  const categoryTitles = explorer.querySelectorAll<HTMLElement>('.prop-category-title');

  // Track which categories have visible props
  const visibleCategories = new Set();

  thumbs.forEach(thumb => {
    const propType = thumb.dataset.prop;
    const label = thumb.querySelector('span')?.textContent.toLowerCase() ?? '';
    const match = !query || label.includes(query) || (propType?.includes(query) ?? false);
    thumb.style.display = match ? '' : 'none';
    if (match) {
      const grid = thumb.parentElement;
      const catTitle = grid?.previousElementSibling;
      if (catTitle?.classList.contains('prop-category-title')) {
        visibleCategories.add((catTitle as HTMLElement).dataset.category);
      }
    }
  });

  categoryTitles.forEach(title => {
    const cat = title.dataset.category;
    const hasVisible = visibleCategories.has(cat);
    title.style.display = hasVisible ? '' : 'none';

    const grid = explorer.querySelector<HTMLElement>(`.prop-grid[data-cat-grid="${cat}"]`);
    if (!grid) return;

    if (!hasVisible) {
      grid.style.display = 'none';
    } else if (query) {
      // While searching, always show matching grids regardless of collapse state
      grid.style.display = '';
    } else {
      // No query: respect collapse state
      grid.style.display = collapsedCategories.has(cat) ? 'none' : '';
    }
  });
}

function renderThumbnails(catalog: PropCatalog) {
  const allThumbs = panel().querySelectorAll<HTMLElement>('.prop-thumb');

  const theme = getTheme();
  const CANVAS_SIZE = 60;
  let index = 0;
  const BATCH_SIZE = 6; // render at least this many per tick regardless of idle budget

  function renderBatch() {
    let rendered = 0;
    while (index < allThumbs.length) {
      const thumb = allThumbs[index];
      index++;

      const propType = thumb.dataset.prop!;
      const def = catalog.props[propType];

      const [rows, cols] = def.footprint;
      const maxDim = Math.max(rows, cols);
      const scale = CANVAS_SIZE / maxDim;

      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;
      const ctx = getCtx(canvas);

      // White background for visibility against the dark panel
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      const transform = { scale, offsetX: 0, offsetY: 0, lineWidth: 1.5 };

      // Center the prop if non-square
      if (cols < maxDim) {
        transform.offsetX = (CANVAS_SIZE - cols * scale) / 2;
      }
      if (rows < maxDim) {
        transform.offsetY = (CANVAS_SIZE - rows * scale) / 2;
      }

      const texCat = getTextureCatalog();
      const getTexImg = texCat
        ? (id: string) => { const e = texCat.textures[id]; return e?.img?.complete ? e.img : null; }
        : null;
      renderProp(ctx, def, 0, 0, 0, 1, theme, transform, false, getTexImg);

      // Replace shimmer with canvas
      const shimmer = thumb.querySelector<HTMLElement>('.prop-thumb-shimmer');
      if (shimmer) {
        shimmer.replaceWith(canvas);
      }

      rendered++;
      // Yield after BATCH_SIZE to avoid blocking the main thread too long
      if (rendered >= BATCH_SIZE) {
        setTimeout(renderBatch, 0);
        return;
      }
    }
  }

  setTimeout(renderBatch, 0);
}

function updateSelectedThumb() {
  const el = panel();
  const explorer = el.querySelector<HTMLElement>('#prop-explorer');
  if (!explorer) return;

  const thumbs = explorer.querySelectorAll<HTMLElement>('.prop-thumb');
  thumbs.forEach(thumb => {
    if (thumb.dataset.prop === state.selectedProp) {
      thumb.classList.add('selected');
    } else {
      thumb.classList.remove('selected');
    }
  });
}

// ── Cell Info (floating panel) ──────────────────────────────────────────────

function getFloatPanel() {
  let fp = document.getElementById('cell-info-float');
   
  if (!fp) {
    fp = document.createElement('div');
    fp.id = 'cell-info-float';
    document.body.appendChild(fp);
  }
  return fp;
}

/**
 * Clear the current cell selection and hide the cell info panel.
 */
export function deselectCell(): void {
  state.selectedCells = [];
  notify();
  requestRender();
}

function updateCellInfo() {
  const fp = getFloatPanel();

  // Only show cell info when the inspect sub-mode is active
  const isInspectMode = state.activeTool === 'select' && state.selectMode === 'inspect';
  if (!state.selectedCells.length || !isInspectMode) {
    fp.classList.remove('visible');
    return;
  }

  const { row, col } = state.selectedCells[0];
  const cells = state.dungeon.cells;
  const cell = cells[row]?.[col];

  let bodyHtml = '';

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (cell === null || cell === undefined) {
    bodyHtml = '<p class="hint">Void cell (no data)</p>';
  } else {
    // Borders
    bodyHtml += '<div class="prop-section">Borders</div>';
    for (const dir of ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw']) {
      const val = (cell as Record<string, unknown>)[dir] ?? '\u2014';
      bodyHtml += `<div class="prop-row"><span>${dir}</span><span class="prop-val">${val}</span></div>`;
    }

    // Center
    bodyHtml += '<div class="prop-section">Center</div>';
    if (cell.center) {
      if (cell.center.label) bodyHtml += `<div class="prop-row"><span>label</span><span class="prop-val">${cell.center.label}</span></div>`;
      if (cell.center['stairs-up']) bodyHtml += `<div class="prop-row"><span>stairs-up</span><span class="prop-val">${JSON.stringify(cell.center['stairs-up'])}</span></div>`;
      if (cell.center['stairs-down']) bodyHtml += `<div class="prop-row"><span>stairs-down</span><span class="prop-val">${JSON.stringify(cell.center['stairs-down'])}</span></div>`;
      if (cell.center['stairs-link']) bodyHtml += `<div class="prop-row"><span>link</span><span class="prop-val">${cell.center['stairs-link']}</span></div>`;
    } else {
      bodyHtml += '<p class="hint">No center content</p>';
    }

    // Trim
    if (cell.trimCorner || cell.trimWall || cell.trimClip) {
      bodyHtml += '<div class="prop-section">Trim</div>';
      if (cell.trimCorner) bodyHtml += `<div class="prop-row"><span>corner</span><span class="prop-val">${cell.trimCorner}</span></div>`;
      if (cell.trimWall) bodyHtml += `<div class="prop-row"><span>type</span><span class="prop-val">round arc</span></div>`;
      else if (cell['ne-sw'] || cell['nw-se']) bodyHtml += `<div class="prop-row"><span>type</span><span class="prop-val">straight diagonal</span></div>`;
      if (cell.trimOpen) bodyHtml += `<div class="prop-row"><span>open</span><span class="prop-val">true</span></div>`;
      if (cell.trimInverted) bodyHtml += `<div class="prop-row"><span>inverted</span><span class="prop-val">true</span></div>`;
      if (cell.trimWall) bodyHtml += `<div class="prop-row"><span>wall pts</span><span class="prop-val">${cell.trimWall.length}</span></div>`;
      if (cell.trimClip) bodyHtml += `<div class="prop-row"><span>clip pts</span><span class="prop-val">${cell.trimClip.length}</span></div>`;
    }

    // Fill
    bodyHtml += '<div class="prop-section">Fill</div>';
    const currentFill = cell.fill ?? '';
    bodyHtml += `<div class="prop-row"><span>type</span><select id="prop-fill-select">`;
    bodyHtml += `<option value=""${currentFill === '' ? ' selected' : ''}>None</option>`;
    bodyHtml += `<option value="water"${currentFill === 'water' ? ' selected' : ''}>Water</option>`;
    bodyHtml += `<option value="lava"${currentFill === 'lava' ? ' selected' : ''}>Lava</option>`;
    bodyHtml += `<option value="pit"${currentFill === 'pit' ? ' selected' : ''}>Pit</option>`;
    bodyHtml += `</select></div>`;
    if (currentFill === 'water' || currentFill === 'lava') {
      const depthKey = currentFill + 'Depth';
      const wd = ((cell as Record<string, unknown>)[depthKey] as number | undefined) ?? 1;
      bodyHtml += `<div class="prop-row"><span>depth</span><select id="prop-fluid-depth">`;
      bodyHtml += `<option value="1"${wd === 1 ? ' selected' : ''}>Shallow</option>`;
      bodyHtml += `<option value="2"${wd === 2 ? ' selected' : ''}>Medium</option>`;
      bodyHtml += `<option value="3"${wd === 3 ? ' selected' : ''}>Deep</option>`;
      bodyHtml += `</select></div>`;
    }
    // Hazard overlay (independent of fill)
    const hasHazard = cell.hazard ?? (cell.fill as string) === 'difficult-terrain';
    bodyHtml += `<div class="prop-row"><span>hazard</span><input type="checkbox" id="prop-hazard-check"${hasHazard ? ' checked' : ''}></div>`;

    // Prop info (from overlay)
    const meta = state.dungeon.metadata;
    const gs = meta.gridSize || 5;
    const overlayProp = meta.props?.find((p: { x: number; y: number }) => Math.abs(p.x - col * gs) < 0.01 && Math.abs(p.y - row * gs) < 0.01);
    if (overlayProp) {
      const Z_NAMES = { 0: 'floor', 10: 'furniture', 20: 'tall', 30: 'hanging' };
      const zName = (Z_NAMES as Record<string, string>)[overlayProp.zIndex] || '';
      const scalePercent = Math.round((overlayProp.scale) * 100);
      bodyHtml += '<div class="prop-section">Prop</div>';
      bodyHtml += `<div class="prop-row"><span>type</span><span class="prop-val">${overlayProp.type}</span></div>`;
      bodyHtml += `<div class="prop-row"><span>rotation</span><span class="prop-val">${overlayProp.rotation}\u00b0</span></div>`;
      bodyHtml += `<div class="prop-row"><span>scale</span><span class="prop-val">${scalePercent}%</span></div>`;
      bodyHtml += `<div class="prop-row"><span>z-order</span><span class="prop-val">${zName ? zName + ' (' + overlayProp.zIndex + ')' : overlayProp.zIndex}</span></div>`;
      if (overlayProp.flipped) bodyHtml += `<div class="prop-row"><span>flipped</span><span class="prop-val">true</span></div>`;
      bodyHtml += `<div class="prop-row"><span>id</span><span class="prop-val">${overlayProp.id}</span></div>`;
    }

    // Texture
    if (cell.texture || cell.textureSecondary) {
      bodyHtml += '<div class="prop-section">Texture</div>';
      if (cell.texture) bodyHtml += `<div class="prop-row"><span>primary</span><span class="prop-val" title="${cell.texture}">${cell.texture.split('/').pop()}</span></div>`;
      if (cell.textureSecondary) bodyHtml += `<div class="prop-row"><span>secondary</span><span class="prop-val" title="${cell.textureSecondary}">${cell.textureSecondary.split('/').pop()}</span></div>`;
    }

    // Raw JSON (collapsed by default)
    bodyHtml += '<details class="prop-raw-details"><summary class="prop-section" style="cursor:pointer">Raw JSON \u25B6</summary>';
    bodyHtml += `<pre class="prop-json">${JSON.stringify(cell, null, 2)}</pre></details>`;
  }

  fp.innerHTML = `
    <div class="cell-info-float-header">
      <span>Cell [${row}, ${col}]</span>
      <button class="cell-info-close" title="Close (Esc)">&#x2715;</button>
    </div>
    <div class="cell-info-float-body">${bodyHtml}</div>
  `;

  fp.classList.add('visible');

  fp.querySelector('.cell-info-close')!.addEventListener('click', deselectCell);

  const fillSelect = fp.querySelector<HTMLElement>('#prop-fill-select');
  if (fillSelect) {
    fillSelect.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as FillType | '';
      pushUndo();
      for (const { row: r, col: c } of state.selectedCells) {
        const targetCell = state.dungeon.cells[r]?.[c];
        if (!targetCell) continue;
        if (value) {
          targetCell.fill = value;
          if (value === 'water') {
            targetCell.waterDepth = targetCell.waterDepth ?? 1;
            delete targetCell.lavaDepth;
          } else if (value === 'lava') {
            targetCell.lavaDepth = targetCell.lavaDepth ?? 1;
            delete targetCell.waterDepth;
          } else {
            delete targetCell.waterDepth;
            delete targetCell.lavaDepth;
          }
        } else {
          delete targetCell.fill;
          delete targetCell.waterDepth;
          delete targetCell.lavaDepth;
        }
      }
      markDirty();
      notify();
    });
  }

  const depthSelect = fp.querySelector<HTMLElement>('#prop-fluid-depth');
  if (depthSelect) {
    depthSelect.addEventListener('change', (e) => {
      const depth = parseInt((e.target as HTMLSelectElement).value, 10);
      pushUndo();
      for (const { row: r, col: c } of state.selectedCells) {
        const targetCell = state.dungeon.cells[r]?.[c];
        if (!targetCell) continue;
        if (targetCell.fill === 'water') targetCell.waterDepth = depth;
        else if (targetCell.fill === 'lava') targetCell.lavaDepth = depth;
      }
      markDirty();
      notify();
    });
  }

  const hazardCheck = fp.querySelector<HTMLElement>('#prop-hazard-check');
  if (hazardCheck) {
    hazardCheck.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      pushUndo();
      for (const { row: r, col: c } of state.selectedCells) {
        const targetCell = state.dungeon.cells[r]?.[c];
        if (!targetCell) continue;
        if (checked) {
          targetCell.hazard = true;
          // Migrate legacy format
          if ((targetCell.fill as string) === 'difficult-terrain') delete targetCell.fill;
        } else {
          delete targetCell.hazard;
        }
      }
      markDirty();
      notify();
    });
  }
}
