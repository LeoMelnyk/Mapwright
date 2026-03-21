// Textures panel — sidebar panel for browsing and selecting floor textures.
// Features: sticky search bar, collapsible categories, click to select.
import state from '../state.js';
import { getTextureCatalog, loadTextureImages } from '../texture-catalog.js';

let container = null;
let searchInput = null;
let scrollArea = null;
let _searchTimer = null;

const TEX_COLLAPSED_KEY = 'mw-texture-collapsed';
const collapsed = new Set(JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(TEX_COLLAPSED_KEY)) || '[]'));

function saveCollapsed() {
  localStorage.setItem(TEX_COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

/**
 * Initialize the textures panel inside the given container element.
 * Called once from main.js after the catalog has loaded.
 */
export function initTexturesPanel(containerEl) {
  container = containerEl;
  render();
}

/**
 * Re-render the panel contents (e.g. to update active selection highlight).
 */
export function renderTexturesPanel() {
  if (container) render();
}

function render() {
  const cat = getTextureCatalog();
  if (!cat) { container.innerHTML = '<div class="panel-empty">Textures not loaded.</div>'; return; }

  container.innerHTML = '';

  // ── Sticky search bar ────────────────────────────────────────────────────
  const searchWrap = document.createElement('div');
  searchWrap.className = 'texture-search-wrap';

  searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search textures…';
  searchInput.className = 'texture-search-input';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'search-clear-btn';
  clearBtn.title = 'Clear search';
  clearBtn.textContent = '×';
  clearBtn.style.display = 'none';

  searchInput.addEventListener('input', () => {
    clearBtn.style.display = searchInput.value ? '' : 'none';
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => filterTextures(cat), 200);
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    filterTextures(cat);
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
    cat.categoryOrder.forEach(c => collapsed.add(c));
    saveCollapsed();
    filterTextures(cat);
  });

  const expandAllBtn = document.createElement('button');
  expandAllBtn.className = 'texture-action-btn';
  expandAllBtn.title = 'Expand All';
  expandAllBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>`;
  expandAllBtn.addEventListener('click', () => {
    collapsed.clear();
    saveCollapsed();
    filterTextures(cat);
  });

  searchWrap.appendChild(actionSep);
  searchWrap.appendChild(collapseAllBtn);
  searchWrap.appendChild(expandAllBtn);

  container.appendChild(searchWrap);

  // ── Scrollable texture grid ──────────────────────────────────────────────
  scrollArea = document.createElement('div');
  scrollArea.className = 'texture-scroll-area';

  buildCategoryGrid(cat, scrollArea, '');

  container.appendChild(scrollArea);
}

/**
 * Build the category + grid structure into the given parent element.
 */
function buildCategoryGrid(cat, parent, filter) {
  parent.innerHTML = '';
  const lowerFilter = filter.toLowerCase();

  for (const category of cat.categoryOrder) {
    const ids = cat.byCategory[category];
    const matched = lowerFilter
      ? ids.filter(id => {
          const entry = cat.textures[id];
          return entry.displayName.toLowerCase().includes(lowerFilter)
            || id.toLowerCase().includes(lowerFilter);
        })
      : ids;

    if (matched.length === 0) continue;

    // Category header (clickable to toggle)
    const catHeader = document.createElement('div');
    catHeader.className = 'texture-category-header';
    const isCollapsed = collapsed.has(category);
    catHeader.classList.toggle('collapsed', isCollapsed);

    const arrow = document.createElement('span');
    arrow.className = 'texture-category-arrow';
    arrow.textContent = isCollapsed ? '▶' : '▼';

    const label = document.createElement('span');
    label.className = 'texture-category-label';
    label.textContent = `${category} (${matched.length})`;

    catHeader.append(arrow, label);
    catHeader.addEventListener('click', () => {
      if (collapsed.has(category)) {
        collapsed.delete(category);
      } else {
        collapsed.add(category);
      }
      saveCollapsed();
      filterTextures(cat);
    });
    parent.appendChild(catHeader);

    // Grid (hidden when collapsed)
    if (!isCollapsed) {
      const grid = document.createElement('div');
      grid.className = 'texture-thumb-grid';

      for (const id of matched) {
        const entry = cat.textures[id];
        const item = document.createElement('div');
        item.className = 'texture-thumb-item';
        if (state.activeTexture === id) item.classList.add('active');
        item.title = entry.displayName;
        item.dataset.textureId = id;

        const shimmer = document.createElement('div');
        shimmer.className = 'texture-thumb-shimmer';

        const img = document.createElement('img');
        img.alt = entry.displayName;
        img.className = 'texture-thumb-img';
        img.style.display = 'none';
        const revealImg = () => { shimmer.remove(); img.style.display = ''; };
        img.addEventListener('load', revealImg);
        img.addEventListener('error', revealImg);
        img.src = `/textures/${entry.file}`; // set src AFTER listeners so cached images fire correctly
        // If already complete (browser cache hit before load event fires), reveal immediately
        if (img.complete) revealImg();

        item.appendChild(shimmer);
        item.appendChild(img);

        const nameEl = document.createElement('span');
        nameEl.className = 'texture-thumb-name';
        nameEl.textContent = entry.displayName;
        item.appendChild(nameEl);

        item.addEventListener('click', () => selectTexture(id));
        grid.appendChild(item);
      }

      parent.appendChild(grid);
    }
  }
}

function filterTextures(cat) {
  if (!scrollArea) return;
  buildCategoryGrid(cat, scrollArea, searchInput?.value || '');
}

/**
 * Select a texture by ID — sets activeTexture on state, switches paint tool
 * to texture mode, and updates panel highlight.
 */
export function selectTexture(id) {
  state.activeTexture = id;
  loadTextureImages(id); // pre-load images so they're ready when the user paints

  // Auto-switch paint tool to texture mode
  state.activeTool = 'paint';

  // Update toolbar buttons and activate the tool on the canvas
  import('./toolbar.js').then(m => {
    m.updateToolButtons();
    m.setSubMode('paint', 'texture');
    m.activateTool('paint');
  });

  // Update panel highlights
  if (scrollArea) {
    scrollArea.querySelectorAll('.texture-thumb-item').forEach(el => {
      el.classList.toggle('active', el.dataset.textureId === id);
    });
  }
}
