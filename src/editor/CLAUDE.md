# Dungeon Editor Automation Guide

This guide explains how to programmatically create and edit maps using the editor's automation API. Claude is the primary intended user of this API.

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

# Export map back to .map text format
node tools/puppeteer-bridge.js --load my_dungeon.json --export-map my_dungeon.map
```

## Bridge CLI Options

```
node tools/puppeteer-bridge.js [options]

--load <file.json>        Load map before commands
--commands '<json>'       Inline JSON command array
--commands-file <file>    Commands from a JSON file
--screenshot <out.png>    Save screenshot after commands
--save <file.json>        Save map JSON after commands
--export-map <out.map>    Export map as .map text after commands
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
- All coordinates are 0-indexed cell positions in **row, col** order throughout — both the API and the `.map` file format use the same convention.
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
| `importMapText` | `mapText` | Parse and import a `.map` text string directly (full round-trip from `exportToMapFormat`) |
| `getMap` | — | Export dungeon as JSON |
| `getMapInfo` | — | Get map metadata (see --info format above) |
| `setName` | `name` | Set dungeon name |
| `setTheme` | `theme` | Set theme (e.g. `"stone-dungeon"`) |
| `setLabelStyle` | `style` | Set label style: `"circled"`, `"plain"`, or `"bold"` |
| `setFeature` | `feature, enabled` | Toggle feature flag. Names: `"grid"`, `"compass"`, `"scale"`, `"border"` |
| `exportToMapFormat` | — | Export dungeon as `.map` text. Returns `{ success, mapText }`. Includes `# ROOMS` summary, column rulers, row annotations, doors, trims, stairs, fills, and a `props:` section. Full round-trip — the exported `.map` can be fed back to `build_map.js`. |

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
| `createTrim` | `r1, c1, r2, c2, [options]` | Cut diagonal corner from room |

The first point `(r1, c1)` is the corner tip (where the void starts). The second point `(r2, c2)` determines the size — the trim spans `max(|r2-r1|, |c2-c1|) + 1` cells along the diagonal.

Options object:
- `corner`: `"auto"` (default), `"nw"`, `"ne"`, `"sw"`, `"se"` — which corner to trim
- `round`: `false` (default) — if true, creates a curved arc instead of straight diagonal
- `inverted`: `false` (default) — flips arc direction (only with round)

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
| `createCorridor` | `label1, label2, [width=2]` | Auto-create a corridor between two adjacent, axis-aligned rooms. Computes corridor bounds from shared overlap, creates it with merge mode, auto-assigns the next room label, and places a door at each end. Returns `{ success, corridorLabel, r1, c1, r2, c2 }`. Throws if rooms have insufficient perpendicular overlap or no gap between them |

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
| `getValidPropPositions` | `label, propType, [facing=0]` | Return all valid anchor `[[row, col], ...]` where the prop fits inside the room without overlapping existing props. Returns `{ success, positions }` |
| `suggestPlacement` | `rows, cols, [adjacentTo]` | Find a free rectangular area of the given size. If `adjacentTo` is a room label, prefers positions adjacent to it. Returns `{ r1, c1, r2, c2 }` or `{ error }` |
| `getUndoDepth` | — | Return current undo stack depth as a number. Record before a build to enable rollback |
| `undoToDepth` | `targetDepth` | Undo all changes back to a previously recorded depth. Returns `{ success, undid }` |
| `placeLightInRoom` | `label, preset, [config]` | Place a light at the center of a labeled room; handles world-feet conversion. Same config as `placeLight`. Returns `{ success, id }` |

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

### Props (Furniture & Objects)

| Method | Args | Description |
|--------|------|-------------|
| `placeProp` | `row, col, propType, [facing=0]` | Place prop at anchor cell. Facing: `0`, `90`, `180`, `270` |
| `removeProp` | `row, col` | Remove prop from anchor cell |
| `rotateProp` | `row, col` | Rotate prop 90° clockwise |
| `listProps` | — | Returns `{ categories: string[], props: { [name]: { name, category, footprint: [rows, cols], facing: bool } } }` |
| `removePropsInRect` | `r1, c1, r2, c2` | Remove all props with anchor cells in rectangle. Returns `{ success, removed }` |

Prop names must exactly match the filename without `.prop` (e.g. `"map-table"`, `"bone-pile"`). See the full prop catalog below.

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

### Undo / Redo

| Method | Args | Description |
|--------|------|-------------|
| `undo` | — | Undo last action |
| `redo` | — | Redo last undone action |

**Build checkpointing pattern** — record depth before a multi-step build, then roll back everything if something goes wrong:
```json
["getUndoDepth"]
```
(Returns the depth as a plain number in the result field.) Then if the build needs to be reversed:
```json
["undoToDepth", 5]
```
This is in the AI Helpers section above.

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

### Trim a corner with rounded arc

```json
[
  ["createTrim", 2, 2, 5, 5, {"corner": "nw", "round": true}]
]
```
This trims the northwest corner, starting at (2,2) with a 4-cell diagonal, using a curved arc.

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

### Export back to .map format

```bash
node tools/puppeteer-bridge.js --load my_dungeon.json --export-map my_dungeon.map
```
The exported `.map` file is a full round-trip — it can be fed directly back to `build_map.js`. It includes:
- A `# ROOMS` block listing each labeled room with its bounds and center
- A column ruler above the grid and row number annotations on each grid row
- `doors:`, `trims:`, `stairs:`, `fills:`, and `props:` sections reconstructed from cell data

**`props:` format in `.map` files:**
```
props:
  row,col: proptype
  row,col: proptype facing:N   # N = 0, 90, 180, or 270
```
Props are placed at the anchor cell (top-left of the footprint). The prop catalog is loaded automatically by `build_map.js` at render time to resolve footprints and draw commands. Use `listProps()` for valid prop names.

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

Footprint is **W×H** (width × height in cells). Facing props rotate with the `facing` argument to `placeProp`. Use `listProps()` for the definitive runtime list.

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
| `No grid found` | `.map` file parse error | Ensure grid section is not empty and header `---` delimiters are present |

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
- Use `createCorridor(label1, label2)` to auto-create a connecting corridor with label + doors between two adjacent rooms — one call replaces createRoom + setLabel + setDoorBetween.
- Use `getUndoDepth()` before a multi-step build, then `undoToDepth(depth)` to roll back everything if something goes wrong.
- `difficult-terrain` is NOT a valid fill type. Use `setHazard` / `setHazardRect` for hazardous/difficult terrain instead.
