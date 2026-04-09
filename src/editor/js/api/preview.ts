// Prop Preview API — renders a single prop to a data URL for agent self-correction.

import type { PropDefinition, RenderPropPreviewOptions, Theme } from '../../../types.js';
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
export async function renderPropPreview(propTypeOrText: string, options: RenderPropPreviewOptions = {}): Promise<Record<string, unknown>> {
  const {
    rotation = 0,
    flipped = false,
    scale = 128,
    background = null,
  } = options;

  const warnings = [];

  // ── Resolve prop definition ───────────────────────────────────────────────

  let propDef: PropDefinition | undefined;

  if (typeof propTypeOrText === 'string' && propTypeOrText.includes('---')) {
    // Raw .prop file text
    try {
      propDef = parsePropFile(propTypeOrText);
    } catch (e) {
      return { success: false, dataUrl: null, name: null, footprint: null, warnings: [(e as Error).message] };
    }
  } else {
    // Catalog lookup
    const catalog = state.propCatalog;
    if (!catalog) {
      return { success: false, dataUrl: null, name: propTypeOrText, footprint: null, warnings: ['Prop catalog not loaded'] };
    }

    propDef = catalog.props[propTypeOrText];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    if (!propDef) {
      // Try case-insensitive search
      const key = Object.keys(catalog.props).find(
        k => k.toLowerCase() === propTypeOrText.toLowerCase()
      );
      if (key) propDef = catalog.props[key];
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    if (!propDef) {
      return { success: false, dataUrl: null, name: propTypeOrText, footprint: null, warnings: [`Prop type "${propTypeOrText}" not found in catalog`] };
    }
  }

  // ── Determine canvas size ─────────────────────────────────────────────────

  const [rows, cols] = propDef.footprint;
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

  const themeCatalog = getThemeCatalog() as Record<string, Record<string, unknown>> | null;
  const themeKey = typeof state.dungeon.metadata.theme === 'string' ? state.dungeon.metadata.theme : 'stone-dungeon';
  const theme = (themeCatalog?.[themeKey]
    ?? themeCatalog?.['stone-dungeon'])
    ?? {};

  const drawCtx = ctx as OffscreenCanvasRenderingContext2D;
  if (background) {
    drawCtx.fillStyle = background;
    drawCtx.fillRect(0, 0, width, height);
  } else if (theme.floorColor) {
    drawCtx.fillStyle = theme.floorColor as string;
    drawCtx.fillRect(0, 0, width, height);
  }
  // else leave transparent

  // ── Grid lines ────────────────────────────────────────────────────────────

  drawCtx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  drawCtx.lineWidth = 1;
  for (let c = 1; c < canvasCols; c++) {
    drawCtx.beginPath();
    drawCtx.moveTo(c * scale, 0);
    drawCtx.lineTo(c * scale, height);
    drawCtx.stroke();
  }
  for (let r = 1; r < canvasRows; r++) {
    drawCtx.beginPath();
    drawCtx.moveTo(0, r * scale);
    drawCtx.lineTo(width, r * scale);
    drawCtx.stroke();
  }

  // ── Render the prop ───────────────────────────────────────────────────────

  // gridSize=1 means 1 "foot" per normalized unit; transform.scale=scale means
  // each normalized unit maps to `scale` pixels. So nx → nx * 1 * scale = nx * scale px.
  const gridSize = 1;
  const transform = { scale: scale, offsetX: 0, offsetY: 0 };
  const getTextureImage = state.textureCatalog?.getTextureImage ?? (() => null);

  try {
    renderProp(drawCtx, propDef, 0, 0, rotation, gridSize, theme as Theme, transform, flipped, getTextureImage);
  } catch (e) {
    warnings.push(`Render error: ${(e as Error).message}`);
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
    footprint: propDef.footprint,
    warnings,
  };
}
