// Metadata panel: dungeon name, gridSize, theme, features
import type { LabelStyle, Metadata, Theme } from '../../../types.js';
import state, { pushUndo, markDirty, notify, subscribe } from '../state.js';
import { getThemeCatalog, renderThemePreview, deleteUserTheme, renameUserTheme } from '../theme-catalog.js';
import { getEditorSettings, setEditorSetting } from '../editor-settings.js';
import { requestRender, invalidateMapCache } from '../canvas-view.js';
import { invalidateLightmapCaches } from '../../../render/index.js';
import { buildCustomEditor, syncCustomEditorValues, renderCustomThumb } from './theme-editor.js';

// bypass requestIdleCallback — starved by animated render loop
const idle = (cb: () => void) => setTimeout(cb, 0);

/**
 * Initialize the metadata panel: dungeon name, grid size, theme, label style, and feature toggles.
 */
export function init(): void {
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
      const saved = state.dungeon.metadata.customTheme as string | Theme | undefined;
      if (!saved) return;
      pushUndo();
      state.dungeon.metadata.theme = saved;
      syncThemePicker();
      syncCustomEditorValues();
      markDirty();
      notify();
    });
    customThumbDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndo();
      const isCustomActive = typeof state.dungeon.metadata.theme === 'object';
      state.dungeon.metadata.customTheme = null;
      if (isCustomActive) {
        state.dungeon.metadata.theme = catalog.names[0];
        syncCustomEditorValues();
      }
      syncThemePicker();
      markDirty();
      notify();
    });

    // User-saved themes — between Custom and built-ins
    for (const uKey of catalog.userNames) {
      const userTheme = catalog.userThemes[uKey];
      const fullKey = `user:${uKey}`;
      const item = document.createElement('div');
      item.className = 'theme-thumb theme-thumb-user';
      item.dataset.themeKey = fullKey;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 64;
      thumbCanvas.height = 64;

      const label = document.createElement('span');
      label.textContent = (userTheme.displayName as string) || uKey;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'theme-thumb-delete';
      deleteBtn.textContent = '\u00D7';
      deleteBtn.title = 'Delete saved theme';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'theme-thumb-rename';
      renameBtn.textContent = '\u270E';
      renameBtn.title = 'Rename theme';

      item.appendChild(thumbCanvas);
      item.appendChild(label);
      item.appendChild(deleteBtn);
      item.appendChild(renameBtn);
      grid.appendChild(item);

      item.addEventListener('click', () => {
        pushUndo();
        const current = state.dungeon.metadata.theme;
        if (typeof current === 'object') {
          state.dungeon.metadata.customTheme = current;
        }
        state.dungeon.metadata.theme = fullKey;
        state.dungeon.metadata.savedThemeData = {
          name: (userTheme.displayName as string) || uKey,
          theme: { ...userTheme },
        };
        delete state.dungeon.metadata.savedThemeData.theme.displayName;
        syncThemePicker();
        syncCustomEditorValues();
        markDirty();
        notify();
      });

      deleteBtn.addEventListener('click', (e) => { void (async () => {
        e.stopPropagation();
        pushUndo();
        await deleteUserTheme(uKey);
        const isActive = state.dungeon.metadata.theme === fullKey;
        if (isActive) {
          state.dungeon.metadata.theme = catalog.names[0];
          delete state.dungeon.metadata.savedThemeData;
          syncCustomEditorValues();
        }
        buildThemePicker();
        syncThemePicker();
        markDirty();
        notify();
      })(); });

      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentName = (userTheme.displayName as string) || uKey;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'theme-thumb-rename-input';
        input.value = currentName;
        label.replaceWith(input);
        input.focus();
        input.select();

        function revert() { input.replaceWith(label); }

        async function commitAsync() {
          const newName = input.value.trim();
          if (!newName || newName === currentName) { revert(); return; }
          pushUndo();
          try {
            const newKey = await renameUserTheme(uKey, newName);
            const isActive = state.dungeon.metadata.theme === fullKey;
            if (isActive) {
              state.dungeon.metadata.theme = `user:${newKey}`;
              state.dungeon.metadata.savedThemeData = { name: newName, theme: { ...userTheme } };
              delete state.dungeon.metadata.savedThemeData.theme.displayName;
            }
            buildThemePicker();
            syncThemePicker();
            markDirty();
            notify();
          } catch {
            input.style.borderColor = '#a02030';
          }
        }
        function commit() { void commitAsync(); }

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
          if (ev.key === 'Escape') { ev.preventDefault(); input.removeEventListener('blur', commit); revert(); }
        });
      });

      idle(() => {
        try {
          const preview = renderThemePreview(fullKey);
          const ctx = thumbCanvas.getContext('2d');
          ctx!.drawImage(preview, 0, 0, preview.width, preview.height, 0, 0, 64, 64);
        } catch (err) {
          console.warn('[theme-picker] Preview failed for', fullKey, err);
        }
      });
    }

    for (const key of catalog.names) {
      const item = document.createElement('div');
      item.className = 'theme-thumb';
      item.dataset.themeKey = key;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 64;
      thumbCanvas.height = 64;

      const label = document.createElement('span');
      label.textContent = (catalog.themes[key].displayName as string) || key;

      item.appendChild(thumbCanvas);
      item.appendChild(label);
      grid.appendChild(item);

      item.addEventListener('click', () => {
        pushUndo();
        // Save the current custom theme before switching to a preset
        const current = state.dungeon.metadata.theme;
        if (typeof current === 'object') {
          state.dungeon.metadata.customTheme = current;
        }
        state.dungeon.metadata.theme = key;
        delete state.dungeon.metadata.savedThemeData;
        syncThemePicker();
        syncCustomEditorValues();
        markDirty();
        notify();
      });

      // Render preview asynchronously
      idle(() => {
        try {
          const preview = renderThemePreview(key);
          const ctx = thumbCanvas.getContext('2d');
          ctx!.drawImage(preview, 0, 0, preview.width, preview.height, 0, 0, 64, 64);
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
    const isCustom = typeof current === 'object';

    // Preset thumbs
    grid.querySelectorAll('.theme-thumb:not(#theme-thumb-custom)').forEach(item => {
      item.classList.toggle('active', !isCustom && (item as HTMLElement).dataset.themeKey === current);
    });

    // Custom thumb: show if there's a saved or active custom theme
    const customThumb = document.getElementById('theme-thumb-custom');
    if (customThumb) {
      const hasCustom = isCustom || savedCustom != null;
      customThumb.style.display = hasCustom ? '' : 'none';
      customThumb.classList.toggle('active', isCustom);
    }

    // Auto-expand the customize panel when a custom theme is active
    const themePanel = document.getElementById('panel-themes');
    if (themePanel && isCustom) {
      themePanel.classList.add('customize-open');
    }
  }

  // ── Sync UI ──────────────────────────────────────────────────────────────

  let _lastMeta: Metadata | null = null;
  let _lastUnsaved: boolean = false;
  let _lastTheme: string | Theme | null = null;
  function syncUI() {
    // Only sync title on unsaved-flag or name change (cheap check every notify)
    const name = state.dungeon.metadata.dungeonName || 'Untitled';
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string should also fall back to 'Untitled'
    if (state.unsavedChanges !== _lastUnsaved || name !== (_lastMeta?.dungeonName || 'Untitled')) {
      const mapTitleEl = document.getElementById('map-title');
      if (mapTitleEl) mapTitleEl.textContent = state.unsavedChanges ? `${name} *` : name;
      _lastUnsaved = state.unsavedChanges;
    }
    // Theme can change from string→object without metadata ref changing,
    // so always check for theme type changes to keep the picker in sync
    const currentTheme = state.dungeon.metadata.theme;
    if (currentTheme !== _lastTheme) {
      _lastTheme = currentTheme;
      syncThemePicker();
    }
    // Skip full sync if metadata reference hasn't changed
    if (state.dungeon.metadata === _lastMeta) return;
    _lastMeta = state.dungeon.metadata;

    if (nameInput) (nameInput as HTMLInputElement).value = state.dungeon.metadata.dungeonName || '';
    const res = state.dungeon.metadata.resolution || 1;
    if (gridSizeSelect) (gridSizeSelect as HTMLSelectElement).value = String((state.dungeon.metadata.gridSize || 5) * res);

    syncThemePicker();
    syncCustomEditorValues();

    if (labelStyleSelect) (labelStyleSelect as HTMLSelectElement).value = state.dungeon.metadata.labelStyle;

    const features = state.dungeon.metadata.features;
    const elGrid = document.getElementById('feat-grid') as HTMLInputElement | null;
    if (elGrid) elGrid.checked = features.showGrid;
    const elCompass = document.getElementById('feat-compass') as HTMLInputElement | null;
    if (elCompass) elCompass.checked = features.compassRose;
    const elScale = document.getElementById('feat-scale') as HTMLInputElement | null;
    if (elScale) elScale.checked = features.scale;
    const elBorder = document.getElementById('feat-border') as HTMLInputElement | null;
    if (elBorder) elBorder.checked = features.border;
    const editorSettings = getEditorSettings();
    const elFps = document.getElementById('feat-fps') as HTMLInputElement | null;
    if (elFps) elFps.checked = editorSettings.fpsCounter === true;
    const elMinimap = document.getElementById('feat-minimap') as HTMLInputElement | null;
    if (elMinimap) elMinimap.checked = editorSettings.minimap === true;
    const elClaude = document.getElementById('feat-claude') as HTMLInputElement | null;
    if (elClaude) elClaude.checked = editorSettings.claude === true;
    const elDebug = document.getElementById('feat-debug') as HTMLInputElement | null;
    if (elDebug) elDebug.checked = editorSettings.debug === true;
    const debugBtn = document.querySelector('.right-icon-btn[data-right-panel="debug"]');
    if (debugBtn) (debugBtn as HTMLElement).style.display = editorSettings.debug ? '' : 'none';
    const rqSelect = document.getElementById('setting-render-quality');
    if (rqSelect) (rqSelect as HTMLInputElement).value = String(editorSettings.renderQuality ?? 20);
    const lqSelect = document.getElementById('setting-light-quality');
    if (lqSelect) (lqSelect as HTMLInputElement).value = String(editorSettings.lightQuality ?? 10);
  }
  syncUI();
  subscribe(syncUI, 'metadata');

  // Rebuild theme picker when user themes change (save/delete/rename from theme-editor)
  window.addEventListener('user-themes-changed', () => {
    buildThemePicker();
    syncThemePicker();
  });

  // Build theme picker and custom editor after syncUI
  buildThemePicker();
  syncThemePicker();
  if (customEditor) buildCustomEditor(customEditor);

  // On load: if theme is already a custom object, seed customTheme and render the thumb
  {
    const t = state.dungeon.metadata.theme;
    if (typeof t === 'object') {
      state.dungeon.metadata.customTheme ??= t;
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
  if (themePanel) {
    const sectionDivider = themePanel.querySelector('.theme-section-divider');
    sectionDivider?.addEventListener('click', () => {
      themePanel.classList.toggle('customize-open');
    });
  }

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
        if (nameInput) (nameInput as HTMLInputElement).value = newName;
        markDirty();
        notify();
        input.replaceWith(mapTitleEl!);
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
      state.dungeon.metadata.dungeonName = (nameInput as HTMLInputElement).value;
      markDirty();
      notify();
    });
  }

  gridSizeSelect?.addEventListener('change', () => {
    pushUndo();
    const res = state.dungeon.metadata.resolution || 1;
    state.dungeon.metadata.gridSize = parseInt((gridSizeSelect as HTMLSelectElement).value) / res;
    markDirty();
    notify();
  });

  labelStyleSelect?.addEventListener('change', () => {
    pushUndo();
    state.dungeon.metadata.labelStyle = (labelStyleSelect as HTMLSelectElement).value as LabelStyle;
    markDirty();
    notify();
  });

  document.getElementById('btn-resize')?.addEventListener('click', () => {
    const cells = state.dungeon.cells;
    const oldRows = cells.length;
    const oldCols = cells[0]?.length || 0;

    const modal = document.getElementById('modal-resize-canvas');
    const rowInput = document.getElementById('modal-resize-rows');
    const colInput = document.getElementById('modal-resize-cols');
    const cancelBtn = document.getElementById('modal-resize-canvas-cancel');
    const okBtn = document.getElementById('modal-resize-canvas-ok');
    if (!modal || !rowInput || !colInput || !cancelBtn || !okBtn) return;

    (rowInput as HTMLInputElement).value = String(oldRows);
    (colInput as HTMLInputElement).value = String(oldCols);
    (modal as HTMLDialogElement).showModal();
    rowInput.focus();
    (rowInput as HTMLInputElement).select();

    function cleanup() {
      (modal as HTMLDialogElement).close();
      cancelBtn!.removeEventListener('click', onCancel);
      okBtn!.removeEventListener('click', onOk);
      modal!.removeEventListener('click', onOverlay);
    }

    function onCancel() { cleanup(); }

    function onOk() {
      const newRows = Math.max(1, parseInt((rowInput as HTMLInputElement).value) || oldRows);
      const newCols = Math.max(1, parseInt((colInput as HTMLInputElement).value) || oldCols);
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
      if (levels.length === 1) levels[0].numRows = newRows;

      markDirty();
      notify();
    }

    function onOverlay(e: MouseEvent) { if (e.target === modal) cleanup(); }

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
    document.getElementById(id)?.addEventListener('change', (e) => {
      pushUndo();
      (state.dungeon.metadata.features as unknown as Record<string, boolean>)[key] = ((e.target ?? e.currentTarget) as HTMLInputElement).checked;
      markDirty();
      notify();
    });
  }

  // Editor setting checkboxes (persist across maps, not saved in dungeon)
  for (const [id, key] of [
    ['feat-fps', 'fpsCounter'],
    ['feat-minimap', 'minimap'],
  ]) {
    document.getElementById(id)?.addEventListener('change', (e) => {
      setEditorSetting(key, ((e.target ?? e.currentTarget) as HTMLInputElement).checked);
      requestRender();
    });
  }

  // Render quality dropdown (editor setting, persists across maps)
  const rqSelect = document.getElementById('setting-render-quality');
  if (rqSelect) {
    rqSelect.addEventListener('change', () => {
      setEditorSetting('renderQuality', parseInt((rqSelect as HTMLInputElement).value));
      requestRender();
    });
  }

  // Light quality dropdown (editor setting, persists across maps)
  const lqSelect = document.getElementById('setting-light-quality');
  if (lqSelect) {
    lqSelect.addEventListener('change', () => {
      setEditorSetting('lightQuality', parseInt((lqSelect as HTMLInputElement).value));
      invalidateLightmapCaches(); // tear down old lightmap canvases so they rebuild at new resolution
      invalidateMapCache();
      requestRender();
    });
  }

  // Debug panel toggle — show/hide the debug icon button in the right sidebar
  document.getElementById('feat-debug')?.addEventListener('change', (e) => {
    setEditorSetting('debug', ((e.target ?? e.currentTarget) as HTMLInputElement).checked);
    const debugBtn = document.querySelector<HTMLElement>('.right-icon-btn[data-right-panel="debug"]');
    if (debugBtn) debugBtn.style.display = ((e.target ?? e.currentTarget) as HTMLInputElement).checked ? '' : 'none';
  });

  // Claude AI toggle — requires reload to add/remove UI elements
  // When enabling, show a warning modal first; disabling proceeds immediately.
  document.getElementById('feat-claude')?.addEventListener('change', (e) => {
    if (!(e.target as HTMLInputElement).checked) {
      setEditorSetting('claude', false);
      location.reload();
      return;
    }

    // Revert checkbox — only commit if the user confirms in the modal
    ((e.target ?? e.currentTarget) as HTMLInputElement).checked = false;

    const modal = document.getElementById('modal-claude-agent-warning');
    if (!modal) return;
    (modal as HTMLDialogElement).showModal();

    const onCancel = () => {
      (modal as HTMLDialogElement).close();
      cleanup();
    };
    const onEnable = () => {
      (modal as HTMLDialogElement).close();
      cleanup();
      setEditorSetting('claude', true);
      location.reload();
    };
    const onOverlay = (ev: MouseEvent) => { if (ev.target === modal) onCancel(); };

    function cleanup() {
      document.getElementById('modal-claude-warning-cancel')?.removeEventListener('click', onCancel);
      document.getElementById('modal-claude-warning-enable')?.removeEventListener('click', onEnable);
      modal!.removeEventListener('click', onOverlay);
    }

    document.getElementById('modal-claude-warning-cancel')?.addEventListener('click', onCancel);
    document.getElementById('modal-claude-warning-enable')?.addEventListener('click', onEnable);
    modal.addEventListener('click', onOverlay);
  });
}
