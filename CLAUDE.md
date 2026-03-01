# Mapwright — Claude Development Guide

## Auto-Context Protocol

When beginning work on this codebase, launch focused Explore agents BEFORE making changes. Use the domain table below to route tasks.

**Protocol:**
1. Identify which domains the task touches from the keyword mapping below
2. Launch 1-3 Explore agents in parallel, one per relevant domain
3. Each agent reads its domain's known files, globs root directories for any new files not in the reference, and returns: key exports, data structures, and patterns
4. If agents report files missing from the domain table, update this file before proceeding
5. Proceed with implementation only after agents return

**Skip auto-context when:**
- Follow-up task in the same session where context is already loaded
- Trivial change to a file already open/read in this conversation
- User provided specific file paths and full context for the change

---

## Map Generation Workflows

Three workflows for generating dungeon maps, from most to least recommended:

### 1. Editor API (Recommended for Claude)

Build maps programmatically using the Puppeteer automation API.

- **Full API reference:** `src/editor/CLAUDE.md`
- **Pipeline:** `tools/puppeteer-bridge.js` commands → JSON + PNG screenshot
- **Supports:** Rooms, walls, doors, stairs, trims, fills, props, textures, lighting, multi-level maps, 16 themes, hundreds of props

```bash
node tools/puppeteer-bridge.js \
  --commands '[["newMap","My Dungeon",25,35],["createRoom",2,2,10,12]]' \
  --screenshot out.png --save out.json
```

**Server check before using Puppeteer:**
```bash
curl -s http://localhost:3000 > /dev/null && echo "up" || echo "down"
```
If down, start it: `npm start` (runs in background). If up, use it directly.

### 2. `.map` Text Format (Hand-Authored)

Write dungeons as ASCII grids with a legend, doors, and features sections. See the **Map Format Reference** section below for full syntax.

- **Pipeline:** `.map` → `tools/build_map.js` → PNG/SVG
- **Best for:** Hand-crafted maps where visual ASCII layout is preferred

```bash
node tools/build_map.js my_dungeon.map
# Split into two steps:
node tools/compile_map.js my_dungeon.map    # → .json
node tools/generate_dungeon.js my_dungeon.json  # → .png
```

### 3. Standalone JSON Rendering

Render an existing compiled JSON dungeon directly to PNG/SVG.

```bash
node tools/generate_dungeon.js my_dungeon.json
```

---

## Barrel Import Rules

All imports within `src/` must go through barrel files (`index.js`), never directly from a specific module file.

| Directory | Barrel | Exports |
|---|---|---|
| `src/render/` | `render/index.js` | `renderCells`, `renderDungeonToCanvas`, `THEMES`, etc. |
| `src/util/` | `util/index.js` | `cellKey`, `isInBounds`, `floodFillRoom`, etc. |
| `src/compile/` | `compile/index.js` | `compileMap`, `compileLevel` |
| `src/editor/js/tools/` | `tools/index.js` | All tool classes, `SYRINGE_CURSOR`, `STAMP_CURSOR` |
| `src/editor/js/panels/` | `panels/index.js` | All panel init functions (prefixed: `initToolbar`, `initSidebar`, etc.) |

**Rules:**
- Always import from the barrel directory, not from the file: `from './tools/index.js'` not `from './tools/tool-room.js'`
- The panels barrel uses explicit named re-exports (not `export *`) to avoid `init()` name conflicts — each panel's `init` is re-exported as `initToolbar`, `initSidebar`, `initProperties`, `initMetadata`, `initLevels`, `initRightSidebar`
- **Exception:** Tool files may import `Tool` directly from `./tool-base.js` to avoid circular dependencies (the tools barrel imports from each tool file)

---

## Debugging Strategy

**Inspect data first, not geometry.** When a rendering issue appears, check map JSON properties, cell flags, and skip conditions before analyzing geometry math. The root cause is usually a simple conditional skip.

**Use temporary debug visualizations.** When a rendering issue is hard to trace (clips, geometry, z-order), add temporary canvas overlays (e.g., stroke clip regions in red, highlight skipped cells, draw bounding boxes). Remove after debugging.

