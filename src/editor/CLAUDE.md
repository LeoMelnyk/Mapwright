# Dungeon Editor Automation Guide

This is the Puppeteer / `editorAPI` reference for Claude. The API has 250+ methods — **don't try to memorize them**. Use the runtime discovery calls below to find the right one. The static reference in this file covers the workflow and high-traffic methods only.

---

## API Discovery — start here

```json
["apiCategories"]
["apiSearch", "prop", { "category": "bulk-props", "limit": 10 }]
["apiDetails", "proposeFurnishing"]
```

**Categories:** `map`, `rooms`, `cells`, `walls-doors`, `labels`, `stairs-bridges`, `trims`, `fills`, `textures`, `lighting`, `props`, `bulk-props`, `relational`, `spatial`, `inspection`, `validation`, `transforms`, `levels`, `plan`, `undo-checkpoints`, `preview`, `session`, `catalog`, `discovery`, `operational`, `weather`, `vocab`.

If you're not sure a method exists, ask the runtime — never guess.

---

## Prerequisites

1. Dev server running: `cd mapwright && npm start` (port 3000)
2. Puppeteer installed: `cd mapwright && npm install`
3. Server check: `curl -s http://localhost:3000 > /dev/null && echo up || echo down`

---

## Quick Start

```bash
# Create + save a map
node tools/puppeteer-bridge.js \
  --commands '[["newMap","My Dungeon",20,30],["createRoom",2,2,8,12],["setDoor",5,12,"east"],["createRoom",2,14,8,22],["setLabel",5,7,"1"],["setLabel",5,18,"2"]]' \
  --screenshot my_dungeon.png \
  --save my_dungeon.json

# Edit existing
node tools/puppeteer-bridge.js --load my_dungeon.json --commands '[...]' --save my_dungeon.json

# Inspect
node tools/puppeteer-bridge.js --load my_dungeon.json --info

# Big batches: load commands from file
node tools/puppeteer-bridge.js --load base.json --commands-file plan.json --save out.json
```

### Bridge CLI

```
--load <file.json>        Load before commands
--commands '<json>'       Inline JSON command array
--commands-file <file>    Commands from JSON file
--screenshot <out.png>    Editor viewport screenshot
--export-png <out.png>    HQ render through full compile pipeline (use for deliverables)
--save <file.json>        Save map JSON after commands
--info                    Print map info
--continue-on-error       Don't stop on failure (still exits 1)
--dry-run                 Skip all file I/O
--port <number>           Editor port (default 3000)
--visible --slow-mo <ms>  Headed browser, watch the map build (debug mode)
```

`--screenshot` captures the viewport. `--export-png` renders through `compile.ts` with full lighting — use it for adventure deliverables.

---

## Recommended Workflow: planBrief → dry-run → execute

`planBrief` offloads all coordinate math. Pass a high-level brief; get back ready-to-execute commands.

```json
["planBrief", {
  "name": "The Keep",
  "theme": "stone-dungeon",
  "gridSize": 5,
  "corridorWidth": 3,
  "rooms": [
    { "label": "A1", "width": 12, "height": 8, "entrance": true },
    { "label": "A2", "width": 10, "height": 8 },
    { "label": "A3", "width": 8, "height": 6 }
  ],
  "connections": [
    { "from": "A1", "to": "A2", "direction": "north" },
    { "from": "A2", "to": "A3", "direction": "west", "type": "secret" }
  ]
}]
```

Returns `{ commands, mapSize }`. Save `commands` to a file, then:

```bash
# 1. Dry-run to check for failures
node tools/puppeteer-bridge.js --commands-file plan.json --dry-run --continue-on-error
# 2. Execute
node tools/puppeteer-bridge.js --commands-file plan.json --save dungeon.json --export-png dungeon.png
```

**Iterative protocol.** For full dungeon generation, build phase-by-phase with screenshots between phases — see [`mapwright/DESIGN.md`](../../DESIGN.md) "Iterative Build Protocol". Don't generate 50+ commands and execute blind.

---

## Command Format

Commands are a JSON array of `[methodName, arg1, arg2, ...]`:

```json
[["createRoom", 2, 2, 8, 12], ["setDoor", 5, 12, "east"], ["setLabel", 5, 7, "A1"]]
```

On failure: `FAILED [i] [method] (CODE): message {context}`. The `code` is stable (e.g. `OUT_OF_BOUNDS`, `UNKNOWN_PROP`, `ROOM_NOT_FOUND`); branch on it. The `context` carries the offending args / valid alternatives.

