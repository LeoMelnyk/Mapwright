// Render warnings collector — accumulates deduplicated warnings during a render frame.
// Browser context flushes these to toasts; Node/CLI context relies on console.warn.

const warnings: Set<string> = new Set();

/**
 * Log a deduplicated warning during a render frame.
 * @param {string} msg - Warning message
 * @returns {void}
 */
export function warn(msg: string): void {
  warnings.add(msg);
  console.warn(msg);
}

/**
 * Flush and return all accumulated warnings, clearing the internal set.
 * @returns {string[]} Array of warning messages
 */
export function flush(): string[] {
  const w = [...warnings];
  warnings.clear();
  return w;
}
