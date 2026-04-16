/**
 * Keyboard event handlers for the dungeon editor.
 *
 * Exports onKeyDown and onKeyUp, which close over their dependencies
 * via imports from sibling modules.
 *
 * @module keyboard-shortcuts
 */

import state, { undo, redo, pushUndo, markDirty, invalidateLightmap, notify } from './state.js';
import { showToast } from './toast.js';
import * as canvasView from './canvas-view.js';
import { saveDungeon, saveDungeonAs } from './io.js';
import { zoomToFit } from './canvas-view.js';
import { lookupPropAt, markPropSpatialDirty } from './prop-spatial.js';
import {
  applyToolSideEffects,
  cycleSubMode,
  updateToolButtons,
  togglePanel,
  deselectCell,
  selectLevel,
} from './panels/index.js';
import type { Tool } from './tools/tool-base.js';
/**
 * Initialise keyboard shortcuts.
 *
 * @param {Object}   tools   - Tool registry (keyed by tool name).
 * @param {(name: string) => void} setTool - Switches the active editor tool.
 * @returns {{ onKeyDown: (e: KeyboardEvent) => void, onKeyUp: (e: KeyboardEvent) => void }}
 */
export function initKeyboardShortcuts(
  tools: Record<string, Tool>,
  setTool: (name: string) => void,
): { onKeyDown: (e: KeyboardEvent) => void; onKeyUp: (e: KeyboardEvent) => void } {
  function onKeyDown(e: KeyboardEvent) {
    // Don't intercept when typing in inputs
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'SELECT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA'
    )
      return;

    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      if (state.undoStack.length) {
        undo();
        showToast('Undo');
      } else {
        showToast('Nothing to undo');
      }
      canvasView.requestRender();
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      if (state.redoStack.length) {
        redo();
        showToast('Redo');
      } else {
        showToast('Nothing to redo');
      }
      canvasView.requestRender();
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      void saveDungeonAs();
      return;
    }
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      void saveDungeon();
    }

    // H: zoom to fit current level
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey) {
      e.preventDefault();
      zoomToFit();
      return;
    }

    // ? or /: open keyboard shortcuts modal
    if ((e.key === '?' || e.key === '/') && !e.ctrlKey) {
      e.preventDefault();
      (window as unknown as { _openShortcutsModal?: () => void })._openShortcutsModal?.();
      return;
    }

    // Ctrl+C: copy selected cells (Select tool only)
    if (e.ctrlKey && e.key === 'c' && state.activeTool === 'select' && state.selectedCells.length > 0) {
      e.preventDefault();
      const cells = state.dungeon.cells;
      const anchorRow = Math.min(...state.selectedCells.map((c) => c.row));
      const anchorCol = Math.min(...state.selectedCells.map((c) => c.col));
      state.clipboard = {
        anchorRow,
        anchorCol,
        cells: state.selectedCells.map(({ row, col }: { row: number; col: number }) => ({
          dRow: row - anchorRow,
          dCol: col - anchorCol,
          data: cells[row]![col] ? JSON.parse(JSON.stringify(cells[row]![col])) : null,
        })),
      };
      const n = state.selectedCells.length;
      showToast(`Copied ${n} cell${n === 1 ? '' : 's'}`);
      return;
    }

    // Ctrl+C: copy selected props (Prop tool only)
    if (e.ctrlKey && e.key === 'c' && state.activeTool === 'prop' && state.selectedPropAnchors.length > 0) {
      e.preventDefault();
      const meta = state.dungeon.metadata;
      const anchorRow = Math.min(...state.selectedPropAnchors.map((a: { row: number; col: number }) => a.row));
      const anchorCol = Math.min(...state.selectedPropAnchors.map((a: { row: number; col: number }) => a.col));
      const props = [];
      const copiedIds = new Set();
      for (const a of state.selectedPropAnchors) {
        // Use propId when available (from box-select/hit-test), else spatial lookup
        const overlay = a.propId
          ? meta.props?.find((p: { id: number | string }) => p.id === a.propId)
          : (() => {
              const entry = lookupPropAt(a.row, a.col);
              return entry ? meta.props?.find((p: { id: number | string }) => p.id === entry.propId) : null;
            })();
        if (overlay && !copiedIds.has(overlay.id)) {
          copiedIds.add(overlay.id);
          const { row, col } = a;
          // Capture linked lights (via propRef matching this prop's anchor)
          const gs = meta.gridSize || 5;
          const propAnchorRow = Math.round(overlay.y / gs);
          const propAnchorCol = Math.round(overlay.x / gs);
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          const linkedLights = (meta.lights || [])
            .filter((l) => l.propRef?.row === propAnchorRow && l.propRef.col === propAnchorCol)
            .map((l) => {
              const clone = JSON.parse(JSON.stringify(l));
              // Store light offset relative to the prop's world position
              clone._offsetX = l.x - overlay.x;
              clone._offsetY = l.y - overlay.y;
              return clone;
            });
          props.push({
            dRow: row - anchorRow,
            dCol: col - anchorCol,
            prop: JSON.parse(JSON.stringify(overlay)),
            lights: linkedLights.length > 0 ? linkedLights : undefined,
          });
        }
      }
      if (props.length > 0) {
        state.propClipboard = { anchorRow, anchorCol, props };
        showToast(`Copied ${props.length} prop${props.length === 1 ? '' : 's'}`);
      }
      return;
    }

    // Ctrl+X: cut selected cells (Select tool only) — copy + delete
    if (e.ctrlKey && e.key === 'x' && state.activeTool === 'select' && state.selectedCells.length > 0) {
      e.preventDefault();
      const cells = state.dungeon.cells;
      const anchorRow = Math.min(...state.selectedCells.map((c) => c.row));
      const anchorCol = Math.min(...state.selectedCells.map((c) => c.col));
      state.clipboard = {
        anchorRow,
        anchorCol,
        cells: state.selectedCells.map(({ row, col }: { row: number; col: number }) => ({
          dRow: row - anchorRow,
          dCol: col - anchorCol,
          data: cells[row]![col] ? JSON.parse(JSON.stringify(cells[row]![col])) : null,
        })),
      };
      // Delete the cells
      pushUndo('Cut cells');
      for (const { row, col } of state.selectedCells) {
        cells[row]![col] = null;
      }
      const n = state.selectedCells.length;
      state.selectedCells = [];
      invalidateLightmap();
      markDirty();
      canvasView.requestRender();
      showToast(`Cut ${n} cell${n === 1 ? '' : 's'}`);
      return;
    }

    // Ctrl+X: cut selected props (Prop tool only) — copy + delete
    if (e.ctrlKey && e.key === 'x' && state.activeTool === 'prop' && state.selectedPropAnchors.length > 0) {
      e.preventDefault();
      const meta = state.dungeon.metadata;
      const anchorRow = Math.min(...state.selectedPropAnchors.map((a: { row: number; col: number }) => a.row));
      const anchorCol = Math.min(...state.selectedPropAnchors.map((a: { row: number; col: number }) => a.col));
      const props = [];
      const copiedIds = new Set();
      for (const a of state.selectedPropAnchors) {
        const overlay = a.propId
          ? meta.props?.find((p: { id: number | string }) => p.id === a.propId)
          : (() => {
              const entry = lookupPropAt(a.row, a.col);
              return entry ? meta.props?.find((p: { id: number | string }) => p.id === entry.propId) : null;
            })();
        if (overlay && !copiedIds.has(overlay.id)) {
          copiedIds.add(overlay.id);
          const { row, col } = a;
          // Capture linked lights (via propRef matching this prop's anchor)
          const gs = meta.gridSize || 5;
          const propAnchorRow = Math.round(overlay.y / gs);
          const propAnchorCol = Math.round(overlay.x / gs);
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          const linkedLights = (meta.lights || [])
            .filter((l) => l.propRef?.row === propAnchorRow && l.propRef.col === propAnchorCol)
            .map((l) => {
              const clone = JSON.parse(JSON.stringify(l));
              clone._offsetX = l.x - overlay.x;
              clone._offsetY = l.y - overlay.y;
              return clone;
            });
          props.push({
            dRow: row - anchorRow,
            dCol: col - anchorCol,
            prop: JSON.parse(JSON.stringify(overlay)),
            lights: linkedLights.length > 0 ? linkedLights : undefined,
          });
        }
      }
      if (props.length > 0) {
        state.propClipboard = { anchorRow, anchorCol, props };
        // Delete the props
        pushUndo('Cut props');
        for (const anchor of state.selectedPropAnchors) {
          // Use propId when available to avoid deleting the overlapping prop on top
          const propId =
            anchor.propId ?? lookupPropAt(anchor.row, anchor.col)?.propId;
          if (propId != null && meta.props) {
            const idx = meta.props.findIndex((p: { id: number | string }) => p.id === propId);
            if (idx >= 0) meta.props.splice(idx, 1);
          }
        }
        state.selectedPropAnchors = [];
        markPropSpatialDirty();
        invalidateLightmap();
        markDirty();
        canvasView.requestRender();
        showToast(`Cut ${props.length} prop${props.length === 1 ? '' : 's'}`);
      }
      return;
    }

    // Ctrl+V: enter prop paste mode (Prop tool, when prop clipboard exists)
    if (e.ctrlKey && e.key === 'v' && state.propClipboard && state.activeTool === 'prop') {
      e.preventDefault();
      // Cancel any in-progress drag
      tools.prop!.onCancel();
      // Deselect the prop template (stop placing new props)
      if (state.selectedProp) {
        state.selectedProp = null;
        state.propRotation = 0;
        state.propScale = 1.0;
      }
      // Clear existing prop selection — paste mode should act like an armed stamp,
      // where keyboard transforms apply to the ghost, not to previously-selected props.
      state.selectedPropAnchors = [];
      state.selectedPropIds = [];
      notify();
      state.propPasteMode = true;
      canvasView.requestRender();
      return;
    }

    // Ctrl+V: enter paste mode (Select tool)
    if (e.ctrlKey && e.key === 'v' && state.clipboard) {
      e.preventDefault();
      if (state.activeTool !== 'select') {
        // Switch to select tool first
        const btn = document.querySelector<HTMLInputElement>('[data-tool="select"]');
        if (btn) btn.click();
      }
      state.pasteMode = true;
      canvasView.requestRender();
      return;
    }

    // Escape: cancel paste mode
    if (e.key === 'Escape' && (state.pasteMode || state.propPasteMode || state.lightPasteMode)) {
      state.pasteMode = false;
      state.propPasteMode = false;
      state.lightPasteMode = false;
      canvasView.requestRender();
      return;
    }

    // F1–F5: toggle sidebar panels
    const panelKeys = { F1: 'themes', F2: 'levels', F3: 'textures', F4: 'lighting', F5: 'session' };
    if ((panelKeys as Record<string, string>)[e.key]) {
      e.preventDefault();
      togglePanel((panelKeys as Record<string, string>)[e.key]!);
      return;
    }

    // Ctrl+1–9: switch to level by index
    if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      selectLevel(parseInt(e.key, 10) - 1);
      return;
    }

    // Suppress tool shortcuts in session tools mode — use session-specific keybinds instead
    const toolKeys = {
      '1': 'room',
      '2': 'paint',
      '3': 'fill',
      '4': 'wall',
      '5': 'door',
      '6': 'label',
      s: 'stairs',
      b: 'bridge',
      t: 'trim',
      a: 'select',
      q: 'prop',
      e: 'erase',
      l: 'light',
    };
    if (state.sessionToolsActive) {
      // 1/2: switch session tools
      const sessionToolKeys = { '1': 'doors', '2': 'range', '3': 'fog-reveal' };
      if ((sessionToolKeys as Record<string, string>)[e.key]) {
        e.preventDefault();
        const toolName = (sessionToolKeys as Record<string, string>)[e.key];
        const btn = document.querySelector<HTMLInputElement>(`[data-session-tool="${toolName}"]`);
        if (btn) btn.click();
        return;
      }
      // Tab / Shift+Tab: cycle range shape sub-tools
      if (e.key === 'Tab') {
        e.preventDefault();
        const shapes = [...document.querySelectorAll<HTMLElement>('#range-options [data-range-shape]')];
        if (shapes.length === 0) return;
        const activeIdx = shapes.findIndex((b) => b.classList.contains('active'));
        const dir = e.shiftKey ? -1 : 1;
        const nextIdx = (activeIdx + dir + shapes.length) % shapes.length;
        shapes[nextIdx]!.click();
        return;
      }
      if ((toolKeys as Record<string, unknown>)[e.key]) return;
    }

    // Number keys for tools + L for light
    const toolKeyVal = (toolKeys as Record<string, string>)[e.key];
    if (toolKeyVal) {
      setTool(toolKeyVal);
      updateToolButtons();
      applyToolSideEffects(toolKeyVal);
    }

    // Tab / Shift+Tab: cycle sub-options for current tool
    if (e.key === 'Tab') {
      e.preventDefault();
      cycleSubMode(e.shiftKey ? -1 : 1);
    }

    // Escape: deselect cell / close cell info panel
    if (e.key === 'Escape' && state.selectedCells.length) {
      deselectCell();
      return;
    }

    // Delete selected cells
    if (e.key === 'Delete' && state.selectedCells.length) {
      pushUndo();
      for (const { row, col } of state.selectedCells) {
        state.dungeon.cells[row]![col] = null;
      }
      state.selectedCells = [];
      markDirty();
      canvasView.requestRender();
    }

    // D / Shift+D: cycle water/lava depth (fill tool, water or lava mode only)
    if (
      (e.key === 'd' || e.key === 'D') &&
      !e.ctrlKey &&
      state.activeTool === 'fill' &&
      (state.fillMode === 'water' || state.fillMode === 'lava')
    ) {
      e.preventDefault();
      const cur = state.fillMode === 'lava' ? state.lavaDepth : state.waterDepth;
      const next = e.shiftKey ? (cur === 1 ? 3 : cur - 1) : cur === 3 ? 1 : cur + 1;
      if (state.fillMode === 'lava') state.lavaDepth = next;
      else state.waterDepth = next;
      document.querySelectorAll<HTMLElement>('[data-water-depth]').forEach((b) => {
        b.classList.toggle('active', parseInt(b.dataset.waterDepth ?? '0', 10) === next);
      });
      return;
    }

    // Forward to active tool
    const tool = tools[state.activeTool];
    tool?.onKeyDown(e);
  }

  function onKeyUp(e: KeyboardEvent) {
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'SELECT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA'
    )
      return;

    // Forward to active tool (needed for room tool shift-release)
    const tool = tools[state.activeTool];
    tool?.onKeyUp(e);
  }

  return { onKeyDown, onKeyUp };
}
