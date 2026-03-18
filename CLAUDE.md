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

## Design Reference

**Before generating any map, read `mapwright/DESIGN.md`.** It contains:
- Room semantic library (20+ room types → props, fills, lighting specs)
- Universal spatial rules (anchor-first, hug-walls, door clearance, clustering)
- Prop density guide, fill usage patterns, lighting design
- Multi-agent map generation pipeline (5-phase command-list architecture)
- Anti-patterns to avoid

**Room templates** in `mapwright/room-templates/` are ready-to-run JSON examples for common room types:

| Template | File |
|---|---|
| Throne Room | `room-templates/throne-room.json` |
| Alchemist's Lab | `room-templates/alchemist-lab.json` |
| Forge / Smithy | `room-templates/forge.json` |
| Crypt / Ossuary | `room-templates/crypt.json` |
| Temple / Shrine | `room-templates/temple.json` |
| Wizard's Sanctum | `room-templates/wizard-sanctum.json` |
| Prison Block | `room-templates/prison-block.json` |

Run any template: `node tools/puppeteer-bridge.js --commands-file room-templates/throne-room.json --screenshot out.png`

---

## Map Generation Workflows

### Editor API (Recommended for Claude)

Build maps programmatically using the Puppeteer automation API via the `mcp__mapwright__execute_commands` MCP tool.

- **Full API reference:** `src/editor/CLAUDE.md`
- **Supports:** Rooms, walls, doors, stairs, trims, fills, props, textures, lighting, multi-level maps, 16 themes, hundreds of props

**CRITICAL: Build iteratively, not in one shot.** Use multiple `execute_commands` calls with `screenshot_file` between phases. Never generate 50+ commands and execute them blind.

**Correct iterative workflow:**
```
Phase 1: planBrief → screenshot → verify layout
Phase 2: setTextureRect per room → waitForTextures → screenshot
Phase 3: getValidPropPositions → placeProp per room → screenshot
Phase 4: placeLightInRoom per room → screenshot
```

**AI helpers that eliminate coordinate guessing (use these every time):**
- `planBrief` — compute full layout from room sizes + connection topology
- `listRooms` — get actual bounds after planBrief (use these, not input estimates)
- `findWallBetween` — correct door positions between rooms
- `setDoorBetween` — place door at midpoint of shared wall automatically
- `getPropFootprint` — exact cells a prop occupies at a given rotation; use before placing any multi-cell prop on a wall
- `getValidPropPositions` — valid anchor cells for a prop inside a room (free-space query — excludes occupied cells, not structurally invalid ones)
- `placeLightInRoom` — light at room center, no world-feet math needed
- `createCorridor` — auto-corridor with doors between adjacent rooms
- `undoToDepth` — rollback to a checkpoint if something goes wrong

**Texture IDs are full polyhaven paths** — e.g. `polyhaven/cobblestone_floor_03`, `polyhaven/dirt_floor`, `polyhaven/wood_floor`. Short IDs like `"cobblestone"` do NOT exist and silently do nothing. Check `AppData/Roaming/mapwright/textures/manifest.json` for all available IDs. Good defaults: `polyhaven/cobblestone_floor_03` (dungeon stone), `polyhaven/dirt_floor` (cave/cell floors), `polyhaven/wood_floor` (barracks/office floors).

**The server must be started with `MAPWRIGHT_TEXTURE_PATH` set** for textures to appear in the export PNG:
```bash
MAPWRIGHT_TEXTURE_PATH="C:\\Users\\leonk\\AppData\\Roaming\\mapwright\\textures" npm start
```

**Light radius cap:** torch=15, brazier=22, max=28 for any indoor light. Never use radius >30 indoors.

**Server check before using Puppeteer:**
```bash
curl -s http://localhost:3000 > /dev/null && echo "up" || echo "down"
```
If down, start it: `npm start` (runs in background). If up, use it directly.

**Stop the server when done — but only if you started it.** If the server was already running before your task, leave it alone (it's likely the user's own session). If you had to start it, kill it after finishing:
```bash
netstat -ano | grep ':3000' | grep 'LISTENING' | awk '{print $5}' | head -1 | xargs -I{} taskkill //PID {} //T //F
```

---

## Barrel Import Rules

All imports within `src/` must go through barrel files (`index.js`), never directly from a specific module file.

