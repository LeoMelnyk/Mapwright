let container = null;

function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message, duration = 4000) {
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
