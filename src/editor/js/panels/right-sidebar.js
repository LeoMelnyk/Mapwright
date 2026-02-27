// Right sidebar: icon bar panel switching (mirrors left sidebar pattern)
import { resizeCanvas } from '../canvas-view.js';

let panelChangeCb = null;

export function setRightPanelChangeCallback(cb) { panelChangeCb = cb; }

/** Return the currently active right panel ID, or null if collapsed. */
export function getActiveRightPanel() {
  const active = document.querySelector('.right-icon-btn.active');
  return active?.dataset.rightPanel || null;
}

/** Toggle a right panel by ID. If already active, collapse it. */
export function toggleRightPanel(panelId) {
  const btn = document.querySelector(`.right-icon-btn[data-right-panel="${panelId}"]`);
  if (btn) btn.click();
}

export function init() {
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
