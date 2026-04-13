let container: HTMLDivElement | null = null;

function getContainer(): HTMLDivElement {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Show a transient toast notification message.
 * @param {string} message - Text to display.
 * @param {number} [duration=4000] - How long the toast stays visible in milliseconds.
 * @returns {void}
 */
export function showToast(message: string, durationOrType: number | string = 4000): void {
  const duration = typeof durationOrType === 'number' ? durationOrType : 4000;
  const c = getContainer();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;

  c.prepend(toast); // newest at top; older pushed down
  toast.offsetHeight; // force reflow to enable CSS transition
  toast.classList.add('toast-visible');

  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.classList.add('toast-hiding');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}
