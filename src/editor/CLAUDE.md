# Dungeon Editor Automation Guide

This guide explains how to programmatically create and edit maps using the editor's automation API. Claude is the primary intended user of this API.

## API Discovery (start here)

The API has 250+ methods. Don't try to load this whole doc unless you need a deep dive — instead, search for the right method:

```json
["apiSearch", "prop", { "category": "bulk-props", "limit": 10 }]
["apiDetails", "proposeFurnishing"]
["apiCategories"]
```

Categories: `map`, `rooms`, `cells`, `walls-doors`, `labels`, `stairs-bridges`, `trims`, `fills`, `textures`, `lighting`, `props`, `bulk-props`, `relational`, `spatial`, `inspection`, `validation`, `transforms`, `levels`, `plan`, `undo-checkpoints`, `preview`, `session`, `catalog`, `discovery`, `operational`.

## What's new in this guide

| Method | Category | Use when |
|---|---|---|
| `describeMap` | inspection | Need to verify "did things land where I think?" without paying for a screenshot. Returns ASCII per room + numbered prop sidecar. |
| `placeRelative` / `placeSymmetric` / `placeFlanking` | relational | Placing props relative to anchors or with bilateral symmetry — saves coordinate math. |
| `proposeFurnishing` / `commitFurnishing` | bulk-props | Plan-then-commit furnishing: inspect/edit the plan before placement. Supersedes black-box `autofurnish`. |
| `critiqueMap` | validation | Run design heuristics (completeness, lighting, spatial, composition) over the whole map. |
| `listLightEmittingProps` | catalog | Know which props auto-emit a light when placed (so you don't double-add a `placeLight` at the same cell). |
| `diffFromCheckpoint` | undo-checkpoints | Summarize what `rollback(name)` would throw away. |
| `getPropThumbnail` / `getPropThumbnails` | preview | Cached small PNG for visual prop picking — cheaper than full screenshots. |
| `pauseForReview` | operational | Block batch execution for human inspection (best with `--visible --slow-mo`). |

`placeProp` now returns `lightsAdded: [{id, preset}]` when the prop auto-emits a light. If you see this in the result, do NOT also call `placeLight` at that cell.

## Prerequisites

1. The dev server must be running: `cd mapwright && npm start` (serves on port 3000)
2. Puppeteer must be installed: `cd mapwright && npm install`

## Quick Start

```bash
# Create a simple dungeon and save it
node tools/puppeteer-bridge.js \
  --commands '[["newMap","My Dungeon",20,30],["createRoom",2,2,8,12],["setDoor",5,12,"east"],["createRoom",2,14,8,22],["setLabel",5,7,"1"],["setLabel",5,18,"2"]]' \
  --screenshot my_dungeon.png \
  --save my_dungeon.json

# Edit an existing map
node tools/puppeteer-bridge.js \
  --load my_dungeon.json \
  --commands '[["createRoom",10,5,15,10,"merge"],["setDoor",10,7,"north"]]' \
  --screenshot updated.png \
  --save my_dungeon.json

# Inspect a map
node tools/puppeteer-bridge.js --load my_dungeon.json --info

# Load a commands list from file (useful for complex maps)
node tools/puppeteer-bridge.js --load base.json --commands-file my_commands.json --save out.json

```

## Bridge CLI Options

```
node tools/puppeteer-bridge.js [options]

--load <file.json>        Load map before commands
--commands '<json>'       Inline JSON command array
--commands-file <file>    Commands from a JSON file
--screenshot <out.png>    Save screenshot after commands
--save <file.json>        Save map JSON after commands
--export-png <out.png>    Export high-quality PNG via full render pipeline (HQ lighting)
--info                    Print map info to stdout (see format below)
--continue-on-error       Don't stop on failed command (still exits 1 if any failed)
--dry-run                 Execute commands but skip all file I/O (screenshot, save, export)
--port <number>           Editor port (default: 3000)
```

## Claude Workflow: Recommended Dungeon Generation Process

Use this 3-step process to build dungeons efficiently, offloading all coordinate math to the editor.

### Step 1 — Plan with `planBrief`

Call `planBrief` with a high-level description of rooms and connections. The editor computes all coordinates and returns ready-to-execute commands.

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

The result contains a `commands` array you can save to a file and pass to `--commands-file`.

### Step 2 — Validate with `--dry-run`

Run the commands without writing any files to check for failures:

```bash
node tools/puppeteer-bridge.js --commands-file plan.json --dry-run --continue-on-error
```

### Step 3 — Execute

Once the dry run passes, run without `--dry-run` to produce the final map:

```bash
node tools/puppeteer-bridge.js --commands-file plan.json --save dungeon.json --export-png dungeon.png
```

---

## Command Format

Commands are a JSON array of `[methodName, arg1, arg2, ...]`:

```json
[
  ["createRoom", 2, 2, 8, 12],
  ["setDoor", 5, 12, "east"],
  ["setLabel", 5, 7, "A1"]
]
```

On failure, output shows the command index: `FAILED [2] [setDoor]: no wall at that position`

## Coordinate System

- **row**: vertical position (0 = top, increases downward)
- **col**: horizontal position (0 = left, increases rightward)
- **direction**: `"north"`, `"south"`, `"east"`, `"west"` (cardinal); `"nw-se"`, `"ne-sw"` (diagonal, walls only)
- All coordinates are 0-indexed cell positions in **row, col** order.
- For multi-level maps, all coordinates are **absolute** row/col in the full grid. Use `startRow` from `getLevels()` to calculate positions within a specific level.

### Coordinate Tips

**Finding room center for label placement:**
Given a room spanning rows 2–8, cols 3–12: center is approximately row 5, col 7. Use `getRoomBounds(label)` to get exact bounds and compute center as `Math.floor((r1+r2)/2), Math.floor((c1+c2)/2)`.

**Finding the wall between two adjacent rooms:**
Use `findWallBetween(label1, label2)` — returns all `{ row, col, direction }` positions on the shared boundary, so you can pick the best door location.

**Multi-level row offsets:**
Call `getLevels()` first. Each level has `startRow`. A cell at row 3 of Level 2 is at absolute row `level2.startRow + 3`.

## --info Output Format

```json
{
  "name": "My Dungeon",
  "rows": 25,
  "cols": 35,
  "gridSize": 5,
  "theme": "stone-dungeon",
  "labelStyle": "circled",
  "features": {
    "showGrid": false,
    "compassRose": false,
    "scale": false,
    "border": false
  },
  "levels": [
    { "index": 0, "name": null, "startRow": 0, "numRows": 25 }
  ],
  "propCount": 4,
  "labelCount": 3,
  "textureIds": ["cobblestone", "wood"],
  "lightCount": 2,
  "lightingEnabled": true
}
```

## API Reference

### Map Management

| Method | Args | Description |
|--------|------|-------------|
| `newMap` | `name, rows, cols, [gridSize=5], [theme="stone-dungeon"]` | Create empty dungeon |
| `loadMap` | `json` | Load from JSON string or object |
| `getMap` | — | Export dungeon as JSON |
| `getMapInfo` | — | Get map metadata (see --info format above) |
| `getFullMapInfo` | — | Comprehensive state: everything in `getMapInfo` plus full room list (with bounds), all props, all doors, lights, stairs, bridges |
| `setName` | `name` | Set dungeon name |
| `setTheme` | `theme` | Set theme (e.g. `"stone-dungeon"`) |
| `setLabelStyle` | `style` | Set label style: `"circled"`, `"plain"`, or `"bold"` |
| `setFeature` | `feature, enabled` | Toggle feature flag. Names: `"grid"`, `"compass"`, `"scale"`, `"border"` |


### Room Creation

| Method | Args | Description |
|--------|------|-------------|
| `createRoom` | `r1, c1, r2, c2, [mode="room"]` | Create walled room. Mode: `"room"` (walls all edges) or `"merge"` (only walls void-facing edges) |

The room tool auto-walls the boundary and clears interior walls. Use `"merge"` to add rooms adjacent to existing ones without double walls.

### Cell Operations

| Method | Args | Description |
|--------|------|-------------|
| `paintCell` | `row, col` | Paint floor (create empty cell) |
| `paintRect` | `r1, c1, r2, c2` | Paint rectangle of cells |
| `eraseCell` | `row, col` | Erase cell (set to void) |
| `eraseRect` | `r1, c1, r2, c2` | Erase rectangle |
| `getCellInfo` | `row, col` | Inspect cell (returns JSON or null) |

### Walls

| Method | Args | Description |
|--------|------|-------------|
| `setWall` | `row, col, direction` | Place wall (+ reciprocal on neighbor) |
| `removeWall` | `row, col, direction` | Remove wall (+ reciprocal) |

Directions: `"north"`, `"south"`, `"east"`, `"west"`, `"nw-se"`, `"ne-sw"`

### Doors

| Method | Args | Description |
|--------|------|-------------|
| `setDoor` | `row, col, direction, [type="d"]` | Place door. Type: `"d"` (normal) or `"s"` (secret) |
| `removeDoor` | `row, col, direction` | Remove door (reverts to wall) |

Directions: `"north"`, `"south"`, `"east"`, `"west"` only.

### Windows

Windows are edge-level entities that block light on the floor (like a wall) but project a gobo pattern through an aperture 4–6 ft above the floor — a "sunpool" on the far side shaped by the chosen gobo. Adjacent windows render as one continuous wide window; adjacent windows sharing a `goboId` also merge their gobo projection into a single continuous pattern.

| Method | Args | Description |
|--------|------|-------------|
| `setWindow` | `row, col, direction, [goboId="window-mullions"]` | Place a window on a cardinal edge. Marks the edge as `"win"` and associates the chosen gobo. If a window already exists at that edge, the gobo is swapped in place. |
| `removeWindow` | `row, col, direction` | Remove a window (reverts the edge to a wall and drops the metadata entry). |

Directions: `"north"`, `"south"`, `"east"`, `"west"` only.

**Available gobo ids** (14 total, all procedurally rendered — no texture assets required): `arrow-slit`, `ceiling-grate`, `cruciform`, `diamond-lattice`, `double-hung`, `horizontal-clerestory`, `horizontal-slats`, `leaded-grid`, `narrow-casement`, `portcullis-window`, `rose-window`, `tall-lancet`, `vertical-bars`, `window-mullions`. Invalid ids are accepted but produce no projection at render time.

**Data model.** Windows live in `metadata.windows: [{ row, col, direction, goboId }]`. `direction` is always stored canonically as `"north"` or `"west"`; south/east edges of the clicked cell are transparently re-expressed as the neighbor's north/west. This means `getCellInfo` at a window cell shows `"north": "win"` on the owning cell and `"south": "win"` on its neighbor, but `metadata.windows` holds exactly one entry per physical window.

### Labels

| Method | Args | Description |
|--------|------|-------------|
| `setLabel` | `row, col, text` | Set room label (e.g. "A1", "1") |
| `removeLabel` | `row, col` | Remove label |

### Stairs

Stairs are defined by **3 corner points** in grid-corner coordinates (integers = grid intersections):
- **P1→P2**: the base edge (hatch lines are parallel to this)
- **P3**: the depth target — determines shape and taper

The hatch pattern is computed by decomposing P3 relative to P2:
- **Inward shift** = 0 → rectangle (parallel lines, same width as base)
- **Small inward** → trapezoid (lines narrow progressively)
- **Large inward** (≥ baseLen/2) → triangle (lines converge to a point)

| Method | Args | Description |
|--------|------|-------------|
| `addStairs` | `p1r, p1c, p2r, p2c, p3r, p3c` | Place stairs from 3 corner points. Returns `{ success, id }` |
| `setStairs` | `row, col, direction` | Legacy: creates a 1×1 rectangle stair. Direction: `"up"` or `"down"` |
| `removeStairs` | `row, col` | Remove the entire stair object that occupies this cell |
| `linkStairs` | `r1, c1, r2, c2` | Link two stair objects (auto-assigns A-Z label). Specify any cell of each stair |

**Examples:**
```
addStairs(5,2, 5,5, 4,5)   → 3-cell rectangle (P3 straight across from P2)
addStairs(5,2, 5,5, 4,4)   → 3-cell trapezoid (P3 shifted 1 cell inward, narrow end = 1)
addStairs(5,2, 5,5, 4,2)   → 3-cell triangle (P3 shifted 3 cells inward, converges to point)
addStairs(5,5, 5,6, 4,6)   → 1-cell rectangle (full parallel lines)
addStairs(5,5, 5,6, 4,5)   → 1-cell triangle (converges to far edge midpoint)
```

**Data model:** Stairs are stored in `metadata.stairs[]` as `{ id, points: [[r,c],[r,c],[r,c]], link: "A"|null }`. Each occupied cell stores `center["stair-id"]` referencing the stair ID.

**`linkStairs` cell coordinates:** The stair cells (for `linkStairs`) are at `row = min(P1_row, P3_row)`, i.e. the shallower (topmost) row of the stair footprint — **not always at P1**. When a stair points downward (P3 below P1), cells are at P1_row. When pointing upward (P3 above P1), cells are at P3_row. Column range starts at P1_col. If `linkStairs` fails with "no stairs to link", inspect the saved JSON: look for cells where `center["stair-id"]` is set — those are the correct coordinates.

### Bridges

Bridges span over void or water using 3 corner points (same geometry as stairs).

| Method | Args | Description |
|--------|------|-------------|
| `addBridge` | `type, p1r, p1c, p2r, p2c, p3r, p3c` | Place a bridge. Types: `"wood"`, `"stone"`, `"rope"`, `"dock"`. Same 3-point geometry as `addStairs`. Returns `{ success, id }` |
| `removeBridge` | `row, col` | Remove the bridge occupying cell (row, col) |
| `getBridges` | — | Return all bridge definitions: `[{ id, type, points }]` |

### Trim (Diagonal Corners)

| Method | Args | Description |
|--------|------|-------------|
| `createTrim` | `r1, c1, r2, c2, corner, [options]` | Cut diagonal corner from room |
| `roundRoomCorners` | `label, [trimSize=3], [options]` | **Recommended.** Round all 4 corners of a labeled room with curved arcs. No coordinate math needed. |

**`roundRoomCorners`** is the preferred way to create circular/rounded rooms. It automatically computes the correct trim regions and corner directions from the room's bounds.

```json
["roundRoomCorners", "A10", 4]
["roundRoomCorners", "A10", 4, {"inverted": true}]
```

Options: `{ inverted: false, trimSize: 3 }` (trimSize can also be the 2nd positional arg).

Returns `{ success, corners, trimSize, bounds }`.

**`createTrim`** for manual control. Two calling conventions:
```json
["createTrim", 2, 2, 5, 5, "nw", {"round": true}]
["createTrim", 2, 2, 5, 5, {"corner": "nw", "round": true}]
```

**IMPORTANT: `(r1, c1)` is the corner TIP** — the outermost cell that will be voided. `(r2, c2)` is the opposite extent that determines size. For NW, the tip is the top-left cell; for NE, the tip is the top-right cell; for SW, bottom-left; for SE, bottom-right. The `corner` specifies which corner of the room is being cut:

| Corner | Position | Trim direction |
|--------|----------|---------------|
| `nw` | Top-left of room | Cuts from top-left inward |
| `ne` | Top-right of room | Cuts from top-right inward |
| `sw` | Bottom-left of room | Cuts from bottom-left inward |
| `se` | Bottom-right of room | Cuts from bottom-right inward |

**The corner label matches the visual position** — use `nw` for the northwest (top-left) corner of the room, `se` for the southeast (bottom-right) corner, etc.

Options: `{ round: false, inverted: false, open: false }`
- `round`: curved arc instead of straight diagonal
- `inverted`: concave arc (cuts into room) instead of convex
- `open`: remove walls without voiding cells

### Fills

| Method | Args | Description |
|--------|------|-------------|
| `setFill` | `row, col, fillType, [depth=1]` | Set cell fill: `"pit"`, `"water"`, or `"lava"`. Depth (1–3) applies to water/lava only |
| `removeFill` | `row, col` | Remove fill from cell |
| `setFillRect` | `r1, c1, r2, c2, fillType, [depth=1]` | Set fill on every cell in rectangle (one undo step). Depth (1–3) for water/lava |
| `removeFillRect` | `r1, c1, r2, c2` | Remove fill from every cell in rectangle |
| `setHazard` | `row, col, [enabled=true]` | Mark a single cell as hazard/difficult terrain (renders as crosshatch overlay). Pass `false` to remove |
| `setHazardRect` | `r1, c1, r2, c2, [enabled=true]` | Mark every cell in rectangle as hazard. One undo step |

### Spatial Queries

| Method | Args | Description |
|--------|------|-------------|
| `findCellByLabel` | `label` | Find the label cell for a room. Returns `{ row, col }` or `null` |
| `getRoomBounds` | `label` | BFS from label cell to find full room extent. Returns `{ r1, c1, r2, c2, centerRow, centerCol }` or `null` |
| `findWallBetween` | `label1, label2` | Find all walls on the shared boundary between two rooms. Returns `[{ row, col, direction, type }]` or `null` |

### Convenience

| Method | Args | Description |
|--------|------|-------------|
| `mergeRooms` | `label1, label2` | Remove all walls on the shared boundary between two rooms, merging them into one open space. Returns `{ success, removed }` |
| `shiftCells` | `dr, dc` | Shift all cells by (dr, dc). The grid grows to accommodate — no content is lost. Updates level `startRow` values on vertical shift. Returns `{ success, newRows, newCols }` |
| `normalizeMargin` | `[targetMargin=2]` | Resize the grid so every level has exactly `targetMargin` empty cells of margin around all structural content on all four sides. Columns are normalized globally (shared across levels); rows are normalized per-level. Shrinks excess margin and expands insufficient margin. Updates cells, level metadata, lights, bridges, and stair points. Returns `{ success, before, after, targetMargin, adjustments }` — check `adjustments.colShift` and `adjustments.levels[i].topShift` to see what moved. |
| `createCorridor` | `label1, label2, [width=2]` | Auto-create a corridor between two adjacent rooms that have a gap between them. **Only use for caves/tunnels/sewers** — for structural buildings (keeps, temples, undercrofts), place rooms flush and use `setDoorBetween` instead. Throws if rooms have insufficient perpendicular overlap or no gap between them |
| `partitionRoom` | `roomLabel, direction, position, [wallType='w'], [options]` | Add an internal wall partition across a room. `direction`: `'horizontal'` or `'vertical'`. `position`: absolute row (horizontal) or col (vertical). `wallType`: `'w'` or `'iw'`. `options: { doorAt }` — place a door at a specific col (horizontal) or row (vertical). Returns `{ success, wallsPlaced }` |

### AI Helpers

These methods offload coordinate math and spatial reasoning to the editor so Claude doesn't have to do it manually.

| Method | Args | Description |
|--------|------|-------------|
| `planBrief` | `brief` | **Flagship.** Compute a full dungeon layout from a high-level brief (room sizes + connection topology) and return ready-to-execute command arrays. See Claude Workflow section above. Returns `{ success, commands, mapSize }` |
| `createPolygonRoom` | `cellList, [mode='room']` | Create a room from an arbitrary list of `[[row, col], ...]` cells — enables L-shapes, U-shapes, any non-rectangular form. `mode='room'` walls all exterior edges; `mode='merge'` only walls edges facing void. Returns `{ success, count }` |
| `listRooms` | — | Return all labeled rooms with bounding boxes and centers. Returns `{ success, rooms: [{ label, r1, c1, r2, c2, center: { row, col } }] }` |
| `listRoomCells` | `label` | Return all floor cells belonging to a room as sorted `[[row, col], ...]`. Returns `{ success, cells }` |
| `getRoomContents` | `label` | Return all props, fills, doors, and textures within a room's bounding box. Returns `{ label, bounds, props, fills, doors, textures }` |
| `setDoorBetween` | `label1, label2, [type='d']` | Place a door on the midpoint of the shared wall between two **directly adjacent** rooms (no corridor between them). `type='d'` (normal) or `'s'` (secret). Throws if rooms are not adjacent. Returns `{ success, row, col, direction }` |
| `getPropFootprint` | `propType, [facing=0]` | Return the cells a prop occupies relative to anchor `[0,0]` at the given rotation. Returns `{ success, spanRows, spanCols, cells: [[dr,dc],...] }`. Use this before placing to confirm orientation — especially for multi-cell props on walls. |
| `getValidPropPositions` | `label, propType, [facing=0]` | Return all valid anchor `[[row, col], ...]` where the prop fits inside the room without overlapping existing props. Returns `{ success, positions }` |
| `suggestPlacement` | `rows, cols, [adjacentTo]` | Find a free rectangular area of the given size. If `adjacentTo` is a room label, prefers positions adjacent to it. Returns `{ r1, c1, r2, c2 }` or `{ error }` |
| `getUndoDepth` | — | Return current undo stack depth as a number. Record before a build to enable rollback |
| `undoToDepth` | `targetDepth` | Undo all changes back to a previously recorded depth. Returns `{ success, undid }` |
| `roundRoomCorners` | `label, [trimSize=3], [options]` | Round all 4 corners of a labeled room with curved arc trims. Automatically computes correct corner directions and trim regions from room bounds. Options: `{ inverted }`. Returns `{ success, corners, trimSize, bounds }` |
| `placeLightInRoom` | `label, preset, [config]` | Place a light at the center of a labeled room; handles world-feet conversion. Same config as `placeLight`. Returns `{ success, id }` |

### Bulk Prop Placement

These methods automate common prop placement patterns. Each call may place multiple props (one undo step per prop). Use `getUndoDepth()` before and `undoToDepth()` after if you need atomic rollback.

| Method | Args | Description |
|--------|------|-------------|
| `fillWallWithProps` | `roomLabel, propType, wall, [options]` | Line a wall with repeated copies of a prop. `wall`: `'north'`/`'south'`/`'east'`/`'west'`. Options: `{ facing, gap, inset, skipDoors }`. `gap`: cells between props (default 0). `inset`: cells inward from wall (default 0). `skipDoors`: skip door-adjacent cells (default true). Returns `{ success, placed: [[r,c],...] }` |
| `lineProps` | `roomLabel, propType, startRow, startCol, direction, count, [options]` | Place props in a straight line. `direction`: `'east'` or `'south'`. `count`: max props to place. Options: `{ facing, gap }`. Returns `{ success, placed }` |
| `scatterProps` | `roomLabel, propType, count, [options]` | Scatter props at random valid positions. Options: `{ facing, avoidWalls }`. `avoidWalls`: number of cells margin from walls. Returns `{ success, placed }` |
| `clusterProps` | `roomLabel, props, anchorRow, anchorCol` | Place a group of props at relative offsets from an anchor. `props`: `[{ type, dr, dc, facing }, ...]`. Returns `{ success, placed, failed }` |

**Example — bookshelves along the north wall:**
```json
["fillWallWithProps", "A3", "bookshelf", "north", {"facing": 0}]
```

**Example — row of pillars down the center:**
```json
["lineProps", "A1", "pillar", 3, 5, "east", 4, {"gap": 2}]
```

**Example — scatter rubble:**
```json
["scatterProps", "A5", "rubble", 3, {"avoidWalls": 1}]
```

**Example — desk cluster:**
```json
["clusterProps", "A2", [
  {"type": "desk", "dr": 0, "dc": 0, "facing": 0},
  {"type": "chair", "dr": 0, "dc": 2, "facing": 270},
  {"type": "book-pile", "dr": 1, "dc": 0}
], 5, 8]
```

### Inspection (read-only)

Cheap, structured queries for surveying a map without screenshots or N×M `getCellInfo` calls.

| Method | Args | Description |
|--------|------|-------------|
| `renderAscii` | `r1, c1, r2, c2` | ASCII grid of the region. Glyphs: `.` floor, ` ` void, `~` water, `^` lava, `_` pit, `:` hazard, `o` prop, `*` label, `>` stair, `=` bridge. Walls: `\|` `-`. Doors: `D` (normal), `S` (secret). Returns `{ ascii, rows, cols, legend }`. Region capped at 80 cols. |
| `inspectRegion` | `r1, c1, r2, c2` | Full structured dump of every cell in the rectangle: walls, fill, prop, label, texture, stair/bridge IDs. Plus lights whose center is inside the region. Returns `{ bounds, cellCount, cells, lights }`. Out-of-bounds rectangles are clamped. |
| `getRoomSummary` | `label` | One-call survey of a labeled room: bounds (bounding box — for L/U shaped rooms this includes void cells), cell count (actual floor cells via flood fill), props, fills, doors, textures, lights affecting (Euclidean radius reach), and `adjacentRooms` (rooms reachable through one door step). Replaces `getRoomBounds + getRoomContents + getLights` calls. |
| `queryCells` | `predicate` | Find cells matching a structured predicate. Fields are AND-combined. Predicate keys: `prop`, `hasProp`, `fill`, `hasFill`, `hasLabel`, `label`, `hasTexture`, `texture`, `hasDoor`, `hasWall`, `hasStair`, `hasBridge`, `isVoid`, `hasHazard`, `region: {r1,c1,r2,c2}`. Array values for `prop`/`fill` mean "any of". Returns `{ count, cells: [{row, col, cell}] }`. |
| `getLightingCoverage` | `[darkThreshold=0.15], [region]` | Per-cell lighting estimate (ambient + sum of falloff per light). **Ignores wall shadowing for speed.** Returns `{ ambient, totalCells, litCells, darkCells, averageIntensity, darkSpots: [{row,col,intensity}] }`. Useful for "did I light this room?" checks. |
| `findConflicts` | `[options]` | Single-call design audit: blocked doors, unreachable rooms (if `entranceLabel` given), lights in void, dark rooms (>50% cells dark, requires lighting enabled). Each conflict has `type`, `severity` (`error`/`warning`), `message`, optional `row/col/context`. Options: `{ entranceLabel?, darkThreshold? }`. |
| `getPropPlacementOptions` | `label, propType, [options]` | Enumerate every candidate anchor in a room with `valid: bool` + `reasons: [...]`. Reasons: `OUT_OF_ROOM`, `OVERLAPS_PROP`, `BLOCKS_DOOR`, `BLOCKS_DOOR_APPROACH`. Options: `{ facing=0, includeInvalid=true }`. Returns `{ options, summary: {total, valid, invalid} }`. Use this instead of `getValidPropPositions` when you want to know *why* a placement was rejected. |

**Examples:**
```json
["renderAscii", 2, 2, 8, 12]
["queryCells", { "prop": "brazier" }]
["queryCells", { "hasFill": true, "region": { "r1": 5, "c1": 5, "r2": 15, "c2": 15 } }]
["getRoomSummary", "A1"]
["findConflicts", { "entranceLabel": "A1" }]
["getPropPlacementOptions", "A1", "throne", { "facing": 180 }]
```

### Catalog & enumeration

| Method | Args | Description |
|--------|------|-------------|
| `searchProps` | `[filter]` | Filter the prop catalog. Filter fields: `placement` ("wall"/"corner"/"center"/"floor"/"any" or array), `roomTypes` (string or array, any-of), `category` (string or array), `facing` (boolean), `maxFootprint`/`minFootprint` ([rows, cols]), `namePattern` (case-insensitive substring). Returns `{ count, props }`. |
| `listDoors` | — | Every door (and secret door) on the map, deduplicated against the reciprocal edge. Returns `{ doors: [{row, col, direction, type}] }`. |
| `listWalls` | — | Every wall edge (visible + invisible), deduplicated. Returns `{ walls: [{row, col, direction, type}] }`. |
| `listFills` | — | Every filled cell with depth. Returns `{ fills: [{row, col, type, depth}] }`. |
| `unlabelledRooms` | — | Rooms (BFS regions of contiguous floor) that have no `center.label`. Useful for "did I forget a label?" checks. Returns `{ count, rooms: [{representativeCell, cellCount}] }`. |
| `getThemeColors` | — | Resolved theme color map for the current map. Returns `{ themeName, colors }`. |
| `waitForRender` | `[timeoutMs=3000]` | Wait until the lighting version stops advancing for two consecutive frames. Useful after bulk light placements before screenshot. Returns `{ settledMs }`. |

### Bulk transforms

| Method | Args | Description |
|--------|------|-------------|
| `cloneRoom` | `label, dr, dc, [{newLabel}]` | Copy a labeled room (cells, walls, fills, props, textures, label, lights inside bbox, overlay props inside bbox) to a new offset. Throws `CLONE_OUT_OF_BOUNDS` or `CLONE_OVERLAP` if destination is invalid. Returns `{ copied: {cells, overlayProps, lights}, bounds }`. |
| `mirrorRegion` | `r1, c1, r2, c2, axis` | Flip cells in a rectangle across `"horizontal"` (E↔W) or `"vertical"` (N↔S) axis. Cell walls are remapped accordingly. **Multi-cell props, overlay props, lights, stairs, bridges inside the region are NOT transformed** — clear them first or use `cloneRoom`. |
| `rotateRegion` | `r1, c1, r2, c2, degrees` | Rotate a SQUARE region 90/180/270 clockwise. Walls remap. Same caveats as `mirrorRegion`. |
| `replaceProp` | `oldType, newType, [{region}]` | Bulk swap one prop type for another in cell-level props and overlay props. Optional region constraint. Returns `{ replaced }`. |
| `replaceTexture` | `oldId, newId, [{region}]` | Bulk swap one texture ID for another (covers main + corner textures). Returns `{ replaced }`. |

### Auto-furnish

| Method | Args | Description |
|--------|------|-------------|
| `autofurnish` | `label, roomType, [{density, preferWall}]` | Catalog-driven prop placement: picks props whose `roomTypes` includes the given type (or `'any'`), groups by `placement`, and places a centerpiece + wall props + scattered floor props. `density: "sparse"\|"normal"\|"dense"`. Centerpiece is anchored to the room's actual cell-set centroid (not the bbox center) so L/U shaped rooms work correctly. Returns `{ placed: [{type,row,col,via}], skipped: [{type,via,reason}], lightsAdded: [{id,preset,propRow,propCol,propType}] }`. |
| `furnishBrief` | `{rooms: [{label, role, density?}]}` | Run `autofurnish` for many rooms in one call. Returns `{ rooms: [...], totals: {placed, skipped} }`. Per-room failures are recorded in the room's own result; the batch never throws. |

### Bulk placement feedback

`fillWallWithProps`, `lineProps`, `scatterProps`, `clusterProps`, `autofurnish`, and `commitFurnishing` all return `{ success, placed, skipped, lightsAdded }`:

- **`skipped: [{ row, col, code, reason, context? }]`** — every position that was attempted but couldn't take a prop. `code` is machine-readable, `reason` is the same string (kept for backward compat), `context` carries structured diagnostics. Codes: `OVERLAPS_PROP`, `OUT_OF_ROOM`, `DOOR_HERE`, `DOOR_APPROACH`, `CELL_VOID`, `PLACE_FAILED`.
- **`lightsAdded: [{ id, preset, propRow, propCol, propType }]`** — every auto-attached light emitted by a placed prop, with attribution. Use this to budget light count across a wall-fill or furnish call without re-querying by propRef.
- `scatterProps` additionally returns `requested` (count asked for) and `available` (valid positions before filtering). It skips door cells and door-approach cells by default (`options.avoidDoors = true`); set `avoidDoors: false` for intentional door-cell placement (traps, pressure plates).
- `clusterProps` skipped entries include the prop `type` alongside the standard fields.

### Annotated screenshots

Pass `--highlight '<json>'` alongside `--screenshot out.png` to overlay markers on the saved image. Each highlight: `{ row, col, [rows=1], [cols=1], [color="#ff3030"], [shape="box"|"dot"|"cross"], [label] }`. Useful for confirming "is this the cell I think it is?" without a second screenshot.

```bash
node tools/puppeteer-bridge.js --load map.json --screenshot out.png \
  --highlight '[{"row":5,"col":7,"label":"throne","color":"#ffd000"}]'
```

The `getScreenshotAnnotated(highlights)` API method returns the annotated PNG as a data URL when called directly via `--commands`.

### Validation

| Method | Args | Description |
|--------|------|-------------|
| `validateDoorClearance` | — | Check for props blocking door cells or their approach cells. Returns `{ clear: bool, issues: [{ row, col, direction, doorType, problem }] }` |
| `validateConnectivity` | `entranceLabel` | BFS from entrance through open edges and doors. Returns `{ connected: bool, reachable: [...], unreachable: [...], totalRooms, visitedCells }` |
| `explainCommand` | `method, ...args` | Dry-run a single command against current state. Returns `{ ok, method, result?, error?, code?, context? }`. Mutating commands are rolled back; read methods return their result. Use this before committing to verify a command works. |
| `validateCommands` | `commands, [options]` | Dry-run a batch of commands sequentially (each command sees the cumulative effect of previous ones). State is fully restored at the end. Returns `{ allOk, results: [{ index, method, ok, error?, code?, context?, result? }] }`. Pass `{ stopOnError: true }` to halt at the first failure. |

**Structured errors.** Every API method that throws raises an `ApiValidationError` with a stable `code` (e.g. `OUT_OF_BOUNDS`, `UNKNOWN_PROP`, `INVALID_DOOR_TYPE`, `STAIR_OVERLAP`, `ROOM_NOT_FOUND`) and a JSON-serializable `context` bag (the offending args, valid alternatives, current state). The Puppeteer bridge surfaces both — failed commands print as `FAILED [i] [method] (CODE): message {context}`. Use the `code` for branching logic; use the `context` to diagnose without a follow-up `getCellInfo` call.

**Dry-run pattern:** before submitting a long batch, validate it first to surface failures cheaply:
```bash
node tools/puppeteer-bridge.js --load map.json \
  --commands '[["validateCommands", [["createRoom",2,2,5,5],["setLabel",3,3,"X"],["placeLightInRoom","X","torch"]]]]'
```

**`planBrief` brief format:**
```json
{
  "name": "Dungeon Name",
  "theme": "stone-dungeon",
  "gridSize": 5,
  "corridorWidth": 3,
  "rooms": [
    { "label": "A1", "width": 12, "height": 8, "entrance": true }
  ],
  "connections": [
    { "from": "A1", "to": "A2", "direction": "north", "corridorWidth": 3, "type": "door" }
  ]
}
```
- `direction` is required per connection: `north|south|east|west` (direction from `from` to `to`)
- `type`: `"door"` (default) or `"secret"`
- Same-direction siblings from the same parent are placed side-by-side (perpendicular to travel axis)
- Corridors are placed between rooms using normal room mode; doors at each junction are explicit `setDoor` commands with computed coordinates

### Levels

| Method | Args | Description |
|--------|------|-------------|
| `getLevels` | — | Returns array of `{ index, name, startRow, numRows }` |
| `renameLevel` | `levelIndex, newName` | Rename a level |
| `resizeLevel` | `levelIndex, newRows` | Add or remove rows at the bottom of a level |
| `addLevel` | `name, [numRows=15]` | Append a new level (with void separator row) |
| `defineLevels` | `levels` | Set level boundaries on existing rows (no rows added). `levels`: `[{ name, startRow, numRows }, ...]`. Validates that ranges fit within the grid |

### Props (Furniture & Objects)

| Method | Args | Description |
|--------|------|-------------|
| `placeProp` | `row, col, propType, [facing=0], [options]` | Place prop at anchor cell. Facing: `0`/`90`/`180`/`270`. Options: `{ scale, flipped, x, y, zIndex, allowOverlap }` — scale 0.25–4.0, `x`/`y` for freeform world-feet placement, `allowOverlap` permits stacking. Returns `{ success, warnings?, lightsAdded? }` where `lightsAdded: [{id, preset}]` for auto-emitted lights |
| `removeProp` | `row, col` | Remove prop from anchor cell |
| `removePropAt` | `row, col` | Remove the prop whose anchor is exactly (row, col). Returns `{ success: false }` if no prop there |
| `rotateProp` | `row, col, [degrees=90]` | Rotate prop by delta (positive = CW). Preserves visible anchor for non-square props |
| `setPropRotation` | `row, col, degrees` | Set prop rotation to an absolute angle (0–359). Preserves visible anchor |
| `flipProp` | `row, col` | Toggle the `flipped` (mirrored) flag |
| `movePropInCells` | `row, col, dr, dc` | Move the prop at (row, col) by (dr, dc) cells. Linked lights follow. Throws `OUT_OF_BOUNDS` / `CELL_VOID` if destination is invalid |
| `listProps` | — | Returns `{ categories, props: { [name]: { name, category, footprint, facing, placement, roomTypes, typicalCount, clustersWith, notes } } }` |
| `getPropsForRoomType` | `roomType` | Return all props tagged for a room type (e.g. `"library"`, `"forge"`). Returns `{ success, props: [...] }` |
| `removePropsInRect` | `r1, c1, r2, c2` | Remove all props with anchor cells in rectangle. Returns `{ success, removed }` |

Prop names must exactly match the filename without `.prop` (e.g. `"map-table"`, `"bone-pile"`). See the full prop catalog below.

**Footprint is R×C (rows × cols) — not W×H.** `1×2` means 1 row tall × 2 cols wide. At rotation 0 a `1×2` prop extends east; at rotation 90 it extends south. Use `getPropFootprint(propType, rotation)` for ground truth before placing.

**Placement metadata:** Every prop has `placement` (wall/corner/center/floor/any), `roomTypes`, `typicalCount`, `clustersWith`, and `notes`. Use `getPropsForRoomType("library")` to find all props suitable for a library. `fillWallWithProps` auto-computes rotation for wall-mounted props — no need to specify `facing` in options.

### Lighting Operations

| Method | Args | Description |
|--------|------|-------------|
| `placeLight` | `x, y, [config]` | Place light at world-feet coordinates. Config: `{preset, type, radius, color, intensity, falloff, angle, spread}`. Use `preset: "torch"` to apply preset defaults; explicit fields override. Returns `{ success, id }` |
| `removeLight` | `id` | Remove a light by its ID |
| `getLights` | — | Return all lights (deep copy). Returns `{ success, lights }` |
| `setAmbientLight` | `level` | Set ambient light level (0.0 = pitch black, 1.0 = fully lit) |
| `setLightingEnabled` | `enabled` | Toggle the lighting system on/off |
| `listLightPresets` | — | Return all light presets. Returns `{ categories, presets: { [name]: { displayName, category, type, color, radius, intensity, falloff } } }` |

Light coordinates are in **world feet** (`x = col * gridSize`, `y = row * gridSize`). Placing a light auto-enables lighting if it was off. Default config: `{type: 'point', radius: 30, color: '#ff9944', intensity: 1.0, falloff: 'smooth'}`. Use `preset` to apply a named preset (e.g. `"torch"`, `"brazier"`, `"candle"`) — call `listLightPresets()` for all available names.

### Textures

Floor textures overlay the room background with tileable PNG images. Textures are per-cell and can be mixed in the same room. Available IDs: `"cobblestone"`, `"dirt"`, `"wood"`.

| Method | Args | Description |
|--------|------|-------------|
| `setTexture` | `row, col, textureId, [opacity=1.0]` | Apply texture to a single cell (cell must already exist) |
| `removeTexture` | `row, col` | Remove texture from a cell |
| `setTextureRect` | `r1, c1, r2, c2, textureId, [opacity=1.0]` | Apply texture to all non-null cells in rectangle (one undo step) |
| `removeTextureRect` | `r1, c1, r2, c2` | Remove texture from all cells in rectangle |
| `floodFillTexture` | `row, col, textureId, [opacity=1.0]` | Flood-fill texture from cell, spreading to all connected floor cells with the same texture (or no texture) |
| `waitForTextures` | `[timeoutMs=8000]` | Wait for all texture images to finish loading before screenshot. Returns `{ success, count }`. **Always call this before `getScreenshot()` after setTexture commands.** |

Typical texture workflow:
```json
["createRoom", 1, 1, 12, 14],
["setTextureRect", 2, 2, 11, 13, "cobblestone"],
["setTextureRect", 2, 2, 5, 5, "dirt"],
["setTextureRect", 7, 9, 11, 13, "wood"],
["waitForTextures"],
```

Edge blending (smooth gradient between adjacent different textures) is controlled per-theme via `theme.textureBlendWidth` (0.0–1.0, default 0.35).

### Undo / Redo / Checkpoints

| Method | Args | Description |
|--------|------|-------------|
| `undo` | — | Undo last action |
| `redo` | — | Redo last undone action |
| `getUndoDepth` | — | Numeric undo stack depth |
| `undoToDepth` | `targetDepth` | Undo back to a numeric depth |
| `checkpoint` | `name` | Record a named checkpoint at the current undo depth. Overwrites if name exists. Returns `{ name, depth }`. |
| `rollback` | `name` | Undo back to the depth captured by `checkpoint(name)`. Checkpoint is preserved (re-rollable). Returns `{ name, depth, undid }`. |
| `listCheckpoints` | — | List all named checkpoints with their depth and `stepsAhead` (how many undo steps since the checkpoint). |
| `clearCheckpoint` | `name` | Delete a named checkpoint. Returns `{ existed }`. |

**Prefer named checkpoints over `getUndoDepth`/`undoToDepth`** — they're more readable and survive across multiple Puppeteer calls without you tracking integers. Checkpoints are cleared automatically on `newMap`/`loadMap`.

```json
["createRoom", 2, 2, 8, 12]
["checkpoint", "after-rooms"]
["setTextureRect", 2, 2, 8, 12, "polyhaven/cobblestone_floor_03"]
["checkpoint", "after-textures"]
["scatterProps", "A1", "rubble", 5]
// If the props look wrong:
["rollback", "after-textures"]
```

### Transactional batches

| Method | Args | Description |
|--------|------|-------------|
| `transaction` | `commands` | Run a batch all-or-nothing. On any failure, undo every preceding command in the batch and return `{ success: false, committed: false, failedAt, results }`. On full success, all commands remain applied. Distinct from `validateCommands` (always rolls back) and `--continue-on-error` (leaves partial state). |

```json
["transaction", [
  ["createRoom", 2, 2, 8, 12],
  ["setLabel", 5, 7, "A1"],
  ["placeProp", 4, 4, "throne", 180]
]]
```

### Session info

| Method | Args | Description |
|--------|------|-------------|
| `getSessionInfo` | — | Rich snapshot of the editor's current state: `mapName, rows, cols, currentLevel, undoDepth, redoDepth, dirty, unsavedChanges, lightingEnabled, catalogsLoaded {props,textures,theme,lights}, checkpoints, counts {rooms,props,lights,stairs,bridges,levels}`. Use as the first call in a Puppeteer session to verify the editor isn't holding stale state from a previous task. |

**`loadMap` now returns `{ success, info }`** where `info` is the same shape as `getMapInfo`. No second roundtrip needed to learn what got loaded.

### Catalog Queries

| Method | Args | Description |
|--------|------|-------------|
| `listTextures` | — | Return all available texture IDs with display names and categories |
| `listThemes` | — | Return all available theme names. Returns `{ themes: string[] }` |

### Advanced / Operational

| Method | Args | Description |
|--------|------|-------------|
| `waitForEditor` | `[timeoutMs=15000]` | Wait for full editor initialization (canvas + catalogs + state). Useful as the first command in Puppeteer scripts if the editor may not be ready yet |
| `eval` | `code` | Evaluate arbitrary JS in the editor context with access to `state` and `editorAPI`. Use `return <value>` to send a result back. Escape hatch for anything not covered by the API |
| `clearCaches` | — | Reload all asset caches (themes, textures, catalogs). Use after modifying prop/theme files on disk |
| `render` | — | Force an immediate re-render of the canvas |

---

## Common Patterns

### Create a multi-room dungeon

```json
[
  ["newMap", "Goblin Cave", 25, 35],
  ["createRoom", 2, 2, 7, 10],
  ["setLabel", 4, 6, "1"],
  ["setDoor", 4, 10, "east"],
  ["createRoom", 2, 12, 10, 20],
  ["setLabel", 6, 16, "2"],
  ["setDoor", 10, 16, "south"],
  ["createRoom", 12, 13, 18, 20],
  ["setLabel", 15, 16, "3"],
  ["setDoor", 12, 16, "north", "s"]
]
```

### Add a corridor connecting rooms

```json
[
  ["createRoom", 4, 10, 4, 12, "merge"]
]
```
A 1-cell-high room with `"merge"` mode creates a corridor that seamlessly connects to adjacent rooms.

### Round all corners of a room (circular chamber)

```json
[
  ["roundRoomCorners", "A10", 4]
]
```
Rounds all 4 corners of room A10 with 4-cell curved arcs. Use this instead of manual `createTrim` calls — it handles corner directions automatically.

### Trim a single corner with rounded arc

```json
[
  ["createTrim", 2, 2, 5, 5, "nw", {"round": true}]
]
```
This trims the northwest (top-left) corner of a room. The corner label matches the visual position — `nw` = top-left, `ne` = top-right, `sw` = bottom-left, `se` = bottom-right.

### Set map metadata

```json
[
  ["setName", "The Sunken Temple"],
  ["setTheme", "water-temple"],
  ["setLabelStyle", "bold"],
  ["setFeature", "compass", true],
  ["setFeature", "grid", false]
]
```

### Fill a room with pit

```json
[
  ["createRoom", 2, 2, 8, 10],
  ["setLabel", 5, 6, "A1"],
  ["setFillRect", 3, 3, 7, 9, "pit"]
]
```
`setFillRect` fills the entire interior in one command. Leave the wall-edge cells unfilled if you want clean borders.

### Fill rooms with water or lava

```json
[
  ["createRoom", 2, 2, 8, 10],
  ["setFillRect", 3, 3, 7, 9, "water", 2],
  ["createRoom", 2, 12, 8, 20],
  ["setFillRect", 3, 13, 7, 19, "lava", 3]
]
```
Depth 1 = shallow (default), 2 = medium, 3 = deep. Water and lava render with per-theme Voronoi patterns. Each theme defines its own shallow/medium/deep/caustic colors for both fluids.

### Furnish a room with props

```json
[
  ["createRoom", 2, 2, 10, 12],
  ["setLabel", 6, 7, "1"],
  ["placeProp", 3, 3, "pillar"],
  ["placeProp", 3, 10, "pillar"],
  ["placeProp", 8, 3, "pillar"],
  ["placeProp", 8, 10, "pillar"],
  ["placeProp", 5, 6, "throne", 180],
  ["placeProp", 4, 4, "brazier"],
  ["placeProp", 4, 9, "brazier"]
]
```

### Place a door between two labeled rooms

```json
[
  ["findWallBetween", "1", "2"]
]
```
Returns the shared wall cells. Pick one and call `setDoor` on it. Example: if result is `[{ row: 5, col: 12, direction: "east" }]`, call `["setDoor", 5, 12, "east"]`.

### Create a two-level dungeon with linked stairs

```json
[
  ["newMap", "Tower", 35, 20],

  ["createRoom", 2, 2, 12, 18],
  ["setLabel", 7, 10, "1"],
  ["addStairs", 10, 10, 10, 11, 11, 11],

  ["addLevel", "Level 2", 15],

  ["getLevels"]
]
```
After `getLevels`, note `startRow` for Level 2 (e.g. 16). Then continue:
```json
[
  ["createRoom", 17, 2, 27, 18],
  ["setLabel", 22, 10, "2"],
  ["addStairs", 19, 10, 19, 11, 20, 11],

  ["linkStairs", 10, 10, 19, 10]
]
```
`addStairs` places a 1×1 rectangle stair (base P1→P2 on top edge, P3 at bottom-right corner). `linkStairs` connects stairs across levels and assigns a shared letter label (A, B, C...).

### Inspect and spatially query a map

```bash
# Get bounds of room labeled "A1"
node tools/puppeteer-bridge.js --load map.json \
  --commands '[["getRoomBounds","A1"]]'

# Find where to put a door between room 1 and room 2
node tools/puppeteer-bridge.js --load map.json \
  --commands '[["findWallBetween","1","2"]]'

# Find the label cell for room "Boss"
node tools/puppeteer-bridge.js --load map.json \
  --commands '[["findCellByLabel","Boss"]]'
```

---

## Themes

All 16 available themes:

| Theme | Best for |
|-------|----------|
| `"stone-dungeon"` | Crypts, tombs, dark dungeons (default) |
| `"blue-parchment"` | Clean architectural maps, general purpose |
| `"sepia-parchment"` | Aged/historical aesthetic, classic module look |
| `"ice-cave"` | Frozen caverns, winter dungeons, Stygia |
| `"earth-cave"` | Natural caves, mines, underground warrens |
| `"water-temple"` | Aquatic environments, flooded ruins, sunken temples |
| `"crypt"` | Undead tombs, bone-white walls, necromancer lairs |
| `"underdark"` | Deep tunnels, alien bioluminescence, Underdark |
| `"volcanic"` | Lava-lit caverns, fire dungeons, elemental planes |
| `"arcane"` | Magical laboratories, enchanted towers, wizard sanctums |
| `"grasslands"` | Outdoor encounters, surface ruins, forest clearings |
| `"desert"` | Arid ruins, sandstone temples, desert tombs |
| `"swamp"` | Boggy passages, bayou shrines, fetid dungeons |
| `"snow-tundra"` | Frozen wastes, icebound keeps, arctic outposts |
| `"dirt"` | Earthen tunnels, abandoned mines, goblin warrens |
| `"alien"` | Otherworldly geometry, aberrant spaces, Far Realm |

---

## Prop Catalog

Footprint is **R×C** (rows × cols in cells) — see the full convention note above. Facing props rotate with the `facing` argument to `placeProp`. Use `listProps()` for the definitive runtime list.

### Combat
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `armor-stand` | Armor Stand | 1×1 | yes |
| `ballista` | Ballista | 1×2 | yes |
| `barrier` | Barrier | 1×2 | yes |
| `battering-ram` | Battering Ram | 1×3 | yes |
| `caltrops` | Caltrops | 1×1 | no |
| `cannon` | Cannon | 1×2 | yes |
| `catapult` | Catapult | 2×2 | yes |
| `oil-cauldron` | Oil Cauldron | 1×1 | no |
| `shield-rack` | Shield Rack | 1×2 | yes |
| `spear-stand` | Spear Stand | 1×1 | no |
| `training-dummy` | Training Dummy | 1×1 | yes |
| `weapon-rack` | Weapon Rack | 1×2 | yes |

### Containers
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `barrel` | Barrel | 1×1 | no |
| `barrel-stack` | Barrel Stack | 1×2 | no |
| `chest` | Chest | 1×1 | yes |
| `crate` | Crate | 1×1 | no |
| `crate-stack` | Crate Stack | 1×2 | no |
| `sarcophagus` | Sarcophagus | 2×1 | yes |
| `trunk` | Trunk | 1×2 | no |
| `wine-rack` | Wine Rack | 1×2 | no |

### Decorative
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `banner` | Banner | 2×1 | yes |
| `carpet` | Carpet | 2×3 | no |
| `chandelier` | Chandelier | 2×2 | no |
| `display-case` | Display Case | 1×2 | no |
| `flag-pole` | Flag Pole | 1×1 | no |
| `mirror` | Mirror | 1×1 | yes |
| `painting` | Painting | 1×2 | yes |
| `tapestry` | Tapestry | 2×1 | no |
| `trophy` | Trophy Mount | 1×1 | no |

### Features
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `altar` | Altar | 2×1 | yes |
| `brazier` | Brazier | 1×1 | no |
| `candle-cluster` | Candle Cluster | 1×1 | no |
| `fountain` | Fountain | 2×2 | no |
| `rubble` | Rubble | 1×1 | no |
| `statue` | Statue | 1×1 | no |
| `treasure-pile` | Treasure Pile | 2×2 | no |
| `well` | Well | 1×1 | no |

### Furniture
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `armchair` | Armchair | 1×1 | yes |
| `bathtub` | Bathtub | 1×2 | yes |
| `bed` | Bed | 2×1 | yes |
| `bench` | Bench | 1×2 | no |
| `bookshelf` | Bookshelf | 2×1 | yes |
| `cabinet` | Cabinet | 1×1 | yes |
| `chair` | Chair | 1×1 | yes |
| `desk` | Desk | 1×2 | yes |
| `fireplace` | Fireplace | 2×1 | yes |
| `hearth` | Hearth | 1×2 | yes |
| `lectern` | Lectern | 1×1 | yes |
| `map-table` | Map Table | 2×2 | no |
| `oven` | Oven | 2×1 | yes |
| `pew` | Pew | 1×3 | no |
| `stool` | Stool | 1×1 | no |
| `table` | Table | 2×2 | no |
| `throne` | Throne | 1×1 | yes |
| `throne-dais` | Throne Dais | 2×3 | yes |
| `trough` | Trough | 1×2 | yes |
| `wardrobe` | Wardrobe | 1×2 | yes |

### Magical
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `arcane-pedestal` | Arcane Pedestal | 1×1 | no |
| `component-shelf` | Component Shelf | 1×2 | yes |
| `crystal-ball` | Crystal Ball | 1×1 | no |
| `crystal-formation` | Crystal Formation | 1×1 | no |
| `magic-circle` | Magic Circle | 3×3 | no |
| `ritual-circle` | Ritual Circle | 3×3 | no |
| `scrying-mirror` | Scrying Mirror | 1×2 | yes |
| `spell-focus` | Spell Focus | 1×1 | no |
| `summoning-cage` | Summoning Cage | 2×2 | no |
| `ward-stone` | Ward Stone | 1×1 | no |

### Nautical
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `anchor` | Anchor | 1×1 | no |
| `binnacle` | Binnacle | 1×1 | no |
| `capstan` | Capstan | 1×1 | no |
| `dock-cleat` | Dock Cleat | 1×1 | yes |
| `dock-post` | Dock Post | 1×1 | no |
| `fish-drying-rack` | Fish Drying Rack | 1×2 | yes |
| `fishing-net` | Fishing Net | 1×2 | no |
| `gangplank` | Gangplank | 1×3 | yes |
| `life-ring` | Life Ring | 1×1 | no |
| `lighthouse-lens` | Lighthouse Lens | 2×2 | no |
| `lobster-trap` | Lobster Trap | 1×1 | no |
| `rope-coil` | Rope Coil | 1×1 | no |
| `rowboat` | Rowboat | 3×2 | yes |
| `ship-wheel` | Ship Wheel | 1×1 | no |
| `ships-hammock` | Ship's Hammock | 1×2 | yes |

### Prison & Torture
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `coffin` | Coffin | 2×1 | yes |
| `execution-block` | Execution Block | 1×1 | yes |
| `gallows` | Gallows | 2×2 | yes |
| `gibbet` | Gibbet | 2×1 | no |
| `iron-maiden` | Iron Maiden | 2×1 | yes |
| `pillory` | Pillory | 1×2 | yes |
| `shackles` | Shackles | 1×1 | no |
| `stocks` | Stocks | 1×2 | yes |
| `torture-rack` | Torture Rack | 1×2 | yes |

### Religious
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `candelabra` | Candelabra | 1×1 | no |
| `censer` | Censer | 1×1 | no |
| `holy-font` | Holy Font | 1×1 | no |
| `idol` | Idol | 1×1 | yes |
| `kneeling-bench` | Kneeling Bench | 1×2 | yes |
| `offering-plate` | Offering Plate | 1×1 | no |
| `reliquary` | Reliquary | 1×1 | yes |

### Structure
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `archway` | Archway | 1×2 | yes |
| `chain-hoist` | Chain Hoist | 1×1 | no |
| `chain-wall` | Chain Wall | 1×3 | yes |
| `lamp-post` | Lamp Post | 1×1 | no |
| `obelisk` | Obelisk | 1×1 | no |
| `pillar` | Pillar | 1×1 | no |
| `pillar-corner` | Corner Pillar | 1×1 | no |
| `portcullis` | Portcullis | 1×2 | yes |
| `stone-column` | Stone Column | 1×1 | no |
| `torch-sconce` | Torch Sconce | 1×1 | yes |
| `trophy-head` | Trophy Head | 1×1 | yes |
| `vault-door` | Vault Door | 2×2 | yes |

### Terrain & Nature
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `bone-pile` | Bone Pile | 1×2 | no |
| `boulder` | Boulder | 1×1 | no |
| `campfire` | Campfire | 1×1 | no |
| `dead-tree` | Dead Tree | 2×2 | no |
| `fallen-log` | Fallen Log | 1×3 | no |
| `lava-pool` | Lava Pool | 2×2 | no |
| `mushroom` | Mushroom | 1×1 | no |
| `mushroom-cluster` | Mushroom Cluster | 2×2 | no |
| `rock-cluster` | Rock Cluster | 2×2 | no |
| `stalagmite` | Stalagmite | 1×1 | no |
| `tree` | Tree | 2×2 | no |
| `tree-stump` | Tree Stump | 1×1 | no |

### Undead & Dark
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `bone-shrine` | Bone Shrine | 1×2 | no |
| `bone-throne` | Bone Throne | 2×1 | yes |
| `burial-urn` | Burial Urn | 1×1 | no |
| `canopic-jar` | Canopic Jar | 1×1 | no |
| `corpse` | Corpse | 2×1 | yes |
| `grave-marker` | Grave Marker | 1×1 | no |
| `grave-mound` | Grave Mound | 1×2 | no |
| `necrotic-altar` | Necrotic Altar | 2×2 | yes |
| `skeleton` | Skeleton | 2×1 | yes |
| `zombie-pit` | Zombie Pit | 1×1 | no |

### Misc
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `birdcage` | Birdcage | 1×1 | no |
| `cart` | Cart | 1×2 | yes |
| `hourglass` | Hourglass | 1×1 | no |
| `notice-board` | Notice Board | 1×2 | yes |
| `telescope` | Telescope | 1×2 | yes |

### Workshop
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `anvil` | Anvil | 1×1 | yes |
| `bellows` | Bellows | 1×1 | yes |
| `forge` | Forge | 2×2 | yes |
| `loom` | Loom | 2×2 | yes |
| `grinding-wheel` | Grinding Wheel | 1×1 | no |
| `potter-wheel` | Potter's Wheel | 1×1 | no |
| `tanning-rack` | Tanning Rack | 1×2 | no |
| `workbench` | Workbench | 2×1 | yes |

### Kitchen
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `cauldron-large` | Cauldron (Large) | 2×2 | no |
| `chopping-block` | Chopping Block | 1×1 | no |
| `kitchen-table` | Kitchen Table | 2×2 | no |
| `pot-rack` | Pot Rack | 1×2 | yes |
| `spice-shelf` | Spice Shelf | 1×2 | yes |
| `wood-pile` | Wood Pile | 1×2 | no |

### Alchemy
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `alembic` | Alembic | 1×1 | no |
| `alchemy-bench` | Alchemy Bench | 2×2 | yes |
| `crucible` | Crucible | 1×1 | no |
| `ingredient-rack` | Ingredient Rack | 1×2 | yes |
| `mortar-pestle` | Mortar & Pestle | 1×1 | no |
| `specimen-jar` | Specimen Jar | 1×1 | no |

### Library & Study
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `book-pile` | Book Pile | 1×1 | no |
| `globe` | Globe | 1×1 | no |
| `scroll-case` | Scroll Case | 1×1 | no |
| `scroll-rack` | Scroll Rack | 1×2 | yes |

### Lighting
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `crystal-torch` | Crystal Torch | 1×1 | no |
| `floor-candelabra` | Floor Candelabra | 1×1 | no |
| `lantern-post` | Lantern Post | 1×1 | no |
| `signal-fire` | Signal Fire | 1×1 | no |
| `wall-lantern` | Wall Lantern | 1×1 | yes |

### Traps
| Name | Display | Footprint | Facing |
|------|---------|-----------|--------|
| `arrow-trap` | Arrow Trap | 1×1 | yes |
| `bear-trap` | Bear Trap | 1×1 | no |
| `pit-trap` | Pit Trap | 1×1 | no |
| `pressure-plate` | Pressure Plate | 1×1 | no |
| `spike-trap` | Spike Trap | 1×1 | no |

---

## Common Errors

| Error message | Cause | Fix |
|---------------|-------|-----|
| `no wall at that position` | `setDoor()` called where no wall exists | Check room boundaries; door must be on a wall between two regions |
| `unknown method: X` | Method name misspelled | Check API reference above; method names are camelCase |
| `unknown prop type: X` | Prop name misspelled | Run `listProps()` for exact names; use kebab-case (e.g. `"map-table"`) |
| `out of bounds` | row/col outside grid dimensions | Call `getMapInfo()` to check rows/cols; remember 0-indexed |
| `invalid fill type` | Bad fill type string | Only `"pit"`, `"water"`, or `"lava"` are valid for `setFill`/`setFillRect`. For hazard/difficult-terrain, use `setHazard`/`setHazardRect` |


---

## Tips

- Always use `createRoom` instead of manually painting cells + setting walls. It handles all the auto-walling logic.
- Use `"merge"` mode when adding rooms adjacent to existing ones to avoid double walls.
- Use `setFillRect` instead of looping `setFill` — it's one undo step and far fewer commands.
- Use `getRoomBounds` to get a room's extent before placing props, doors, or stairs.
- Use `findWallBetween` to locate the shared wall before placing a door.
- Use `mergeRooms` to tear down the wall between two adjacent rooms in a single call — equivalent to calling `removeWall` on every wall in the shared boundary.
- Use `shiftCells` to reposition all content when you need more space at an edge — the grid grows automatically, no content is lost.
- Take screenshots after major changes to visually verify the layout.
- The `--info` flag is useful for checking dimensions before editing.
- The `--commands-file` flag is better than inline `--commands` for complex maps with 20+ commands.
- All methods that modify the map push to the undo stack automatically.
- `--continue-on-error` is useful for debugging — lets you see how far a command sequence gets before failing.
- Use `--dry-run` to validate a command sequence executes without errors before committing to file I/O.
- Use `--export-png` instead of `--screenshot` when you need print-quality output. `--screenshot` captures the editor viewport; `--export-png` renders through the full compile pipeline with HQ lighting.
- Use `placeLight` with `preset: "torch"` (or `"brazier"`, `"candle"`, etc.) instead of manually specifying color/radius/intensity. Call `listLightPresets()` for all preset names.
- Use `removePropsInRect` to clear all props from a room in one call instead of calling `removeProp` on each cell.
- **AI workflow**: Use `planBrief` to generate all room coordinates from a graph description — never manually compute adjacency gaps or room positions.
- Use `setDoorBetween` instead of `findWallBetween` + `setDoor` when rooms are **directly adjacent** (share a wall). For rooms connected via merge-mode corridors, use explicit `setDoor` with computed coordinates instead — `findWallBetween` won't find walls across a merged-open boundary.
- Use `listRoomCells` to find valid interior positions for props, labels, or fills without computing bounds manually.
- Use `getValidPropPositions` to find safe anchor cells for multi-cell props (checks room membership and existing prop overlap).
- Use `createPolygonRoom` for L-shaped, U-shaped, or irregular rooms — pass the full list of cells, no rectangles required.
- Use `getRoomContents` to inspect what props, fills, doors, and textures already exist in a room before adding more.
- Use `suggestPlacement(rows, cols, adjacentTo)` to find free space for a new room without manually scanning the grid.
- Use `createCorridor(label1, label2)` for cave/tunnel connections where rooms have a gap between them. **Do NOT use for structural buildings** — place rooms flush (adjacent cols/rows) and use `setDoorBetween` instead. Corridor stubs in buildings look like airlocks.
- Use `getUndoDepth()` before a multi-step build, then `undoToDepth(depth)` to roll back everything if something goes wrong.
- `difficult-terrain` is NOT a valid fill type. Use `setHazard` / `setHazardRect` for hazardous/difficult terrain instead.
- Use `fillWallWithProps` to line a wall with bookshelves, torch-sconces, etc. — no manual coordinate loops needed.
- Use `lineProps` for rows of pillars or pews — specify start position, direction, and count.
- Use `scatterProps` for organic placement (rubble, mushrooms, bone piles) — places at random valid positions.
- Use `clusterProps` for furniture groupings (desk + chair + book-pile) — define relative offsets from an anchor point.
- Use `partitionRoom` to split a large room with an internal wall — optionally with a door at a specific position.
- Use `validateDoorClearance()` after placing props to check no props block doors.
- Use `validateConnectivity("A1")` after building to verify all rooms are reachable from the entrance.
- Use `getFullMapInfo()` for a comprehensive snapshot of the map state — includes all rooms, props, doors, lights, stairs, and bridges.
- Use `defineLevels` to set level boundaries on an existing grid without adding rows (useful after manual multi-level setup).

---

## Multi-Agent Map Generation

For complex multi-room dungeons, use a phased pipeline where agents coordinate by **producing command arrays** — never by writing to the map concurrently. This prevents all coordination conflicts.

### Why command arrays, not live edits

The Puppeteer server handles one session at a time. Multiple agents writing to the map in parallel would corrupt state. Instead, agents produce `.json` files of commands. Only the final integration step runs Puppeteer.

### The 5-Phase Pipeline

**Phase 1 — Planner (serial):** Takes adventure context and outputs `room_plan.json` — a list of rooms with semantic types (`"type": "throne-room"`, `"type": "forge"`, etc.), sizes, and connections.

**Phase 2 — Layout (serial):** Calls `planBrief` to compute spatial positions. Outputs `layout_commands.json` + `layout_info.json` (label → bounds, used by decorators).

To generate `layout_info.json` after layout:
```bash
node tools/puppeteer-bridge.js \
  --commands-file layout_commands.json \
  --save layout_base.json
node tools/puppeteer-bridge.js \
  --load layout_base.json \
  --commands '[["listRooms"]]'
```

**Phase 3 — Decorators (parallel):** One agent per room. Each reads its room label, type, and bounds from `layout_info.json`, then produces `decorator_A1.json`, `decorator_A2.json`, etc.

**Strict decorator rules:**
- ONLY use: `placeProp`, `removeProp`, `setFill`, `setFillRect`, `removeFill`, `setHazard`, `setHazardRect`, `setTexture`, `setTextureRect`, `placeLight`, `setLabel`, `createTrim`, `setDoor`
- NEVER use: `newMap`, `createRoom`, `setTheme`, `setName`, `setFeature`, `addLevel`, or any structural commands
- ALL coordinates must fall within the assigned room's bounds (from `layout_info.json`)
- Read `mapwright/DESIGN.md` (Room Semantic Library section) to select props and fills for the room type

**Phase 4 — Integration (serial):** Concatenates all command arrays:
1. `layout_commands.json` first (structure)
2. All `decorator_*.json` files in room label order
3. Final tail: `["setAmbientLight", 0.3]`, `["setLightingEnabled", true]`, `["waitForTextures", 5000]`

Output: `final_commands.json`

**Phase 5 — Execution:**
```bash
# Validate first
node tools/puppeteer-bridge.js \
  --commands-file final_commands.json \
  --dry-run --continue-on-error

# Normal headless render
node tools/puppeteer-bridge.js \
  --commands-file final_commands.json \
  --save dungeon.json \
  --export-png dungeon.png

# Debug mode — visible browser, watch the map build in real time
node tools/puppeteer-bridge.js \
  --commands-file final_commands.json \
  --visible \
  --slow-mo 150 \
  --save dungeon.json \
  --export-png dungeon.png
```

### Debug Mode (`--visible --slow-mo`)

`--visible` launches a headed (non-headless) browser window. `--slow-mo <ms>` adds a delay between each command so you can watch the map assemble step by step. Use `--slow-mo 0` for fast-but-visible, `--slow-mo 200` to clearly see each prop placement.

### Room Semantic Library

The design rules, room type → prop/fill/lighting specs, spatial arrangement patterns, and multi-agent coordination details are documented in `mapwright/DESIGN.md`. **Read it before generating any map.**

