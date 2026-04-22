// Light tool: place, select, and move light sources
import type { Light, RenderTransform } from '../../../types.js';
import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { mutate, markDirty, invalidateLightmap, notify, undo } from '../state.js';
import { requestRender, getTransform, setCursor } from '../canvas-view.js';
import { fromCanvas, toCanvas } from '../utils.js';
import { getLightCatalog } from '../light-catalog.js';
import { openLightEditDialog } from '../panels/light-edit.js';
import { showToast } from '../toast.js';

const LIGHT_HIT_RADIUS = 14; // pixels at screen scale for click detection — sized to the bulb icon

// ── Helpers ─────────────────────────────────────────────────────────────────

function getLights(): Light[] {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return state.dungeon.metadata.lights || [];
}

function ensureLightsArray(): void {
  if (!state.dungeon.metadata.nextLightId) state.dungeon.metadata.nextLightId = 1;
}

function findLightById(id: number): Light | null {
  return getLights().find((l) => l.id === id) ?? null;
}

function hitTestLight(pos: { x: number; y: number }): Light | null {
  const transform = getTransform();
  const lights = getLights();
  let closest: Light | null = null;
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
  dragging: {
    lightId: number;
    offsetX: number;
    offsetY: number;
    origX?: number;
    origY?: number;
    origRadius?: number;
    metaSnapshot?: string;
    isNewPlacement?: boolean;
  } | null = null;
  dragMoved: boolean = false;
  hoveredLightId: number | null = null;
  hoverPos: CanvasPos | null = null;

  constructor() {
    super('light', 'L', 'crosshair');
    this.dragging = null; // { lightId, offsetX, offsetY } during drag
    this.dragMoved = false;
    this.hoveredLightId = null; // light under cursor (for cursor changes)
    this.hoverPos = null; // current cursor position (for placement preview)
  }

  getCursor() {
    return 'crosshair'; // dynamic cursor updates happen in onMouseMove
  }

  onActivate() {
    // Auto-open lighting sidebar panel
    const btn = document.querySelector('.icon-btn[data-panel="lighting"]');
    if (btn && !btn.classList.contains('active')) {
      (btn as HTMLElement).click();
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
    const bar = document.getElementById('light-options')!;
    bar.style.display = 'none';
  }

  /** Populate and show the preset select in the suboptions bar. */
  _syncPresetBar() {
    const bar = document.getElementById('light-options')!;
    const select = document.getElementById('light-preset-select')!;

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
        for (const id of catalog.byCategory[category] ?? []) {
          const preset = catalog.lights[id];
          if (!preset) continue;
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = preset.displayName;
          group.appendChild(opt);
        }
        select.appendChild(group);
      }

      select.addEventListener('change', () => {
        const selected = (select as HTMLInputElement).value;
        if (!selected) {
          this._clearPreset();
          return;
        }
        const lightCatalog = getLightCatalog();
        if (!lightCatalog) return;
        const preset = lightCatalog.lights[selected];
        if (!preset) return;
        state.lightPreset = selected;
        state.lightType = preset.type;
        state.lightColor = preset.color;
        state.lightRadius = preset.radius;
        state.lightIntensity = preset.intensity;
        state.lightFalloff = preset.falloff;
        state.lightDimRadius = preset.dimRadius ?? 0;
        state.lightZ = (preset as Record<string, unknown>).z as number;
        state.lightAnimation = preset.animation ? { ...preset.animation } : null;
        if (preset.type === 'directional' && preset.spread != null) {
          state.lightSpread = preset.spread;
        }
        this._updateStatusInstruction();
      });
    }

    // Reflect current state
    (select as HTMLInputElement).value = state.lightPreset ?? '';
    bar.style.display = 'flex';
  }

  onMouseDown(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    // Paste mode: place the clipboard light at cursor position
    if (state.lightPasteMode && state.lightClipboard) {
      this._commitLightPaste(pos, event);
      return;
    }

    // Unified: hit-test first — select+drag if over a light, place otherwise
    const hit = hitTestLight(pos!);
    if (hit) {
      // Double-click on a light opens the edit dialog (no drag).
      if (event.detail === 2) {
        state.selectedLightId = hit.id;
        notify();
        openLightEditDialog(hit.id);
        return;
      }
      this._startSelectOrDrag(pos);
    } else if (state.lightPreset) {
      this._placeLight(pos, event);
    } else if (state.selectedLightId != null) {
      // No preset selected: clicking empty space deselects the current light
      state.selectedLightId = null;
      this._updateStatusInstruction();
      notify();
      requestRender();
    }
  }

  onMouseMove(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    this.hoverPos = pos;

    if (this.dragging) {
      this.dragMoved = true;
      const transform = getTransform();
      const light = findLightById(this.dragging.lightId);
      if (light) {
        if (event.ctrlKey && light.type !== 'directional') {
          // Ctrl+drag: resize radius — measure distance from light center to cursor
          const world = fromCanvas(pos!.x, pos!.y, transform);
          const dx = world.x - light.x;
          const dy = world.y - light.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const gridSize = state.dungeon.metadata.gridSize || 5;
          light.radius = Math.max(gridSize, Math.round(dist / gridSize) * gridSize);
        } else {
          // Normal drag: move light position
          const world = fromCanvas(pos!.x - this.dragging.offsetX, pos!.y - this.dragging.offsetY, transform);
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
    const idleCursor = state.lightPreset ? 'crosshair' : 'default';
    const hit = pos ? hitTestLight(pos) : null;
    if (hit) {
      if (this.hoveredLightId !== hit.id) {
        this.hoveredLightId = hit.id;
        setCursor('grab');
        requestRender();
      }
    } else {
      if (this.hoveredLightId !== null) {
        this.hoveredLightId = null;
        setCursor(idleCursor);
        requestRender();
      }
    }
  }

  onMouseUp() {
    if (this.dragging) {
      // New placements: the "Add light" mutation already captured the placement;
      // any drag-while-holding is part of the same gesture, so don't layer a
      // separate "Move light" undo entry on top.
      if (this.dragMoved && !this.dragging.isNewPlacement) {
        // Light is already at the new position from onMouseMove.
        // Temporarily restore pre-drag metadata so mutate captures the correct "before" state,
        // then re-apply the current (moved) state inside fn().
        const currentMeta = JSON.stringify(state.dungeon.metadata);
        const preDragMeta = this.dragging.metaSnapshot!;
        Object.assign(state.dungeon.metadata, JSON.parse(preDragMeta));
        mutate(
          'Move light',
          [],
          () => {
            Object.assign(state.dungeon.metadata, JSON.parse(currentMeta));
          },
          { metaOnly: true, invalidate: ['lighting'] },
        );
      }
      this.dragging = null;
      this.dragMoved = false;
      setCursor(this.hoveredLightId ? 'grab' : state.lightPreset ? 'crosshair' : 'default');
    }
  }

  onCancel() {
    if (this.dragging) {
      const dragging = this.dragging;
      const light = findLightById(dragging.lightId);
      if (dragging.isNewPlacement) {
        // The click that placed this light is what's being cancelled — undo
        // the "Add light" mutation entirely so we don't leave a half-placed
        // light with stale coordinates on the map.
        undo();
        if (state.selectedLightId === dragging.lightId) state.selectedLightId = null;
        if (this.hoveredLightId === dragging.lightId) this.hoveredLightId = null;
        invalidateLightmap(false);
        notify();
        requestRender();
      } else if (light && this.dragMoved) {
        // Existing light: restore original position — no undo entry created
        light.x = dragging.origX!;
        light.y = dragging.origY!;
        if (dragging.origRadius != null) light.radius = dragging.origRadius;
        invalidateLightmap(false);
        markDirty();
        requestRender();
      }
      this.dragging = null;
      this.dragMoved = false;
      setCursor(this.hoveredLightId ? 'grab' : state.lightPreset ? 'crosshair' : 'default');
      return true;
    }
    return false;
  }

  onRightClick(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent) {
    // Right-click during drag cancels the move
    if (this.dragging) {
      this.onCancel();
      return;
    }

    // Delete light under cursor
    const pos = { x: event.offsetX, y: event.offsetY };
    const light = hitTestLight(pos);
    if (!light) return;

    const lightToDelete = light;
    mutate(
      'Delete light',
      [],
      () => {
        const lights = getLights();
        const idx = lights.indexOf(lightToDelete);
        if (idx >= 0) lights.splice(idx, 1);
      },
      { metaOnly: true, invalidate: ['lighting'] },
    );

    if (state.selectedLightId === lightToDelete.id) {
      state.selectedLightId = null;
    }
    if (this.hoveredLightId === lightToDelete.id) {
      this.hoveredLightId = null;
      setCursor(state.lightPreset ? 'crosshair' : 'default');
    }

    this._updateStatusInstruction();
    requestRender();
  }

  onKeyDown(e: KeyboardEvent) {
    // Enter on a selected light opens the edit dialog.
    if (e.key === 'Enter' && state.selectedLightId != null) {
      const target = e.target as HTMLElement | null;
      // Don't hijack Enter while the user is typing in an input/textarea.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      openLightEditDialog(state.selectedLightId);
      return;
    }

    // Delete selected light
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedLightId != null) {
        this._deleteSelectedLight();
      }
      return;
    }

    // Escape: cascade — cancel drag → exit paste mode → deselect light → clear preset
    if (e.key === 'Escape') {
      if (this.dragging) {
        this.onCancel();
        return;
      }
      if (state.lightPasteMode) {
        state.lightPasteMode = false;
        requestRender();
        return;
      }
      if (state.selectedLightId != null) {
        state.selectedLightId = null;
        this._updateStatusInstruction();
        notify();
        requestRender();
        return;
      }
      if (state.lightPreset) {
        this._clearPreset();
        return;
      }
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

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform) {
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
    // Draw placement preview when hovering empty space (no hit, no drag) — only with a preset
    else if (this.hoverPos && !this.dragging && !this.hoveredLightId && state.lightPreset) {
      this._drawPlacementPreview(ctx, this.hoverPos, transform);
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  _updateStatusInstruction() {
    if (!state.lightPreset) {
      state.statusInstruction = 'Select a preset to place lights · Click existing to select · Right-click to delete';
      return;
    }
    const typeName = state.lightType === 'directional' ? 'Directional' : 'Point';
    state.statusInstruction = `Click to place ${typeName} light · Shift+click to snap to grid · Hover existing to move · Right-click to delete · Esc to clear preset`;
  }

  _clearPreset() {
    state.lightPreset = null;
    const select = document.getElementById('light-preset-select') as HTMLInputElement | null;
    if (select) select.value = '';
    this._updateStatusInstruction();
    setCursor(this.hoveredLightId ? 'grab' : 'default');
    notify();
    requestRender();
  }

  // ── Delete / Paste Helpers ───────────────────────────────────────────────

  _deleteSelectedLight() {
    if (state.selectedLightId == null) return;
    const light = findLightById(state.selectedLightId);
    if (!light) return;
    const lightRef = light;
    mutate(
      'Delete light',
      [],
      () => {
        const lights = getLights();
        const idx = lights.indexOf(lightRef);
        if (idx >= 0) lights.splice(idx, 1);
      },
      { metaOnly: true, invalidate: ['lighting'] },
    );
    if (this.hoveredLightId === lightRef.id) {
      this.hoveredLightId = null;
      setCursor(state.lightPreset ? 'crosshair' : 'default');
    }
    state.selectedLightId = null;
    this._updateStatusInstruction();
    requestRender();
  }

  _commitLightPaste(pos: CanvasPos | null, event: MouseEvent) {
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize || 5;
    let world = fromCanvas(pos!.x, pos!.y, transform);

    // Shift+click: snap to grid
    if (event.shiftKey) {
      world = {
        x: Math.round(world.x / gridSize) * gridSize,
        y: Math.round(world.y / gridSize) * gridSize,
      };
    }

    const src = state.lightClipboard;
    const worldPos = world;
    let newLightId: number;
    mutate(
      'Paste light',
      [],
      () => {
        ensureLightsArray();
        const light = JSON.parse(JSON.stringify(src));
        light.id = state.dungeon.metadata.nextLightId++;
        light.x = worldPos.x;
        light.y = worldPos.y;
        state.dungeon.metadata.lights.push(light);
        newLightId = light.id;
      },
      { metaOnly: true, invalidate: ['lighting'] },
    );
    state.selectedLightId = newLightId!;
    state.lightPasteMode = false;

    requestRender();
    showToast('Pasted light');
  }

  // ── Place ────────────────────────────────────────────────────────────────

  _placeLight(pos: CanvasPos | null, event: MouseEvent) {
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize || 5;
    let world = fromCanvas(pos!.x, pos!.y, transform);

    // Shift+click: snap position to grid intersection
    if (event.shiftKey) {
      world = {
        x: Math.round(world.x / gridSize) * gridSize,
        y: Math.round(world.y / gridSize) * gridSize,
      };
    }

    let newLight: Light;
    mutate(
      'Add light',
      [],
      () => {
        ensureLightsArray();

        const light: Light = {
          id: state.dungeon.metadata.nextLightId++,
          x: world.x,
          y: world.y,
          type: state.lightType as Light['type'],
          radius: state.lightRadius,
          color: state.lightColor,
          intensity: state.lightIntensity,
          falloff: state.lightFalloff as Light['falloff'],
        };

        // Dim radius
        if (state.lightDimRadius > 0) light.dimRadius = state.lightDimRadius;

        // Z-height (height above floor in feet)
        if (state.lightZ) light.z = state.lightZ;

        // Track which preset this light was created from (enables Resync Preset Lights)
        if (state.lightPreset) light.presetId = state.lightPreset;

        // Animation
        if (state.lightAnimation?.type) light.animation = { ...state.lightAnimation };

        // Add directional-specific properties
        if (state.lightType === 'directional') {
          light.spread = state.lightAngle;
          light.range = state.lightRadius;
        }

        state.dungeon.metadata.lights.push(light);
        newLight = light;
      },
      { metaOnly: true, invalidate: ['lighting'] },
    );

    state.selectedLightId = newLight!.id;

    // Start dragging the newly placed light so user can reposition while holding.
    // isNewPlacement=true means onCancel should remove the light entirely (the
    // placement itself is what's being cancelled), not try to restore a
    // nonexistent pre-drag position.
    this.dragging = {
      lightId: newLight!.id,
      offsetX: 0,
      offsetY: 0,
      origX: world.x,
      origY: world.y,
      isNewPlacement: true,
    };
    this.dragMoved = false;

    requestRender();
  }

  // ── Select + Drag ────────────────────────────────────────────────────────

  _startSelectOrDrag(pos: CanvasPos | null) {
    if (!pos) return;
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
        metaSnapshot: JSON.stringify(state.dungeon.metadata),
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

  _drawLightIcon(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    light: Light,
    isSelected: boolean,
    isHovered: boolean,
  ) {
    const emojiSize = isSelected ? 24 : isHovered ? 22 : 18;
    const color = light.color || '#ff9944';

    ctx.save();

    // Colored glow halo — tints the icon by the light's color
    const glowR = emojiSize * 0.9;
    ctx.beginPath();
    ctx.arc(px, py, glowR, 0, Math.PI * 2);
    ctx.fillStyle = color + (isSelected ? '60' : isHovered ? '45' : '30');
    ctx.fill();

    // Lightbulb emoji — force opaque fill (Chromium applies fillStyle alpha
    // to color-bitmap emoji, and the halo above left fillStyle at low alpha).
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 1;
    ctx.font = `${emojiSize}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💡', px, py);

    // Selected ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(px, py, emojiSize * 0.7, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Directional: arrow outside the bulb pointing along the light's angle
    if (light.type === 'directional') {
      const angleRad = ((light.angle ?? 0) * Math.PI) / 180;
      const start = emojiSize * 0.75;
      const end = emojiSize * 1.3;
      const ax = px + Math.cos(angleRad) * end;
      const ay = py + Math.sin(angleRad) * end;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(angleRad) * start, py + Math.sin(angleRad) * start);
      ctx.lineTo(ax, ay);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      const head = emojiSize * 0.3;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(angleRad - 0.5) * head, ay - Math.sin(angleRad - 0.5) * head);
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(angleRad + 0.5) * head, ay - Math.sin(angleRad + 0.5) * head);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawLightPreview(ctx: CanvasRenderingContext2D, px: number, py: number, light: Light, transform: RenderTransform) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.6)';

    if (light.type === 'directional') {
      const range = ((light.range ?? light.radius) || 30) * transform.scale;
      const angleRad = ((light.angle ?? 0) * Math.PI) / 180;
      const spreadRad = ((light.spread ?? 45) * Math.PI) / 180;

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

  _drawPlacementPreview(ctx: CanvasRenderingContext2D, pos: CanvasPos | null, transform: RenderTransform) {
    const color = state.lightColor || '#ff9944';
    const { x, y } = pos!;

    ctx.save();
    ctx.setLineDash([4, 4]);

    if (state.lightType === 'directional') {
      const range = (state.lightRadius || 30) * transform.scale;
      const angleRad = ((state.lightAngle || 0) * Math.PI) / 180;
      const spreadRad = ((state.lightSpread || 45) * Math.PI) / 180;

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

  _drawPastePreview(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, transform: { scale: number }) {
    const light = state.lightClipboard;
    if (!light) return;
    const color = light.color || '#ff9944';
    const { x, y } = pos;

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);

    if (light.type === 'directional') {
      const range = ((light.range ?? light.radius) || 30) * transform.scale;
      const angleRad = ((light.angle ?? 0) * Math.PI) / 180;
      const spreadRad = ((light.spread ?? 45) * Math.PI) / 180;

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
