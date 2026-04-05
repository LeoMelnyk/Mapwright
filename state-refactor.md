# State Refactor: Monolithic Object → Typed Sub-Stores

## Problem

The editor state is a single monolithic object with 53+ properties. Everything from dungeon data to tool modes to clipboard buffers to animation clocks lives on one object. All 64 files that import state get the whole thing, and all subscribers are notified on every change regardless of what changed.

## Current State Shape (Categorized)

### A. Dungeon Data (Serialized, Undo-Tracked)
`dungeon`, `undoStack`, `redoStack`, `dirty`, `unsavedChanges`, `currentLevel`

### B. Viewport (Transient, Auto-Saved)
`zoom`, `panX`, `panY`

### C. Tool Config (~30 properties)
`activeTool`, `paintMode`, `activeTexture`, `textureOpacity`, `paintSecondary`,
`fillMode`, `waterDepth`, `lavaDepth`, `roomMode`, `doorType`, `labelMode`,
`stairsMode`, `stairPlacement`, `linkSource`, `bridgeType`, `selectedBridgeId`,
`lightPreset`, `lightType`, `lightRadius`, `lightColor`, `lightIntensity`,
`lightFalloff`, `lightDimRadius`, `lightAnimation`, `lightAngle`, `lightSpread`,
`lightCoverageMode`, `selectMode`, `selectedProp`, `propRotation`, `propFlipped`,
`propScale`, `selectedPropAnchors`, `selectedPropIds`,
`trimCorner`, `trimRound`, `trimInverted`, `trimOpen`

### D. Clipboard
`clipboard`, `pasteMode`, `propClipboard`, `propPasteMode`, `lightClipboard`, `lightPasteMode`

### E. Runtime Catalogs
`propCatalog`, `textureCatalog`, `lightCatalog`

### F. Render/Animation
`texturesVersion`, `animClock`, `hoveredCell`, `hoveredCorner`, `selectedCells`

### G. File I/O
`fileName`, `fileHandle`

### H. Session
`session`, `sessionToolsActive`, `statusInstruction`

### I. Debug
`debugShowHitboxes`

### J. Infrastructure
`listeners`, `_lastPushUndoMs`

## Proposed Sub-Stores

### Store 1: `dungeonStore`
**Purpose:** Map content + undo history. The only store that's serialized and undo-tracked.

```typescript
interface DungeonStore {
  dungeon: Dungeon;
  currentLevel: number;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  dirty: boolean;
  unsavedChanges: boolean;

  pushUndo(label?: string): void;
  undo(): void;
  redo(): void;
  jumpToState(idx: number): void;
  markDirty(): void;
  clearDirty(): void;
}
```

### Store 2: `viewportStore`
**Purpose:** Camera state. Auto-saved for session recovery.

```typescript
interface ViewportStore {
  zoom: number;
  panX: number;
  panY: number;

  setZoom(z: number): void;
  setPan(x: number, y: number): void;
}
```

### Store 3: `toolStore`
**Purpose:** All tool-specific UI state. Never serialized or undo-tracked.

```typescript
interface ToolStore {
  activeTool: string;
  // Paint
  paintMode: string;
  activeTexture: string | null;
  textureOpacity: number;
  paintSecondary: boolean;
  // Fill
  fillMode: string;
  waterDepth: number;
  lavaDepth: number;
  // Room
  roomMode: string;
  // Door
  doorType: string;
  // Label
  labelMode: string;
  // Stairs
  stairsMode: string;
  stairPlacement: { p1: any; p2: any };
  linkSource: string | null;
  // Bridge
  bridgeType: string;
  selectedBridgeId: string | null;
  // Light (10 properties)
  lightPreset: string;
  lightType: string;
  lightRadius: number;
  lightColor: string;
  lightIntensity: number;
  lightFalloff: string;
  lightDimRadius: number;
  lightAnimation: object | null;
  lightAngle: number;
  lightSpread: number;
  lightCoverageMode: boolean;
  // Select/Prop
  selectMode: string;
  selectedProp: string | null;
  propRotation: number;
  propFlipped: boolean;
  propScale: number;
  selectedPropAnchors: any[];
  selectedPropIds: string[];
  // Trim
  trimCorner: string;
  trimRound: boolean;
  trimInverted: boolean;
  trimOpen: boolean;

  setActiveTool(tool: string): void;
}
```

### Store 4: `clipboardStore`
**Purpose:** Copy/paste buffers. Ephemeral.

