// Background Image panel: upload, scale alignment, offset, and opacity controls
import state, { markDirty, notify, pushUndo, subscribe } from '../state.js';
import { requestRender, activateBgCellMeasure, getCachedBgImage } from '../canvas-view.js';
import { invalidateAllCaches } from '../../../render/index.js';

let container = null;

export function initBackgroundImagePanel(el) {
  container = el;
  render();
  subscribe(() => render());
}

function render() {
  if (!container) return;
  container.innerHTML = '';

  const metadata = state.dungeon.metadata;
  const bi = metadata.backgroundImage;

  // ── Upload row ──────────────────────────────────────────────────────────
  const uploadSection = el('div', 'bg-image-section');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  fileInput.id = 'bg-image-file-input';
  uploadSection.appendChild(fileInput);

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'toolbar-btn bg-image-btn-sm';
  uploadBtn.textContent = bi ? 'Replace' : 'Upload Image';
  uploadBtn.addEventListener('click', () => fileInput.click());

  const uploadBtns = el('div', 'bg-image-upload-btns');
  uploadBtns.appendChild(uploadBtn);

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const ppc = bi?.pixelsPerCell ?? 70;
      const applyUpload = (offsetX, offsetY) => {
        pushUndo();
        metadata.backgroundImage = {
          dataUrl,
          filename: file.name,
          offsetX,
          offsetY,
          pixelsPerCell: ppc,
          opacity: bi?.opacity ?? 0.5,
        };
        markDirty();
        notify();
      };
      // On first upload (no existing image), auto-center on the dungeon grid
      if (!bi) {
        const tmpImg = new Image();
        tmpImg.onload = () => {
          const cols = state.dungeon.cells[0]?.length ?? 30;
          const rows = state.dungeon.cells.length;
          applyUpload(
            (cols - tmpImg.naturalWidth / ppc) / 2,
            (rows - tmpImg.naturalHeight / ppc) / 2,
          );
        };
        tmpImg.onerror = () => applyUpload(0, 0);
        tmpImg.src = dataUrl;
      } else {
        applyUpload(bi.offsetX, bi.offsetY);
      }
    };
    reader.readAsDataURL(file);
  });

  if (bi) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'toolbar-btn bg-image-btn-sm';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      pushUndo();
      metadata.backgroundImage = null;
      markDirty();
      notify();
    });
    uploadBtns.appendChild(clearBtn);
  }

  uploadSection.appendChild(uploadBtns);

  if (bi) {
    const filename = el('div', 'bg-image-filename');
    filename.textContent = bi.filename || 'image';
    filename.title = bi.filename || '';
    uploadSection.appendChild(filename);
  }

  container.appendChild(uploadSection);

  if (!bi) return;

  // ── Scale ───────────────────────────────────────────────────────────────
  container.appendChild(sectionLabel('Grid Alignment'));

  const scaleRow = numericRow(
    'Scale (px / cell)',
    bi.pixelsPerCell,
    1, null, 1,
    'How many pixels in the source image equal one Mapwright grid cell. Adjust until grid lines overlap.',
    (v) => { bi.pixelsPerCell = v; markDirty(); requestRender(); },
    (v) => { pushUndo(); bi.pixelsPerCell = v; markDirty(); notify(); }
  );

  // ── Measure Cell drag tool ───────────────────────────────────────────────
  const measureBtn = document.createElement('button');
  measureBtn.className = 'toolbar-btn bg-image-btn-sm bg-image-measure-btn';
  measureBtn.textContent = 'Measure';
  measureBtn.title = 'Click and drag across one grid cell in the image to auto-calculate scale';
  measureBtn.addEventListener('click', () => {
    measureBtn.textContent = 'Drag cell…';
    measureBtn.classList.add('active');
    activateBgCellMeasure((newPpc) => {
      pushUndo();
      bi.pixelsPerCell = newPpc;
      markDirty();
      notify(); // triggers panel re-render which resets the button
    });
  });
  scaleRow.appendChild(measureBtn);
  container.appendChild(scaleRow);

  // ── Rows / Cols calculator ───────────────────────────────────────────────
  container.appendChild(sectionLabel('Calculate from grid size'));

  const calcRow = el('div', 'bg-image-calc-row');

  const colsLabel = el('label', 'bg-image-label');
  colsLabel.textContent = 'Cols';
  calcRow.appendChild(colsLabel);

  const colsInput = document.createElement('input');
  colsInput.type = 'number';
  colsInput.className = 'bg-image-number';
  colsInput.min = 1;
  colsInput.step = 1;
  colsInput.placeholder = '—';
  calcRow.appendChild(colsInput);

  const calcSep = el('span', 'bg-image-calc-sep');
  calcSep.textContent = '×';
  calcRow.appendChild(calcSep);

  const rowsInput = document.createElement('input');
  rowsInput.type = 'number';
  rowsInput.className = 'bg-image-number';
  rowsInput.min = 1;
  rowsInput.step = 1;
  rowsInput.placeholder = '—';
  calcRow.appendChild(rowsInput);

  const calcBtn = document.createElement('button');
  calcBtn.className = 'toolbar-btn bg-image-btn-sm';
  calcBtn.textContent = 'Calc';
  calcBtn.title = 'Compute scale from the number of rows/columns in the source image';
  calcBtn.addEventListener('click', () => {
    const cols = parseInt(colsInput.value, 10);
    const rows = parseInt(rowsInput.value, 10);
    const img = getCachedBgImage(bi.dataUrl);
    if (!img || !img.complete || !img.naturalWidth) return;
    const ppcFromCols = cols > 0 ? img.naturalWidth  / cols : null;
    const ppcFromRows = rows > 0 ? img.naturalHeight / rows : null;
    if (!ppcFromCols && !ppcFromRows) return;
    const ppc = (ppcFromCols && ppcFromRows)
      ? Math.round((ppcFromCols + ppcFromRows) / 2)
      : Math.round(ppcFromCols ?? ppcFromRows);
    pushUndo();
    bi.pixelsPerCell = Math.max(1, ppc);
    markDirty();
    notify();
  });
  calcRow.appendChild(calcBtn);

  container.appendChild(calcRow);

  // ── Offsets ─────────────────────────────────────────────────────────────
  container.appendChild(sectionLabel('Position'));

  container.appendChild(numericRow(
    'Offset X (cells)',
    parseFloat(bi.offsetX.toFixed(2)),
    null, null, 0.5,
    'Horizontal shift of the image in grid cells. Use to align vertical grid lines.',
    (v) => { bi.offsetX = v; markDirty(); requestRender(); },
    (v) => { pushUndo(); bi.offsetX = v; markDirty(); notify(); }
  ));

  container.appendChild(numericRow(
    'Offset Y (cells)',
    parseFloat(bi.offsetY.toFixed(2)),
    null, null, 0.5,
    'Vertical shift of the image in grid cells. Use to align horizontal grid lines.',
    (v) => { bi.offsetY = v; markDirty(); requestRender(); },
    (v) => { pushUndo(); bi.offsetY = v; markDirty(); notify(); }
  ));

  const centerBtn = document.createElement('button');
  centerBtn.className = 'toolbar-btn bg-image-btn-sm';
  centerBtn.textContent = 'Center Image';
  centerBtn.title = 'Center the image on the dungeon grid using current scale';
  centerBtn.addEventListener('click', () => {
    const imgEl = getCachedBgImage(bi.dataUrl);
    if (!imgEl.complete || !imgEl.naturalWidth) return;
    const cols = state.dungeon.cells[0]?.length ?? 0;
    const rows = state.dungeon.cells.length;
    pushUndo();
    bi.offsetX = (cols - imgEl.naturalWidth / bi.pixelsPerCell) / 2;
    bi.offsetY = (rows - imgEl.naturalHeight / bi.pixelsPerCell) / 2;
    markDirty();
    notify();
  });
  container.appendChild(centerBtn);

  // ── Fill Cells ───────────────────────────────────────────────────────────
  container.appendChild(sectionLabel('Floor Cells'));

  const fillBtn = document.createElement('button');
  fillBtn.className = 'toolbar-btn bg-image-btn-sm';
  fillBtn.textContent = 'Fill Cells Under Image';
  fillBtn.title = 'Create floor cells for every dungeon grid square covered by the image';
  fillBtn.addEventListener('click', () => {
    const imgEl = getCachedBgImage(bi.dataUrl);
    if (!imgEl.complete || !imgEl.naturalWidth) return;
    const imgWidthCells = imgEl.naturalWidth / bi.pixelsPerCell;
    const imgHeightCells = imgEl.naturalHeight / bi.pixelsPerCell;
    const { cells } = state.dungeon;
    const totalRows = cells.length;
    const totalCols = cells[0]?.length ?? 0;
    const r1 = Math.max(0, Math.floor(bi.offsetY));
    const c1 = Math.max(0, Math.floor(bi.offsetX));
    const r2 = Math.min(totalRows - 1, Math.ceil(bi.offsetY + imgHeightCells) - 1);
    const c2 = Math.min(totalCols - 1, Math.ceil(bi.offsetX + imgWidthCells) - 1);
    if (r1 > r2 || c1 > c2) return;
    pushUndo();
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (!cells[r][c]) cells[r][c] = {};
      }
    }
    invalidateAllCaches();
    markDirty();
    notify();
  });
  container.appendChild(fillBtn);

  // ── Resize warning ───────────────────────────────────────────────────────
  const imgEl = getCachedBgImage(bi.dataUrl);
  if (imgEl.complete && imgEl.naturalWidth > 0) {
    const imgWidthCells = imgEl.naturalWidth / bi.pixelsPerCell;
    const imgHeightCells = imgEl.naturalHeight / bi.pixelsPerCell;
    const { cells } = state.dungeon;
    const totalRows = cells.length;
    const totalCols = cells[0]?.length ?? 0;
    const neededCols = Math.ceil(Math.max(0, bi.offsetX + imgWidthCells));
    const neededRows = Math.ceil(Math.max(0, bi.offsetY + imgHeightCells));
    if (neededCols > totalCols || neededRows > totalRows) {
      const warnEl = el('div', 'bg-image-resize-warning');
      warnEl.textContent = `Image extends beyond dungeon (needs ${neededCols}×${neededRows}).`;
      const resizeBtn = document.createElement('button');
      resizeBtn.className = 'toolbar-btn';
      resizeBtn.textContent = `Resize to ${neededCols}×${neededRows}`;
      resizeBtn.addEventListener('click', () => {
        pushUndo();
        const { cells: c, metadata: m } = state.dungeon;
        const curRows = c.length;
        const curCols = c[0]?.length ?? 0;
        if (neededCols > curCols) {
          for (const row of c) while (row.length < neededCols) row.push(null);
        }
        if (neededRows > curRows) {
          const colCount = Math.max(neededCols, curCols);
          for (let r = curRows; r < neededRows; r++) {
            c.push(new Array(colCount).fill(null));
          }
          const levels = m.levels;
          if (levels.length > 0) {
            const last = levels[levels.length - 1];
            last.numRows = neededRows - last.startRow;
          }
        }
        invalidateAllCaches();
        markDirty();
        notify();
      });
      warnEl.appendChild(resizeBtn);
      container.appendChild(warnEl);
    }
  } else if (!imgEl.complete) {
    imgEl.addEventListener('load', () => notify(), { once: true });
  }

  // ── Opacity ─────────────────────────────────────────────────────────────
  container.appendChild(sectionLabel('Opacity'));

  const opacityRow = el('div', 'bg-image-slider-row');
  const opacityLabel = el('label', 'bg-image-label');
  opacityLabel.textContent = 'Opacity';
  opacityRow.appendChild(opacityLabel);

  const opacitySlider = document.createElement('input');
  opacitySlider.type = 'range';
  opacitySlider.min = 0;
  opacitySlider.max = 100;
  opacitySlider.step = 5;
  opacitySlider.value = Math.round((bi.opacity ?? 0.5) * 100);

  const opacityDisplay = el('span', 'bg-image-value');
  opacityDisplay.textContent = `${opacitySlider.value}%`;

  opacitySlider.addEventListener('input', () => {
    const v = parseInt(opacitySlider.value, 10) / 100;
    opacityDisplay.textContent = `${opacitySlider.value}%`;
    bi.opacity = v;
    markDirty();
    requestRender();
  });
  opacitySlider.addEventListener('change', () => {
    pushUndo();
    bi.opacity = parseInt(opacitySlider.value, 10) / 100;
    markDirty();
    notify();
  });

  opacityRow.appendChild(opacitySlider);
  opacityRow.appendChild(opacityDisplay);
  container.appendChild(opacityRow);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function sectionLabel(text) {
  const label = el('div', 'bg-image-section-label');
  label.textContent = text;
  return label;
}

function numericRow(labelText, value, min, max, step, title, onInput, onChange) {
  const row = el('div', 'bg-image-slider-row');

  const labelEl = el('label', 'bg-image-label');
  labelEl.textContent = labelText;
  if (title) labelEl.title = title;
  row.appendChild(labelEl);

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'bg-image-number';
  input.value = value;
  if (min !== null) input.min = min;
  if (max !== null) input.max = max;
  input.step = step;

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!isNaN(v) && (min === null || v >= min) && (max === null || v <= max)) {
      onInput(v);
    }
  });
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!isNaN(v) && (min === null || v >= min) && (max === null || v <= max)) {
      onChange(v);
    }
  });

  row.appendChild(input);
  return row;
}