**Take Puppeteer screenshots proactively.** Don't edit code blindly — take before/after screenshots to verify rendering changes:
```bash
node tools/puppeteer-bridge.js --load map.json --screenshot out.png
node tools/puppeteer-bridge.js --load map.json --commands '[["getCellInfo",5,7]]'
node tools/puppeteer-bridge.js --load map.json --commands '[...]' --screenshot result.png --save map.json
```

---

## Domain Routing Table

### Domain: rendering

**Keywords:** render, draw, canvas, theme, visual, border, compass, decoration, effect, scale indicator

**Root dirs:** `src/render/`

**Known files:**
- `render/render.js` — Main render orchestrator. `renderCells()` draws all cell layers (floors, walls, doors, fills, labels, props). Calls sub-renderers in layer order.
- `render/effects.js` — Visual effects: shadows, bloom, glow, fog-of-war transitions.
- `render/borders.js` — Dungeon border frame, compass rose, scale ruler, grid overlay.
- `render/decorations.js` — Background fill, dungeon title, compass rose positioning, scale indicator.
- `render/floors.js` — Floor base color and texture blending.
- `render/features.js` — Renders doors, stairs, trims, fills onto cells.
- `render/themes.js` — Theme color/style constants. `THEMES` object with all named themes.
- `render/bounds.js` — Spatial query helpers: `calculateBoundsFromCells()`, `toCanvas()`, `fromCanvas()`.
- `render/constants.js` — `GRID_SCALE`, `MARGIN`, and other render constants.
- `render/validate.js` — Dungeon matrix format validation.
- `render/compile.js` — Bridge from JSON dungeon → canvas rendering for PNG/SVG export. `renderDungeonToCanvas()`, `calculateCanvasSize()`.
- `render/props.js` — Prop rendering: `parsePropFile()`, `renderProp()`, `renderAllProps()`, `extractPropLightSegments()`.
- `render/lighting.js` — `extractWallSegments()`, `computeVisibility()`, `renderLightmap()`. Wall segments from cell grid + props, 2D raycasting visibility polygon.
- `render/lighting-hq.js` — `renderLightmapHQ()`. Per-pixel falloff, shadow mask rasterization, normal map bump. Used for PNG export only.
- `render/bridges.js` — Bridge rendering (wood, stone, rope, dock types). Contains hardcoded Polyhaven texture IDs.
- `render/blend.js` — Texture blending at cell edges and corners.
- `render/prop-catalog-node.js` — Node.js version of prop catalog for CLI rendering.
- `render/texture-catalog-node.js` — Node.js texture catalog loader for CLI rendering.

---

### Domain: lighting

**Keywords:** light, shadow, visibility, ambient, glow, ray, dark, lightmap, falloff

**Root dirs:** `src/render/`, `src/lights/`

**Known files:**
- `render/lighting.js` — `extractWallSegments()`, `computeVisibility()`, `renderLightmap()`.
- `render/lighting-hq.js` — `renderLightmapHQ()`. PNG export only.
- `editor/js/tools/tool-light.js` — Light placement tool.
- `editor/js/panels/lighting.js` — Lighting panel UI.
- `editor/js/light-catalog.js` — Light preset catalog loading and caching.
- `lights/manifest.json` — Light preset catalog (candle, torch, brazier, etc.).

**Focus:** Wall extraction → visibility polygon → lightmap pipeline, light object shape (`{id, x, y, type, radius, color, intensity, falloff, angle, spread}`), how props interact with lighting (`blocksLight`, `extractPropLightSegments`).

---

### Domain: props

**Keywords:** prop, furniture, object, place, footprint, blocks_light, shadow, catalog

**Root dirs:** `src/render/`, `src/props/`

**Known files:**
- `render/props.js` — `parsePropFile()`, `renderProp()`, `renderAllProps()`, `extractPropLightSegments()`.
- `editor/js/tools/tool-prop.js` — Prop placement tool.
- `editor/js/prop-catalog.js` — Loads `props/manifest.json` + all `.prop` files.
- `render/prop-catalog-node.js` — Node.js version for CLI rendering.
- `src/props/CLAUDE.md` — Prop creation guide: footprint conventions, draw command syntax, texture references, design patterns.

**Focus:** `.prop` file format (YAML header: name, category, footprint, facing, shadow, blocks_light + draw commands), `PropDefinition` shape, cell.prop shape (`{type, span, facing, flipped}`).