## Coordinate System

- `row`: vertical (0 = top, increases down)
- `col`: horizontal (0 = left, increases right)
- `direction`: `"north" | "south" | "east" | "west"` (cardinal); `"nw-se" | "ne-sw"` (diagonal walls only)
- All coordinates are 0-indexed cell positions in **(row, col)** order.
- Multi-level maps: coordinates are **absolute** in the full grid. Use `getLevels()` and `level.startRow` to translate.

**Useful tip helpers:**
- `getRoomBounds(label)` — exact bounds + center
- `findWallBetween(label1, label2)` — every wall on the shared boundary
- `findCellByLabel(label)` — locate a labeled cell

---

## High-Traffic API Reference

This section covers the methods you'll use on almost every map. **For everything else, use `apiSearch` / `apiDetails`.**

### Map Management

| Method | Args | Description |
|--------|------|-------------|
| `newMap` | `name, rows, cols, [gridSize=5], [theme="stone-dungeon"]` | Create empty dungeon |
| `loadMap` | `json` | Load from JSON. Returns `{ success, info }` |
| `getMap` | — | Export dungeon as JSON |
| `getMapInfo` | — | Map metadata snapshot |
| `getFullMapInfo` | — | Comprehensive: rooms+bounds, props, doors, lights, stairs, bridges |
| `getSessionInfo` | — | Editor state (catalogsLoaded, undoDepth, dirty, checkpoints, counts). Call as the first command to verify the editor isn't holding stale state |
| `setName` / `setTheme` / `setLabelStyle` / `setFeature` | — | Map metadata setters. `setFeature(name, enabled)`: `"grid"`, `"compass"`, `"scale"`, `"border"` |
| `listThemes` | — | Authoritative theme list — never hardcode |

### Rooms, Cells, Walls, Doors, Windows

| Method | Args | Description |
|--------|------|-------------|
| `createRoom` | `r1, c1, r2, c2, [mode="room"]` | Walled room. `mode="merge"` only walls void-facing edges (use when adjacent to existing room) |
| `createPolygonRoom` | `cells, [mode]` | L/U/+ shapes. `cells: [[r,c],...]` |
| `paintCell` / `paintRect` / `eraseCell` / `eraseRect` | — | Cell-level grid editing |
| `getCellInfo` | `row, col` | Inspect cell (full deep clone) |
| `setWall` / `removeWall` | `row, col, direction` | Walls (incl. diagonals `nw-se` / `ne-sw`) |
| `setDoor` / `removeDoor` | `row, col, direction, [type="d"]` | Type: `"d"` normal, `"s"` secret. Cardinal only |
| `setWindow` / `removeWindow` | `row, col, direction, [goboId="window-mullions"]` | Edge-level windows that block light below the aperture and project a gobo above. See `apiDetails("setWindow")` for the gobo id list |

### Labels

| Method | Args | Description |
|--------|------|-------------|
| `setLabel` / `removeLabel` | `row, col, [text]` | Room label (e.g. "A1") |

### Stairs (3-point geometry)

Stairs use 3 corner points in **grid-corner coordinates** (integers = grid intersections):
- **P1→P2**: base edge (hatch lines parallel to this)
- **P3**: depth target. Inward shift = 0 → rectangle; small → trapezoid; ≥ baseLen/2 → triangle.

| Method | Args | Description |
|--------|------|-------------|
| `addStairs` | `p1r, p1c, p2r, p2c, p3r, p3c` | Returns `{ success, id }` |
| `linkStairs` | `r1, c1, r2, c2` | Link two stair objects (auto A-Z label) |
| `removeStairs` | `row, col` | Remove the stair occupying this cell |
| `setStairs` | `row, col, direction` | Legacy 1×1 rectangle stair |

**linkStairs gotcha.** Cells are at `row = min(P1_row, P3_row)` — the shallower (topmost) row. If `linkStairs` says "no stairs to link", inspect saved JSON for cells where `center["stair-id"]` is set; those are the right coordinates.

### Bridges

```json
["addBridge", "wood", p1r, p1c, p2r, p2c, p3r, p3c]   // Types: wood|stone|rope|dock
["removeBridge", row, col]
["getBridges"]
```

Same 3-point geometry as stairs.

### Trim (diagonal corners)

