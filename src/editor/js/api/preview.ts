// Prop Preview API — renders a single prop to a data URL for agent self-correction.

import { state, getThemeCatalog } from './_shared.js';
import { parsePropFile, renderProp } from '../../../render/props.js';

/**
 * Render a single prop to a data-URL image for visual inspection.
 *
 * @param {string} propTypeOrText - Either a prop catalog name (e.g. "pillar")
 *   or raw .prop file text (must contain '---').
 * @param {object} options
 * @param {number}  [options.rotation=0]      - Rotation in degrees (0, 90, 180, 270).
 * @param {boolean} [options.flipped=false]    - Mirror the prop horizontally.
 * @param {number}  [options.scale=128]        - Pixels per grid cell.
 * @param {string|null} [options.background=null] - Background CSS color, or null for theme floor.
 * @returns {{ success: boolean, dataUrl: string, name: string, footprint: number[], warnings: string[] }}
 */
export async function renderPropPreview(propTypeOrText: string, options: Record<string, any> = {}): Promise<any> {
  const {
    rotation = 0,
    flipped = false,
    scale = 128,
    background = null,
  } = options;

  const warnings = [];

  // ── Resolve prop definition ───────────────────────────────────────────────

  let propDef;

  if (typeof propTypeOrText === 'string' && propTypeOrText.includes('---')) {
    // Raw .prop file text
    try {
      propDef = parsePropFile(propTypeOrText);
    } catch (e) {
      return { success: false, dataUrl: null, name: null, footprint: null, warnings: [(e as any).message] };
    }
  } else {
    // Catalog lookup
    const catalog = state.propCatalog;
    if (!catalog) {
      return { success: false, dataUrl: null, name: propTypeOrText, footprint: null, warnings: ['Prop catalog not loaded'] };
    }

    propDef = catalog[propTypeOrText];
    if (!propDef) {
      // Try case-insensitive search
      const key = Object.keys(catalog).find(
        k => k.toLowerCase() === String(propTypeOrText).toLowerCase()
      );
      if (key) propDef = catalog[key];
    }
    if (!propDef) {
      return { success: false, dataUrl: null, name: propTypeOrText, footprint: null, warnings: [`Prop type "${propTypeOrText}" not found in catalog`] };
    }
  }

  // ── Determine canvas size ─────────────────────────────────────────────────

  const [rows, cols] = propDef.footprint || [1, 1];
  // Account for rotation: 90/270 swaps rows and cols
  const rotated = (rotation === 90 || rotation === 270);
  const canvasRows = rotated ? cols : rows;
  const canvasCols = rotated ? rows : cols;
  const width = canvasCols * scale;
  const height = canvasRows * scale;

  // ── Create canvas ─────────────────────────────────────────────────────────

  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');

  // ── Background ────────────────────────────────────────────────────────────

  const themeCatalog = getThemeCatalog();
  const theme = themeCatalog?.[state.dungeon?.metadata?.theme]
    || themeCatalog?.['stone-dungeon']
    || {};

  if (background) {
    (ctx! as any).fillStyle = background;
    (ctx! as any).fillRect(0, 0, width, height);
  } else if (theme.floorColor) {
    (ctx! as any).fillStyle = theme.floorColor;
    (ctx! as any).fillRect(0, 0, width, height);
  }
  // else leave transparent

  // ── Grid lines ────────────────────────────────────────────────────────────

  (ctx! as any).strokeStyle = 'rgba(0, 0, 0, 0.15)';
  (ctx! as any).lineWidth = 1;
  for (let c = 1; c < canvasCols; c++) {
    (ctx! as any).beginPath();
    (ctx! as any).moveTo(c * scale, 0);
    (ctx! as any).lineTo(c * scale, height);
    (ctx! as any).stroke();
  }
  for (let r = 1; r < canvasRows; r++) {
    (ctx! as any).beginPath();
    (ctx! as any).moveTo(0, r * scale);
    (ctx! as any).lineTo(width, r * scale);
    (ctx! as any).stroke();
  }

  // ── Render the prop ───────────────────────────────────────────────────────

  // gridSize=1 means 1 "foot" per normalized unit; transform.scale=scale means
  // each normalized unit maps to `scale` pixels. So nx → nx * 1 * scale = nx * scale px.
  const gridSize = 1;
  const transform = { scale: scale, offsetX: 0, offsetY: 0 };
  const getTextureImage = state.propCatalog?.getTextureImage || (() => null);

  try {
    // @ts-expect-error — strict-mode migration
    renderProp(ctx, propDef, 0, 0, rotation, gridSize, theme, transform, flipped, getTextureImage);
  } catch (e) {
    warnings.push(`Render error: ${(e as any).message}`);
  }

  // ── Convert to data URL ───────────────────────────────────────────────────

  let dataUrl;
  if (canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } else {
    dataUrl = canvas.toDataURL('image/png');
  }

  return {
    success: true,
    dataUrl,
    name: propDef.name || propTypeOrText,
    footprint: propDef.footprint || [1, 1],
    warnings,
  };
}