---

### Domain: editor

**Keywords:** editor, state, UI, panel, tool, undo, save, canvas-view, automation, puppeteer, API

**Root dirs:** `src/editor/js/`

**Known files — Core:**
- `editor/js/state.js` — Central store. `state`, `pushUndo()`, `undo()`, `redo()`, `markDirty()`, `notify()`, `subscribe()`, `getTheme()`.
- `editor/js/canvas-view.js` — Canvas render loop, pan/zoom, mouse event routing.
- `editor/js/main.js` — App init. Loads catalogs, wires toolbar/sidebar, registers tools.
- `editor/js/editor-api.js` — Puppeteer automation API (~70+ methods). Full reference: `src/editor/CLAUDE.md`.
- `editor/js/io.js` — File I/O. `loadDungeon()`, `saveDungeon()`, PNG export.
- `editor/js/utils.js` — `toCanvas()`, `fromCanvas()`, `pixelToCell()`, `nearestEdge()`, `createEmptyDungeon()`.
- `editor/CLAUDE.md` — Full Puppeteer automation API reference.

**Known files — Tools** (`editor/js/tools/`):
`tool-room`, `tool-paint`, `tool-fill`, `tool-erase`, `tool-wall`, `tool-door`, `tool-stairs`, `tool-trim`, `tool-label`, `tool-prop`, `tool-light`, `tool-select`, `tool-border`, `tool-range`

**Known files — Panels** (`editor/js/panels/`):
`toolbar`, `sidebar`, `right-sidebar`, `history`, `properties`, `metadata`, `textures`, `levels`, `lighting`, `session`

**Focus:** State shape (dungeon.metadata, dungeon.cells), mutation pattern (`pushUndo → modify → markDirty → notify`), tool interface (`onMouseDown/Move/Up/activate/deactivate`).

---

### Domain: compile

**Keywords:** compile, parse, .map, generate, build, export, PNG, JSON

**Root dirs:** `src/compile/`

**Known files:**
- `compile/compile.js` — `compileMap(mapPath)`. Parses header, compiles each level, merges into single grid.
- `compile/parse.js` — `parseMapFile()`, `parseLevelContent()`. Extracts grid, legend, doors, trims, stairs, fills, props, lights, bridges.
- `compile/features.js` — `applyTrims()`, `applyFills()`.
- `compile/grid.js` — Grid parsing and cell generation.
- `compile/trims.js` — Diagonal corner and arc trim geometry.
- `compile/constants.js` — Reserved characters and magic numbers.
- `render/compile.js` — `renderDungeonToCanvas()`, `calculateCanvasSize()`.
- `tools/build_map.js` — CLI entry point: `.map` → JSON → PNG/SVG.
- `tools/compile_map.js` — Standalone: `.map` → `.json`.
- `tools/generate_dungeon.js` — Standalone: `.json` → PNG/SVG.

---

### Domain: textures

**Keywords:** texture, floor, blend, tile, normal map, polyhaven

**Root dirs:** `src/textures/`, `src/editor/js/`

**Known files:**
- `editor/js/texture-catalog.js` — Browser texture catalog; fetches metadata from `/textures/` served by Express.
- `editor/js/panels/textures.js` — Texture selector panel UI.
- `render/blend.js` — Texture blending at cell edges and corners.
- `render/bridges.js` — Hardcoded Polyhaven texture IDs for bridge types.
- `render/texture-catalog-node.js` — Node.js texture catalog for CLI rendering. Reads from `MAPWRIGHT_TEXTURE_PATH` (Electron userData) or `src/textures/` (CLI fallback). Looks for `manifest.json` first, then scans `.texture` files.
- `tools/download-textures.js` — CLI tool to download required or all Polyhaven textures.

**Note:** `src/textures/` is empty in the repo. In the desktop app, textures are downloaded to the user's AppData folder (`MAPWRIGHT_TEXTURE_PATH`). For CLI tools (`build_map.js`, `generate_dungeon.js`), run `node tools/download-textures.js --required` to populate `src/textures/` locally.

**Focus:** Texture entry shape, how textures are stored on cells (`cell.texture = {id, opacity}`), blending logic.

---

### Domain: player-session