```json
["roundRoomCorners", "A10", 4]                              // Recommended: round all 4 corners
["roundRoomCorners", "A10", 4, {"inverted": true}]          // Concave (cuts into room)
["createTrim", 2, 2, 5, 5, "nw", {"round": true}]           // Manual single corner
```

`(r1, c1)` is the corner **tip** — the outermost cell that gets voided. Corner labels match the visual position (`nw` = top-left, `se` = bottom-right). Options: `{ round, inverted, open }`.

### Fills

| Method | Args | Description |
|--------|------|-------------|
| `setFill` / `removeFill` | `row, col, fillType, [depth=1]` | Types: `"pit"`, `"water"`, `"lava"`. Depth 1–3 for water/lava |
| `setFillRect` / `removeFillRect` | `r1, c1, r2, c2, fillType, [depth=1]` | One undo step |
| `setHazard` / `setHazardRect` | `row, col, [enabled=true]` | Difficult terrain crosshatch overlay. **Not a fill type** — separate API |

### Spatial & Convenience

| Method | Args | Description |
|--------|------|-------------|
| `findCellByLabel` / `getRoomBounds` / `findWallBetween` | — | See "Useful tip helpers" above |
| `setDoorBetween` | `label1, label2, [type='d']` | Place door at midpoint of shared wall between **directly adjacent** rooms. Throws if not adjacent |
| `mergeRooms` | `label1, label2` | Remove all walls on the shared boundary |
| `createCorridor` | `label1, label2, [width=2]` | **Caves/tunnels only.** For structural buildings, use `setDoorBetween` on flush rooms |
| `partitionRoom` | `roomLabel, direction, position, [wallType='w'], [{doorAt}]` | Internal wall partition |
| `shiftCells` | `dr, dc` | Shift everything; grid grows automatically |
| `normalizeMargin` | `[targetMargin=2]` | Trim/expand grid to exactly N empty cells of margin around content |

### AI Helpers (the workflow primitives)

| Method | Args | Description |
|--------|------|-------------|
| `planBrief` | `brief` | **Flagship.** Compute layout from rooms + connections. See workflow above |
| `listRooms` | — | All labeled rooms with bounds + center. **Always call after `planBrief` / `normalizeMargin`** — input estimates are not exact |
| `listRoomCells` | `label` | All floor cells in a room |
| `getRoomContents` | `label` | Props, fills, doors, textures within bbox |
| `getPropFootprint` | `propType, [facing=0]` | Cells a prop occupies relative to anchor — confirm orientation before placing wall props |
| `getValidPropPositions` | `label, propType, [facing=0]` | Valid anchor cells (free space — does not exclude stair cells) |
| `placeLightInRoom` | `label, preset, [config]` | Light at room center, no world-feet math |
| `roundRoomCorners` | `label, [trimSize=3], [{inverted}]` | All 4 corners at once |
| `suggestPlacement` | `rows, cols, [adjacentTo]` | Find free rectangular area |

### Inspection (cheap structured queries — avoid screenshots)

| Method | Args | Description |
|--------|------|-------------|
| `renderAscii` | `r1, c1, r2, c2` | ASCII grid. Glyphs: `.` floor, ` ` void, `~` water, `^` lava, `_` pit, `:` hazard, `o` prop, `*` label, `>` stair, `=` bridge, walls `|`/`-`, doors `D`/`S`. Region capped at 80 cols |
| `inspectRegion` | `r1, c1, r2, c2` | Full structured dump of every cell + lights centered in region |
| `getRoomSummary` | `label` | One call: bounds, cell count, props, fills, doors, textures, lights affecting, adjacent rooms |
| `queryCells` | `predicate` | Find cells matching `{ prop?, fill?, hasLabel?, hasDoor?, hasWall?, hasStair?, isVoid?, hasHazard?, region? }` (AND-combined). Array values for `prop`/`fill` mean any-of |
| `getLightingCoverage` | `[darkThreshold=0.15], [region]` | Per-cell intensity estimate. **Ignores wall shadows for speed** |
| `getPropPlacementOptions` | `label, propType, [{facing,includeInvalid}]` | Every candidate with `valid: bool` + reasons (`OUT_OF_ROOM`, `OVERLAPS_PROP`, `BLOCKS_DOOR`, `BLOCKS_DOOR_APPROACH`) |
| `findConflicts` | `[{entranceLabel,darkThreshold}]` | Single-call audit: blocked doors, unreachable rooms, lights in void, dark rooms |
| `describeMap` | — | ASCII per room + numbered prop sidecar — verify "did things land where I think?" without a screenshot |

