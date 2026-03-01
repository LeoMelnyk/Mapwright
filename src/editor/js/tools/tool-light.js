// Light tool: place, select, and move light sources
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, notify, invalidateLightmap } from '../state.js';
import { requestRender, getTransform } from '../canvas-view.js';
import { fromCanvas, toCanvas } from '../utils.js';

const LIGHT_HIT_RADIUS = 8; // pixels at screen scale for click detection

// ── Helpers ─────────────────────────────────────────────────────────────────

function getLights() {
  return state.dungeon.metadata.lights || [];
}

function ensureLightsArray() {
  if (!state.dungeon.metadata.lights) state.dungeon.metadata.lights = [];
  if (!state.dungeon.metadata.nextLightId) state.dungeon.metadata.nextLightId = 1;
}

function findLightById(id) {
  return getLights().find(l => l.id === id) || null;
}

function hitTestLight(pos) {
  const transform = getTransform();
  const lights = getLights();
  let closest = null;
  let closestDist = LIGHT_HIT_RADIUS;

  for (const light of lights) {
    const screenPos = toCanvas(light.x, light.y, transform);
    const dx = pos.x - screenPos.x;
    const dy = pos.y - screenPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < closestDist) {
      closestDist = dist;
      closest = light;
    }
  }

  return closest;
}

// ── Tool ────────────────────────────────────────────────────────────────────

export class LightTool extends Tool {
  constructor() {
    super('light', 'L', 'crosshair');
    this.dragging = null; // { lightId, offsetX, offsetY } during drag
    this.dragMoved = false;
  }

  getCursor() {
    return state.lightMode === 'select' ? 'default' : 'crosshair';
  }

  onActivate() {
    // Auto-open lighting sidebar panel
    const btn = document.querySelector('.icon-btn[data-panel="lighting"]');
    if (btn && !btn.classList.contains('active')) {
      btn.click();
    }
    state.statusInstruction = 'Right-click to delete light';
  }

  onDeactivate() {
    this.dragging = null;
    this.dragMoved = false;
    state.statusInstruction = null;
  }

  onMouseDown(row, col, edge, event, pos) {
    if (state.lightMode === 'place') {
      this._placeLight(pos);
    } else {
      this._startSelectOrDrag(pos, event);
    }
  }

  onMouseMove(row, col, edge, event, pos) {
    if (this.dragging) {
      this.dragMoved = true;
      const transform = getTransform();
      const light = findLightById(this.dragging.lightId);
      if (light) {
        if (event?.ctrlKey && light.type !== 'directional') {
          // Ctrl+drag: resize radius — measure distance from light center to cursor
          const world = fromCanvas(pos.x, pos.y, transform);
          const dx = world.x - light.x;
          const dy = world.y - light.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const gridSize = state.dungeon.metadata.gridSize || 5;
          light.radius = Math.max(gridSize, Math.round(dist / gridSize) * gridSize);
        } else {
          // Normal drag: move light position
          const world = fromCanvas(pos.x - this.dragging.offsetX, pos.y - this.dragging.offsetY, transform);
          light.x = world.x;
          light.y = world.y;
        }
        invalidateLightmap();
        markDirty();
        requestRender();
      }
    }
  }

  onMouseUp(row, col, edge, event, pos) {
    if (this.dragging) {
      if (this.dragMoved) {
        // Finalize move — undo was already pushed on drag start
        notify();
      }
      this.dragging = null;
      this.dragMoved = false;
    }
  }

  onCancel() {
    if (this.dragging) {
      this.dragging = null;
      this.dragMoved = false;
      return true;
    }
    return false;
  }

  onRightClick(row, col, edge, event) {
    // Delete light under cursor
    const pos = { x: event.offsetX ?? event.layerX, y: event.offsetY ?? event.layerY };
    const light = hitTestLight(pos);
    if (!light) return;

    pushUndo('Delete light');
    const lights = getLights();
    const idx = lights.indexOf(light);
    if (idx >= 0) lights.splice(idx, 1);

    if (state.selectedLightId === light.id) {
      state.selectedLightId = null;
      state.statusInstruction = null;
    }

    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
  }

