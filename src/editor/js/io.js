// File I/O: load, save, new dungeon, export PNG
import state, { pushUndo, markDirty, notify } from './state.js';
import { showToast } from './toast.js';
import { createEmptyDungeon } from './utils.js';
import { calculateCanvasSize, renderDungeonToCanvas, invalidatePropsCache } from '../../render/index.js';
import { collectTextureIds, ensureTexturesLoaded, loadTextureCatalog, loadTextureImages, clearTextureCatalogCache } from './texture-catalog.js';
import { loadPropCatalog, clearPropCatalogCache } from './prop-catalog.js';
import { loadThemeCatalog, clearThemeCatalogCache } from './theme-catalog.js';
import { loadLightCatalog, clearLightCatalogCache } from './light-catalog.js';
import { requestRender } from './canvas-view.js';
import { exportDungeonToMapFormat } from './export-map.js';

/**
 * Load a dungeon JSON object into the editor state.
 * This is the shared core used by Open, Import, etc.
 * @param {object} json - A valid dungeon JSON with metadata + cells.
 * @param {object} [opts] - Options: fileHandle, fileName.
 */
export function loadDungeonJSON(json, opts = {}) {
  pushUndo();
  state.dungeon = json;
  migrateHalfTextures(json);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.fileHandle = opts.fileHandle || null;
  state.fileName = opts.fileName || null;
  markDirty();
  state.unsavedChanges = false;
  notify();
  // Load images for textures used in the loaded map (floor + props)
  const usedIds = collectTextureIds(json.cells);
  if (state.propCatalog?.props) {
    for (const row of json.cells) {
      if (!row) continue;
      for (const cell of row) {
        if (!cell?.prop) continue;
        const propDef = state.propCatalog.props[cell.prop.type];
        if (propDef?.textures) {
          for (const id of propDef.textures) usedIds.add(id);
        }
      }
    }
  }
  if (usedIds.size > 0) ensureTexturesLoaded(usedIds).then(() => { state.texturesVersion++; notify(); });
}

export function migrateHalfTextures(dungeon) {
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
    .replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.json';
}

function confirmUnsaved() {
  if (!state.unsavedChanges) return true;
  return confirm('You have unsaved changes. Continue without saving?');
}

/**
 * Load a dungeon JSON via File System Access API (or fallback)
 */
export async function loadDungeon() {
  if (!confirmUnsaved()) return;

  // Try File System Access API first
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Dungeon JSON', accept: { 'application/json': ['.json'] } }],
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
      if (err.name === 'AbortError') return; // user cancelled
      console.warn('File System Access API failed, falling back:', err);
    }
  }

  // Fallback: classic file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target.result);
        if (!json.metadata || !json.cells) {
          showToast('Invalid dungeon JSON: missing metadata or cells');
          return;
        }
        loadDungeonJSON(json, { fileName: file.name });
      } catch (err) {
        showToast('Failed to parse JSON: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

/**
 * Save dungeon — writes back to the loaded file, or prompts for location
 */
export async function saveDungeon() {
  const json = JSON.stringify(state.dungeon, null, 2);

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
      if (err.name === 'AbortError') return;
      console.warn('Failed to write to file handle, falling back to Save As:', err);
      // Fall through to Save As
    }
  }

  // No file handle — prompt for save location
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: getSuggestedName(),
        types: [{ description: 'Dungeon JSON', accept: { 'application/json': ['.json'] } }],
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
      if (err.name === 'AbortError') return;
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
async function saveBlob(blob, suggestedName) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err; // user cancelled
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
 * Export the current dungeon as a PNG image.
 * Renders server-side via @napi-rs/canvas to avoid browser memory limits.
 * Falls back to browser-side rendering (without textures) if the server
 * endpoint is unavailable (e.g. when using npx serve instead of server.js).
 */
export async function exportPng() {
  const config = state.dungeon;
  const suggestedName = (config.metadata.dungeonName || 'dungeon')
    .replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.png';

  // Try server-side rendering first (handles textures without browser memory issues)
  try {
    const res = await fetch('/api/export-png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (res.ok) {
      const blob = await res.blob();
      await saveBlob(blob, suggestedName);
      showToast('Exported as PNG');
      return;
    }
    console.warn('Server export returned', res.status, '— falling back to browser render');
  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled save dialog
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
      showToast('Export failed: canvas too large');
      return;
    }

    renderDungeonToCanvas(ctx, config, width, height, null, null);

    const blob = await new Promise(resolve => offscreen.toBlob(resolve, 'image/png'));
    if (!blob) {
      showToast('Export failed: could not encode PNG');
      return;
    }
    await saveBlob(blob, suggestedName);
    showToast('Exported as PNG (without textures — start server.js for full export)');
  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled save dialog
    console.error('Export PNG failed:', err);
    showToast('Export failed: ' + err.message);
  }
}

/**
 * Export the current dungeon as a .map text file.
 */
export async function exportMapFormat() {
  const result = exportDungeonToMapFormat(state.dungeon);
  if (!result.success) {
    showToast('Export failed: ' + (result.error || 'unknown error'));
    return;
  }
  const name = (state.dungeon.metadata.dungeonName || 'dungeon')
    .replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const blob = new Blob([result.mapText], { type: 'text/plain' });

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name + '.map',
        types: [{ description: 'Map file', accept: { 'text/plain': ['.map'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToast('Exported ' + name + '.map');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('showSaveFilePicker failed, falling back to download:', err);
    }
  }

  // Fallback: anchor download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.map';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('Exported ' + name + '.map');
}

/**
 * Clear all cached assets from localStorage + memory and reload from server.
 */
export async function reloadAssets() {
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
  // Also collect prop-referenced textures
  if (propCatalog?.props) {
    for (const row of state.dungeon.cells) {
      if (!row) continue;
      for (const cell of row) {
        if (!cell?.prop) continue;
        const propDef = propCatalog.props[cell.prop.type];
        if (propDef?.textures) {
          for (const id of propDef.textures) usedIds.add(id);
        }
      }
    }
  }
  if (usedIds.size > 0) {
    await ensureTexturesLoaded(usedIds);
  }

  requestRender();
  showToast('Assets reloaded');
}

/**
 * Save As — forces a new file picker regardless of existing handle
 */
export async function saveDungeonAs() {
  const savedHandle = state.fileHandle;
  state.fileHandle = null;
  await saveDungeon();
  // If user cancelled (fileHandle still null), restore the old handle
  if (!state.fileHandle) {
    state.fileHandle = savedHandle;
  }
}

/**
 * Create a new empty dungeon
 */
export function newDungeon() {
  if (!confirmUnsaved()) return;

  const name = prompt('Dungeon name:', 'New Dungeon');
  if (name === null) return;
  const rowsStr = prompt('Number of rows:', '20');
  if (rowsStr === null) return;
  const colsStr = prompt('Number of columns:', '30');
  if (colsStr === null) return;
  const rows = parseInt(rowsStr) || 20;
  const cols = parseInt(colsStr) || 30;

  pushUndo();
  state.dungeon = createEmptyDungeon(name, rows, cols);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.fileHandle = null;
  state.fileName = null;
  markDirty();
  state.unsavedChanges = false;
  notify();
}