### Validation

| Method | Args | Description |
|--------|------|-------------|
| `explainCommand` | `method, ...args` | Dry-run a single command. Mutating commands roll back; reads return their result |
| `validateCommands` | `commands, [{stopOnError}]` | Dry-run a batch (each command sees the cumulative effect of prior ones). Returns `{ allOk, results }` |
| `validateDoorClearance` | — | Check for props blocking doors / approach cells |
| `validateConnectivity` | `entranceLabel` | BFS from entrance — returns reachable / unreachable rooms |
| `critiqueMap` | — | Run completeness / lighting / spatial / composition heuristics over the whole map |

### Props

| Method | Args | Description |
|--------|------|-------------|
| `placeProp` | `row, col, propType, [facing=0], [{scale,flipped,x,y,zIndex,allowOverlap}]` | Returns `{ success, lightsAdded? }`. **If `lightsAdded` is non-empty, do NOT also call `placeLight` at that cell — the prop already brought its own light** |
| `removeProp` / `removePropAt` | `row, col` | Remove |
| `removePropsInRect` | `r1, c1, r2, c2` | Bulk remove |
| `rotateProp` / `setPropRotation` / `flipProp` | — | Orientation |
| `movePropInCells` | `row, col, dr, dc` | Move; linked lights follow |
| `listProps` | — | Authoritative catalog (~1500 props across many categories — never hardcode) |
| `getPropsForRoomType` | `roomType` | E.g. `"library"`, `"forge"` |
| `searchProps` | `[{placement, roomTypes, category, facing, maxFootprint, minFootprint, namePattern}]` | Filter the catalog |
| `listLightEmittingProps` | — | Props that auto-emit on placement (so you don't double-add a light) |
| `renderPropPreview` / `getPropThumbnails` | — | Cached PNGs for visual prop picking |

**Footprint is R×C (rows × cols), not W×H.** A `1×2` prop is 1 row tall × 2 cols wide. At rotation 0 it extends east; at 90 it extends south. Use `getPropFootprint(propType, rotation)` for ground truth before placing on a wall.

### Bulk Prop Placement

| Method | Args | Description |
|--------|------|-------------|
| `fillWallWithProps` | `roomLabel, propType, wall, [{facing,gap,inset,skipDoors}]` | Auto-computes rotation per wall — no `facing` needed for wall-mounted props |
| `lineProps` | `roomLabel, propType, startRow, startCol, direction, count, [{facing,gap}]` | Rows of pillars/pews |
| `scatterProps` | `roomLabel, propType, count, [{facing,avoidWalls,avoidDoors}]` | Organic placement |
| `clusterProps` | `roomLabel, [{type,dr,dc,facing},...], anchorRow, anchorCol` | Furniture groupings |
| `proposeFurnishing` | `[{rooms,density,symmetric,lightCap}]` | Plan-then-commit. Inspect / edit the plan before placement |
| `commitFurnishing` | `plan` | Apply a proposed plan |
| `autofurnish` | `label, roomType, [{density,preferWall}]` | Catalog-driven furnishing for one room |
| `furnishBrief` | `{rooms:[{label,role,density?}]}` | Furnish many rooms in one call |

All bulk methods return `{ placed, skipped, lightsAdded }`. `skipped` codes: `OVERLAPS_PROP`, `OUT_OF_ROOM`, `DOOR_HERE`, `DOOR_APPROACH`, `CELL_VOID`, `PLACE_FAILED`.

**Bulk placement methods place one prop per undo step.** For atomic rollback, wrap with `getUndoDepth()` before and `undoToDepth()` after — or use checkpoints (below).

### Bulk Transforms

```json
["cloneRoom", "A1", 0, 12, {"newLabel": "A2"}]   // Cells, props, lights, overlay props
["mirrorRegion", r1, c1, r2, c2, "horizontal"]   // E↔W. Multi-cell props/lights NOT transformed
["rotateRegion", r1, c1, r2, c2, 90]             // Square regions only
["replaceProp", "old-type", "new-type", {"region": {...}}]
["replaceTexture", "old/id", "new/id"]
```

### Lighting

| Method | Args | Description |
|--------|------|-------------|
| `placeLight` | `x, y, [config]` | World-feet coords (`x = col * gridSize`). Use `preset: "torch"` for catalog defaults |
| `removeLight` | `id` | — |
| `getLights` | — | All lights (deep copy) |
| `setAmbientLight` / `setLightingEnabled` | — | Map-level toggles |
| `listLightPresets` | — | Authoritative preset list (47 presets — `apiSearch` for the rest of the lighting API) |

**Light radius cap: 28 indoors, never higher.** Multiple weak lights (12–18) read better than one large one. Default config: `{type: 'point', radius: 30, color: '#ff9944', intensity: 1.0, falloff: 'smooth'}`.

Advanced lighting (animations, groups, cookies, soft shadows, darkness mode) is documented via `apiSearch`/`apiDetails`. See [`src/themes/CLAUDE.md`](../themes/CLAUDE.md) for the `.light` and `.gobo` file formats.

### Textures

```json
["setTexture", row, col, "polyhaven/cobblestone_floor_03", 0.85]
["setTextureRect", r1, c1, r2, c2, "polyhaven/cobblestone_floor_03"]
["floodFillTexture", row, col, "polyhaven/dirt_floor"]
["waitForTextures"]   // ALWAYS call before getScreenshot/export
```

**Texture IDs are full Polyhaven paths.** Short IDs like `"cobblestone"` silently fail. **Always call `listTextures()` before a texture pass** — the catalog grows over time. Common defaults: `polyhaven/cobblestone_floor_03` (dungeon stone), `polyhaven/dirt_floor` (caves), `polyhaven/wood_floor` (interiors).

The server must be started with `MAPWRIGHT_TEXTURE_PATH` set for textures to appear in PNG exports:

```bash
MAPWRIGHT_TEXTURE_PATH="C:\\Users\\leonk\\AppData\\Roaming\\mapwright\\textures" npm start
```

Edge blending is per-theme via `theme.textureBlendWidth` (0.0–1.0).

### Weather

```json
["createWeatherGroup", { "name": "Courtyard rain", "type": "rain", "intensity": 0.7, "lightning": { "enabled": true } }]
// → returns { id }, then assign cells:
["setWeatherRect", r1, c1, r2, c2, "wg-abc123"]
["floodFillWeather", row, col, "wg-abc123"]
```

Types: `rain`, `snow`, `ash`, `embers`, `sandstorm`, `fog`, `leaves`, `cloudy`. Lightning spawns ephemeral lights at render time, so a strike inside a walled room flashes only that room. Split cells (diagonal/trim) require `halfKey` (`'ne'`/`'sw'` or `'interior'`/`'exterior'`).

### Levels

```json
["addLevel", "Level 2", 15]
["getLevels"]    // → [{ index, name, startRow, numRows }]
["resizeLevel", levelIndex, newRows]
["renameLevel", levelIndex, newName]
["defineLevels", [{ name, startRow, numRows }, ...]]   // Without adding rows
```

### Undo / Checkpoints

```json
["checkpoint", "after-rooms"]
["setTextureRect", ...]
["scatterProps", ...]
["rollback", "after-rooms"]   // Undo back to the checkpoint; checkpoint is preserved
```

Prefer named checkpoints over `getUndoDepth`/`undoToDepth(N)` — they survive across Puppeteer calls without you tracking integers. Cleared automatically on `newMap`/`loadMap`. Other methods: `undo`, `redo`, `getUndoDepth`, `undoToDepth`, `listCheckpoints`, `clearCheckpoint`, `diffFromCheckpoint`.

### Transactions

```json
["transaction", [["createRoom",...], ["setLabel",...], ["placeProp",...]]]
```

All-or-nothing: on any failure, every preceding command in the batch is undone. Distinct from `validateCommands` (always rolls back) and `--continue-on-error` (leaves partial state).

### Operational

| Method | Args | Description |
|--------|------|-------------|
| `waitForEditor` | `[timeoutMs=15000]` | Wait for full init (canvas + catalogs + state). First call in any Puppeteer script |
| `waitForRender` | `[timeoutMs=3000]` | Wait until the lighting version stops advancing for two consecutive frames |
| `waitForTextures` | `[timeoutMs=8000]` | Wait for textures to load. Always before `getScreenshot` after texture commands |
| `clearCaches` | — | Reload catalogs (after editing prop/theme/light files on disk) |
| `render` | — | Force re-render |
| `eval` | `code` | Escape hatch — JS in editor context with `state` and `editorAPI` |
| `pauseForReview` | — | Block batch execution for human inspection (use with `--visible --slow-mo`) |

### Annotated Screenshots

```bash
node tools/puppeteer-bridge.js --load map.json --screenshot out.png \
  --highlight '[{"row":5,"col":7,"label":"throne","color":"#ffd000"}]'
```

Each highlight: `{ row, col, [rows=1], [cols=1], [color="#ff3030"], [shape="box"|"dot"|"cross"], [label] }`. Confirm "is this the cell I think it is?" without a second screenshot.

---

## Common Patterns

### Multi-room dungeon (flush rooms, structural building)

```json
[
  ["newMap", "Goblin Cave", 25, 35],
  ["createRoom", 2, 2, 8, 12], ["setLabel", 5, 7, "1"],
  ["createRoom", 2, 13, 8, 22], ["setLabel", 5, 17, "2"],
  ["setDoorBetween", "1", "2"]
]
```

Note `1` ends at col 12, `2` starts at col 13 — they share the wall, no gap. **Don't use `createCorridor` for buildings** — use it only for caves/tunnels with genuine gaps. See `mapwright/DESIGN.md` "Room Connectivity" for the full decision guide.

### Round all corners (circular chamber)

```json
["roundRoomCorners", "A10", 4]
```

### Furnish a room with props

```json
[
  ["placeProp", 3, 3, "pillar"],
  ["placeProp", 3, 10, "pillar"],
  ["placeProp", 5, 6, "throne", 180],
  ["placeProp", 4, 4, "brazier"]
]
```

`brazier` auto-emits a light — `placeProp` returns `lightsAdded: [{id, preset:"brazier"}]`. Don't add a separate `placeLight` at that cell.

### Two-level dungeon with linked stairs

```json
[
  ["newMap", "Tower", 35, 20],
  ["createRoom", 2, 2, 12, 18], ["setLabel", 7, 10, "1"],
  ["addStairs", 10, 10, 10, 11, 11, 11],
  ["addLevel", "Level 2", 15],
  ["getLevels"]
]
```

After `getLevels`, note `startRow` for Level 2, then create matching stairs and `linkStairs` across.

### Rollback with checkpoints

```json
[
  ["createRoom", 2, 2, 8, 12],
  ["checkpoint", "after-rooms"],
  ["setTextureRect", 2, 2, 8, 12, "polyhaven/cobblestone_floor_03"],
  ["checkpoint", "after-textures"],
  ["scatterProps", "A1", "rubble", 5]
  // If rubble looks wrong:
  // ["rollback", "after-textures"]
]
```

---

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `no wall at that position` | `setDoor` called where no wall exists | Check room boundaries; door must be on a wall between two regions |
| `unknown method: X` | Misspelled method | Use `apiSearch` to find the right name |
| `unknown prop type: X` | Misspelled prop | `listProps()` for exact names; kebab-case (e.g. `"map-table"`) |
| `out of bounds` | row/col outside grid | `getMapInfo()` to check rows/cols (0-indexed) |
| `invalid fill type` | Bad fill type | Only `"pit"`, `"water"`, `"lava"` for `setFill`/`setFillRect`. For difficult terrain use `setHazard`/`setHazardRect` |

---

## Tips

- **Discover, don't guess.** Use `apiSearch`/`apiDetails` whenever you're unsure a method exists.
- `--export-png` for adventure deliverables; `--screenshot` for quick previews.
- `--commands-file` over inline `--commands` for batches > ~20 commands.
- `--dry-run --continue-on-error` validates a batch cheaply before committing.
- All mutating methods auto-push to undo. Use checkpoints for named rollback.
- Use `placeProp` with `preset:"torch"` etc. instead of hand-specifying `color/radius/intensity`.
- `setDoorBetween` (rooms must be flush) > `findWallBetween` + `setDoor`.
- `listRooms` after `planBrief` or `normalizeMargin` — input estimates are not exact.
- For full-map generation, **iterate phase-by-phase** with screenshots between phases. See [`mapwright/DESIGN.md`](../../DESIGN.md).

---

## See Also

- [`mapwright/DESIGN.md`](../../DESIGN.md) — Iterative build protocol, room semantic library, spatial rules, prop density. Read before generating any map.
- [`mapwright/CLAUDE.md`](../../CLAUDE.md) — Domain routing, data shapes, debugging strategy.
- [`src/props/CLAUDE.md`](../props/CLAUDE.md) — `.prop` file format and authoring guide.
- [`src/themes/CLAUDE.md`](../themes/CLAUDE.md) — `.theme`, `.light`, `.gobo` file formats.
