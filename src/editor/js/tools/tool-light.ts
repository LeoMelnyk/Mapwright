// Light tool: place, select, and move light sources
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, notify, invalidateLightmap } from '../state.js';
import { requestRender, getTransform, setCursor } from '../canvas-view.js';
import { fromCanvas, toCanvas } from '../utils.js';
import { getLightCatalog } from '../light-catalog.js';
import { showToast } from '../toast.js';

const LIGHT_HIT_RADIUS = 8; // pixels at screen scale for click detection

// ── Helpers ─────────────────────────────────────────────────────────────────

function getLights(): any[] {
  return state.dungeon.metadata.lights || [];
}

function ensureLightsArray(): void {
  if (!state.dungeon.metadata.lights) state.dungeon.metadata.lights = [];
  if (!state.dungeon.metadata.nextLightId) state.dungeon.metadata.nextLightId = 1;
}

function findLightById(id: number): any {
  return getLights().find(l => l.id === id) || null;
}

function hitTestLight(pos: { x: number; y: number }): any {
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

/**
 * Light tool: place, select, move, resize, copy/paste, and delete light sources.
 * Supports point and directional lights with preset catalog integration.
 */
export class LightTool extends Tool {
  declare _dragging: boolean;
  declare _dragLightId: number | null;
  declare _dragStartPos: { x: number; y: number } | null;
  declare _pendingPlace: boolean;
  declare _resizing: boolean;
  declare _resizeStartDist: number;
  declare _resizeStartRadius: number;

  constructor() {
    super('light', 'L', 'crosshair');
    this.dragging = null;    // { lightId, offsetX, offsetY } during drag
    this.dragMoved = false;
    this.hoveredLightId = null; // light under cursor (for cursor changes)
    this.hoverPos = null;       // current cursor position (for placement preview)
  }

  getCursor() {
    return 'crosshair'; // dynamic cursor updates happen in onMouseMove
  }

  onActivate() {
    // Auto-open lighting sidebar panel
    const btn = document.querySelector('.icon-btn[data-panel="lighting"]');
    if (btn && !btn.classList.contains('active')) {
      btn.click();
    }
    this._syncPresetBar();
    this._updateStatusInstruction();
  }

  onDeactivate() {
    this.dragging = null;
    this.dragMoved = false;
    this.hoveredLightId = null;
    this.hoverPos = null;
    state.lightPasteMode = false;
    state.statusInstruction = null;
    const bar = document.getElementById('light-options');
    if (bar) bar.style.display = 'none';
  }

  /** Populate and show the preset select in the suboptions bar. */
  _syncPresetBar() {
    const bar = document.getElementById('light-options');
    const select = document.getElementById('light-preset-select');
    if (!bar || !select) return;

    const catalog = getLightCatalog();
    if (catalog && select.childElementCount === 0) {
      // Populate once — grouped by category
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '— select preset —';
      select.appendChild(empty);

      for (const category of catalog.categoryOrder) {
        const group = document.createElement('optgroup');
        group.label = category;
        for (const id of catalog.byCategory[category]) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = catalog.lights[id].displayName;
          group.appendChild(opt);
        }
        select.appendChild(group);
      }

      select.addEventListener('change', () => {
        const catalog = getLightCatalog();
        const preset = catalog?.lights[select.value];
        if (!preset) return;
        state.lightPreset  = select.value;
        state.lightType    = preset.type || 'point';
        state.lightColor   = preset.color;
        state.lightRadius  = preset.radius;
        state.lightIntensity = preset.intensity;
        state.lightFalloff = preset.falloff;
        state.lightDimRadius = preset.dimRadius ?? 0;
        state.lightZ = preset.z ?? null;
        state.lightAnimation = preset.animation ? { ...preset.animation } : null;
        if (preset.type === 'directional' && preset.spread != null) {
          state.lightSpread = preset.spread;
        }
        this._updateStatusInstruction();
      });
    }

    // Reflect current state
    select.value = state.lightPreset || '';
    bar.style.display = 'flex';
  }

  onMouseDown(row, col, edge, event, pos) {
    // Paste mode: place the clipboard light at cursor position
    if (state.lightPasteMode && state.lightClipboard) {
      this._commitLightPaste(pos, event);
      return;
    }

    // Unified: hit-test first — select+drag if over a light, place otherwise
    const hit = hitTestLight(pos);
    if (hit) {
      this._startSelectOrDrag(pos, event);
    } else {
      this._placeLight(pos, event);
    }
  }

  onMouseMove(row, col, edge, event, pos) {
    this.hoverPos = pos;

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
        invalidateLightmap(false); // light-only change — skip prop zone recomputation
        markDirty();
        requestRender();
      }
      return;
    }

    // Update hover state and cursor — only request render on actual state transitions
    const hit = hitTestLight(pos);
    if (hit) {
      if (this.hoveredLightId !== hit.id) {
        this.hoveredLightId = hit.id;
        setCursor('grab');
        requestRender();
      }
    } else {
      if (this.hoveredLightId !== null) {
        this.hoveredLightId = null;
        setCursor('crosshair');
        requestRender();
      }
    }
  }

  onMouseUp() {
    if (this.dragging) {
      if (this.dragMoved) {
        // Commit: push undo with the original position, then notify
        pushUndo('Move light', this.dragging.undoSnapshot);
        notify();
      }
      this.dragging = null;
      this.dragMoved = false;
      setCursor(this.hoveredLightId ? 'grab' : 'crosshair');
    }
  }

  onCancel() {
    if (this.dragging) {
      // Restore original position — no undo entry created
      const light = findLightById(this.dragging.lightId);
      if (light && this.dragMoved) {
        light.x = this.dragging.origX;
        light.y = this.dragging.origY;
        if (this.dragging.origRadius != null) light.radius = this.dragging.origRadius;
        invalidateLightmap(false);
        markDirty();
        requestRender();
      }
      this.dragging = null;
      this.dragMoved = false;
      setCursor(this.hoveredLightId ? 'grab' : 'crosshair');
      return true;
    }
    return false;
  }

  onRightClick(row, col, edge, event) {
    // Right-click during drag cancels the move
    if (this.dragging) {
      this.onCancel();
      return;
    }

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
    }
    if (this.hoveredLightId === light.id) {
      this.hoveredLightId = null;
      setCursor('crosshair');
    }

    this._updateStatusInstruction();
    invalidateLightmap(false);
    markDirty();
    notify();
    requestRender();
  }

  onKeyDown(e) {
    // Delete selected light
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedLightId != null) {
        this._deleteSelectedLight();
      }
      return;
    }

    // Escape: cancel drag or paste mode
    if (e.key === 'Escape' && this.dragging) {
      this.onCancel();
      return;
    }
    if (e.key === 'Escape' && state.lightPasteMode) {
      state.lightPasteMode = false;
      requestRender();
      return;
    }

    // Ctrl+C: copy selected light
    if (e.ctrlKey && e.key === 'c' && state.selectedLightId != null) {
      e.preventDefault();
      const light = findLightById(state.selectedLightId);
      if (light) {
        state.lightClipboard = JSON.parse(JSON.stringify(light));
        showToast('Copied light');
      }
      return;
    }

    // Ctrl+X: cut selected light (copy + delete)
    if (e.ctrlKey && e.key === 'x' && state.selectedLightId != null) {
      e.preventDefault();
      const light = findLightById(state.selectedLightId);
      if (light) {
        state.lightClipboard = JSON.parse(JSON.stringify(light));
        this._deleteSelectedLight();
        showToast('Cut light');
      }
      return;
    }

    // Ctrl+V: enter light paste mode
    if (e.ctrlKey && e.key === 'v' && state.lightClipboard) {
      e.preventDefault();
      state.lightPasteMode = true;
      requestRender();
      return;
    }
  }

  renderOverlay(ctx, transform) {
    const lights = getLights();
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    for (const light of lights) {
      const px = light.x * transform.scale + transform.offsetX;
      const py = light.y * transform.scale + transform.offsetY;

      // Cull off-screen lights (with generous margin for glow/radius preview)
      const margin = 50;
      if (px < -margin || px > w + margin || py < -margin || py > h + margin) continue;

      const isSelected = light.id === state.selectedLightId;
      const isHovered = light.id === this.hoveredLightId;

      // Draw light icon
      this._drawLightIcon(ctx, px, py, light, isSelected, isHovered);

      // Draw radius/cone preview for selected light
      if (isSelected) {
        this._drawLightPreview(ctx, px, py, light, transform);
      }
    }

    // Draw paste preview when in light paste mode
    if (state.lightPasteMode && state.lightClipboard && this.hoverPos) {
      this._drawPastePreview(ctx, this.hoverPos, transform);
    }
    // Draw placement preview when hovering empty space (no hit, no drag)
    else if (this.hoverPos && !this.dragging && !this.hoveredLightId) {
      this._drawPlacementPreview(ctx, this.hoverPos, transform);
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  _updateStatusInstruction() {
    const typeName = state.lightType === 'directional' ? 'Directional' : 'Point';
    state.statusInstruction = `Click to place ${typeName} light · Shift+click to snap to grid · Hover existing to move · Right-click to delete`;
  }

  // ── Delete / Paste Helpers ───────────────────────────────────────────────

  _deleteSelectedLight() {
    const light = findLightById(state.selectedLightId);
    if (!light) return;
    pushUndo('Delete light');
    const lights = getLights();
    const idx = lights.indexOf(light);
    if (idx >= 0) lights.splice(idx, 1);
    if (this.hoveredLightId === light.id) {
      this.hoveredLightId = null;
      setCursor('crosshair');
    }
    state.selectedLightId = null;
    this._updateStatusInstruction();
    invalidateLightmap(false);
    markDirty();
    notify();
    requestRender();
  }

  _commitLightPaste(pos, event) {
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize || 5;
    let world = fromCanvas(pos.x, pos.y, transform);

    // Shift+click: snap to grid
    if (event?.shiftKey) {
      world = {
        x: Math.round(world.x / gridSize) * gridSize,
        y: Math.round(world.y / gridSize) * gridSize,
      };
    }

    pushUndo('Paste light');
    ensureLightsArray();

    const src = state.lightClipboard;
    const light = JSON.parse(JSON.stringify(src));
    light.id = state.dungeon.metadata.nextLightId++;
    light.x = world.x;
    light.y = world.y;

    state.dungeon.metadata.lights.push(light);
    state.selectedLightId = light.id;
    state.lightPasteMode = false;

    invalidateLightmap(false);
    markDirty();
    notify();
    requestRender();
    showToast('Pasted light');
  }

  // ── Place ────────────────────────────────────────────────────────────────

  _placeLight(pos, event) {
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize || 5;
    let world = fromCanvas(pos.x, pos.y, transform);

    // Shift+click: snap position to grid intersection
    if (event?.shiftKey) {
      world = {
        x: Math.round(world.x / gridSize) * gridSize,
        y: Math.round(world.y / gridSize) * gridSize,
      };
    }

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

    // Dim radius
    if (state.lightDimRadius > 0) light.dimRadius = state.lightDimRadius;

    // Z-height (height above floor in feet)
    if (state.lightZ != null) light.z = state.lightZ;

    // Track which preset this light was created from (enables Resync Preset Lights)
    if (state.lightPreset) light.presetId = state.lightPreset;

    // Animation
    if (state.lightAnimation?.type) light.animation = { ...state.lightAnimation };

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

    invalidateLightmap(false);
    markDirty();
    notify();
    requestRender();
  }

  // ── Select + Drag ────────────────────────────────────────────────────────

  _startSelectOrDrag(pos) {
    const light = hitTestLight(pos);

    if (light) {
      state.selectedLightId = light.id;
      state.statusInstruction = 'Drag to move · Ctrl+drag to resize radius · Right-click to delete';

      // Start drag — save original position for cancel/restore.
      // Snapshot state now so we can push undo on commit (mouse-up).
      const transform = getTransform();
      const screenPos = toCanvas(light.x, light.y, transform);
      this.dragging = {
        lightId: light.id,
        offsetX: pos.x - screenPos.x,
        offsetY: pos.y - screenPos.y,
        origX: light.x,
        origY: light.y,
        origRadius: light.radius,
        undoSnapshot: JSON.stringify(state.dungeon),
      };
      this.dragMoved = false;
      setCursor('grabbing');
    } else {
      state.selectedLightId = null;
      this._updateStatusInstruction();
    }

    notify();
    requestRender();
  }

  // ── Rendering Helpers ────────────────────────────────────────────────────

  _drawLightIcon(ctx, px, py, light, isSelected, isHovered) {
    const size = isSelected ? 10 : isHovered ? 9 : 7;

    ctx.save();
    const color = light.color || '#ff9944';

    // Outer glow — use a larger translucent circle instead of expensive shadowBlur
    const glowSize = isSelected ? 18 : isHovered ? 15 : 11;
    ctx.beginPath();
    ctx.arc(px, py, glowSize, 0, Math.PI * 2);
    ctx.fillStyle = color + (isSelected ? '40' : isHovered ? '30' : '20');
    ctx.fill();

    // Icon circle
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Border
    ctx.strokeStyle = isSelected ? '#ffffff' : isHovered ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = isSelected ? 2.5 : isHovered ? 2 : 1.5;
    ctx.stroke();

    // Inner type indicator
    ctx.fillStyle = '#fff';
    ctx.font = size >= 10 ? 'bold 10px sans-serif' : size >= 9 ? 'bold 9px sans-serif' : 'bold 7px sans-serif';
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
      // Point light — draw bright radius circle
      const rPx = (light.radius || 30) * transform.scale;
      ctx.beginPath();
      ctx.arc(px, py, rPx, 0, Math.PI * 2);
      ctx.stroke();

      // Dim radius circle (if set and larger than bright radius)
      if (light.dimRadius && light.dimRadius > (light.radius || 0)) {
        const dimRPx = light.dimRadius * transform.scale;
        ctx.strokeStyle = 'rgba(255, 200, 50, 0.35)';
        ctx.beginPath();
        ctx.arc(px, py, dimRPx, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _drawPlacementPreview(ctx, pos, transform) {
    const color = state.lightColor || '#ff9944';
    const { x, y } = pos;

    ctx.save();
    ctx.setLineDash([4, 4]);

    if (state.lightType === 'directional') {
      const range = (state.lightRadius || 30) * transform.scale;
      const angleRad = (state.lightAngle || 0) * Math.PI / 180;
      const spreadRad = (state.lightSpread || 45) * Math.PI / 180;

      ctx.strokeStyle = color + '80';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, range, angleRad - spreadRad, angleRad + spreadRad);
      ctx.closePath();
      ctx.stroke();
    } else {
      const rPx = (state.lightRadius || 30) * transform.scale;
      ctx.strokeStyle = color + '80';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, rPx, 0, Math.PI * 2);
      ctx.stroke();

      // Dim radius preview circle
      if (state.lightDimRadius > 0 && state.lightDimRadius > state.lightRadius) {
        const dimRPx = state.lightDimRadius * transform.scale;
        ctx.strokeStyle = 'rgba(255, 200, 50, 0.35)';
        ctx.beginPath();
        ctx.arc(x, y, dimRPx, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Center dot
    ctx.setLineDash([]);
    ctx.fillStyle = color + 'c0';
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawPastePreview(ctx, pos, transform) {
    const light = state.lightClipboard;
    const color = light.color || '#ff9944';
    const { x, y } = pos;

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);

    if (light.type === 'directional') {
      const range = (light.range || light.radius || 30) * transform.scale;
      const angleRad = (light.angle || 0) * Math.PI / 180;
      const spreadRad = (light.spread || 45) * Math.PI / 180;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, range, angleRad - spreadRad, angleRad + spreadRad);
      ctx.closePath();
      ctx.stroke();
    } else {
      const rPx = (light.radius || 30) * transform.scale;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, rPx, 0, Math.PI * 2);
      ctx.stroke();

      if (light.dimRadius && light.dimRadius > (light.radius || 0)) {
        const dimRPx = light.dimRadius * transform.scale;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(x, y, dimRPx, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Center dot
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}
