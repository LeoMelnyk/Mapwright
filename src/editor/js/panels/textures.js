// Textures panel — sidebar panel for browsing and selecting floor textures.
// Features: sticky search bar, collapsible categories, click to select.
import state from '../state.js';
import { getTextureCatalog, loadTextureImages } from '../texture-catalog.js';

let container = null;
let searchInput = null;
let scrollArea = null;
const collapsed = new Set(); // category names that are collapsed

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
  searchInput.addEventListener('input', () => filterTextures(cat));
  searchWrap.appendChild(searchInput);

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

        const img = document.createElement('img');
        img.src = `/textures/${entry.file}`;
        img.alt = entry.displayName;
        img.className = 'texture-thumb-img';
        img.loading = 'lazy';
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
