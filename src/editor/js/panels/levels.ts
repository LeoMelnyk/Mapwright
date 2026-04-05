// Levels panel: add/remove/switch levels, rename, resize
import state, { pushUndo, markDirty, notify, subscribe } from '../state.js';
import { invalidateAllCaches } from '../../../render/index.js';
import { panToLevel } from '../canvas-view.js';
import { showToast } from '../toast.js';

let isEditing = false; // guard: prevent update() from destroying inline input
let dragFromIdx: any = null;

/**
 * Initialize the levels panel: subscribe to state, render levels list, bind add-level button.
 */
export function init(): void {
  subscribe(update, 'levels');
  update();

  // @ts-expect-error — strict-mode migration
  document!.getElementById('btn-add-level').addEventListener('click', addLevel);
}

function update() {
  if (isEditing) return; // don't rebuild while user is renaming

  const list = document.getElementById('levels-list');
  if (!list) return;

  const levels = state.dungeon.metadata.levels || [];
  list.innerHTML = levels.map((level, i) => `
    <div class="level-item ${i === state.currentLevel ? 'active' : ''}" data-level="${i}">
      <span class="level-drag-handle" title="Drag to reorder">&#8942;</span>
      <span class="level-name">L${i + 1} — ${level.name}</span>
      <span class="level-rows">${level.numRows}r</span>
      <div class="level-actions">
        <button class="level-btn" data-action="rename" title="Rename">&#9998;</button>
        <button class="level-btn" data-action="duplicate" title="Duplicate level">&#10064;</button>
        <button class="level-btn" data-action="resize" title="Resize">&#8597;</button>
        <button class="level-btn level-btn-danger" data-action="delete" title="Delete level">&#128465;</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.level-item').forEach(el => {
    // @ts-expect-error — strict-mode migration
    const levelIdx = parseInt((el as HTMLElement).dataset.level);
    (el as HTMLElement).draggable = true;

    // Click: select level + pan viewport to it
    el.addEventListener('click', (e) => {
      if ((e.target! as any).closest('.level-btn')) return;
      if (isEditing) return;
      selectLevel(levelIdx);
    });

    // Drag-and-drop reorder
    el.addEventListener('dragstart', (e) => {
      if ((e.target! as any).closest('.level-btn, .level-rename-input')) { e.preventDefault(); return; }
      dragFromIdx = levelIdx;
      (e as any).dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('dragging'), 0);
    });

    el.addEventListener('dragend', () => {
      dragFromIdx = null;
      list.querySelectorAll('.level-item').forEach(i => i.classList.remove('dragging', 'drag-above', 'drag-below'));
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragFromIdx === null) return;
      const rect = el.getBoundingClientRect();
      const isAbove = (e as any).clientY < rect.top + rect.height / 2;
      list.querySelectorAll('.level-item').forEach(i => i.classList.remove('drag-above', 'drag-below'));
      el.classList.add(isAbove ? 'drag-above' : 'drag-below');
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFromIdx === null) return;
      const overIdx = levelIdx;
      const rect = el.getBoundingClientRect();
      const isAbove = (e as any).clientY < rect.top + rect.height / 2;
      list.querySelectorAll('.level-item').forEach(i => i.classList.remove('drag-above', 'drag-below'));
      const gap = isAbove ? overIdx : overIdx + 1;
      const n = levels.length;
      const toIdx = dragFromIdx < gap ? Math.min(gap - 1, n - 1) : Math.min(gap, n - 1);
      if (toIdx !== dragFromIdx) moveLevelToIndex(dragFromIdx, toIdx);
    });

    // Rename button
    // @ts-expect-error — strict-mode migration
    el!.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(el, levelIdx);
    });

    // Duplicate button
    // @ts-expect-error — strict-mode migration
    el!.querySelector('[data-action="duplicate"]').addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateLevel(levelIdx);
    });

    // Resize button
    // @ts-expect-error — strict-mode migration
    el!.querySelector('[data-action="resize"]').addEventListener('click', (e) => {
      e.stopPropagation();
      resizeLevel(levelIdx);
    });

    // Delete button
    // @ts-expect-error — strict-mode migration
    el!.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLevel(levelIdx);
    });
  });
}

/**
 * Select a level: set it as current and zoom/pan viewport to fit it.
 */
/**
 * Switch to a level by index and pan the viewport to show it.
 * @param {number} idx - Zero-based level index
 */
export function selectLevel(idx: number): void {
  const levels = state.dungeon.metadata.levels || [];
  if (idx < 0 || idx >= levels.length) return;

  state.currentLevel = idx;
  panToLevel(levels[idx].startRow, levels[idx].numRows);
}

/**
 * Inline rename: replace the name span with an input.
 */
function startRename(el: any, levelIdx: any) {
  if (isEditing) return;
  const level = state.dungeon.metadata.levels[levelIdx];
  if (!level) return;

  isEditing = true;
  const span = el.querySelector('.level-name');
  const oldName = level.name;
  const input = document.createElement('input');
  input.type = 'text';
  // @ts-expect-error — strict-mode migration
  input.value = oldName;
  input.className = 'level-rename-input';
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    if (!isEditing) return;
    const newName = input.value.trim() || oldName;
    if (newName !== oldName) {
      pushUndo('Rename level');
      level.name = newName;
    }
    isEditing = false;
    const newSpan = document.createElement('span');
    newSpan.className = 'level-name';
    newSpan.textContent = `L${levelIdx + 1} — ${level.name}`;
    input.replaceWith(newSpan);
    notify();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (ke) => {
    if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
    // @ts-expect-error — strict-mode migration
    if (ke.key === 'Escape') { input.value = oldName; input.blur(); }
  });
}

/**
 * Resize a level: show styled modal, then add/remove rows.
 */
function resizeLevel(levelIdx: any) {
  const levels = state.dungeon.metadata.levels;
  if (!levels || levelIdx < 0 || levelIdx >= levels.length) return;

  const level = levels[levelIdx];
  const modal = document.getElementById('modal-resize-level');
  const descEl = document.getElementById('modal-resize-level-desc');
  const rowInput = document.getElementById('modal-resize-level-rows');
  const cancelBtn = document.getElementById('modal-resize-level-cancel');
  const okBtn = document.getElementById('modal-resize-level-ok');
  if (!modal || !rowInput) return;

  if (descEl) descEl.textContent = `"${level.name}" currently has ${level.numRows} rows.`;
  // @ts-expect-error — strict-mode migration
  (rowInput as HTMLInputElement).value = level.numRows;
  (modal as HTMLDialogElement).showModal();
  rowInput.focus();
  ((rowInput as HTMLElement) as any).select();

  function cleanup() {
    (modal as HTMLDialogElement).close();
    cancelBtn!.removeEventListener('click', onCancel);
    okBtn!.removeEventListener('click', onOk);
    rowInput!.removeEventListener('keydown', onKey);
    modal!.removeEventListener('click', onOverlay);
  }

  function onCancel() { cleanup(); }

  function onOk() {
    const newRows = parseInt((rowInput! as any).value, 10);
    if (isNaN(newRows) || newRows < 1) {
      rowInput!.focus();
      return;
    }
    cleanup();
    if (newRows === level.numRows) return;

    const cells = state.dungeon.cells;
    const numCols = cells[0]?.length || 30;
    const delta = newRows - level.numRows;
    const levelEnd = level.startRow + level.numRows;

    if (delta < 0) {
      const removeCount = -delta;
      const removeStart = levelEnd - removeCount;
      let hasContent = false;
      for (let r = removeStart; r < levelEnd && !hasContent; r++) {
        for (let c = 0; c < numCols; c++) {
          if (cells[r][c] !== null) { hasContent = true; break; }
        }
      }
      if (hasContent) {
        _confirmDestructiveResize(level, removeCount, () => _applyResize(levelIdx, levels, cells, numCols, delta, newRows, levelEnd));
        return;
      }
    }

    _applyResize(levelIdx, levels, cells, numCols, delta, newRows, levelEnd);
  }

  function onKey(ke: any) {
    if (ke.key === 'Enter') onOk();
    if (ke.key === 'Escape') cleanup();
  }

  function onOverlay(e: any) { if (e.target === modal) cleanup(); }

  cancelBtn!.addEventListener('click', onCancel);
  okBtn!.addEventListener('click', onOk);
  rowInput.addEventListener('keydown', onKey);
  modal.addEventListener('click', onOverlay);
}

function _confirmDestructiveResize(level: any, removeCount: any, onConfirm: any) {
  const confirmModal = document.getElementById('modal-resize-level-confirm');
  const msgEl = document.getElementById('modal-resize-level-confirm-msg');
  const cancelBtn = document.getElementById('modal-resize-level-confirm-cancel');
  const okBtn = document.getElementById('modal-resize-level-confirm-ok');
  if (!confirmModal) { onConfirm(); return; }

  if (msgEl) msgEl.textContent = `This will delete ${removeCount} row(s) at the bottom of "${level.name}" that contain cell data. Continue?`;
  (confirmModal as HTMLDialogElement).showModal();

  function cleanup() {
    (confirmModal as HTMLDialogElement).close();
    cancelBtn!.removeEventListener('click', onCancel);
    okBtn!.removeEventListener('click', onOk);
    confirmModal!.removeEventListener('click', onOverlay);
  }
  function onCancel() { cleanup(); }
  function onOk() { cleanup(); onConfirm(); }
  function onOverlay(e: any) { if (e.target === confirmModal) cleanup(); }

  cancelBtn!.addEventListener('click', onCancel);
  okBtn!.addEventListener('click', onOk);
  confirmModal.addEventListener('click', onOverlay);
}

/**
 * Remove lights/bridges in cell rows [rowStart, rowEnd) and shift all lights/bridges
 * in rows >= rowEnd by shiftRows. Returns the Set of removed bridge IDs so callers
 * can scrub stale bridge-id references from remaining cells.
 */
function _cleanupAndShiftLightsBridges(meta: any, gridSize: any, rowStart: any, rowEnd: any, shiftRows: any) {
  const yStart = rowStart * gridSize;
  const yEnd   = rowEnd   * gridSize;
  const removedBridgeIds = new Set();

  if (meta.lights) {
    meta.lights = meta.lights.filter((l: any) => {
      if (l.y >= yStart && l.y < yEnd) return false;
      return true;
    });
    if (shiftRows !== 0) {
      for (const l of meta.lights) {
        if (l.y >= yEnd) l.y += shiftRows * gridSize;
      }
    }
  }

  if (meta.bridges) {
    meta.bridges = meta.bridges.filter((b: any) => {
      if (b.points.some(([r]: any) => r >= rowStart && r < rowEnd)) {
        removedBridgeIds.add(b.id);
        return false;
      }
      return true;
    });
    if (shiftRows !== 0) {
      for (const b of meta.bridges) {
        b.points = b.points.map(([r, c]: any) => r >= rowEnd ? [r + shiftRows, c] : [r, c]);
      }
    }
  }

  return removedBridgeIds;
}

/** Scrub stale bridge-id references from all remaining cells. */
function _scrubBridgeRefs(cells: any, removedBridgeIds: any) {
  if (!removedBridgeIds.size) return;
  for (const row of cells) {
    for (const cell of row) {
      if (cell?.center?.['bridge-id'] != null && removedBridgeIds.has(cell.center['bridge-id'])) {
        delete cell.center['bridge-id'];
      }
    }
  }
}

function _applyResize(levelIdx: any, levels: any, cells: any, numCols: any, delta: any, newRows: any, levelEnd: any) {
  pushUndo('Resize level');

  const meta = state.dungeon.metadata;
  const gridSize = meta.gridSize || 5;

  if (delta > 0) {
    const newCellRows = [];
    for (let i = 0; i < delta; i++) {
      const row = [];
      for (let c = 0; c < numCols; c++) row.push(null);
      newCellRows.push(row);
    }
    cells.splice(levelEnd, 0, ...newCellRows);
    // Shift lights/bridges in subsequent levels down by delta rows
    _cleanupAndShiftLightsBridges(meta, gridSize, levelEnd, levelEnd, delta);
  } else {
    const removeCount = -delta;
    const removeStart = levelEnd - removeCount;
    const removedBridgeIds = _cleanupAndShiftLightsBridges(meta, gridSize, removeStart, levelEnd, delta);
    cells.splice(removeStart, removeCount);
    _scrubBridgeRefs(cells, removedBridgeIds);
  }

  levels[levelIdx].numRows = newRows;

  for (let i = levelIdx + 1; i < levels.length; i++) {
    levels[i].startRow += delta;
  }

  invalidateAllCaches();
  markDirty();
  notify();
}

function duplicateLevel(idx: any) {
  const levels = state.dungeon.metadata.levels;
  if (!levels || idx < 0 || idx >= levels.length) return;

  const source = levels[idx];
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;
  const numCols = cells[0]?.length || 30;
  const gridSize = meta.gridSize || 5;

  pushUndo('Duplicate level');

  // Deep-copy source rows
  const sourceEnd = source.startRow + source.numRows;
  const newRows = [];
  for (let r = source.startRow; r < sourceEnd; r++) {
    newRows.push(cells[r].map(cell => cell ? JSON.parse(JSON.stringify(cell)) : null));
  }

  // How far down the new level sits relative to the source (1 separator + numRows data)
  const rowOffset = source.numRows + 1;
  const yOffset = rowOffset * gridSize;

  // Copy lights that fall within the source level's y range
  const yStart = source.startRow * gridSize;
  const yEnd = sourceEnd * gridSize;
  if (meta.lights?.length) {
    if (!meta.nextLightId) meta.nextLightId = 1;
    const newLights = meta.lights
      .filter(l => l.y >= yStart && l.y < yEnd)
      .map(l => ({ ...l, id: meta.nextLightId++, y: l.y + yOffset }));
    meta.lights.push(...newLights);
  }

  // Copy bridges whose points all fall within the source level's row range.
  // Also remap bridge-id references in the copied cells.
  if (meta.bridges?.length) {
    if (meta.nextBridgeId == null) meta.nextBridgeId = 0;
    const bridgeIdMap = new Map();
    const newBridges = meta.bridges
      .filter(b => b.points.every(([r]) => r >= source.startRow && r < sourceEnd))
      .map(b => {
        const newId = meta.nextBridgeId++;
        bridgeIdMap.set(b.id, newId);
        return { ...b, id: newId, points: b.points.map(([r, c]) => [r + rowOffset, c]) };
      });
    if (bridgeIdMap.size > 0) {
      for (const row of newRows) {
        for (const cell of row) {
          if (cell?.center?.['bridge-id'] != null) {
            const newId = bridgeIdMap.get(cell.center['bridge-id']);
            if (newId != null) cell.center['bridge-id'] = newId;
          }
        }
      }
    }
    // @ts-expect-error — strict-mode migration
    meta.bridges.push(...newBridges);
  }

  // Renumber labels in copied rows: find the highest existing number, then assign
  // new sequential numbers to duplicated labels (sorted by original number to preserve order).
  const letter = meta.dungeonLetter || 'A';
  const labelPattern = new RegExp(`^${letter}(\\d+)$`);
  let maxLabelNum = 0;
  for (const row of cells) {
    for (const cell of row) {
      const m = cell?.center?.label?.match(labelPattern);
      if (m) maxLabelNum = Math.max(maxLabelNum, parseInt(m[1]));
    }
  }
  const copiedLabels = [];
  for (const row of newRows) {
    for (const cell of row) {
      const m = cell?.center?.label?.match(labelPattern);
      if (m) copiedLabels.push({ cell, origNum: parseInt(m[1]) });
    }
  }
  copiedLabels.sort((a, b) => a.origNum - b.origNum);
  let nextLabelNum = maxLabelNum + 1;
  for (const { cell } of copiedLabels) {
    // @ts-expect-error — strict-mode migration
    cell.center.label = letter + nextLabelNum++;
  }

  // Insert a separator void row + the copied rows after the source level
  const insertAt = sourceEnd;
  const separator = Array(numCols).fill(null);
  cells.splice(insertAt, 0, separator, ...newRows);
  invalidateAllCaches();

  // Insert the new level entry at idx+1
  const newLevel = {
    name: `${source.name} (copy)`,
    startRow: insertAt + 1,
    numRows: source.numRows,
  };
  levels.splice(idx + 1, 0, newLevel);

  // Shift startRow of all subsequent levels (+numRows+1 for separator)
  const shift = source.numRows + 1;
  for (let i = idx + 2; i < levels.length; i++) {
    levels[i].startRow += shift;
  }

  state.currentLevel = idx + 1;
  markDirty();
  notify();
  panToLevel(newLevel.startRow, newLevel.numRows);
  showToast('Level duplicated');
}

/**
 * Move a level from fromIdx to toIdx, physically relocating its cell rows and
 * updating all level metadata. toIdx is the final index in the output array.
 */
function moveLevelToIndex(fromIdx: any, toIdx: any) {
  if (fromIdx === toIdx) return;
  const levels = state.dungeon.metadata.levels;
  if (!levels || fromIdx < 0 || fromIdx >= levels.length) return;
  toIdx = Math.max(0, Math.min(toIdx, levels.length - 1));
  if (fromIdx === toIdx) return;

  pushUndo('Reorder levels');

  const cells = state.dungeon.cells;

  if (cells.some(row => row?.some(cell => cell?.center?.stairsLink))) {
    console.warn('[levels] Stair cross-level links detected — verify stair connections after reorder.');
  }

  // Extract from-level's block: [separator_row, ...dataRows]
  const fromLevel = levels[fromIdx];
  const blockStart = fromLevel.startRow - 1;
  const blockLen = fromLevel.numRows + 1;
  const block = cells.splice(blockStart, blockLen);

  // Shift startRows of remaining levels that were positioned after the extracted block
  for (const lv of levels) {
    if (lv !== fromLevel && lv.startRow - 1 >= blockStart) lv.startRow -= blockLen;
  }

  // Remove fromLevel from metadata
  levels.splice(fromIdx, 1);

  // Find insertion point in cells for the target position in the (now shorter) levels array
  const insertCellPos = toIdx >= levels.length ? cells.length : levels[toIdx].startRow - 1;

  // Insert block and shift affected startRows right
  cells.splice(insertCellPos, 0, ...block);
  for (const lv of levels) {
    if (lv.startRow - 1 >= insertCellPos) lv.startRow += blockLen;
  }

  // Insert fromLevel into metadata with its new startRow
  fromLevel.startRow = insertCellPos + 1;
  levels.splice(toIdx, 0, fromLevel);

  // Keep currentLevel tracking the same logical level
  if (state.currentLevel === fromIdx) {
    state.currentLevel = toIdx;
  } else if (fromIdx < toIdx) {
    if (state.currentLevel > fromIdx && state.currentLevel <= toIdx) state.currentLevel--;
  } else {
    if (state.currentLevel >= toIdx && state.currentLevel < fromIdx) state.currentLevel++;
  }

  invalidateAllCaches();
  markDirty();
  notify();
}

function deleteLevel(idx: any) {
  const levels = state.dungeon.metadata.levels;
  if (!levels || idx < 0 || idx >= levels.length) return;

  if (levels.length === 1) {
    showToast('Cannot delete the only level');
    return;
  }

  const level = levels[idx];
  const modal = document.getElementById('modal-delete-level');
  const msgEl = document.getElementById('modal-delete-level-msg');
  const cancelBtn = document.getElementById('modal-delete-level-cancel');
  const okBtn = document.getElementById('modal-delete-level-ok');
  if (!modal) return;

  if (msgEl) msgEl.textContent = `Delete "${level.name}" and all its content?`;
  (modal as HTMLDialogElement).showModal();

  function cleanup() {
    (modal as HTMLDialogElement).close();
    cancelBtn!.removeEventListener('click', onCancel);
    okBtn!.removeEventListener('click', onOk);
    modal!.removeEventListener('click', onOverlay);
  }
  function onCancel() { cleanup(); }
  function onOk() {
    cleanup();
    pushUndo('Delete level');

    const cells = state.dungeon.cells;
    const meta = state.dungeon.metadata;
    const gridSize = meta.gridSize || 5;
    const blockStart = level.startRow - 1;
    const blockLen = level.numRows + 1;

    // Remove lights/bridges inside the level and shift subsequent ones up
    const removedBridgeIds = _cleanupAndShiftLightsBridges(
      meta, gridSize, level.startRow, level.startRow + level.numRows, -blockLen
    );

    cells.splice(blockStart, blockLen);
    _scrubBridgeRefs(cells, removedBridgeIds);

    // Shift startRows of subsequent levels
    for (let i = idx + 1; i < levels.length; i++) {
      levels[i].startRow -= blockLen;
    }

    levels.splice(idx, 1);

    // Keep currentLevel in bounds, preferring the level below, then above
    if (state.currentLevel >= levels.length) state.currentLevel = levels.length - 1;

    invalidateAllCaches();
    markDirty();
    notify();
    showToast('Level deleted');
  }
  function onOverlay(e: any) { if (e.target === modal) cleanup(); }

  cancelBtn!.addEventListener('click', onCancel);
  okBtn!.addEventListener('click', onOk);
  modal.addEventListener('click', onOverlay);
}

function addLevel() {
  const modal = document.getElementById('modal-add-level');
  const nameInput = document.getElementById('modal-add-level-name');
  const cancelBtn = document.getElementById('modal-add-level-cancel');
  const okBtn = document.getElementById('modal-add-level-ok');
  if (!modal || !nameInput) return;

  const defaultName = `Level ${(state.dungeon.metadata.levels?.length || 0) + 1}`;
  (nameInput as HTMLInputElement).value = defaultName;
  (modal as HTMLDialogElement).showModal();
  nameInput.focus();
  ((nameInput as HTMLElement) as any).select();

  function cleanup() {
    (modal as HTMLDialogElement).close();
    cancelBtn!.removeEventListener('click', onCancel);
    okBtn!.removeEventListener('click', onOk);
    nameInput!.removeEventListener('keydown', onKey);
    modal!.removeEventListener('click', onOverlay);
  }

  function onCancel() { cleanup(); }

  function onOk() {
    const name = (nameInput! as any).value.trim();
    if (!name) { nameInput!.focus(); return; }
    cleanup();

    pushUndo('Add level');

    const cells = state.dungeon.cells;
    const currentRows = cells.length;
    const numCols = cells[0]?.length || 30;
    const newRows = 15;

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

    state.currentLevel = state.dungeon.metadata.levels.length - 1;
    invalidateAllCaches();
    markDirty();
    notify();
    panToLevel(currentRows + 1, newRows);
    showToast('Level added');
  }

  function onKey(ke: any) {
    if (ke.key === 'Enter') onOk();
    if (ke.key === 'Escape') cleanup();
  }

  function onOverlay(e: any) { if (e.target === modal) cleanup(); }

  cancelBtn!.addEventListener('click', onCancel);
  okBtn!.addEventListener('click', onOk);
  nameInput.addEventListener('keydown', onKey);
  modal.addEventListener('click', onOverlay);
}
