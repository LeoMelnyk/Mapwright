// Global scroll-wheel support for every <input type="range"> in the editor.
// Attaches a single delegated listener so new sliders automatically inherit the behavior.

// Debounce the synthetic `change` event per-slider so a burst of wheel ticks
// collapses into one undo entry — mirrors native <input type=range> behavior
// where `change` only fires on mouseup.
const CHANGE_DEBOUNCE_MS = 250;
const pendingChange = new WeakMap<HTMLInputElement, ReturnType<typeof setTimeout>>();

function scheduleChange(target: HTMLInputElement): void {
  const existing = pendingChange.get(target);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingChange.delete(target);
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }, CHANGE_DEBOUNCE_MS);
  pendingChange.set(target, timer);
}

export function initRangeSliderWheel(): void {
  document.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'range' || target.disabled) return;

      e.preventDefault();

      const step = parseFloat(target.step) || 1;
      const min = parseFloat(target.min);
      const max = parseFloat(target.max);
      const current = parseFloat(target.value) || 0;

      // Scroll up (deltaY < 0) → increase; scroll down → decrease.
      const direction = e.deltaY < 0 ? 1 : -1;
      let next = current + direction * step;

      if (!Number.isNaN(min)) next = Math.max(min, next);
      if (!Number.isNaN(max)) next = Math.min(max, next);

      // Snap to step precision to avoid floating-point drift (e.g. 0.1 + 0.2).
      const decimals = (target.step.split('.')[1] ?? '').length;
      if (decimals > 0) next = parseFloat(next.toFixed(decimals));

      if (next === current) return;

      target.value = String(next);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      scheduleChange(target);
    },
    { passive: false },
  );
}
