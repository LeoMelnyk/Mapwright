// History panel: scrollable undo/redo history list
import state, { subscribe, undo, redo, jumpToState } from '../state.js';

let container: HTMLElement | null = null;

/**
 * Initialize the history panel with undo/redo list.
 * @param {HTMLElement} el - Container element for the panel
 */
export function initHistoryPanel(el: HTMLElement): void {
  container = el;
  subscribe(update, 'history');
  update();
}

let _lastUndoLen = -1;
let _lastRedoLen = -1;
function update() {
  if (!container) return;

  const stack = state.undoStack;
  const redoStack = state.redoStack;

  // Skip rebuild if stack depths haven't changed and DOM is still populated
  if (stack.length === _lastUndoLen && redoStack.length === _lastRedoLen && container.children.length > 0) return;
  _lastUndoLen = stack.length;
  _lastRedoLen = redoStack.length;

  let html = '<div class="panel-title">History</div>';

  if (stack.length === 0 && redoStack.length === 0) {
    html += '<div class="history-hint">No history yet</div>';
    container.innerHTML = html;
    return;
  }

  html += '<div class="history-list">';

  // Redo entries (greyed out, most recent redo at top)
  for (let i = redoStack.length - 1; i >= 0; i--) {
    const entry = redoStack[i];
    const label = typeof entry === 'object' ? entry.label : 'Edit';
    // Skip the 'Current' placeholder labels pushed by undo/jumpToState
    const displayLabel = label === 'Current' || label === 'Redo' ? 'Edit' : label;
    html += `<div class="history-item redo" data-redo-index="${i}">`;
    html += `<span class="history-label">${displayLabel}</span>`;
    html += `<span class="history-badge">redo</span>`;
    html += '</div>';
  }

  // Current state marker
  html += '<div class="history-item current">';
  html += '<span class="history-label">Current State</span>';
  html += '</div>';

  // Undo entries (most recent first)
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    const label = typeof entry === 'object' ? entry.label : 'Edit';
    const num = i + 1;
    html += `<div class="history-item undo" data-undo-index="${i}">`;
    html += `<span class="history-num">${num}.</span>`;
    html += `<span class="history-label">${label}</span>`;
    html += '</div>';
  }

  html += '</div>';

  // Undo/redo button row
  html += '<div class="history-actions">';
  html += `<button class="toolbar-btn history-undo-btn"${stack.length === 0 ? ' disabled' : ''}>Undo</button>`;
  html += `<button class="toolbar-btn history-redo-btn"${redoStack.length === 0 ? ' disabled' : ''}>Redo</button>`;
  html += '</div>';

  container.innerHTML = html;

  // Wire click handlers for jumping to a state
  container.querySelectorAll('.history-item.undo').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.undoIndex, 10);
      jumpToState(idx);
    });
  });

  // Wire redo clicks — jump to the clicked redo state
  container.querySelectorAll('.history-item.redo').forEach(item => {
    item.addEventListener('click', () => {
      const redoIdx = parseInt(item.dataset.redoIndex, 10);
      const steps = state.redoStack.length - redoIdx;
      for (let i = 0; i < steps; i++) redo();
    });
  });

  // Undo/redo buttons
  const undoBtn = container.querySelector('.history-undo-btn');
  if (undoBtn) undoBtn.addEventListener('click', () => undo());
  const redoBtn = container.querySelector('.history-redo-btn');
  if (redoBtn) redoBtn.addEventListener('click', () => redo());
}
