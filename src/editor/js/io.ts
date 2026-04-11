// File I/O: load, save, new dungeon, export PNG

/** Window with File System Access API (not in lib.dom.d.ts by default). */
interface FilePickerWindow {
  showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle>;
}

import type { Dungeon } from '../../types.js';
import state, { pushUndo, markDirty, notify } from './state.js';
import { CURRENT_FORMAT_VERSION, migrateToLatest } from './migrations.js';
import { showToast } from './toast.js';
import { createEmptyDungeon } from './utils.js';
import { calculateCanvasSize, renderDungeonToCanvas, invalidatePropsCache, invalidateAllCaches, THEMES, BRIDGE_TEXTURE_IDS } from '../../render/index.js';
import { validateDungeonStructure } from '../../render/validate.js';
import { collectTextureIds, ensureTexturesLoaded, loadTextureCatalog, clearTextureCatalogCache } from './texture-catalog.js';
import { loadPropCatalog, clearPropCatalogCache } from './prop-catalog.js';
import { loadThemeCatalog, clearThemeCatalogCache, saveUserTheme } from './theme-catalog.js';
import { loadLightCatalog, clearLightCatalogCache } from './light-catalog.js';
import { requestRender, zoomToFit, invalidateMapCache } from './canvas-view.js';
import { markPropSpatialDirty } from './prop-spatial.js';
import { onMapLoaded } from './dm-session.js';

/**
 * Load a dungeon JSON object into the editor state.
 * @param {Object} json - A valid dungeon JSON with metadata + cells.
 * @param {Object} [opts] - Options: fileHandle, fileName.
 * @returns {void}
 */
export function loadDungeonJSON(json: Dungeon, opts: { fileHandle?: FileSystemFileHandle | null; fileName?: string } = {}): void {
  pushUndo();
  state.dungeon = json;
  (migrateToLatest as (j: unknown) => void)(json);

  // Lightweight structural validation — warn but don't reject
  const loadWarnings = validateDungeonStructure(json);
  if (loadWarnings.length > 0) {
    console.warn('[load] Dungeon structure warnings:', loadWarnings);
    showToast(`Loaded with ${loadWarnings.length} warning(s) — check console for details`);
  }

  // Ensure metadata fields added in later versions exist on old maps
  const meta = json.metadata as Record<string, unknown>;
  meta.stairs ??= [];
  meta.bridges ??= [];
  meta.nextStairId ??= 1;
  meta.nextBridgeId ??= 1;

  // Auto-install embedded user theme if not locally available
  const _theme = json.metadata.theme;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
  if (typeof _theme === 'string' && _theme.startsWith('user:') && !THEMES[_theme] && json.metadata.savedThemeData?.theme) {
    // Register in memory for immediate use
    (THEMES as Record<string, unknown>)[_theme] = json.metadata.savedThemeData.theme;
    // Persist to disk for future sessions (fire-and-forget)
    saveUserTheme(((json.metadata.savedThemeData as Record<string, unknown>).name as string) || _theme.slice(5), json.metadata.savedThemeData.theme as Record<string, string | number | boolean>).catch(() => {});
  }

  state.currentLevel = 0;
  state.selectedCells = [];
  state.fileHandle = opts.fileHandle ?? null;
  state.fileName = opts.fileName ?? null;
  // Flush all render caches (geometry, fluid, blend, visibility, props)
  // so stale data from the previous map doesn't bleed through.
  invalidateAllCaches();
  // If a player session is active, reset fog and re-init the player with the new map
  onMapLoaded();
  markDirty();
  state.unsavedChanges = false;
  notify();
  // Load images for textures used in the loaded map (floor + props)
  const usedIds = collectTextureIds(json.cells);
  if (state.propCatalog?.props && json.metadata.props) {
    for (const op of json.metadata.props) {
      const propDef = state.propCatalog.props[op.type];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
      if (propDef?.textures) {
        for (const id of propDef.textures) usedIds.add(id);
      }
    }
  }
  // Bridge textures (single source of truth: render/constants.ts BRIDGE_TEXTURE_IDS)
  if (json.metadata.bridges.length) {
    const bridgeTexLookup = BRIDGE_TEXTURE_IDS as unknown as Record<string, string | undefined>;
    for (const b of json.metadata.bridges) {
      const tid = bridgeTexLookup[b.type];
      if (tid) usedIds.add(tid);
    }
  }
  showEditorLoading();
  if (usedIds.size > 0) {
    void ensureTexturesLoaded(usedIds).then(() => {
      state.texturesVersion++;
      notify();
      hideEditorLoading();
    }).catch((err: unknown) => {
      // Don't leave the loading overlay stuck on. The map itself loaded fine —
      // textures just won't render until the next reload.
      console.warn('[load] texture load failed; map will render without textures', err);
      showToast('Some textures failed to load — re-open the map to retry');
      hideEditorLoading();
    });
  } else {
    hideEditorLoading();
  }
  // Zoom to fit the loaded map in the viewport
  requestAnimationFrame(() => zoomToFit());
}

