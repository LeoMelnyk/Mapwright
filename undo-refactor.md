# Undo/Redo Refactor: JSON Snapshots → Targeted Diffs

## Problem

Every `pushUndo()` call serializes the **entire** `state.dungeon` via `JSON.stringify()`. For a 20×30 dungeon with props, lights, and textures, that's 5–50KB per edit. With MAX_UNDO=100, that's up to 5MB of JSON strings in memory — most of which is identical between consecutive entries.

Worse, there's no undo grouping: painting 10 cells with a drag creates 10 undo entries (though some tools batch via a single `pushUndo()` before a loop).

## Current System

```
UndoEntry = { json: string, label: string, timestamp: number (unused) }

pushUndo(label?) → JSON.stringify(state.dungeon) → undoStack.push()
undo()           → pop undoStack → push current to redoStack → JSON.parse(entry.json)
redo()           → pop redoStack → push current to undoStack → JSON.parse(entry.json)
jumpToState(idx) → splice undoStack at idx → move remainder to redo → restore target
```

178 call sites across: 18 API files, 14 tool files, 13 panel files, core files.

## Proposed System: Operation Patches

Replace full JSON snapshots with **forward/reverse patches** — small objects describing exactly what changed.

### New UndoEntry

```typescript
interface UndoEntry {
  label: string;
  timestamp: number;
  patches: Patch[];       // Forward patches (undo→redo direction)
  inversePatches: Patch[]; // Reverse patches (redo→undo direction)
}

type Patch =
  | { op: 'cell', row: number, col: number, before: Cell | null, after: Cell | null }
  | { op: 'meta', path: string[], before: unknown, after: unknown }
  | { op: 'replace', before: string, after: string }  // Full replacement (file load)
```

### Three Patch Types

1. **Cell patches** — Most common. Captures the before/after of a single cell. Cells are small (~200 bytes each), so storing before+after of changed cells is vastly cheaper than the full grid.

2. **Metadata patches** — For lights, stairs, bridges, props, features, theme changes. Uses a JSON path like `['lights', 3]` or `['lightingEnabled']` to target the specific metadata field.

3. **Replace patches** — For full dungeon replacements (file load, new map). Falls back to the current behavior — stores before/after as full JSON strings. These are rare (1-2 per session).

### Mutation Recording API

```typescript
// Start recording changes
const recorder = beginUndoGroup('Paint cells');

// Make changes — recorder intercepts mutations
state.dungeon.cells[5][3] = { east: 'w', south: 'd' };
state.dungeon.metadata.lights.push(newLight);

// Finalize — computes patches and pushes to stack
recorder.commit();  // or recorder.discard() to abort
```

**Implementation approach:** Use a `Proxy`-based recorder that wraps `state.dungeon` during a mutation group. The proxy intercepts property sets on cells and metadata, capturing before/after values. When `commit()` is called, it computes the minimal patch set.

### Alternative: Snapshot Diff (Simpler, Less Efficient)

If Proxy-based recording is too invasive:

```typescript
function pushUndo(label: string): void {
  const beforeJson = JSON.stringify(state.dungeon);
  // ... later, after mutations ...
  const afterJson = JSON.stringify(state.dungeon);
  const patches = computeDiff(beforeJson, afterJson);
  undoStack.push({ label, patches, inversePatches: invertPatches(patches) });
}
```

This compares before/after snapshots to produce minimal diffs. Simpler to implement (no Proxy), but still requires two full serializations. Good as a stepping stone.

### Undo/Redo Application

```typescript
function undo(): void {
  const entry = undoStack.pop();
  redoStack.push(entry);
  applyPatches(state.dungeon, entry.inversePatches);  // Apply reverse patches
  markDirty();
  notify();
}

function redo(): void {
  const entry = redoStack.pop();
  undoStack.push(entry);
  applyPatches(state.dungeon, entry.patches);  // Apply forward patches
  markDirty();
  notify();
}
```

### jumpToState Migration

`jumpToState(targetIndex)` currently restores a full JSON snapshot. With patches:

```typescript
function jumpToState(targetIndex: number): void {
  // Apply inverse patches from current position back to target
  while (undoStack.length > targetIndex + 1) {
    const entry = undoStack.pop();
    applyPatches(state.dungeon, entry.inversePatches);
    redoStack.push(entry);
  }
  markDirty();
  notify();
}
```

## Migration Strategy

### Phase 1: Snapshot Diff (Low Risk)
1. Modify `pushUndo()` to capture `beforeJson` snapshot
2. Add `afterPushUndo()` that computes diff and stores patches
3. Keep `json` field as fallback — store full snapshot only every Nth entry (e.g., every 10th) as a "keyframe"
4. Undo/redo: if patches exist, apply them; if only json exists, fall back to full restore
5. **Zero changes to call sites** — the 178 callers don't change

### Phase 2: Undo Grouping
1. Add `beginUndoGroup(label)` / `endUndoGroup()` API
2. Multiple mutations within a group produce one undo entry
3. Retrofittools that batch (paint drag, room creation) to use groups
4. **Reduces undo entry count dramatically**

### Phase 3: Proxy-Based Recording (Optional)
1. Replace snapshot diff with Proxy-based mutation interception
2. Eliminates the "two serializations" cost
3. Only worthwhile if Phase 1 performance is insufficient

### Phase 4: Keyframe Compression
1. Store a full snapshot every N entries (keyframe)
2. Between keyframes, store only patches
3. jumpToState restores nearest keyframe, then applies patches forward/backward
4. Reduces memory by ~90% for typical editing sessions

## Undo Grouping Design

```typescript
let _groupDepth = 0;
let _groupPatches: Patch[] = [];
let _groupLabel = '';

export function beginUndoGroup(label: string): void {
  if (_groupDepth === 0) {
    _groupLabel = label;
    _groupPatches = [];
    // Capture before-state of dungeon
  }
  _groupDepth++;
}

export function endUndoGroup(): void {
  _groupDepth--;
  if (_groupDepth === 0) {
    // Compute final patches, push to undo stack
    undoStack.push({ label: _groupLabel, patches: _groupPatches, ... });
  }
}
```

This handles the nested-pushUndo problem (where `fillWallWithProps` calls `placeProp` which calls `pushUndo` internally). Inner calls just accumulate patches; only the outermost group creates the undo entry.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Patch application produces invalid state | Keyframe every 10 entries; full validation on apply |
| Performance of diff computation | Cell-level granularity is fast; metadata paths are small |
| History panel breaks | Panel only uses `label` field — no changes needed |
| File load/new map | Use `replace` patch type — full before/after |
| Concurrent mutations | Single-threaded JS — not a concern |
| Proxy browser compat | All modern browsers support Proxy; skip if Electron target is old |

## Files to Modify

| File | Changes |
|------|---------|
| `src/types.ts` | New `Patch`, `UndoEntry` types |
| `src/editor/js/state.ts` | `pushUndo()`, `undo()`, `redo()`, `jumpToState()` rewrite |
| `src/editor/js/panels/history.ts` | Minor — may need to display patch count |
| All 178 call sites | Phase 1: zero changes. Phase 2: wrap batched operations in groups |