**Keywords:** player, DM, session, multiplayer, fog, WebSocket, fog-of-war

**Root dirs:** `src/player/`, `src/editor/js/`

**Known files:**
- `player/player-main.js`, `player/player-canvas.js`, `player/player-state.js`, `player/fog.js`
- `editor/js/dm-session.js` — DM ↔ Player WebSocket relay.
- `editor/js/panels/session.js` — Session panel UI.
- `server.js` — Express + WebSocket server.

---

### Domain: utilities

**Keywords:** grid, geometry, range, distance, util, helper

**Root dirs:** `src/util/`

**Known files:**
- `util/grid.js` — Grid utility functions shared across compile and render.
- `util/range-geometry.js` — Range and distance geometry helpers.

---

## Core Data Shapes

### Cell
```
{ north, south, east, west: "w"|"d"|"s"|"iw"|"id"|null,
  "nw-se", "ne-sw": "w"|"iw"|null,
  fill, texture: {id, opacity},
  trimmed: true|undefined,
  center: {label},
  prop: {type, span, facing, flipped} }
```

### Edge value taxonomy

| Value | Name | BFS | Casts shadow | Player sees |
|-------|------|-----|--------------|-------------|
| `"w"` | Wall | Blocks always | Yes | Wall |
| `"d"` | Door | Blocks (passable with `traverseDoors`) | Yes | Door |
| `"s"` | Secret door | Blocks (passable with `traverseDoors`) | Yes | Wall until opened |
| `"iw"` | Invisible wall | Blocks always | **No** | Nothing |
| `"id"` | Invisible door | Blocks (passable with `traverseDoors`) | **No** | Nothing (DM can open) |

Invisible types are stripped from player cells in `player/fog.js` and excluded from shadow geometry in `render/lighting.js` (`extractWallSegments`). **Note:** `render/lighting-hq.js` (export pipeline) imports `extractWallSegments` directly from `lighting.js`, so invisible-type exclusions apply automatically to both real-time and HQ rendering without any additional changes.

### Metadata
```
{ dungeonName, gridSize, theme, labelStyle,
  features: {showGrid, compassRose, scale, border},
  levels: [{name, startRow, numRows}],
  lightingEnabled, ambientLight,
  lights: [{id, x, y, type, radius, color, intensity, falloff, angle, spread}],
  bridges: [{id, type, points: [[r,c],[r,c],[r,c]]}],
  nextLightId, nextBridgeId }
```

### Coordinate System
- Grid: row 0=top ↓, col 0=left →. Cell address = `[row, col]`.
- World feet: `x = col * gridSize`, `y = row * gridSize`.
- Canvas pixels: `px = x * transform.scale + transform.offsetX`.

### State Mutation Pattern
```
pushUndo() → modify state.dungeon → markDirty() → notify()
```

---

## Adding a New Feature

When adding a new feature, every layer of the pipeline needs to be considered. Not all features touch every layer, but consciously decide which layers apply and verify each one is covered before considering the feature complete.

### Checklist

#### 1. Core: Does the feature work?

The rendering pipeline flows: `.map` file → parser → compiler → JSON → renderer → PNG/SVG.

- [ ] **Data model** — Define how the feature is stored in the matrix JSON (cell-level property, metadata field, etc.)
- [ ] **Parser** (`src/compile/parse.js`) — If the feature is configurable from `.map` files, add a new section keyword or header field. Validate syntax and emit clear errors with line numbers.
- [ ] **Compiler** (`src/compile/compile.js`, `grid.js`, `features.js`, `trims.js`) — If the feature transforms parsed data into cell properties, add the compilation step. Wire it into `compileLevel()` at the right stage.
- [ ] **Renderer** (`src/render/render.js`, `floors.js`, `borders.js`, `features.js`, `decorations.js`) — Add visual rendering. Determine which render pass the feature belongs in (floor fill, border, feature overlay, decoration).
- [ ] **Themes** (`src/render/themes.js`) — If the feature introduces new colors, add properties to the theme object and update all existing theme presets.
- [ ] **Constants** (`src/compile/constants.js`, `src/render/constants.js`) — If new reserved characters or magic numbers are needed, add them to the appropriate constants file.
- [ ] **Validation** — Add error messages for invalid configurations. Use the `srcLine()` helper in parse.js for line-number references.
- [ ] **CLI entry points** (`tools/build_map.js`, `tools/compile_map.js`, `tools/generate_dungeon.js`) — If the feature adds CLI flags, update argument parsing and usage text in all relevant entry points.
- [ ] **Examples** — Update or add example `.map` files in `examples/` that demonstrate the feature.
- [ ] **Documentation** — Update the Map Format Reference section in this file with syntax, valid values, rendering behavior, and any new validation errors.

