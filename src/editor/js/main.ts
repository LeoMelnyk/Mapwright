// App initialization — entry point orchestrator
import state from './state.js';
import * as canvasView from './canvas-view.js';
import {
  RoomTool,
  PaintTool,
  WallTool,
  DoorTool,
  WindowTool,
  LabelTool,
  StairsTool,
  BridgeTool,
  SelectTool,
  TrimTool,
  PropTool,
  EraseTool,
  LightTool,
  FillTool,
  WeatherTool,
} from './tools/index.js';
import { sessionState } from './dm-session.js';
import { setSessionTool } from './canvas-view.js';
import { getToolCursor, updateToolButtons, getActivePanel, refreshKeybindingsHelper } from './panels/index.js';
import { initApp } from './app-init.js';
import { initKeyboardShortcuts } from './keyboard-shortcuts.js';
import { initRangeSliderWheel } from './range-wheel.js';
import type { Tool } from './tools/tool-base.js';

// Tool registry
const tools = {
  room: new RoomTool(),
  paint: new PaintTool(),
  fill: new FillTool(),
  wall: new WallTool(),
  door: new DoorTool(),
  window: new WindowTool(),
  label: new LabelTool(),
  stairs: new StairsTool(),
  bridge: new BridgeTool(),
  select: new SelectTool(),
  trim: new TrimTool(),
  prop: new PropTool(),
  erase: new EraseTool(),
  light: new LightTool(),
  weather: new WeatherTool(),
};

function setTool(name: string) {
  // Deactivate previous tool (read state.activeTool before updating it).
  // Guard against state.activeTool holding an unknown name (e.g. from a
  // stale autosave or external API misuse) — calling .onDeactivate() on
  // undefined would crash the editor on init.
  const prevTool = (tools as Record<string, Tool | undefined>)[state.activeTool];
  prevTool?.onDeactivate();

  state.activeTool = name;

  const tool = (tools as Record<string, Tool>)[name]!;

  // Activate new tool
  tool.onActivate();
  canvasView.setActiveTool(tool);
  // Use toolbar's mode-aware cursor, falling back to tool default
  const cursor = getToolCursor(name);
  canvasView.setCursor(cursor ?? tool.getCursor());
  refreshKeybindingsHelper();
}

// ── Session tools mode ─────────────────────────────────────────────────────

let savedTool: string | null = null;

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
  const prevTool = tools[state.activeTool as keyof typeof tools];
  prevTool.onDeactivate();
  canvasView.setActiveTool(null);
  canvasView.setCursor('default');

  // Hide normal toolbar, show session toolbar
  document.getElementById('editor-tool-row')!.style.display = 'none';
  document.querySelectorAll<HTMLElement>('.suboptions-bar, .tertiaryoptions-bar').forEach((el) => {
    el.style.display = 'none';
  });
  document.getElementById('session-tool-row')!.style.display = 'flex';
  document.getElementById('drawing-toolbar')?.classList.add('session-active');
}

function exitSessionToolsMode() {
  // Deactivate current session tool (e.g. fog reveal) so it cleans up state
  setSessionTool(null);

  // Hide session toolbar + range sub-options, show normal toolbar
  document.getElementById('session-tool-row')!.style.display = 'none';
  const rangeOpts = document.getElementById('range-options')!;
  rangeOpts.style.display = 'none';
  document.getElementById('editor-tool-row')!.style.display = 'flex';
  document.getElementById('drawing-toolbar')?.classList.remove('session-active');

  // Restore previous editor tool
  const toolToRestore = savedTool && (tools as Record<string, unknown>)[savedTool] ? savedTool : 'room';
  setTool(toolToRestore);
  updateToolButtons();
  savedTool = null;
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  void (async () => {
    // Bootstrap the application
    await initApp(tools, setTool, updateSessionToolsMode);

    // Scroll-wheel support for every range slider (delegated).
    initRangeSliderWheel();

    // Wire keyboard shortcuts
    const { onKeyDown, onKeyUp } = initKeyboardShortcuts(tools, setTool);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
  })();
});
