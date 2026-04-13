// Background Image panel: upload, scale alignment, offset, and opacity controls
import type { BackgroundImage } from '../../../types.js';
import state, { markDirty, notify, pushUndo, subscribe } from '../state.js';
import { requestRender, activateBgCellMeasure, getCachedBgImage } from '../canvas-view.js';
import { invalidateAllCaches } from '../../../render/index.js';

let container: HTMLElement | null = null;

/**
 * Initialize the background image panel: upload, scale, offset, and opacity controls.
 * @param {HTMLElement} el - Container element for the panel
 */
export function initBackgroundImagePanel(containerEl: HTMLElement): void {
  container = containerEl;
  render();
  subscribe(() => render(), 'bg-image');
}

let _lastBgImage: BackgroundImage | null | undefined = undefined;
function render() {
  if (!container) return;

  const metadata = state.dungeon.metadata;
  const bi = metadata.backgroundImage;

  // Skip rebuild if background image config hasn't changed and DOM is still populated
  if (bi === _lastBgImage && container.children.length > 0) return;
  _lastBgImage = bi;

  container.innerHTML = '';

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
    const file = fileInput.files![0]!;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target!.result as string;
      const fallbackPpc = bi?.pixelsPerCell ?? 70;
      const applyUpload = (offsetX: number, offsetY: number, pixelsPerCell: number) => {
        pushUndo();
        metadata.backgroundImage = {
          dataUrl,
          filename: file.name,
          offsetX,
          offsetY,
          pixelsPerCell,
          opacity: bi?.opacity ?? 1.0,
        };
        // Auto-fill floor cells under the image (same undo step), leaving border cells voided
        const imgW = tmpImg.naturalWidth / pixelsPerCell;
        const imgH = tmpImg.naturalHeight / pixelsPerCell;
        const { cells } = state.dungeon;
        const r1 = Math.max(0, Math.floor(offsetY) + 1);
        const c1 = Math.max(0, Math.floor(offsetX) + 1);
        const r2 = Math.min(cells.length - 1, Math.ceil(offsetY + imgH) - 2);
        const c2 = Math.min((cells[0]?.length ?? 0) - 1, Math.ceil(offsetX + imgW) - 2);
        if (r1 <= r2 && c1 <= c2) {
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
              cells[r]![c] ??= {};
            }
          }
          invalidateAllCaches();
        }
        markDirty();
        notify();
      };
      const tmpImg = new Image();
      tmpImg.onload = () => {
        const detected = _analyzeGrid(tmpImg);
        const ppc = detected?.pixelsPerCell ?? fallbackPpc;
        if (!bi) {
          // First upload: auto-center with grid phase alignment
          const cols = state.dungeon.cells[0]?.length ?? 30;
          const rows = state.dungeon.cells.length;
          const imgW_cells = tmpImg.naturalWidth / ppc;
          const imgH_cells = tmpImg.naturalHeight / ppc;
          const rawOffsetX = (cols - imgW_cells) / 2;
          const rawOffsetY = (rows - imgH_cells) / 2;
          // Phase-align: shift so image grid lines land on integer cell boundaries.
          // Grid lines are at cell position (offsetX + phaseX_cells + k) for integer k.
          // We need offsetX + phaseX_cells = integer n, with n closest to rawOffsetX + phaseX_cells.
          let offsetX = rawOffsetX;
          let offsetY = rawOffsetY;
          if (detected) {
            const phaseX_cells = detected.phaseX / ppc;
            const phaseY_cells = detected.phaseY / ppc;
            offsetX = Math.round(rawOffsetX + phaseX_cells) - phaseX_cells;
            offsetY = Math.round(rawOffsetY + phaseY_cells) - phaseY_cells;
          }
          applyUpload(offsetX, offsetY, ppc);
        } else {
          // Replace: keep existing offsets; update scale if detection succeeded
          applyUpload(bi.offsetX!, bi.offsetY!, detected?.pixelsPerCell ?? fallbackPpc);
        }
      };
      tmpImg.onerror = () => applyUpload(0, 0, fallbackPpc);
      tmpImg.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });

  if (bi) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'toolbar-btn bg-image-btn-sm';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      pushUndo();
      metadata.backgroundImage = undefined;
      markDirty();
      notify();
    });
    uploadBtns.appendChild(clearBtn);
  }

  uploadSection.appendChild(uploadBtns);

  if (bi) {
    const filename = el('div', 'bg-image-filename');
    filename.textContent = bi.filename ?? 'image';
    filename.title = bi.filename ?? '';
    uploadSection.appendChild(filename);
  }

  container.appendChild(uploadSection);

  if (!bi) return;

  // ── Shared helper: recenter image and fill floor cells under it ──────────
  // Called after scale changes (Measure / Calc). Mutates bi.offsetX!/offsetY
  // and fills cells in the same undo step already pushed by the caller.
  const recenterAndFill = (imgEl: HTMLImageElement, ppc: number) => {
    const { cells } = state.dungeon;
    const totalCols = cells[0]?.length ?? 0;
    const totalRows = cells.length;
    const imgW_cells = imgEl.naturalWidth / ppc;
    const imgH_cells = imgEl.naturalHeight / ppc;
    const rawOffsetX = (totalCols - imgW_cells) / 2;
    const rawOffsetY = (totalRows - imgH_cells) / 2;
    const phase = _detectPhase(imgEl, ppc);
    const phaseX_cells = phase.phaseX / ppc;
    const phaseY_cells = phase.phaseY / ppc;
    bi.offsetX = Math.round(rawOffsetX + phaseX_cells) - phaseX_cells;
    bi.offsetY = Math.round(rawOffsetY + phaseY_cells) - phaseY_cells;
    const r1 = Math.max(0, Math.floor(bi.offsetY) + 1);
    const c1 = Math.max(0, Math.floor(bi.offsetX) + 1);
    const r2 = Math.min(totalRows - 1, Math.ceil(bi.offsetY + imgH_cells) - 2);
    const c2 = Math.min(totalCols - 1, Math.ceil(bi.offsetX + imgW_cells) - 2);
    if (r1 <= r2 && c1 <= c2) {
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          cells[r]![c] ??= {};
        }
      }
      invalidateAllCaches();
    }
  };

  // ── Scale ───────────────────────────────────────────────────────────────
  container.appendChild(sectionLabel('Grid Alignment'));

  const scaleRow = numericRow(
    'Scale (px / cell)',
    bi.pixelsPerCell!,
    1,
    null,
    1,
    'How many pixels in the source image equal one Mapwright grid cell. Adjust until grid lines overlap.',
    (v: number) => {
      bi.pixelsPerCell = v;
      markDirty();
      requestRender();
    },
    (v: number) => {
      pushUndo();
      bi.pixelsPerCell = v;
      markDirty();
      notify();
    },
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
      const imgEl = getCachedBgImage(bi.dataUrl);
      if (imgEl.complete && imgEl.naturalWidth) recenterAndFill(imgEl, newPpc);
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
  colsInput.min = '1';
  colsInput.step = '1';
  colsInput.placeholder = '—';
  calcRow.appendChild(colsInput);

  const calcSep = el('span', 'bg-image-calc-sep');
  calcSep.textContent = '×';
  calcRow.appendChild(calcSep);

  const rowsInput = document.createElement('input');
  rowsInput.type = 'number';
  rowsInput.className = 'bg-image-number';
  rowsInput.min = '1';
  rowsInput.step = '1';
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
    const ppcFromCols = cols > 0 ? img.naturalWidth / cols : null;
    const ppcFromRows = rows > 0 ? img.naturalHeight / rows : null;
    if (!ppcFromCols && !ppcFromRows) return;
    const ppc = Math.max(
      1,
      ppcFromCols && ppcFromRows
        ? Math.round((ppcFromCols + ppcFromRows) / 2)
        : Math.round((ppcFromCols ?? ppcFromRows)!),
    );
    pushUndo();
    bi.pixelsPerCell = ppc;
    recenterAndFill(img, ppc);
    markDirty();
    notify();
  });
  calcRow.appendChild(calcBtn);

  container.appendChild(calcRow);

  // ── Offsets ─────────────────────────────────────────────────────────────
  container.appendChild(sectionLabel('Position'));

  container.appendChild(
    numericRow(
      'Offset X (cells)',
      parseFloat(bi.offsetX!.toFixed(2)),
      null,
      null,
      0.01,
      'Horizontal shift of the image in grid cells. Use to align vertical grid lines.',
      (v: number) => {
        bi.offsetX = v;
        markDirty();
        requestRender();
      },
      (v: number) => {
        pushUndo();
        bi.offsetX = v;
        markDirty();
        notify();
      },
    ),
  );

  container.appendChild(
    numericRow(
      'Offset Y (cells)',
      parseFloat(bi.offsetY!.toFixed(2)),
      null,
      null,
      0.01,
      'Vertical shift of the image in grid cells. Use to align horizontal grid lines.',
      (v: number) => {
        bi.offsetY = v;
        markDirty();
        requestRender();
      },
      (v: number) => {
        pushUndo();
        bi.offsetY = v;
        markDirty();
        notify();
      },
    ),
  );

  const centerBtn = document.createElement('button');
  centerBtn.className = 'toolbar-btn bg-image-btn-sm';
  centerBtn.textContent = 'Center Image';
  centerBtn.title = 'Center the image on the dungeon grid using current scale';
  centerBtn.addEventListener('click', () => {
    const imgEl = getCachedBgImage(bi.dataUrl);
    if (!imgEl.complete || !imgEl.naturalWidth) return;
    const ppc = bi.pixelsPerCell!;
    const cols = state.dungeon.cells[0]?.length ?? 0;
    const rows = state.dungeon.cells.length;
    const imgW_cells = imgEl.naturalWidth / ppc;
    const imgH_cells = imgEl.naturalHeight / ppc;
    const rawOffsetX = (cols - imgW_cells) / 2;
    const rawOffsetY = (rows - imgH_cells) / 2;
    // Phase-align using the current ppc so grid lines land on editor cell boundaries
    const phase = _detectPhase(imgEl, ppc);
    const phaseX_cells = phase.phaseX / ppc;
    const phaseY_cells = phase.phaseY / ppc;
    const offsetX = Math.round(rawOffsetX + phaseX_cells) - phaseX_cells;
    const offsetY = Math.round(rawOffsetY + phaseY_cells) - phaseY_cells;
    pushUndo();
    bi.offsetX = offsetX;
    bi.offsetY = offsetY;
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
    const imgWidthCells = imgEl.naturalWidth / bi.pixelsPerCell!;
    const imgHeightCells = imgEl.naturalHeight / bi.pixelsPerCell!;
    const { cells } = state.dungeon;
    const totalRows = cells.length;
    const totalCols = cells[0]?.length ?? 0;
    const r1 = Math.max(0, Math.floor(bi.offsetY!) + 1);
    const c1 = Math.max(0, Math.floor(bi.offsetX!) + 1);
    const r2 = Math.min(totalRows - 1, Math.ceil(bi.offsetY! + imgHeightCells) - 2);
    const c2 = Math.min(totalCols - 1, Math.ceil(bi.offsetX! + imgWidthCells) - 2);
    if (r1 > r2 || c1 > c2) return;
    pushUndo();
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        cells[r]![c] ??= {};
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
    const imgWidthCells = imgEl.naturalWidth / bi.pixelsPerCell!;
    const imgHeightCells = imgEl.naturalHeight / bi.pixelsPerCell!;
    const { cells } = state.dungeon;
    const totalRows = cells.length;
    const totalCols = cells[0]?.length ?? 0;
    const neededCols = Math.max(1, Math.ceil(Math.max(0, bi.offsetX! + imgWidthCells)) + 1);
    const neededRows = Math.max(1, Math.ceil(Math.max(0, bi.offsetY! + imgHeightCells)) + 1);
    if (neededCols > totalCols || neededRows > totalRows) {
      // Canvas too small — image extends beyond the dungeon boundary
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
            const last = levels[levels.length - 1]!;
            last.numRows = neededRows - last.startRow;
          }
        }
        // Clear all floors, re-center image, re-fill under image
        for (let r = 0; r < c.length; r++) for (let col = 0; col < c[r]!.length; col++) c[r]![col] = null;
        if (imgEl.complete && imgEl.naturalWidth) recenterAndFill(imgEl, bi.pixelsPerCell!);
        invalidateAllCaches();
        markDirty();
        notify();
      });
      warnEl.appendChild(resizeBtn);
      container.appendChild(warnEl);
    } else if (neededCols < totalCols || neededRows < totalRows) {
      // Canvas too large — dungeon has excess empty space beyond the image
      const warnEl = el('div', 'bg-image-resize-warning');
      warnEl.textContent = `Dungeon is larger than the image (${totalCols}×${totalRows} vs ${neededCols}×${neededRows}).`;
      const resizeBtn = document.createElement('button');
      resizeBtn.className = 'toolbar-btn';
      resizeBtn.textContent = `Shrink to ${neededCols}×${neededRows}`;
      resizeBtn.addEventListener('click', () => {
        pushUndo();
        const { cells: c, metadata: m } = state.dungeon;
        // Trim rows and cols to the needed size
        if (neededRows < c.length) c.splice(neededRows);
        for (const row of c) if (row.length > neededCols) row.splice(neededCols);
        // Update last level's numRows
        const levels = m.levels;
        if (levels.length > 0) {
          const last = levels[levels.length - 1]!;
          last.numRows = neededRows - last.startRow;
        }
        // Clear all floors, re-center image, re-fill under image
        for (let r = 0; r < c.length; r++) for (let col = 0; col < c[r]!.length; col++) c[r]![col] = null;
        if (imgEl.complete && imgEl.naturalWidth) recenterAndFill(imgEl, bi.pixelsPerCell!);
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
  opacitySlider.min = '0';
  opacitySlider.max = '100';
  opacitySlider.step = '5';
  opacitySlider.value = String(Math.round(bi.opacity * 100));

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

function el(tag: string, className: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function sectionLabel(text: string) {
  const label = el('div', 'bg-image-section-label');
  label.textContent = text;
  return label;
}

function numericRow(
  labelText: string,
  value: number | string,
  min: number | null,
  max: number | null,
  step: number,
  title: string,
  onInput: (v: number) => void,
  onChange: (v: number) => void,
) {
  const row = el('div', 'bg-image-slider-row');

  const labelEl = el('label', 'bg-image-label');
  labelEl.textContent = labelText;
  if (title) labelEl.title = title;
  row.appendChild(labelEl);

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'bg-image-number';
  input.value = String(value);
  if (min !== null) input.min = String(min);
  if (max !== null) input.max = String(max);
  input.step = String(step);

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
  input.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const v = parseFloat(input.value) || 0;
      const delta = e.deltaY < 0 ? step : -step;
      const next = parseFloat((v + delta).toFixed(10));
      if ((min === null || next >= min) && (max === null || next <= max)) {
        input.value = String(next);
        onInput(next);
        clearTimeout((input as unknown as { _wheelTimer: ReturnType<typeof setTimeout> })._wheelTimer);
        (input as unknown as { _wheelTimer: ReturnType<typeof setTimeout> })._wheelTimer = setTimeout(
          () => onChange(next),
          400,
        );
      }
    },
    { passive: false },
  );

  row.appendChild(input);
  return row;
}

// ── Grid auto-detection ───────────────────────────────────────────────────────

/**
 * Analyse a loaded HTMLImageElement and return an estimated pixels-per-cell
 * value by computing the autocorrelation of row- and column-gradient signals.
 * Returns null if no clear periodic pattern is found.
 */
function _analyzeGrid(img: HTMLImageElement) {
  const MAX_DIM = 1024;
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const cvs = document.createElement('canvas');
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx!.drawImage(img, 0, 0, w, h);
  const { data } = ctx!.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  }
  // Row signal: mean |dy| per row — spikes at horizontal grid lines
  const rowSig = new Float32Array(h);
  for (let y = 1; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += Math.abs(gray[y * w + x]! - gray[(y - 1) * w + x]!);
    rowSig[y] = s / w;
  }
  // Col signal: mean |dx| per col — spikes at vertical grid lines
  const colSig = new Float32Array(w);
  for (let x = 1; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += Math.abs(gray[y * w + x]! - gray[y * w + x - 1]!);
    colSig[x] = s / h;
  }
  const rp = _findPeriod(rowSig);
  const cp = _findPeriod(colSig);
  if (!rp && !cp) return null;
  const avgPeriod = rp && cp ? (rp + cp) / 2 : (rp ?? cp)!;
  const raw = Math.max(4, Math.round(avgPeriod / scale));
  // For larger grid sizes, snap to the nearest multiple of 5 (e.g. 73 → 75)
  const pixelsPerCell = raw > 50 ? Math.round(raw / 5) * 5 : raw;
  // Detect grid phase: position of the first grid line within the image (in image pixels).
  // Fold each signal into period buckets; the peak bucket index is the phase offset.
  const scaledPhaseX = cp ? _findPhase(colSig, cp) : _findPhase(colSig, rp!);
  const scaledPhaseY = rp ? _findPhase(rowSig, rp) : _findPhase(rowSig, cp!);
  return { pixelsPerCell, phaseX: scaledPhaseX / scale, phaseY: scaledPhaseY / scale };
}

/**
 * Find the dominant period of a 1-D signal using normalised autocorrelation.
 * Checks sub-harmonics to avoid returning a multiple of the true period.
 */
function _findPeriod(signal: Float32Array) {
  const n = signal.length;
  const MIN_P = 6;
  const MAX_P = Math.min(Math.floor(n / 3), 400);
  if (MAX_P < MIN_P * 2) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i]!;
  mean /= n;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = signal[i]! - mean;
  let var0 = 0;
  for (let i = 0; i < n; i++) var0 += s[i]! * s[i]!;
  var0 /= n;
  if (var0 < 1e-10) return null;
  // Normalised autocorrelation — find the lag with the highest correlation
  let bestR = 0.15; // minimum significance threshold
  let bestK = null;
  for (let k = MIN_P; k <= MAX_P; k++) {
    const len = n - k;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += s[i]! * s[i + k]!;
    const r = sum / (len * var0);
    if (r > bestR) {
      bestR = r;
      bestK = k;
    }
  }
  if (!bestK) return null;
  // Sub-harmonic check: only needed when large-scale image structure (e.g. repeating
  // room layouts) pushes bestK to a multiple of the true cell period. Skip entirely
  // for small bestK values that are already plausible grid periods on their own.
  if (bestK < 40) return bestK;
  // Check divisors 2–8 for a shorter fundamental period.
  // No early break: keep updating to find the smallest passing sub-harmonic.
  // (Handles cases where large-scale map features dominate, e.g. bestK = 5×T)
  let foundSub = null;
  for (const div of [2, 3, 4, 5, 6, 7, 8]) {
    const sub = Math.round(bestK / div);
    if (sub < MIN_P) break;
    // Only accept if sub is actually a near-exact harmonic divisor of bestK
    if (Math.abs(bestK - div * sub) / sub > 0.15) continue;
    const len = n - sub;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += s[i]! * s[i + sub]!;
    const r = sum / (len * var0);
    if (r >= 0.35 * bestR) foundSub = sub;
  }
  return foundSub ?? bestK;
}