#### 2. Editor: Can users control this feature visually?

- [ ] **State** (`src/editor/js/state.js`) — If the feature needs UI state, add it to the state object with a sensible default.
- [ ] **Tool** (`src/editor/js/tools/`) — If the feature is a new interactive tool or a sub-mode of an existing tool, create or update the tool class. Follow the `Tool` base class pattern.
- [ ] **Tool sub-options** — If the feature adds modes to an existing tool, add the button group to `index.html` and wire show/hide + active state in `toolbar.js`.
- [ ] **Toolbar** (`src/editor/js/panels/toolbar.js`) — Wire new buttons, mode selectors, or export actions.
- [ ] **Properties panel** (`src/editor/js/panels/properties.js`) — If the feature is a cell-level property, add it to the properties inspector.
- [ ] **Metadata panel** (`src/editor/js/panels/metadata.js`) — If the feature is a map-level setting, add a control to the metadata panel.
- [ ] **Canvas rendering** (`src/editor/js/canvas-view.js`) — If the feature affects rendering, pass new parameters through to `renderDungeonToCanvas()`.
- [ ] **HTML** (`src/editor/index.html`) / **CSS** (`src/editor/style.css`) — Add and style new UI elements.
- [ ] **Keyboard shortcuts** — If the feature warrants a shortcut, add it to the key handler in `main.js`.

#### 3. API: Can Claude control this feature programmatically?

- [ ] **Editor API** (`src/editor/js/editor-api.js`) — Add methods. Pattern: validate inputs → `pushUndo()` → modify state → `markDirty()` → `notify()` → return `{ success: true }`.
- [ ] **Puppeteer bridge** (`tools/puppeteer-bridge.js`) — The bridge is generic (calls any `editorAPI` method by name), so new API methods work automatically. Verify end-to-end.
- [ ] **API documentation** (`src/editor/CLAUDE.md`) — Document new methods with args, description, and examples.
- [ ] **`getMapInfo()`** — If the feature adds map-level metadata, include it in the return value.
- [ ] **`getCellInfo()`** — Cell-level properties are automatically included (deep clone of cell), but verify the new property is present.

### Layer Applicability by Feature Type

| Feature Type | Parser | Compiler | Renderer | Editor Tool | Editor Panel | API |
|---|---|---|---|---|---|---|
| New cell property (e.g. fill) | Yes (section) | Yes (apply to cells) | Yes (draw it) | Maybe (paint mode) | Yes (properties) | Yes (set/remove) |
| New metadata setting (e.g. label style) | Yes (header) | Pass-through | Yes (use it) | No | Yes (dropdown) | Yes (setter) |
| New decoration (e.g. compass) | Yes (header flag) | Pass-through | Yes (draw it) | No | Yes (checkbox) | Yes (setFeature) |
| New tool (e.g. eraser) | No | No | No | Yes (tool class) | Maybe | Yes (method) |
| New theme color | No | No | Yes (use it) | No | No | No |
| New export format | No | No | Maybe | Yes (button) | No | Maybe |

### Testing

```bash
# Build all example maps — verify no regressions
for f in examples/*.map; do node tools/build_map.js "$f"; done

# Test through the Puppeteer bridge
node tools/puppeteer-bridge.js --commands '[["newMethod", args]]' --screenshot test.png
```

### Reference Implementations

| Feature Type | Reference | Files |
|---|---|---|
| Cell property | **Fills** (difficult-terrain, pit) | `compile/features.js` → `render/features.js` → `editor-api.js:setFill` |
| Metadata setting | **Label style** (circled, plain, bold) | `compile/parse.js` header → `render/decorations.js` → `editor-api.js:setLabelStyle` |
| Interactive tool | **Door tool** | `editor/js/tools/tool-door.js` → `editor-api.js:setDoor` |
| Decoration toggle | **Compass rose** | `render/borders.js:drawCompassRose()` → `editor-api.js:setFeature` |
| Asset catalog | **Props** | `src/props/*.prop` → `prop-catalog.js` → `tool-prop.js` → `render/props.js` |
| Bulk rect operation | **Fill rect** | `editor-api.js:setFillRect` pattern |

