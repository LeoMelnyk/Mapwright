// Debug instrumentation for `traverse()` — lets the editor visualize every
// cell touched by the BFS, colored by depth from the seed (the "Flood Rainbow"
// dev toggle). When no recorder is set every call is a no-op, so traversal
// pays nothing in production.
//
// The util layer can't import from editor state, so the editor registers a
// recorder via `setFloodRecorder()`. The recorder is a singleton — only one
// consumer at a time, which is fine for the debug-overlay use case.

export interface FloodRecorder {
  /** Called once at the start of every traverse() invocation. */
  start(): void;
  /** Called once per visited cell with its BFS depth from the seed. */
  visit(row: number, col: number, depth: number): void;
  /** Called once after traverse() finishes — gives the recorder a chance to commit. */
  end(): void;
}

let recorder: FloodRecorder | null = null;

export function setFloodRecorder(r: FloodRecorder | null): void {
  recorder = r;
}

export function isFloodRecording(): boolean {
  return recorder !== null;
}

export function recordFloodStart(): void {
  recorder?.start();
}

export function recordFloodCell(row: number, col: number, depth: number): void {
  recorder?.visit(row, col, depth);
}

export function recordFloodEnd(): void {
  recorder?.end();
}
