// Sidebar: icon bar panel switching
import { resizeCanvas } from '../canvas-view.js';

let panelChangeCb: ((panel: string | null) => void) | null = null;

/**
 * Register a callback invoked when the active sidebar panel changes.
 * @param {Function} cb - Callback receiving the panel ID or null
 */
export function setPanelChangeCallback(cb: (panel: string | null) => void): void { panelChangeCb = cb; }

/**
 * Return the currently active sidebar panel ID, or null if collapsed.
 * @returns {string|null} Panel ID
 */
export function getActivePanel(): string | null {
  const active = document.querySelector<HTMLElement>('.icon-btn.active');
  return active?.dataset.panel ?? null;
}

/**
 * Toggle a panel by ID. If already active, collapse it.
 * @param {string} panelId - Panel identifier
 */
export function togglePanel(panelId: string): void {
  const btn = document.querySelector<HTMLElement>(`.icon-btn[data-panel="${panelId}"]`);
  if (btn) btn.click();
}

/**
 * Initialize the left sidebar: bind icon buttons for panel switching.
 */
export function init(): void {
  const iconBtns = document.querySelectorAll<HTMLElement>('.icon-btn');
  const sideContent = document.getElementById('side-content')!;

  iconBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.dataset.panel;
      const isActive = btn.classList.contains('active');

      // Deactivate all icons and hide all panels
      iconBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll<HTMLElement>('.side-panel').forEach(p => (p.style.display = 'none'));

      const wasCollapsed = sideContent.classList.contains('hidden');

      if (!isActive) {
        // Activate the clicked icon and show its panel
        btn.classList.add('active');
        const panel = document.getElementById(`panel-${panelId}`);
        if (panel) panel.style.display = panel.dataset.display ?? 'flex';
        sideContent.classList.remove('hidden');
        if (panelChangeCb) panelChangeCb(panelId ?? null);
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
