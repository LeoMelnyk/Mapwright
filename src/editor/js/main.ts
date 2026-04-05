// App initialization — entry point orchestrator
import state from './state.js';
import * as canvasView from './canvas-view.js';
import { RoomTool, PaintTool, WallTool, DoorTool, LabelTool, StairsTool, BridgeTool, SelectTool, TrimTool, PropTool, EraseTool, LightTool, FillTool } from './tools/index.js';
import { sessionState } from './dm-session.js';
import { setSessionTool } from './canvas-view.js';
import { getToolCursor, updateToolButtons, getActivePanel, refreshKeybindingsHelper } from './panels/index.js';
import { initApp } from './app-init.js';
import { initKeyboardShortcuts } from './keyboard-shortcuts.js';

// Tool registry
const tools = {
  room: new RoomTool(),
  paint: new PaintTool(),
  fill: new FillTool(),
  wall: new WallTool(),
  door: new DoorTool(),
  label: new LabelTool(),
  stairs: new StairsTool(),
  bridge: new BridgeTool(),
  select: new SelectTool(),
  trim: new TrimTool(),
  prop: new PropTool(),
  erase: new EraseTool(),
  light: new LightTool(),
};

function setTool(name) {
  // Deactivate previous tool (read state.activeTool before updating it)
  const prevTool = tools[state.activeTool];
  if (prevTool?.onDeactivate) prevTool.onDeactivate();

  state.activeTool = name;

  const tool = tools[name];
  if (!tool) return;

  // Activate new tool
  if (tool.onActivate) tool.onActivate();
  canvasView.setActiveTool(tool);
  // Use toolbar's mode-aware cursor, falling back to tool default
  const cursor = getToolCursor(name);
  canvasView.setCursor(cursor ?? tool.getCursor());
  refreshKeybindingsHelper();
}

// ── Session tools mode ─────────────────────────────────────────────────────

let savedTool = null;

function updateSessionToolsMode() {
  const shouldBeActive = getActivePanel() === 'session' && sessionState.active;
  if (shouldBeActive === state.sessionToolsActive) return;
  state.sessionToolsActive = shouldBeActive;

  if (shouldBeActive) {
    enterSessionToolsMode();
  } else {
    exitSessionToolsMode();
  }
  canvasView.requestRender();
}

function enterSessionToolsMode() {
  savedTool = state.activeTool;

  // Deactivate current editor tool
  const prevTool = tools[state.activeTool];
  if (prevTool?.onDeactivate) prevTool.onDeactivate();
  canvasView.setActiveTool(null);
  canvasView.setCursor('default');

  // Hide normal toolbar, show session toolbar
  document.getElementById('editor-tool-row').style.display = 'none';
  document.querySelectorAll('.suboptions-bar, .tertiaryoptions-bar').forEach(el => el.style.display = 'none');
  document.getElementById('session-tool-row').style.display = 'flex';
  document.getElementById('drawing-toolbar')?.classList.add('session-active');
}

function exitSessionToolsMode() {
  // Deactivate current session tool (e.g. fog reveal) so it cleans up state
  setSessionTool(null);

  // Hide session toolbar + range sub-options, show normal toolbar
  document.getElementById('session-tool-row').style.display = 'none';
  const rangeOpts = document.getElementById('range-options');
  if (rangeOpts) rangeOpts.style.display = 'none';
  document.getElementById('editor-tool-row').style.display = 'flex';
  document.getElementById('drawing-toolbar')?.classList.remove('session-active');

  // Restore previous editor tool
  const toolToRestore = savedTool && tools[savedTool] ? savedTool : 'room';
  setTool(toolToRestore);
  updateToolButtons();
  savedTool = null;
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  // Bootstrap the application
  await initApp(tools, setTool, updateSessionToolsMode);

  // Wire keyboard shortcuts
  const { onKeyDown, onKeyUp } = initKeyboardShortcuts(tools, setTool);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
});
