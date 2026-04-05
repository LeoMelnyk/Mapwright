// Right sidebar: icon bar panel switching (mirrors left sidebar pattern)
import { resizeCanvas } from '../canvas-view.js';

let panelChangeCb: ((panel: string | null) => void) | null = null;

/**
 * Register a callback invoked when the active right panel changes.
 * @param {Function} cb - Callback receiving the panel ID or null
 */
export function setRightPanelChangeCallback(cb: (panel: string | null) => void): void { panelChangeCb = cb; }

/**
 * Return the currently active right panel ID, or null if collapsed.
 * @returns {string|null} Panel ID
 */
export function getActiveRightPanel(): string | null {
  const active = document.querySelector('.right-icon-btn.active');
  return active?.dataset.rightPanel || null;
}

/**
 * Toggle a right panel by ID. If already active, collapse it.
 * @param {string} panelId - Panel identifier
 */
export function toggleRightPanel(panelId: string): void {
  const btn = document.querySelector(`.right-icon-btn[data-right-panel="${panelId}"]`);
  if (btn) btn.click();
}

/**
 * Initialize the right sidebar: bind icon buttons for panel switching.
 */
export function init(): void {
  const iconBtns = document.querySelectorAll('.right-icon-btn');
  const rightContent = document.getElementById('right-content');

  iconBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.dataset.rightPanel;
      const isActive = btn.classList.contains('active');

      // Deactivate all icons and hide all panels
      iconBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.right-panel').forEach(p => (p.style.display = 'none'));

      const wasCollapsed = rightContent.classList.contains('hidden');

      if (!isActive) {
        // Activate the clicked icon and show its panel
        btn.classList.add('active');
        const panel = document.getElementById(`right-panel-${panelId}`);
        if (panel) panel.style.display = panel.dataset.display || 'flex';
        rightContent.classList.remove('hidden');
        if (panelChangeCb) panelChangeCb(panelId);
      } else {
        // Same icon clicked again — collapse
        rightContent.classList.add('hidden');
        if (panelChangeCb) panelChangeCb(null);
      }

      // Resize canvas only when sidebar visibility changed
      const isCollapsed = rightContent.classList.contains('hidden');
      if (wasCollapsed !== isCollapsed) {
        updateFloatPositions(isCollapsed);
        requestAnimationFrame(() => resizeCanvas());
      }
    });
  });
}

/** Adjust floating element positions when the right panel collapses/expands. */
function updateFloatPositions(collapsed) {
  const rightOffset = collapsed ? '52px' : '272px';
  const cellFloat = document.getElementById('cell-info-float');
  if (cellFloat) cellFloat.style.right = rightOffset;
  const toastContainer = document.getElementById('toast-container');
  if (toastContainer) toastContainer.style.right = rightOffset;
}
