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
  applyToolSideEffects, cycleSubMode, updateToolButtons,
  togglePanel, deselectCell, selectLevel,
} from './panels/index.js';

/**
 * Initialise keyboard shortcuts.
 *
 * @param {Object}   tools   - Tool registry (keyed by tool name).
 * @param {Function} setTool - Switches the active editor tool.
 * @returns {{ onKeyDown: Function, onKeyUp: Function }}
 */
export function initKeyboardShortcuts(tools: Record<string, any>, setTool: (name: string) => void): { onKeyDown: (e: KeyboardEvent) => void; onKeyUp: (e: KeyboardEvent) => void } {

  function onKeyDown(e: any) {
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); if (state.undoStack.length) { undo(); showToast('Undo'); } else { showToast('Nothing to undo'); } canvasView.requestRender(); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); if (state.redoStack.length) { redo(); showToast('Redo'); } else { showToast('Nothing to redo'); } canvasView.requestRender(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'S') { e.preventDefault(); saveDungeonAs(); return; }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveDungeon(); }

    // H: zoom to fit current level
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey) {
      e.preventDefault();
      zoomToFit();
      return;
    }

    // ? or /: open keyboard shortcuts modal
    if ((e.key === '?' || e.key === '/') && !e.ctrlKey) {
      e.preventDefault();
      // @ts-expect-error — strict-mode migration
      window._openShortcutsModal?.();
      return;
    }

    // Ctrl+C: copy selected cells (Select tool only)
    if (e.ctrlKey && e.key === 'c' && state.activeTool === 'select' && state.selectedCells.length > 0) {
      e.preventDefault();
      const cells = state.dungeon.cells;
      const anchorRow = Math.min(...state.selectedCells.map((c: any) => c.row));
      const anchorCol = Math.min(...state.selectedCells.map((c: any) => c.col));
      state.clipboard = {
        anchorRow, anchorCol,
        cells: state.selectedCells.map(({ row, col }: any) => ({
          dRow: row - anchorRow,
          dCol: col - anchorCol,
          data: cells[row][col] ? JSON.parse(JSON.stringify(cells[row][col])) : null,
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
      const anchorRow = Math.min(...state.selectedPropAnchors.map((a: any) => a.row));
      const anchorCol = Math.min(...state.selectedPropAnchors.map((a: any) => a.col));
      const props = [];
      const copiedIds = new Set();
      for (const a of state.selectedPropAnchors) {
        // Use propId when available (from box-select/hit-test), else spatial lookup
        const overlay = a.propId
          // @ts-expect-error — strict-mode migration
          ? meta?.props?.find((p: any) => p.id === a.propId)
          // @ts-expect-error — strict-mode migration
          : (() => { const e = lookupPropAt(a.row, a.col); return e ? meta?.props?.find((p: any) => p.id === e.propId) : null; })();
        if (overlay && !copiedIds.has(overlay.id)) {
          copiedIds.add(overlay.id);
          const { row, col } = a;
          // Capture linked lights (via propRef matching this prop's anchor)
          const gs = meta.gridSize || 5;
          const propAnchorRow = Math.round(overlay.y / gs);
          const propAnchorCol = Math.round(overlay.x / gs);
          const linkedLights = (meta.lights || [])
            .filter(l => l.propRef?.row === propAnchorRow && l.propRef?.col === propAnchorCol)
            .map(l => {
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
      const anchorRow = Math.min(...state.selectedCells.map((c: any) => c.row));
      const anchorCol = Math.min(...state.selectedCells.map((c: any) => c.col));
      state.clipboard = {
        anchorRow, anchorCol,
        cells: state.selectedCells.map(({ row, col }: any) => ({
          dRow: row - anchorRow,
          dCol: col - anchorCol,
          data: cells[row][col] ? JSON.parse(JSON.stringify(cells[row][col])) : null,
        })),
      };
      // Delete the cells
      pushUndo('Cut cells');
      for (const { row, col } of state.selectedCells) {
        cells[row][col] = null;
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
      const anchorRow = Math.min(...state.selectedPropAnchors.map((a: any) => a.row));
      const anchorCol = Math.min(...state.selectedPropAnchors.map((a: any) => a.col));
      const props = [];
      const copiedIds = new Set();
      for (const a of state.selectedPropAnchors) {
        const overlay = a.propId
          // @ts-expect-error — strict-mode migration
          ? meta?.props?.find((p: any) => p.id === a.propId)
          // @ts-expect-error — strict-mode migration
          : (() => { const e = lookupPropAt(a.row, a.col); return e ? meta?.props?.find((p: any) => p.id === e.propId) : null; })();
        if (overlay && !copiedIds.has(overlay.id)) {
          copiedIds.add(overlay.id);
          const { row, col } = a;
          // Capture linked lights (via propRef matching this prop's anchor)
          const gs = meta.gridSize || 5;
          const propAnchorRow = Math.round(overlay.y / gs);
          const propAnchorCol = Math.round(overlay.x / gs);
          const linkedLights = (meta.lights || [])
            .filter(l => l.propRef?.row === propAnchorRow && l.propRef?.col === propAnchorCol)
            .map(l => {
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
          const entry = lookupPropAt(anchor.row, anchor.col);
          if (entry && meta?.props) {
            // @ts-expect-error — strict-mode migration
            const idx = meta.props.findIndex((p: any) => p.id === entry.propId);
            // @ts-expect-error — strict-mode migration
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
      tools.prop.onCancel();
      // Deselect the prop template (stop placing new props)
      if (state.selectedProp) {
        state.selectedProp = null;
        state.propRotation = 0;
        state.propScale = 1.0;
        notify();
      }
      state.propPasteMode = true;
      canvasView.requestRender();
      return;
    }

    // Ctrl+V: enter paste mode (Select tool)
    if (e.ctrlKey && e.key === 'v' && state.clipboard) {
      e.preventDefault();
      if (state.activeTool !== 'select') {
        // Switch to select tool first
        const btn = document.querySelector('[data-tool="select"]');
        // @ts-expect-error — strict-mode migration
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
    const panelKeys = { 'F1': 'themes', 'F2': 'levels', 'F3': 'textures', 'F4': 'lighting', 'F5': 'session' };
    if ((panelKeys as any)[e.key]) { e.preventDefault(); togglePanel((panelKeys as any)[e.key]); return; }

    // Ctrl+1–9: switch to level by index
    if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      selectLevel(parseInt(e.key, 10) - 1);
      return;
    }

    // Suppress tool shortcuts in session tools mode — use session-specific keybinds instead
    const toolKeys = { '1': 'room', '2': 'paint', '3': 'fill', '4': 'wall', '5': 'door', '6': 'label', 's': 'stairs', 'b': 'bridge', 't': 'trim', 'a': 'select', 'q': 'prop', 'e': 'erase', 'l': 'light' };
    if (state.sessionToolsActive) {
      // 1/2: switch session tools
      const sessionToolKeys = { '1': 'doors', '2': 'range', '3': 'fog-reveal' };
      if ((sessionToolKeys as any)[e.key]) {
        e.preventDefault();
        const toolName = (sessionToolKeys as any)[e.key];
        const btn = document.querySelector(`[data-session-tool="${toolName}"]`);
        // @ts-expect-error — strict-mode migration
        if (btn) btn.click();
        return;
      }
      // Tab / Shift+Tab: cycle range shape sub-tools
      if (e.key === 'Tab') {
        e.preventDefault();
        const shapes = [...document.querySelectorAll('#range-options [data-range-shape]')];
        if (shapes.length === 0) return;
        const activeIdx = shapes.findIndex(b => b.classList.contains('active'));
        const dir = e.shiftKey ? -1 : 1;
        const nextIdx = (activeIdx + dir + shapes.length) % shapes.length;
        // @ts-expect-error — strict-mode migration
        shapes[nextIdx].click();
        return;
      }
      if ((toolKeys as any)[e.key]) return;
    }

    // Number keys for tools + L for light
    if ((toolKeys as any)[e.key]) {
      setTool((toolKeys as any)[e.key]);
      updateToolButtons();
      applyToolSideEffects((toolKeys as any)[e.key]);
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
        state.dungeon.cells[row][col] = null;
      }
      state.selectedCells = [];
      markDirty();
      canvasView.requestRender();
    }

    // D / Shift+D: cycle water/lava depth (fill tool, water or lava mode only)
    if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey &&
        state.activeTool === 'fill' && (state.fillMode === 'water' || state.fillMode === 'lava')) {
      e.preventDefault();
      const cur = state.fillMode === 'lava' ? state.lavaDepth : state.waterDepth;
      const next = e.shiftKey ? (cur === 1 ? 3 : cur - 1) : (cur === 3 ? 1 : cur + 1);
      if (state.fillMode === 'lava') state.lavaDepth = next;
      else state.waterDepth = next;
      document.querySelectorAll('[data-water-depth]').forEach(b => {
        // @ts-expect-error — strict-mode migration
        b.classList.toggle('active', parseInt(b.dataset.waterDepth, 10) === next);
      });
      return;
    }

    // Forward to active tool
    const tool = tools[state.activeTool];
    if (tool?.onKeyDown) tool.onKeyDown(e);
  }

  function onKeyUp(e: any) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    // Forward to active tool (needed for room tool shift-release)
    const tool = tools[state.activeTool];
    if (tool?.onKeyUp) tool.onKeyUp(e);
  }

  return { onKeyDown, onKeyUp };
}
