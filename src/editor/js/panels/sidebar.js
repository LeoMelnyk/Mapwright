// Sidebar: icon bar panel switching
import { resizeCanvas } from '../canvas-view.js';

let panelChangeCb = null;

export function setPanelChangeCallback(cb) { panelChangeCb = cb; }

/** Return the currently active sidebar panel ID, or null if collapsed. */
export function getActivePanel() {
  const active = document.querySelector('.icon-btn.active');
  return active?.dataset.panel || null;
}

/** Toggle a panel by ID. If already active, collapse it. */
export function togglePanel(panelId) {
  const btn = document.querySelector(`.icon-btn[data-panel="${panelId}"]`);
  if (btn) btn.click();
}

export function init() {
  const iconBtns = document.querySelectorAll('.icon-btn');
  const sideContent = document.getElementById('side-content');

  iconBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.dataset.panel;
      const isActive = btn.classList.contains('active');

      // Deactivate all icons and hide all panels
      iconBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.side-panel').forEach(p => (p.style.display = 'none'));

      const wasCollapsed = sideContent.classList.contains('hidden');

      if (!isActive) {
        // Activate the clicked icon and show its panel
        btn.classList.add('active');
        const panel = document.getElementById(`panel-${panelId}`);
        if (panel) panel.style.display = panel.dataset.display || 'flex';
        sideContent.classList.remove('hidden');
        if (panelChangeCb) panelChangeCb(panelId);
      } else {
        // Same icon clicked again — collapse
        sideContent.classList.add('hidden');
        if (panelChangeCb) panelChangeCb(null);
      }

      // Resize canvas only when sidebar visibility changed
      const isCollapsed = sideContent.classList.contains('hidden');
      if (wasCollapsed !== isCollapsed) {
        requestAnimationFrame(() => resizeCanvas());
      }
    });
  });
}