/**
 * Migrate legacy half-cell texture properties to the unified primary/secondary format.
 * @param {Object} dungeon - The dungeon object with cells to migrate.
 * @returns {void}
 */
export function migrateHalfTextures(dungeon: Dungeon): void {
  for (const row of dungeon.cells) {
    for (const cell of row) {
      if (!cell) continue;
      const hasOld = cell.textureNE !== undefined || cell.textureSW !== undefined
                   || cell.textureNW !== undefined || cell.textureSE !== undefined;
      if (!hasOld) continue;
      if (cell['nw-se']) {
        if (cell.textureNE) { cell.texture = cell.textureNE; if (cell.textureNEOpacity !== undefined) cell.textureOpacity = cell.textureNEOpacity; }
        if (cell.textureSW) { cell.textureSecondary = cell.textureSW; if (cell.textureSWOpacity !== undefined) cell.textureSecondaryOpacity = cell.textureSWOpacity; }
      } else if (cell['ne-sw']) {
        if (cell.textureNW) { cell.texture = cell.textureNW; if (cell.textureNWOpacity !== undefined) cell.textureOpacity = cell.textureNWOpacity; }
        if (cell.textureSE) { cell.textureSecondary = cell.textureSE; if (cell.textureSEOpacity !== undefined) cell.textureSecondaryOpacity = cell.textureSEOpacity; }
      }
      delete cell.textureNE; delete cell.textureNEOpacity;
      delete cell.textureSW; delete cell.textureSWOpacity;
      delete cell.textureNW; delete cell.textureNWOpacity;
      delete cell.textureSE; delete cell.textureSEOpacity;
    }
  }
}

function getSuggestedName() {
  return (state.dungeon.metadata.dungeonName || 'dungeon')
    .replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.mapwright';
}

function showConfirmModal(message: string) {
  return new Promise(resolve => {
    const overlay = document.getElementById('modal-confirm')!;
    const msg     = document.getElementById('modal-confirm-msg')!;
    const btnOk   = document.getElementById('modal-confirm-ok')!;
    const btnCancel = document.getElementById('modal-confirm-cancel')!;
    msg.textContent = message;
    (overlay as HTMLDialogElement).showModal();
    const finish = (result: boolean) => {
      (overlay as HTMLDialogElement).close();
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('cancel', onNativeCancel);
      resolve(result);
    };
    const onOk     = () => finish(true);
    const onCancel = () => finish(false);
    const onNativeCancel = (e: Event) => { e.preventDefault(); finish(false); };
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('cancel', onNativeCancel);
  });
}

