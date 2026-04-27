// Debug panel: render layer toggles and hitbox visualization
import state, { undoDisabled, setUndoDisabled } from '../state.js';
import { invalidateMapCache, requestRender } from '../canvas-view.js';
import { getEditorSettings, setEditorSetting } from '../editor-settings.js';
import { setFloodRainbowEnabled } from '../flood-rainbow-overlay.js';

let container: HTMLElement | null = null;

const LAYERS = [
  ['cells', 'Cells'],
  ['dots', 'Dots'],
  ['shading', 'Shading'],
  ['floors', 'Floors'],
  ['textures', 'Textures'],
  ['grid', 'Grid'],
  ['props', 'Props'],
  ['labels', 'Labels'],
  ['lighting', 'Lighting'],
];

/**
 * Initialize the debug panel: render layer toggles and hitbox visualization.
 * @param {HTMLElement} el - Container element for the panel
 */
export function initDebugPanel(el: HTMLElement): void {
  container = el;
  // Restore persisted debug state
  state.debugShowHitboxes = getEditorSettings().debugShowHitboxes === true;
  state.debugShowSelectionBoxes = getEditorSettings().debugShowSelectionBoxes === true;
  state.debugFloodRainbow = getEditorSettings().debugFloodRainbow === true;
  setFloodRainbowEnabled(state.debugFloodRainbow);
  build();
}

function build() {
  if (!container) return;

  let html = '<div class="debug-section"><span class="debug-section-title">Overlays</span>';
  html += `<label class="debug-toggle"><input type="checkbox" data-debug="hitboxes" ${state.debugShowHitboxes ? 'checked' : ''}> Show Hitboxes</label>`;
  html += `<label class="debug-toggle"><input type="checkbox" data-debug="selection-boxes" ${state.debugShowSelectionBoxes ? 'checked' : ''}> Show Selection Boxes</label>`;
  html += `<label class="debug-toggle"><input type="checkbox" data-debug="flood-rainbow" ${state.debugFloodRainbow ? 'checked' : ''}> Flood Rainbow</label>`;
  html += `<label class="debug-toggle"><input type="checkbox" data-debug="disable-undo" ${undoDisabled ? 'checked' : ''}> Disable Undo Stack</label>`;
  html += '</div>';

  html += '<div class="debug-section"><span class="debug-section-title">Render Layers</span>';
  for (const [key, label] of LAYERS) {
    html += `<label class="debug-toggle"><input type="checkbox" data-layer="${key}" checked> ${label}</label>`;
  }
  html += '</div>';

  html += '<div class="debug-section"><span class="debug-section-title">Actions</span>';
  html += '<button class="debug-btn" data-action="clear-caches">Clear All Caches &amp; Reload</button>';
  html += '</div>';

  container.innerHTML = html;

  container.querySelector('[data-action="clear-caches"]')!.addEventListener('click', () => {
    // Clear all mapwright localStorage entries
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('prop-catalog') || k.startsWith('mw-') || k.startsWith('mapwright'))) {
        keys.push(k);
      }
    }
    keys.forEach((k) => localStorage.removeItem(k));
    location.reload();
  });

  container.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('input[type="checkbox"]')) return;

    if (input.dataset.debug === 'hitboxes') {
      state.debugShowHitboxes = input.checked;
      setEditorSetting('debugShowHitboxes', input.checked);
      requestRender();
      return;
    }

    if (input.dataset.debug === 'selection-boxes') {
      state.debugShowSelectionBoxes = input.checked;
      setEditorSetting('debugShowSelectionBoxes', input.checked);
      requestRender();
      return;
    }

    if (input.dataset.debug === 'flood-rainbow') {
      state.debugFloodRainbow = input.checked;
      setEditorSetting('debugFloodRainbow', input.checked);
      setFloodRainbowEnabled(input.checked);
      requestRender();
      return;
    }

    if (input.dataset.debug === 'disable-undo') {
      setUndoDisabled(input.checked);
      return;
    }

    const layer = input.dataset.layer;
    if (layer) {
      if (typeof window !== 'undefined') {
        if (!(window as unknown as Record<string, unknown>)._skipPhases)
          (window as unknown as Record<string, unknown>)._skipPhases = {};
        ((window as unknown as Record<string, unknown>)._skipPhases as Record<string, boolean>)[layer] = input.checked;
      }
      invalidateMapCache();
      requestRender();
    }
  });
}
