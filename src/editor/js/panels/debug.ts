// Debug panel: render layer toggles and hitbox visualization
import state, { undoDisabled, setUndoDisabled } from '../state.js';
import { invalidateMapCache, requestRender } from '../canvas-view.js';
import { getEditorSettings, setEditorSetting } from '../editor-settings.js';

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
  build();
}

function build() {
  if (!container) return;

  let html = '<div class="debug-section"><span class="debug-section-title">Overlays</span>';
  html += `<label class="debug-toggle"><input type="checkbox" data-debug="hitboxes" ${state.debugShowHitboxes ? 'checked' : ''}> Show Hitboxes</label>`;
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

  // @ts-expect-error — strict-mode migration
  container!.querySelector('[data-action="clear-caches"]').addEventListener('click', () => {
    // Clear all mapwright localStorage entries
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('prop-catalog') || k.startsWith('mw-') || k.startsWith('mapwright'))) {
        keys.push(k);
      }
    }
    keys.forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  container.addEventListener('change', (e) => {
    const input = e.target;
    if ((!input! as any).matches('input[type="checkbox"]')) return;

    if ((input! as any).dataset.debug === 'hitboxes') {
      state.debugShowHitboxes = (input! as any).checked;
      setEditorSetting('debugShowHitboxes', (input! as any).checked);
      requestRender();
      return;
    }

    if ((input! as any).dataset.debug === 'disable-undo') {
      setUndoDisabled((input! as any).checked);
      return;
    }

    const layer = (input! as any).dataset.layer;
    if (layer) {
      if (typeof window !== 'undefined') {
        if (!(window as any)._skipPhases) (window as any)._skipPhases = {};
        (window as any)._skipPhases[layer] = (!input! as any).checked;
      }
      invalidateMapCache();
      requestRender();
    }
  });
}