---

## Map Format Reference

### How to Run

```bash
# Single command: compile + render (recommended)
node tools/build_map.js <name>.map

# With SVG output instead of PNG
node tools/build_map.js <name>.map --svg

# Validate only (no output files)
node tools/build_map.js <name>.map --check

# Watch mode (auto-rebuild on save)
node tools/build_map.js <name>.map --watch

# Two-step pipeline
node tools/compile_map.js <name>.map       # → .json
node tools/generate_dungeon.js <name>.json # → .png
```

### Header

Between `---` delimiters. Key-value pairs, one per line.

```
---
name: The Forgotten Crypt
theme: stone-dungeon
showGrid: true
compassRose: true
scale: true
border: true
---
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Dungeon name rendered as the title. |
| `theme` | Yes | Theme preset name (see Themes section). |
| `gridSize` | No | Feet per grid square. Default: 5. |
| `titleFontSize` | No | Font size override for the dungeon title in pixels. |
| `showGrid` | No | Show grid lines on background/non-room areas. Default: false. |
| `compassRose` | No | Draw a compass rose in an empty corner. Default: false. |
| `scale` | No | Show a scale indicator at the bottom. Default: false. |
| `border` | No | Draw a decorative border around the map. Default: false. |
| `labelStyle` | No | Room label style: `circled` (default), `plain`, or `bold`. |

#### Theme Overrides

```
---
name: Custom Crypt
theme: stone-dungeon
themeOverrides:
  wallFill: #444444
  background: #333333
---
```

### ASCII Grid

Each character defines one grid square. All rows must be the same length — pad shorter rows with `.`.

| Character | Meaning |
|---|---|
| `.` | Void / empty space |
| `-` or `#` | Walled corridor — generates walls on all sides facing other rooms |
| `=` | Open corridor — no walls generated against adjacent rooms |
| Any other | Room cell — all contiguous cells of the same character form one room |

Use `=` to connect rooms through void space without walls between them. Do NOT place `=` between directly adjacent rooms (it merges them visually).

### Legend

Maps grid characters to room labels. Appears after the grid.

```
legend:
  A: A1
  B: A2
  n:        # unlabeled corridor (empty value)
```

- Every non-reserved character in the grid **must** have a legend entry.
- Characters with labels render circled labels. Empty labels (`n:`) are unlabeled corridors.
- Reserved characters `.`, `-`, `#`, `=` cannot be legend keys.

### Doors

```
doors:
  5,8: door
  3,4 west: door
  1,2: secret
```

**Format:** `col,row: type` or `col,row direction: type`

- Coordinates are **col,row** (x,y). Column 0 = left edge, row 0 = top edge.
- Types: `door` or `secret`.
- When no direction is given, the compiler auto-detects which wall faces a different room. Add a direction (`north`, `south`, `east`, `west`) if the cell borders multiple different rooms.
- The door is placed on both sides of the wall automatically.
- **Double doors:** Two adjacent same-type doors on the same wall automatically render as one double door.

### Trims

```
trims:
  K7: nw
  K8: ne2
  K9: sw, se
  K10: nw3r
  K11: nw3ri
```

**Format:** `label: corner[N][r|ri], ...`

- Valid corners: `nw`, `ne`, `sw`, `se`.
- **Size** (optional): `nw` = 1 cell, `nw2` = 2 cells, `nw3` = 3 cells.
- **Rounded** (optional): `r` = convex arc (rounds the corner outward), `ri` = concave arc (cuts into the room).
- Apply `r` to all 4 corners with matching size to create a circular tower.
- Trims must not overlap on the same room.

### Stairs

```
stairs:
  4,2: down                     # explicit coordinate, standalone
  2,0: down - 10,8: up          # explicit, linked pair
  A1: up - L2:B1: down          # room-relative, cross-level linked
  A1: up - L2:8,1: down         # mixed: room-relative + explicit
```

