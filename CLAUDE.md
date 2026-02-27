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
- **Pipeline:** `puppeteer-bridge.js` commands → JSON + PNG screenshot
- **Supports:** Rooms, walls, doors, stairs, trims, fills, props, textures, lighting, multi-level maps, 16 themes, hundreds of props

```bash
node puppeteer-bridge.js \
  --commands '[["newMap","My Dungeon",25,35],["createRoom",2,2,10,12]]' \
  --screenshot out.png --save out.json
```

**Server check before using Puppeteer:**
```bash
curl -s http://localhost:3000 > /dev/null && echo "up" || echo "down"
```
If down, start it: `npm start` (runs in background). If up, use it directly.

### 2. `.map` Text Format (Hand-Authored)

Write dungeons as ASCII grids with a legend, doors, and features sections.

- **Format reference:** `guide.md`
- **Pipeline:** `.map` → `build_map.js` → PNG/SVG
- **Best for:** Hand-crafted maps where visual ASCII layout is preferred

```bash
node build_map.js my_dungeon.map
# Split into two steps:
node compile_map.js my_dungeon.map    # → .json
node generate_dungeon.js my_dungeon.json  # → .png
```

### 3. Standalone JSON Rendering

Render an existing compiled JSON dungeon directly to PNG/SVG.

```bash
node generate_dungeon.js my_dungeon.json
```

---

## Debugging Strategy

**Inspect data first, not geometry.** When a rendering issue appears, check map JSON properties, cell flags, and skip conditions before analyzing geometry math. The root cause is usually a simple conditional skip.

**Use temporary debug visualizations.** When a rendering issue is hard to trace (clips, geometry, z-order), add temporary canvas overlays (e.g., stroke clip regions in red, highlight skipped cells, draw bounding boxes). Remove after debugging.

**Take Puppeteer screenshots proactively.** Don't edit code blindly — take before/after screenshots to verify rendering changes:
```bash
node puppeteer-bridge.js --load map.json --screenshot out.png
node puppeteer-bridge.js --load map.json --commands '[["getCellInfo",5,7]]'
node puppeteer-bridge.js --load map.json --commands '[...]' --screenshot result.png --save map.json
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
- `build_map.js` — CLI entry point: `.map` → JSON → PNG/SVG.
- `compile_map.js` — Standalone: `.map` → `.json`.
- `generate_dungeon.js` — Standalone: `.json` → PNG/SVG.
- `src/compile/CLAUDE.md` — Full `.map` format reference.

---

### Domain: textures

**Keywords:** texture, floor, blend, tile, normal map, polyhaven

**Root dirs:** `src/textures/`, `src/editor/js/`

**Known files:**
- `editor/js/texture-catalog.js` — Loads `textures/manifest.json`, preloads images.
- `editor/js/panels/textures.js` — Texture selector panel UI.
- `render/blend.js` — Texture blending at cell edges and corners.
- `render/bridges.js` — Hardcoded Polyhaven texture IDs for bridge types.
- `textures/manifest.json` — Texture ID catalog (`polyhaven/*`).
- `tools/download-textures.js` — CLI tool to download required or all Polyhaven textures.

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
{ north, south, east, west: "w"|"d"|"s"|null,
  "nw-se", "ne-sw": "w"|null,
  fill, texture: {id, opacity},
  trimmed: true|undefined,
  center: {label},
  prop: {type, span, facing, flipped} }
```

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