/**
 * Given a 1-D signal and a known period T, detect the phase offset — i.e. the
 * position (0..T-1) within one period where the grid lines fall.
 * Folds the signal into T buckets by accumulating signal[i] into bucket[i % T].
 * The bucket with the highest sum is the dominant phase.
 */
function _findPhase(signal: Float32Array, period: number) {
  const T = Math.max(1, Math.round(period));
  const bucket = new Float32Array(T);
  for (let i = 0; i < signal.length; i++) bucket[i % T]! += signal[i]!;
  let maxVal = -Infinity,
    phase = 0;
  for (let p = 0; p < T; p++) {
    if (bucket[p]! > maxVal) {
      maxVal = bucket[p]!;
      phase = p;
    }
  }
  return phase;
}

/**
 * Detect the grid phase (first-line offset) for a given ppc — always returns a
 * result. Unlike _analyzeGrid, this uses the caller-supplied pixelsPerCell so
 * phase bucketing is correct even when the user has manually set a different scale.
 */
function _detectPhase(img: HTMLImageElement, ppc: number) {
  const MAX_DIM = 1024;
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const cvs = document.createElement('canvas');
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx!.drawImage(img, 0, 0, w, h);
  const { data } = ctx!.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  }
  const rowSig = new Float32Array(h);
  for (let y = 1; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += Math.abs(gray[y * w + x]! - gray[(y - 1) * w + x]!);
    rowSig[y] = s / w;
  }
  const colSig = new Float32Array(w);
  for (let x = 1; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += Math.abs(gray[y * w + x]! - gray[y * w + x - 1]!);
    colSig[x] = s / h;
  }
  const scaledPpc = ppc * scale;
  return {
    phaseX: _findPhase(colSig, scaledPpc) / scale,
    phaseY: _findPhase(rowSig, scaledPpc) / scale,
  };
}