  onKeyDown(e) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedLightId != null) {
        const light = findLightById(state.selectedLightId);
        if (light) {
          pushUndo('Delete light');
          const lights = getLights();
          const idx = lights.indexOf(light);
          if (idx >= 0) lights.splice(idx, 1);
          state.selectedLightId = null;
          state.statusInstruction = null;
          invalidateLightmap();
          markDirty();
          notify();
          requestRender();
        }
      }
    }
  }

  renderOverlay(ctx, transform, gridSize) {
    const lights = getLights();
    if (lights.length === 0 && state.lightMode !== 'place') return;

    for (const light of lights) {
      const px = light.x * transform.scale + transform.offsetX;
      const py = light.y * transform.scale + transform.offsetY;
      const isSelected = light.id === state.selectedLightId;

      // Draw light icon
      this._drawLightIcon(ctx, px, py, light, isSelected);

      // Draw radius/cone preview for selected light
      if (isSelected) {
        this._drawLightPreview(ctx, px, py, light, transform);
      }
    }
  }

  // ── Place Mode ──────────────────────────────────────────────────────────

  _placeLight(pos) {
    const transform = getTransform();
    const world = fromCanvas(pos.x, pos.y, transform);

    pushUndo('Add light');
    ensureLightsArray();

    const light = {
      id: state.dungeon.metadata.nextLightId++,
      x: world.x,
      y: world.y,
      type: state.lightType,
      radius: state.lightRadius,
      color: state.lightColor,
      intensity: state.lightIntensity,
      falloff: state.lightFalloff,
    };

    // Add directional-specific properties
    if (state.lightType === 'directional') {
      light.angle = state.lightAngle;
      light.spread = state.lightSpread;
      light.range = state.lightRadius; // use radius as range
      delete light.radius;
    }

    state.dungeon.metadata.lights.push(light);
    state.selectedLightId = light.id;

    // Start dragging the newly placed light so user can reposition while holding
    this.dragging = { lightId: light.id, offsetX: 0, offsetY: 0 };
    this.dragMoved = false;

    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
  }

  // ── Select Mode ─────────────────────────────────────────────────────────

  _startSelectOrDrag(pos, event) {
    const light = hitTestLight(pos);

    if (light) {
      state.selectedLightId = light.id;
      state.statusInstruction = 'Drag to move · Ctrl+drag to resize radius';

      // Start drag
      const transform = getTransform();
      const screenPos = toCanvas(light.x, light.y, transform);
      pushUndo('Move light');
      this.dragging = {
        lightId: light.id,
        offsetX: pos.x - screenPos.x,
        offsetY: pos.y - screenPos.y,
      };
      this.dragMoved = false;
    } else {
      state.selectedLightId = null;
      state.statusInstruction = null;
    }

    notify();
    requestRender();
  }

  // ── Rendering Helpers ───────────────────────────────────────────────────

  _drawLightIcon(ctx, px, py, light, isSelected) {
    const size = isSelected ? 10 : 7;

    ctx.save();

    // Outer glow
    ctx.shadowColor = light.color || '#ff9944';
    ctx.shadowBlur = isSelected ? 12 : 6;

    // Icon circle
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fillStyle = light.color || '#ff9944';
    ctx.fill();

    ctx.shadowBlur = 0;

    // Border
    ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.stroke();

    // Inner type indicator
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(light.type === 'directional' ? 'D' : 'P', px, py);

    ctx.restore();
  }

  _drawLightPreview(ctx, px, py, light, transform) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.6)';

    if (light.type === 'directional') {
      const range = (light.range || light.radius || 30) * transform.scale;
      const angleRad = (light.angle || 0) * Math.PI / 180;
      const spreadRad = (light.spread || 45) * Math.PI / 180;

      // Draw cone
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, range, angleRad - spreadRad, angleRad + spreadRad);
      ctx.closePath();
      ctx.stroke();

      // Draw direction indicator
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255, 200, 50, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(angleRad) * range * 0.3, py + Math.sin(angleRad) * range * 0.3);
      ctx.stroke();
    } else {
      // Point light — draw radius circle
      const rPx = (light.radius || 30) * transform.scale;
      ctx.beginPath();
      ctx.arc(px, py, rPx, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}