| Directory | Barrel | Exports |
|---|---|---|
| `src/render/` | `render/index.js` | `renderCells`, `renderDungeonToCanvas`, `THEMES`, etc. |
| `src/util/` | `util/index.js` | `cellKey`, `isInBounds`, `floodFillRoom`, etc. |
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
- `render/compile.js` — Bridge from JSON dungeon → canvas rendering for PNG export. `renderDungeonToCanvas()`, `calculateCanvasSize()`.
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

**Note:** `src/textures/` is empty in the repo. In the desktop app, textures are downloaded to the user's AppData folder (`MAPWRIGHT_TEXTURE_PATH`). For CLI tools, run `node tools/download-textures.js --required` to populate `src/textures/` locally.

**Focus:** Texture entry shape, how textures are stored on cells (`cell.texture = {id, opacity}`), blending logic.

---

### Domain: player-session

**Keywords:** player, DM, session, multiplayer, fog, WebSocket, fog-of-war, dm-view, reveal

**Root dirs:** `src/player/`, `src/editor/js/`

**Known files:**
- `player/player-main.js` — Player view entry point; connects to WebSocket, drives player canvas.
- `player/player-canvas.js` — Renders the player's view of the map with fog-of-war applied.
- `player/player-state.js` — Shared state for the player view (revealed cells, current level).
- `player/fog.js` — Strips invisible wall/door types (`iw`, `id`) from cells before sending to players; manages reveal state.
- `editor/js/dm-session.js` — DM session state (`sessionState`), WebSocket relay logic, and the DM fog overlay. Key exports: `toggleDmView()`, `renderDmFogOverlay()`, `renderSessionOverlay()`.
- `editor/js/panels/session.js` — Session panel UI (start/stop session, reveal controls, player count).
- `server.js` (`/ws` endpoint) — WebSocket relay: DM sends commands to all players; tracks player count and notifies DM on join/leave.

**DM fog overlay:** `sessionState.dmViewActive` toggles a dark tint over all unrevealed cells in the DM view. Rendered via `renderDmFogOverlay(ctx, transform, gridSize)` — registered with `setDmFogOverlay()` in `canvas-view.js` and called each frame when active.

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

- [ ] **Data model** — Define how the feature is stored in the matrix JSON (cell-level property, metadata field, etc.)
- [ ] **Renderer** (`src/render/render.js`, `floors.js`, `borders.js`, `features.js`, `decorations.js`) — Add visual rendering. Determine which render pass the feature belongs in (floor fill, border, feature overlay, decoration).
- [ ] **Themes** (`src/render/themes.js`) — If the feature introduces new colors, add properties to the theme object and update all existing theme presets.
- [ ] **Constants** (`src/render/constants.js`) — If new magic numbers are needed, add them to the constants file.
- [ ] **Validation** — Add error messages for invalid configurations.

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

| Feature Type | Renderer | Editor Tool | Editor Panel | API |
|---|---|---|---|---|
| New cell property (e.g. fill) | Yes (draw it) | Maybe (paint mode) | Yes (properties) | Yes (set/remove) |
| New metadata setting (e.g. label style) | Yes (use it) | No | Yes (dropdown) | Yes (setter) |
| New decoration (e.g. compass) | Yes (draw it) | No | Yes (checkbox) | Yes (setFeature) |
| New tool (e.g. eraser) | No | Yes (tool class) | Maybe | Yes (method) |
| New theme color | Yes (use it) | No | No | No |
| New export format | Maybe | Yes (button) | No | Maybe |

### Testing

```bash
# Test through the Puppeteer bridge
node tools/puppeteer-bridge.js --commands '[["newMethod", args]]' --screenshot test.png
```

### Reference Implementations

| Feature Type | Reference | Files |
|---|---|---|
| Cell property | **Fills** (difficult-terrain, pit) | `render/features.js` → `editor-api.js:setFill` |
| Metadata setting | **Label style** (circled, plain, bold) | `render/decorations.js` → `editor-api.js:setLabelStyle` |
| Interactive tool | **Door tool** | `editor/js/tools/tool-door.js` → `editor-api.js:setDoor` |
| Decoration toggle | **Compass rose** | `render/borders.js:drawCompassRose()` → `editor-api.js:setFeature` |
| Asset catalog | **Props** | `src/props/*.prop` → `prop-catalog.js` → `tool-prop.js` → `render/props.js` |
| Bulk rect operation | **Fill rect** | `editor-api.js:setFillRect` pattern |

---

