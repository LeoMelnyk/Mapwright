// Metadata panel: dungeon name, gridSize, theme, features
import state, { pushUndo, markDirty, notify, subscribe } from '../state.js';
import { getThemeCatalog, renderThemePreview } from '../theme-catalog.js';
import { getEditorSettings, setEditorSetting } from '../editor-settings.js';
import { requestRender } from '../canvas-view.js';
import { buildCustomEditor, syncCustomEditorValues, renderCustomThumb } from './theme-editor.js';

const idle = window.requestIdleCallback
  ? (cb) => window.requestIdleCallback(cb)
  : (cb) => setTimeout(cb, 0);

export function init() {
  const nameInput = document.getElementById('meta-name');
  const gridSizeSelect = document.getElementById('meta-gridsize');
  const labelStyleSelect = document.getElementById('meta-labelstyle');
  const customEditor = document.getElementById('custom-theme-editor');

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
    customThumbDelete.textContent = '\u00D7';
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
  buildCustomEditor(customEditor);

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
