// Global test setup — mocks for browser-dependent modules.
// These mocks are applied before any test file imports, allowing the
// editor API modules (which import from _shared.js) to load in Node.
import { vi } from 'vitest';

// ── Minimal DOM stubs (prevents "document is not defined" in api/index.js) ───

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    readyState: 'complete',
    getElementById: (id) => {
      // Return a fake element for 'editor-canvas' so api/index.js waitForReady() resolves
      if (id === 'editor-canvas') return { toDataURL: () => '' };
      return null;
    },
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      getContext: () => null,
      width: 0, height: 0,
      style: {},
    }),
  };
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

if (typeof globalThis.localStorage === 'undefined') {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

// ── Browser/DOM-dependent modules ────────────────────────────────────────────

vi.mock('../src/editor/js/canvas-view.js', () => ({
  requestRender: vi.fn(),
  setCursor: vi.fn(),
  getTransform: vi.fn(() => ({ scale: 1, offsetX: 0, offsetY: 0 })),
}));

vi.mock('../src/editor/js/panels/index.js', () => ({
  selectTexture: vi.fn(),
}));

vi.mock('../src/editor/js/theme-catalog.js', () => ({
  getThemeCatalog: vi.fn(() => ({ names: ['stone-dungeon', 'blue-parchment'] })),
  renderThemePreview: vi.fn(),
}));

vi.mock('../src/editor/js/texture-catalog.js', () => ({
  collectTextureIds: vi.fn(() => new Set()),
  ensureTexturesLoaded: vi.fn(() => Promise.resolve()),
  loadTextureImages: vi.fn(),
  getTextureCatalog: vi.fn(() => null),
}));

vi.mock('../src/editor/js/light-catalog.js', () => ({
  getLightCatalog: vi.fn(() => ({
    lights: {
      torch: { displayName: 'Torch', category: 'fire', type: 'point', color: '#ff8833', radius: 20, intensity: 1, falloff: 'smooth' },
    },
    categoryOrder: ['fire'],
  })),
}));

vi.mock('../src/editor/js/io.js', () => ({
  reloadAssets: vi.fn(() => Promise.resolve()),
  migrateHalfTextures: vi.fn(),
}));

vi.mock('../src/editor/js/migrations.js', () => ({
  CURRENT_FORMAT_VERSION: 1,
  migrateToLatest: vi.fn((json) => json),
}));

// ── Geometry helpers that need real implementations ──────────────────────────

// Stair and bridge geometry are pure math — use real implementations
// but we need to handle the import path resolution
vi.mock('../src/editor/js/stair-geometry.js', () => ({
  classifyStairShape: vi.fn((p1, p2, p3) => ({ vertices: [p1, p2, p3] })),
  isDegenerate: vi.fn(() => false),
  getOccupiedCells: vi.fn((vertices) => {
    // Simple rectangle approximation for testing
    const rows = vertices.map(v => v[0]);
    const cols = vertices.map(v => v[1]);
    const minR = Math.min(...rows), maxR = Math.max(...rows);
    const minC = Math.min(...cols), maxC = Math.max(...cols);
    const cells = [];
    for (let r = minR; r < maxR; r++) {
      for (let c = minC; c < maxC; c++) {
        cells.push({ row: r, col: c });
      }
    }
    return cells;
  }),
}));

vi.mock('../src/editor/js/bridge-geometry.js', () => ({
  isBridgeDegenerate: vi.fn(() => false),
  getBridgeOccupiedCells: vi.fn(() => [{ row: 0, col: 0 }]),
}));

// ── Tool classes (browser-dependent) ─────────────────────────────────────────

vi.mock('../src/editor/js/tools/index.js', () => {
  class MockTool {
    constructor(name) { this.name = name; }
    onActivate() {}
    onDeactivate() {}
    onMouseDown() {}
    onMouseMove() {}
    onMouseUp() {}
    onKeyDown() {}
    onRightClick() {}
    getCursor() { return 'crosshair'; }
    renderOverlay() {}
  }
  class MockRoomTool extends MockTool {
    constructor() {
      super('room');
      this.dragStart = null;
      this.dragEnd = null;
    }
    _applyWalls() {
      // No-op in tests — createRoom delegates wall placement here.
      // Test wall logic via createPolygonRoom which does inline wall placement.
    }
  }
  class MockTrimTool extends MockTool {
    constructor() {
      super('trim');
      this.dragStart = null;
      this.dragEnd = null;
      this.resolvedCorner = null;
      this.previewCells = null;
      this._updatePreview = vi.fn();
    }
  }
  class MockPaintTool extends MockTool {
    constructor() {
      super('paint');
      this.floodFill = vi.fn();
    }
  }
  return {
    Tool: MockTool,
    RoomTool: MockRoomTool,
    TrimTool: MockTrimTool,
    PaintTool: MockPaintTool,
    WallTool: class extends MockTool { constructor() { super('wall'); } },
    DoorTool: class extends MockTool { constructor() { super('door'); } },
    LabelTool: class extends MockTool { constructor() { super('label'); } },
    STAMP_CURSOR: 'stamp',
    StairsTool: class extends MockTool { constructor() { super('stairs'); } },
    BridgeTool: class extends MockTool { constructor() { super('bridge'); } },
    SelectTool: class extends MockTool { constructor() { super('select'); } },
    PropTool: class extends MockTool { constructor() { super('prop'); } },
    EraseTool: class extends MockTool { constructor() { super('erase'); } },
    LightTool: class extends MockTool { constructor() { super('light'); } },
    FillTool: class extends MockTool { constructor() { super('fill'); } },
    RangeTool: class extends MockTool { constructor() { super('range'); } },
    FogRevealTool: class extends MockTool { constructor() { super('fog-reveal'); } },
    SYRINGE_CURSOR: 'syringe',
  };
});

// ── Render pipeline (not needed for API tests) ──────────────────────────────

vi.mock('../src/render/index.js', () => ({
  calculateCanvasSize: vi.fn(() => ({ width: 800, height: 600 })),
  renderDungeonToCanvas: vi.fn(),
  invalidateAllCaches: vi.fn(),
  invalidateVisibilityCache: vi.fn(),
  invalidateGeometryCache: vi.fn(),
  invalidateBlendLayerCache: vi.fn(),
  invalidateFluidCache: vi.fn(),
  invalidatePropsCache: vi.fn(),
  renderCells: vi.fn(),
  renderLabels: vi.fn(),
  THEMES: { 'stone-dungeon': {}, 'blue-parchment': {} },
  captureBeforeState: vi.fn(() => ({})),
  smartInvalidate: vi.fn(),
}));
