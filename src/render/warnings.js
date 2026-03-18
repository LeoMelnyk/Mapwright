// Render warnings collector — accumulates deduplicated warnings during a render frame.
// Browser context flushes these to toasts; Node/CLI context relies on console.warn.

const warnings = new Set();

export function warn(msg) {
  warnings.add(msg);
  console.warn(msg);
}

export function flush() {
  const w = [...warnings];
  warnings.clear();
  return w;
}
