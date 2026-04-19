// Lightweight leveled logger.
//
// `dev` and `devTrace` are gated on the editor's Debug toggle (right sidebar).
// `info`/`warn`/`error` always print. Renderer-side code can call this without
// importing from `editor/` because the gate is set explicitly via
// `setDevLogging()` from the editor settings module.

let _devEnabled = false;

// Bootstrap from the persisted editor settings so renderer-side dev logs work
// before app-init wires the toggle. Fails silently outside the browser (CLI).
try {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem('mw-editor-settings');
    if (raw) _devEnabled = Boolean((JSON.parse(raw) as { debug?: unknown }).debug);
  }
} catch {
  // localStorage unavailable or corrupt — leave dev logging off.
}

/** Toggle dev-only logging. Called by the editor's Debug setting setter. */
export function setDevLogging(enabled: boolean): void {
  _devEnabled = enabled;
}

/** Whether dev-only logging is currently active. */
export function isDevLoggingEnabled(): boolean {
  return _devEnabled;
}

export const log = {
  /** Verbose dev message. Suppressed unless the Debug toggle is on. */
  dev(...args: unknown[]): void {
    if (!_devEnabled) return;
    console.log('[DEV]', ...args);
  },
  /** Verbose dev message with stack trace. Suppressed unless Debug is on. */
  devTrace(...args: unknown[]): void {
    if (!_devEnabled) return;
    console.trace('[DEV]', ...args);
  },
  info(...args: unknown[]): void {
    console.log('[INFO]', ...args);
  },
  warn(...args: unknown[]): void {
    console.warn('[WARN]', ...args);
  },
  error(...args: unknown[]): void {
    console.error('[ERROR]', ...args);
  },
};
