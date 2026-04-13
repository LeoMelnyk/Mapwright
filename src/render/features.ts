import { GRID_SCALE } from './constants.js';
import type { Theme } from '../types.js';

/**
 * Draw a cell label (room number/name or plain text).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} cx - Center X in canvas pixels
 * @param {number} cy - Center Y in canvas pixels
 * @param {string} label - Label text to draw
 * @param {Theme} theme - Theme object with label color config
 * @param {string} labelStyle - 'circled' (default), 'plain', or 'bold'
 * @param {number} scale - transform.scale (pixels per foot); sizes are relative to GRID_SCALE
 * @returns {void}
 */
function drawCellLabel(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  label: string,
  theme: Theme,
  labelStyle: string = 'circled',
  scale: number = GRID_SCALE,
): void {
  const isRoomLabel = /^[A-Z]\d+$/.test(label);
  const s = scale / GRID_SCALE;

  // Theme-controlled label colors (default: black border, black font, white background)
  const labelColors = ((theme as Record<string, unknown>).labels ?? {}) as Record<string, string>;
  const borderColor: string = labelColors.borderColor ?? '#000000';
  const fontColor: string = labelColors.fontColor ?? '#000000';
  const bgColor: string = labelColors.backgroundColor ?? '#FFFFFF';

  if (isRoomLabel && labelStyle === 'circled') {
    // Circled style: background circle with border, bold text inside
    const radius = 30 * s;
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3 * s;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    ctx.font = `bold ${28 * s}px Arial`;
    ctx.fillStyle = fontColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
  } else if (isRoomLabel && labelStyle === 'bold') {
    // Bold style: bold text with background rectangle
    ctx.font = `bold ${28 * s}px Arial`;
    const metrics = ctx.measureText(label);
    const padX = 10 * s;
    const padY = 6 * s;
    const textWidth = metrics.width;
    const textHeight = 28 * s;
    const rectX = cx - textWidth / 2 - padX;
    const rectY = cy - textHeight / 2 - padY;
    const rectW = textWidth + padX * 2;
    const rectH = textHeight + padY * 2;
    const cornerRadius = 6 * s;

    // Background
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.moveTo(rectX + cornerRadius, rectY);
    ctx.lineTo(rectX + rectW - cornerRadius, rectY);
    ctx.quadraticCurveTo(rectX + rectW, rectY, rectX + rectW, rectY + cornerRadius);
    ctx.lineTo(rectX + rectW, rectY + rectH - cornerRadius);
    ctx.quadraticCurveTo(rectX + rectW, rectY + rectH, rectX + rectW - cornerRadius, rectY + rectH);
    ctx.lineTo(rectX + cornerRadius, rectY + rectH);
    ctx.quadraticCurveTo(rectX, rectY + rectH, rectX, rectY + rectH - cornerRadius);
    ctx.lineTo(rectX, rectY + cornerRadius);
    ctx.quadraticCurveTo(rectX, rectY, rectX + cornerRadius, rectY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Bold text
    ctx.fillStyle = fontColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
  } else if (isRoomLabel && labelStyle === 'plain') {
    // Plain style: just text with subtle shadow for readability
    ctx.font = `bold ${28 * s}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Subtle text shadow/outline for readability against floor
    ctx.save();
    ctx.shadowColor = bgColor;
    ctx.shadowBlur = 6 * s;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = fontColor;
    ctx.fillText(label, cx, cy);
    ctx.restore();
  } else {
    // Non-room labels always render as plain text (also doubled)
    ctx.font = `bold ${24 * s}px Arial`;
    ctx.fillStyle = fontColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
  }
}

/**
 * Draw a DM-only label with a parchment scroll backdrop.
 * Auto-sizes to text width.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} cx - Center X in canvas pixels
 * @param {number} cy - Center Y in canvas pixels
 * @param {string} text - DM label text
 * @param {number} scale - transform.scale (pixels per foot); sizes are relative to GRID_SCALE
 * @returns {void}
 */
function drawDmLabel(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  text: string,
  scale: number = GRID_SCALE,
): void {
  const s = scale / GRID_SCALE;
  ctx.save();
  ctx.font = `italic ${12 * s}px "Palatino Linotype", "Book Antiqua", Palatino, serif`;
  const metrics = ctx.measureText(text);
  const padX = 12 * s,
    padY = 6 * s;
  const w = Math.max(metrics.width + padX * 2, 40 * s);
  const h = 20 * s + padY * 2;
  const x = cx - w / 2,
    y = cy - h / 2;
  const curl = 4 * s;
  const bulge = 2 * s;

  // Parchment body with curved scroll edges
  ctx.fillStyle = '#F5E6C8';
  ctx.strokeStyle = '#8B7355';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(x + curl, y);
  ctx.lineTo(x + w - curl, y); // top edge
  ctx.quadraticCurveTo(x + w + bulge, y + h * 0.3, x + w, y + h / 2); // right curl top
  ctx.quadraticCurveTo(x + w + bulge, y + h * 0.7, x + w - curl, y + h); // right curl bottom
  ctx.lineTo(x + curl, y + h); // bottom edge
  ctx.quadraticCurveTo(x - bulge, y + h * 0.7, x, y + h / 2); // left curl bottom
  ctx.quadraticCurveTo(x - bulge, y + h * 0.3, x + curl, y); // left curl top
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.fillStyle = '#3C2415';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

export { drawCellLabel, drawDmLabel };