- Types: `up` or `down`.
- **Room-relative syntax** (`RoomLabel: type`): auto-places at the room's centroid, avoiding trim cells and existing labels. More resilient to trim changes than explicit coordinates.
- **Cross-level linked** (`L#:` prefix): links stairs across levels. Coordinates are relative to that level's grid.
- Stairs cannot share a cell with a room label or be placed on diagonal trim cells.

### Fills

```
fills:
  A3: pit
  A5: difficult-terrain
  A6: water
```

| Fill Type | Rendering |
|---|---|
| `pit` | Dark filled floor |
| `difficult-terrain` | Diagonal cross-hatching |
| `water` | Water depth shading |

### Levels

Use `=== Level Name ===` markers to define separate floors in one `.map` file.

```
---
name: The Tower
theme: stone-dungeon
---

=== Ground Floor ===

AAAAABBBBB
AAAAABBBBB

legend:
  A: A1
  B: A2

stairs:
  8,1: up - L2:8,1: down

=== Upper Floor ===

CCCCCDDDDDD

legend:
  C: B1
  D: B2
```

- Levels are numbered implicitly (first `===` = L1, etc.).
- Coordinates are level-relative (row 0 = top of that level's grid).
- Room labels must be unique across all levels.
- Characters can be reused across levels (each level has its own legend).
- Use different letter prefixes per level (A1/A2 for L1, B1/B2 for L2, etc.).

### Themes

| Theme | Best For |
|---|---|
| `stone-dungeon` | Crypts, tombs, underground fortresses |
| `crypt` | Dark stone crypts, undead lairs |
| `earth-cave` | Natural caves, mines, burrows |
| `ice-cave` | Frozen environments, winter dungeons |
| `water-temple` | Aquatic environments, flooded ruins |
| `underdark` | Deep underground, Underdark passages |
| `volcanic` | Lava caves, fire-themed dungeons |
| `swamp` | Bog ruins, murky environments |
| `desert` | Arid ruins, sand-buried dungeons |
| `dirt` | Earthen burrows, rough tunnels |
| `grasslands` | Outdoor overworld, surface maps |
| `snow-tundra` | Arctic overworld, frozen wastes |
| `arcane` | Wizard towers, magical environments |
| `alien` | Sci-fi, aberrant, Far Realm |
| `blue-parchment` | Clean architectural style, general purpose |
| `sepia-parchment` | Aged/historical feel, classic module aesthetic |

### Validation Errors

| Error | Cause |
|---|---|
| `Missing header` | No `---` delimiters found |
| `Header missing "name"/"theme"` | Required field absent |
| `Character 'X' appears in grid but is not in legend` | Add to legend or replace with `.` |
| `Character 'X' has disconnected cells` | Same character appears in separate non-contiguous groups |
| `Door at col,row: out of bounds / void / no wall / ambiguous` | Check coordinates and add direction if needed |
| `Trim references unknown room label` | Label doesn't match any legend value |
| `trim extends beyond the room` | Reduce trim size or enlarge the room |
| `trim overlaps with another trim` | Reduce trim sizes so they don't affect the same cell |
| `Unreachable rooms from X` | Add doors or corridors to connect isolated rooms |
| `Stairs at col,row: out of bounds / void / cell has label / diagonal border` | Move to valid cell or use room-relative syntax |

### Room Sizing for Combat

| Size | Space | Grid Squares (5 ft) |
|---|---|---|
| Medium (humanoid) | 5×5 ft | 1×1 |
| Large (ogre, dire wolf) | 10×10 ft | 2×2 |
| Huge (giant, young dragon) | 15×15 ft | 3×3 |
| Gargantuan (ancient dragon) | 20×20 ft | 4×4 |

**Formula:** Total creature squares + 50–100% extra for movement/flanking/terrain.

### Room Numbering

Number all spaces in **exploration order from the entrance**, not by spatial position.

1. **A1 is always the entrance.**
2. Number sequentially along the main path.
3. Include corridors in the numbering.
4. Branch rooms get the next available number when the branch is first encountered.
5. Secret/optional spaces get the highest numbers.
6. Dead-end branches before continuing rooms.

### Examples

Example maps are in `examples/`. Build with:
```bash
node tools/build_map.js examples/island.map
```