function showNewMapModal(): Promise<{ name: string; rows: number; cols: number } | null> {
  return new Promise(resolve => {
    const overlay  = document.getElementById('modal-new-map')!;
    const nameEl   = document.getElementById('modal-map-name')!;
    const rowsEl   = document.getElementById('modal-map-rows')!;
    const colsEl   = document.getElementById('modal-map-cols')!;
    const btnCreate = document.getElementById('modal-new-create')!;
    const btnCancel = document.getElementById('modal-new-cancel')!;

    (nameEl as HTMLInputElement).value = 'New Dungeon';
    (rowsEl as HTMLInputElement).value = '20';
    (colsEl as HTMLInputElement).value = '30';
    (overlay as HTMLDialogElement).showModal();
    setTimeout(() => (nameEl as HTMLInputElement).select(), 0);

    const finish = (result: { name: string; rows: number; cols: number } | null) => {
      (overlay as HTMLDialogElement).close();
      btnCreate.removeEventListener('click', onCreate);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onCreate = () => finish({
      name: (nameEl as HTMLInputElement).value.trim() || 'New Dungeon',
      rows: parseInt((rowsEl as HTMLInputElement).value) || 20,
      cols: parseInt((colsEl as HTMLInputElement).value) || 30,
    });
    const onCancel = () => finish(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter')  { e.preventDefault(); onCreate(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    btnCreate.addEventListener('click', onCreate);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKey);
  });
}

async function confirmUnsaved() {
  if (!state.unsavedChanges) return true;
  return showConfirmModal('You have unsaved changes. Continue without saving?');
}

/**
 * Load a dungeon JSON via File System Access API (or fallback file input).
 * @returns {Promise<void>}
 */
function showEditorLoading(): void {
  document.getElementById('editor-loading-overlay')?.classList.remove('hidden');
}

function hideEditorLoading(): void {
  document.getElementById('editor-loading-overlay')?.classList.add('hidden');
}

export async function loadDungeon(): Promise<void> {
  if (!await confirmUnsaved()) return;

  // Try File System Access API first
  if ((window as unknown as FilePickerWindow).showOpenFilePicker) {
    try {
      const [handle] = await (window as unknown as FilePickerWindow).showOpenFilePicker!({
        types: [{ description: 'Mapwright Dungeon', accept: { 'application/json': ['.mapwright', '.json'] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json.metadata || !json.cells) {
        showToast('Invalid dungeon JSON: missing metadata or cells');
        return;
      }
      loadDungeonJSON(json, { fileHandle: handle, fileName: file.name });
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // user cancelled
      console.warn('File System Access API failed, falling back:', err);
    }
  }

  // Fallback: classic file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mapwright,.json';
  input.onchange = (e) => {
    const file = ((e.target ?? e.currentTarget) as HTMLInputElement).files![0];
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target!.result as string);
        if (!json.metadata || !json.cells) {
          showToast('Invalid dungeon JSON: missing metadata or cells');
          return;
        }
        loadDungeonJSON(json, { fileName: file.name });
      } catch (err) {
        showToast('Failed to parse JSON: ' + (err as Error).message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

/**
 * Save the dungeon — writes back to the loaded file, or prompts for a save location.
 * @returns {Promise<void>}
 */
export async function saveDungeon(): Promise<void> {
  state.dungeon.metadata.formatVersion = CURRENT_FORMAT_VERSION;
  if (state.appVersion) state.dungeon.metadata.createdWith = state.appVersion;

  // Embed user theme data for cross-machine portability
  const _saveTheme = state.dungeon.metadata.theme;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
  if (typeof _saveTheme === 'string' && _saveTheme.startsWith('user:') && THEMES[_saveTheme]) {
    const themeObj = THEMES[_saveTheme];
    state.dungeon.metadata.savedThemeData = {
      name: (themeObj as Record<string, unknown>).displayName as string || _saveTheme.slice(5),
      theme: { ...themeObj },
    };
    delete state.dungeon.metadata.savedThemeData.theme.displayName;
  } else if (typeof _saveTheme === 'string' && !_saveTheme.startsWith('user:')) {
    delete state.dungeon.metadata.savedThemeData;
  }

  const json = JSON.stringify(state.dungeon);

  // If we have an existing file handle, write directly to it
  if (state.fileHandle) {
    try {
      const writable = await state.fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
      state.unsavedChanges = false;
      notify();
      showToast('Saved');
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn('Failed to write to file handle, falling back to Save As:', err);
      // Fall through to Save As
    }
  }

  // No file handle — prompt for save location
  if ((window as unknown as FilePickerWindow).showSaveFilePicker) {
    try {
      const handle = await (window as unknown as FilePickerWindow).showSaveFilePicker!({
        suggestedName: getSuggestedName(),
        types: [{ description: 'Mapwright Dungeon', accept: { 'application/json': ['.mapwright'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      state.fileHandle = handle;
      state.fileName = (await handle.getFile()).name;
      state.unsavedChanges = false;
      notify(); // update status bar
      showToast('Saved');
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn('showSaveFilePicker failed, falling back to download:', err);
    }
  }

  // Final fallback: blob download
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = getSuggestedName();
  a.click();
  URL.revokeObjectURL(url);
  state.unsavedChanges = false;
  showToast('Saved');
}

/**
 * Save a blob to disk — uses native file picker when available, falls back to anchor download.
 */
async function saveBlob(blob: Blob, suggestedName: string) {
  if ((window as unknown as FilePickerWindow).showSaveFilePicker) {
    try {
      const handle = await (window as unknown as FilePickerWindow).showSaveFilePicker!({
        suggestedName,
        types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err; // user cancelled
      console.warn('showSaveFilePicker failed, falling back to download:', err);
    }
  }

  // Fallback: anchor download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Export the current dungeon as a PNG image (server-side or browser fallback).
 * @returns {Promise<void>}
 */
let exportOverlay: HTMLElement | null = null;

function showExportOverlay() {
  if (!exportOverlay) {
    exportOverlay = document.createElement('div');
    exportOverlay.className = 'export-overlay';
    exportOverlay.innerHTML = `
      <div class="export-overlay-content">
        <div class="export-spinner"></div>
        <div class="export-overlay-label">Rendering PNG\u2026</div>
        <div class="export-overlay-sublabel">This may take a minute for large maps</div>
      </div>`;
    document.body.appendChild(exportOverlay);
  }
  exportOverlay.style.display = 'flex';
  exportOverlay.offsetHeight; // force reflow
  exportOverlay.classList.add('visible');
}

function hideExportOverlay() {
  if (!exportOverlay) return;
  exportOverlay.classList.remove('visible');
  exportOverlay.addEventListener('transitionend', () => {
    exportOverlay!.style.display = 'none';
  }, { once: true });
}

export async function exportPng(): Promise<void> {
  const config = state.dungeon;
  const suggestedName = (config.metadata.dungeonName || 'dungeon')
    .replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.png';

  showExportOverlay();

  // Try server-side rendering first (handles textures without browser memory issues)
  try {
    const res = await fetch('/api/export-png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (res.ok) {
      const blob = await res.blob();
      hideExportOverlay();
      await saveBlob(blob, suggestedName);
      showToast('Exported as PNG');
      return;
    }
    // Server responded with an error — surface it rather than silently falling back
    hideExportOverlay();
    let detail = `HTTP ${res.status}`;
    try { const body = await res.json(); if (body.error) detail = body.error; } catch {}
    showToast(`Export failed: ${detail}`);
    console.error('[export] Server error:', res.status, detail);
    return;
  } catch (err) {
    if ((err as Error).name === 'AbortError') { hideExportOverlay(); return; }
    console.warn('Server export unavailable — falling back to browser render');
  }

  // Fallback: browser-side render without textures (avoids browser memory issues)
  try {
    const { width, height } = calculateCanvasSize(config);
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
      hideExportOverlay();
      showToast('Export failed: canvas too large');
      return;
    }

    // Resolve background image element if present
    let bgImageEl: HTMLImageElement | null = null;
    const bi = config.metadata.backgroundImage;
    if (bi?.dataUrl) {
      bgImageEl = new Image();
      await new Promise(resolve => {
        bgImageEl!.onload = resolve;
        bgImageEl!.onerror = resolve; // fail gracefully — image won't appear but export continues
        bgImageEl!.src = bi.dataUrl!;
      });
    }

    renderDungeonToCanvas(ctx, config, width, height, null, null, bgImageEl);

    const blob = await new Promise(resolve => offscreen.toBlob(resolve, 'image/png'));
    if (!blob) {
      hideExportOverlay();
      showToast('Export failed: could not encode PNG');
      return;
    }
    hideExportOverlay();
    await saveBlob(blob as Blob, suggestedName);
    showToast('Exported as PNG (without textures — run start.bat for full export)');
  } catch (err) {
    hideExportOverlay();
    if ((err as Error).name === 'AbortError') return; // user cancelled save dialog
    console.error('Export PNG failed:', err);
    showToast('Export failed: ' + (err as Error).message);
  }
}

/**
 * Export the current dungeon as Universal VTT (.dd2vtt) format.
 * Sends the full config to the server which renders the PNG and builds the dd2vtt JSON.
 * @returns {Promise<void>}
 */
export async function exportDd2vtt(): Promise<void> {
  const config = state.dungeon;
  const suggestedName = (config.metadata.dungeonName || 'dungeon')
    .replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.dd2vtt';

  showExportOverlay();

  try {
    const res = await fetch('/api/export-dd2vtt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      hideExportOverlay();
      let detail = `HTTP ${res.status}`;
      try { const body = await res.json(); if (body.error) detail = body.error; } catch {}
      showToast(`Export failed: ${detail}`);
      return;
    }
    const blob = await res.blob();
    hideExportOverlay();
    await saveBlob(blob, suggestedName);
    showToast('Exported as Universal VTT (.dd2vtt)');
  } catch (err) {
    hideExportOverlay();
    if ((err as Error).name === 'AbortError') return;
    console.error('Export dd2vtt failed:', err);
    showToast('Export failed: ' + (err as Error).message);
  }
}

/**
 * Clear all cached assets from localStorage + memory and reload from server.
 * @returns {Promise<void>}
 */
export async function reloadAssets(): Promise<void> {
  // Clear localStorage
  for (const key of ['prop-catalog', 'prop-catalog-ver', 'texture-catalog', 'texture-catalog-ver',
                      'theme-catalog', 'theme-catalog-ver', 'light-catalog', 'light-catalog-ver']) {
    localStorage.removeItem(key);
  }

  // Clear in-memory caches
  clearPropCatalogCache();
  invalidatePropsCache();
  clearTextureCatalogCache();
  clearThemeCatalogCache();
  clearLightCatalogCache();

  // Reload all catalogs
  const [propCatalog, textureCatalog, lightCatalog] = await Promise.all([
    loadPropCatalog(),
    loadTextureCatalog(),
    loadLightCatalog(),
  ]);
  state.propCatalog = propCatalog;
  state.textureCatalog = textureCatalog;
  state.lightCatalog = lightCatalog;
  // Themes register into a shared THEMES object — just reload the catalog
  await loadThemeCatalog();

  // Re-load texture images for everything currently on the map
  const usedIds = collectTextureIds(state.dungeon.cells);
  // Also collect prop-referenced textures from overlay
  if (propCatalog?.props && state.dungeon.metadata.props) {
    for (const op of state.dungeon.metadata.props) {
      const propDef = propCatalog.props[op.type];
      for (const id of propDef.textures) usedIds.add(id);
    }
  }
  if (usedIds.size > 0) {
    await ensureTexturesLoaded(usedIds);
  }

  // Invalidate all render and spatial caches so the canvas rebuilds from fresh assets
  invalidateAllCaches();
  invalidateMapCache();
  markPropSpatialDirty();

  requestRender();
  showToast('Assets reloaded');
}

/**
 * Save As — forces a new file picker regardless of existing handle.
 * @returns {Promise<void>}
 */
export async function saveDungeonAs(): Promise<void> {
  const savedHandle = state.fileHandle;
  state.fileHandle = null;
  await saveDungeon();
  // If user cancelled (fileHandle still null), restore the old handle
  state.fileHandle ??= savedHandle;
}

/**
 * Create a new empty dungeon (prompts for name and dimensions).
 * @returns {Promise<void>}
 */
export async function newDungeon(): Promise<void> {
  if (!await confirmUnsaved()) return;

  const result = await showNewMapModal();
  if (!result) return;
  const { name, rows, cols } = result;

  pushUndo();
  state.dungeon = createEmptyDungeon(name, rows, cols);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.fileHandle = null;
  state.fileName = null;
  markDirty();
  state.unsavedChanges = false;
  notify();
  requestAnimationFrame(() => zoomToFit());
}
