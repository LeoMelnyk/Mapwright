// Levels panel: add/remove/switch levels, rename, resize
import state, { pushUndo, markDirty, notify, subscribe } from '../state.js';
import { panToLevel } from '../canvas-view.js';

let isEditing = false; // guard: prevent update() from destroying inline input

export function init() {
  subscribe(update);
  update();

  document.getElementById('btn-add-level').addEventListener('click', addLevel);
}

function update() {
  if (isEditing) return; // don't rebuild while user is renaming

  const list = document.getElementById('levels-list');
  if (!list) return;

  const levels = state.dungeon.metadata.levels || [];
  list.innerHTML = levels.map((level, i) => `
    <div class="level-item ${i === state.currentLevel ? 'active' : ''}" data-level="${i}">
      <span class="level-name">${level.name}</span>
      <span class="level-rows">${level.numRows}r</span>
      <div class="level-actions">
        <button class="level-btn" data-action="rename" title="Rename">&#9998;</button>
        <button class="level-btn" data-action="resize" title="Resize">&#8597;</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.level-item').forEach(el => {
    const levelIdx = parseInt(el.dataset.level);

    // Click: select level + pan viewport to it
    el.addEventListener('click', (e) => {
      // Don't trigger on button clicks
      if (e.target.closest('.level-btn')) return;
      if (isEditing) return;
      selectLevel(levelIdx);
    });

    // Rename button
    el.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(el, levelIdx);
    });

    // Resize button
    el.querySelector('[data-action="resize"]').addEventListener('click', (e) => {
      e.stopPropagation();
      resizeLevel(levelIdx);
    });
  });
}

/**
 * Select a level: set it as current and zoom/pan viewport to fit it.
 */
function selectLevel(idx) {
  const levels = state.dungeon.metadata.levels || [];
  if (idx < 0 || idx >= levels.length) return;

  state.currentLevel = idx;
  panToLevel(levels[idx].startRow, levels[idx].numRows);
}

/**
 * Inline rename: replace the name span with an input.
 */
function startRename(el, levelIdx) {
  if (isEditing) return;
  const level = state.dungeon.metadata.levels[levelIdx];
  if (!level) return;

  isEditing = true;
  const span = el.querySelector('.level-name');
  const oldName = level.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = oldName;
  input.className = 'level-rename-input';
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    if (!isEditing) return;
    const newName = input.value.trim() || oldName;
    if (newName !== oldName) {
      pushUndo();
      level.name = newName;
    }
    isEditing = false;
    const newSpan = document.createElement('span');
    newSpan.className = 'level-name';
    newSpan.textContent = level.name;
    input.replaceWith(newSpan);
    notify();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (ke) => {
    if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
    if (ke.key === 'Escape') { input.value = oldName; input.blur(); }
  });
}

/**
 * Resize a level: prompt for new row count, then add/remove rows.
 */
function resizeLevel(levelIdx) {
  const levels = state.dungeon.metadata.levels;
  if (!levels || levelIdx < 0 || levelIdx >= levels.length) return;

  const level = levels[levelIdx];
  const input = prompt(`Rows for "${level.name}" (currently ${level.numRows}):`, level.numRows);
  if (input === null) return;

  const newRows = parseInt(input, 10);
  if (isNaN(newRows) || newRows < 1) {
    alert('Row count must be a positive integer.');
    return;
  }
  if (newRows === level.numRows) return;

  pushUndo();

  const cells = state.dungeon.cells;
  const numCols = cells[0]?.length || 30;
  const delta = newRows - level.numRows;
  const levelEnd = level.startRow + level.numRows; // first row AFTER this level

  if (delta > 0) {
    // Insert void rows at the end of this level
    const newCellRows = [];
    for (let i = 0; i < delta; i++) {
      const row = [];
      for (let c = 0; c < numCols; c++) row.push(null);
      newCellRows.push(row);
    }
    cells.splice(levelEnd, 0, ...newCellRows);
  } else {
    // Remove rows from the end of this level (delta is negative)
    // Only remove void rows — warn if non-void cells would be lost
    const removeCount = -delta;
    const removeStart = levelEnd - removeCount;
    let hasContent = false;
    for (let r = removeStart; r < levelEnd; r++) {
      for (let c = 0; c < numCols; c++) {
        if (cells[r][c] !== null) { hasContent = true; break; }
      }
      if (hasContent) break;
    }
    if (hasContent) {
      if (!confirm(`This will delete ${removeCount} row(s) at the bottom of "${level.name}" that contain cell data. Continue?`)) {
        return;
      }
    }
    cells.splice(removeStart, removeCount);
  }

  // Update this level's numRows
  level.numRows = newRows;

  // Shift startRow of all subsequent levels
  for (let i = levelIdx + 1; i < levels.length; i++) {
    levels[i].startRow += delta;
  }

  markDirty();
  notify();
}

function addLevel() {
  const name = prompt('Level name:', `Level ${(state.dungeon.metadata.levels?.length || 0) + 1}`);
  if (!name) return;

  pushUndo();

  const cells = state.dungeon.cells;
  const currentRows = cells.length;
  const numCols = cells[0]?.length || 30;
  const newRows = 15;

  // Add a void separator row + new level rows
  for (let r = 0; r < 1 + newRows; r++) {
    const row = [];
    for (let c = 0; c < numCols; c++) row.push(null);
    cells.push(row);
  }

  if (!state.dungeon.metadata.levels) state.dungeon.metadata.levels = [];
  state.dungeon.metadata.levels.push({
    name,
    startRow: currentRows + 1,
    numRows: newRows,
  });

  // Select and pan to the new level
  state.currentLevel = state.dungeon.metadata.levels.length - 1;
  markDirty();
  notify();
  panToLevel(currentRows + 1, newRows);
}