```typescript
interface ClipboardStore {
  clipboard: CellClipboard | null;
  pasteMode: boolean;
  propClipboard: PropClipboard | null;
  propPasteMode: boolean;
  lightClipboard: Light | null;
  lightPasteMode: boolean;
}
```

### Store 5: `catalogStore`
**Purpose:** Runtime asset catalogs. Loaded once at init.

```typescript
interface CatalogStore {
  propCatalog: PropCatalog | null;
  textureCatalog: TextureCatalog | null;
  lightCatalog: LightCatalog | null;

  loadAll(): Promise<void>;
}
```

### Store 6: `editorStore`
**Purpose:** Miscellaneous editor UI state that doesn't fit elsewhere.

```typescript
interface EditorStore {
  // Render
  texturesVersion: number;
  animClock: number;
  // Hover
  hoveredCell: { row: number; col: number } | null;
  hoveredCorner: { row: number; col: number } | null;
  selectedCells: any[];
  // File
  fileName: string;
  fileHandle: FileSystemFileHandle | null;
  // Session
  session: { active: boolean; playerCount: number };
  sessionToolsActive: boolean;
  statusInstruction: string | null;
  // Debug
  debugShowHitboxes: boolean;
}
```

## Notification System

### Current: Broadcast to All
```typescript
notify() → for each listener → listener.fn(state)
```

### Proposed: Selective Subscriptions
```typescript
// Each store has its own subscribe
dungeonStore.subscribe(callback);   // Only fires on dungeon changes
toolStore.subscribe(callback);      // Only fires on tool changes
viewportStore.subscribe(callback);  // Only fires on camera changes

// Legacy compatibility — broadcast from all stores
subscribeAll(callback);  // Fires on any store change
```

### Migration Path for Subscribers

The 18+ `subscribe()` call sites can be migrated incrementally:
1. Keep the current `subscribe()` function as `subscribeAll()` — it listens to all stores
2. Migrate one subscriber at a time to the specific store(s) it actually needs
3. Once all subscribers are migrated, remove `subscribeAll()`

## Migration Strategy

### Phase 1: Extract + Re-Export (Zero Breaking Changes)
1. Create individual store modules: `dungeon-store.ts`, `viewport-store.ts`, `tool-store.ts`, etc.
2. Each store owns its properties and exposes getters/setters
3. **`state.ts` re-exports everything** — all 64 importing files still work unchanged
4. `state.ts` becomes a facade that delegates to sub-stores

```typescript
// state.ts (facade)
import { dungeonStore } from './stores/dungeon-store.js';
import { toolStore } from './stores/tool-store.js';
import { viewportStore } from './stores/viewport-store.js';
// ... etc.

export const state = {
  get dungeon() { return dungeonStore.dungeon; },
  set dungeon(v) { dungeonStore.dungeon = v; },
  get activeTool() { return toolStore.activeTool; },
  set activeTool(v) { toolStore.activeTool = v; },
  // ... all 53 properties as getters/setters
};

// Re-export mutation functions
export { pushUndo, undo, redo, markDirty, notify, subscribe } from './stores/dungeon-store.js';
```

### Phase 2: Migrate Importers (File by File)
1. Change imports from `import { state } from '../state.js'` to specific stores
2. Start with leaf files (tools, panels) that only need 1-2 stores
3. Update subscribe calls to use specific store subscriptions
4. **Each file migration is independent** — can be done incrementally

### Phase 3: Remove Facade
1. Once all files import from specific stores, delete the facade in `state.ts`
2. Remove `subscribeAll()` if no longer used
3. Final cleanup

## File Impact Estimate

| Phase | Files Changed | Risk |
|-------|--------------|------|
| Phase 1 (facade) | 1 new file per store + state.ts rewrite | Low — no external API changes |
| Phase 2 (migrate) | 64 files (all state importers) | Medium — mechanical but tedious |
| Phase 3 (cleanup) | state.ts removal | Low — just removing dead code |

## Testing

- Existing 854 tests should pass through all phases (they import from state.ts which remains the facade)
- Add targeted tests for each sub-store's subscribe/notify behavior
- Phase 2 migrations can be verified by running the existing test suite after each batch

## Relationship to Undo Refactor

The undo/redo refactor (see `undo-refactor.md`) and state sub-store extraction are complementary:
- **Do undo refactor first** — it only modifies state.ts internals
- **Then extract sub-stores** — the new undo system naturally lives in `dungeonStore`
- The facade pattern in Phase 1 means both refactors can proceed independently
