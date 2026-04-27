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

Room palettes, density, and spatial arrangement for common room types are documented in `mapwright/DESIGN.md` under "Room Semantic Library". There are no template files — each room is designed fresh from those primitives so dungeons don't feel like collections of stamped rooms.

---

## Map Generation Workflows

### Editor API (Recommended for Claude)

Build maps programmatically using the Puppeteer automation API via the `mcp__mapwright__execute_commands` MCP tool.

- **Workflow + high-traffic API reference:** [src/editor/CLAUDE.md](src/editor/CLAUDE.md). The full 250+ method API is discoverable at runtime via `apiCategories` / `apiSearch` / `apiDetails`.
- **Supports:** Rooms, walls, doors, windows, stairs, bridges, trims, fills, props (~1500), textures (Polyhaven), lighting (47 presets, animations, groups, cookies, gobos), weather, multi-level maps, 16 themes

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

All imports within `src/` must go through barrel files (`index.ts`), never directly from a specific module file.

| Directory | Barrel | Exports |
|---|---|---|
| `src/render/` | `render/index.ts` | `renderCells`, `renderDungeonToCanvas`, `THEMES`, etc. |
| `src/util/` | `util/index.ts` | `cellKey`, `isInBounds`, `floodFillRoom`, etc. |
| `src/editor/js/tools/` | `tools/index.ts` | All tool classes, `SYRINGE_CURSOR`, `STAMP_CURSOR` |
| `src/editor/js/panels/` | `panels/index.ts` | All panel init functions (prefixed: `initToolbar`, `initSidebar`, etc.) |

**Rules:**
- Always import from the barrel directory, not from the file: `from './tools/index.js'` not `from './tools/tool-room.js'` (note: TypeScript import paths use `.js` extensions by convention even though source files are `.ts`)
- The panels barrel uses explicit named re-exports (not `export *`) to avoid `init()` name conflicts — each panel's `init` is re-exported as `initToolbar`, `initSidebar`, `initProperties`, `initMetadata`, `initLevels`, `initRightSidebar`, `initHistoryPanel`, `initLightingPanel`, `initWeatherPanel`, `initSessionPanel`, `initTexturesPanel`, `initClaudePanel`, `initBackgroundImagePanel`, `initKeybindingsHelper`, `initDebugPanel`, `initPropEditDialog`, `initLightEditDialog`. (Authoritative list: [panels/index.ts](src/editor/js/panels/index.ts).)
- **Exception:** Tool files may import `Tool` directly from `./tool-base.ts` to avoid circular dependencies (the tools barrel imports from each tool file)

---

## Changelog Maintenance

When you ship a user-visible change, append it to `CHANGELOG.md` under the version that matches the current branch. Branch names follow `release/<version>` — `release/0.10.0` → write to the `## v0.10.0` section. If that section doesn't exist yet, create it at the top of the file.

**Audience: end users, not developers.** They install the desktop app and want to know what's new, what got faster, what got fixed. They don't read source code. Avoid:
- Internal function names (`mutate()`, `_collectRoomCells`)
- File paths or module references
- Refactoring details that don't change behavior
- Test counts, lint cleanups, type safety improvements

Include:
- **What changed** in plain language ("Door placement now flags blocked approaches", not "added validateDoorClearance API method")
- **Why it matters** to the user when it's not obvious ("...so you don't lose props to misplaced doors")
- **Breaking changes** — flag clearly so users know to update their workflows
- New features, bug fixes, performance wins, UI changes

**Organize by topic, not by commit.** Group related items under section headings (`### Lighting`, `### Editor UI`, `### Performance`). Existing sections in `## v0.10.0` show the pattern — match its tone and depth. If a change touches a new area, add a new `###` heading.

**Format per entry:** start with a bold lead phrase that names the change, then a short clause explaining what it does or why it's there.
- `- **Wall blends now respect texture opacity** — fixes the seam that appeared when blending two partially-transparent floor textures`

**Features vs. bug fixes — different framing.** A bug-fix entry says what was wrong and is now right. A feature entry markets the capability that shipped — it's a launch announcement, not a worklog. Critically: when delivering a feature meant fixing N specific issues along the way (a leaky flood-fill, a wrong-segment write, a misaligned highlight), those bugs do **not** become the changelog entries. They're the path to the feature; only the feature ships in the changelog.

A feature section should read like:
1. **The headline capability** — one entry naming what you built and what it lets the user do (e.g. "Cells now use a polygon-segment model — curved walls are first-class boundaries"). This is the lead.
2. **Concrete user-facing behaviors** — 2-4 entries describing what each tool now does, what new shapes are possible, what variants behave the same, etc. Each one is a capability statement, not "we fixed X."
3. **"Foundation for…" or "what's next"** (optional) — if the work unlocks a future feature, name it. Helps users understand why the change is bigger than what's immediately visible.

If you find yourself writing "used to leak / used to crash / now correctly does X" for a *new feature* (not a fix), you're framing it as a worklog. Rewrite as "X works the way you'd expect across every tool" instead.

**Skip the changelog when:** the change is purely internal (refactor, test, lint, dependency bump with no behavior change, code reorganization). If you're unsure whether it's user-visible, it probably isn't — ask the user.

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
- `render/index.ts` — Main barrel export; re-exports all public render functions and constants.
- `render/render.ts` — Barrel re-export from render-state, render-cache, render-phases, render-cells.
- `render/render-cells.ts` — Main render orchestrator. `renderCells()` draws all cell layers in order.
- `render/render-phases.ts` — Multi-phase rendering (floors, blending, grid, hazards, walls, labels, props). Exports `renderFloors()`, `renderFillPatternsAndGrid()`, `renderWallsAndBorders()`, `renderLabelsStairsProps()`.
- `render/render-props.ts` — Canvas rendering and tile caching for props. `renderProp()`, `renderAllProps()`, `renderOverlayProps()`.
- `render/render-cache.ts` — Per-frame caches for room cells, geometry, blend/fluid regions. `getCachedRoomCells()`, `invalidateGeometryCache()`.
- `render/render-state.ts` — Render performance profiling and frame state. `renderTimings`, `getContentVersion()`, `getGeometryVersion()`.
- `render/map-cache.ts` — Offscreen cache with two layers + snapshot. `MapCache` class and cache management.
- `render/effects.ts` — Visual effects: shadows, bloom, glow, fog-of-war transitions. `drawWallShadow()`, `drawRoughWalls()`, `drawBufferShading()`.
- `render/borders.ts` — Dungeon border frame, wall/door rendering. `renderBorder()`, `drawStairsInCell()`, `wallSegmentCoords()`.
- `render/decorations.ts` — Background fill, dungeon title, compass rose positioning, scale indicator. `drawBackground()`, `drawCompassRose()`, `drawScaleIndicator()`.
- `render/floors.ts` — Floor base color and texture blending. `determineRoomCells()`.
- `render/features.ts` — Renders labels onto cells. `drawCellLabel()`, `drawDmLabel()`.
- `render/themes.ts` — Shared mutable theme registry. `THEMES` object populated at runtime.
- `render/bounds.ts` — Spatial query helpers: `calculateBoundsFromCells()`, `toCanvas()`, coordinate utilities.
- `render/constants.ts` — `GRID_SCALE`, `MARGIN`, `LINE_WIDTH`, `Z_POSITIONS`, `FEATURE_SIZES`, `BRIDGE_TEXTURE_IDS`.
- `render/validate.ts` — Top-level matrix-format validator. Delegates to the four `validate-*.ts` siblings: `validate-cells.ts` (cell shape, segment integrity), `validate-coordinates.ts` (bounds, level row math), `validate-rooms.ts` (BFS room sanity), `validate-structure.ts` (metadata, lights, stairs, weather).
- `render/compile.ts` — Bridge from JSON dungeon → canvas rendering for PNG export. `renderDungeonToCanvas()`, `calculateCanvasSize()`, `normalizeTheme()`.
- `render/theme-diff.ts` — Computes the minimal patch between two theme objects. Used by the theme editor panel to save only overrides.
- `render/render-weather.ts` — Per-frame weather particle and haze overlay. Driven by `metadata.weatherGroups`.
- `render/gobo.ts`, `render/parse-gobo.ts` — Procedural gobo pattern rendering and `.gobo` file parsing. Patterns: `slats`, `dapple`, `caustics`, `sigil`, `grid`, `stained-glass`, plus the named window gobos (`window-mullions`, `arrow-slit`, `cruciform`, etc.).
- `render/props.ts` — Barrel re-export of prop functions: `parsePropFile`, `renderProp`, `renderAllProps`, `generateHitbox`, `hitTestPropPixel`, `extractPropLightSegments`.
- `render/parse-props.ts` — Prop file parsing and coordinate transformation. `parsePropFile()`, `parseCommand()`, `parseCoord()`, `flipCommand()`, `transformCommand()`.
- `render/hitbox-props.ts` — Hitbox generation, hit testing, light segment extraction. `generateHitbox()`, `hitTestPropPixel()`, `extractPropLightSegments()`.
- `render/prop-validate.ts` — Validates prop draw commands stay within footprint bounds.
- `render/lighting.ts` — 2D lighting engine. `renderLightmap()`, `computeVisibility()`, `extractWallSegments()`, `falloffMultiplier()`. The same path is used for both real-time editor preview and PNG export — there is no separate HQ pipeline anymore.
- `render/lighting-geometry.ts` — Wall segment extraction and z-height prop shadow zones. `extractWallSegments()`, `extractPropShadowZones()`, `computePropShadowPolygon()`.
- `render/bridges.ts` — Bridge/dock rendering (wood, stone, rope, dock types). `renderAllBridges()`.
- `render/blend.ts` — Texture blending at cell edges and corners. `renderTextureBlending()`, `patchBlendRegion()`.
- `render/fluid.ts` — Fluid/liquid rendering (water, lava, pit). `getFluidPathCache()`, `getRenderedFluidLayer()`.
- `render/patterns.ts` — Hatching patterns and Voronoi effects data. `HATCH_PATTERNS`, `WATER_SPATIAL`.
- `render/export-dd2vtt.ts` — Universal VTT export for Foundry VTT, Roll20. `convertToDd2vtt()`.
- `render/warnings.ts` — Deduplicated render warnings collector. `warn()`, `flush()`.
- `render/prop-catalog-node.ts` — Node.js version of prop catalog for CLI rendering.
- `render/texture-catalog-node.ts` — Node.js texture catalog loader for CLI rendering.

---

### Domain: lighting

**Keywords:** light, shadow, visibility, ambient, glow, ray, dark, lightmap, falloff, gobo, cookie

**Root dirs:** `src/render/`, `src/lights/`, `src/gobos/`

**Known files:**
- `render/lighting.ts` — `extractWallSegments()`, `computeVisibility()`, `renderLightmap()`, `renderStaticLightmap()`, `renderAnimatedLightOverlay()`, plus gobo render integration. Used for both editor preview and PNG export.
- `render/lighting-config.ts` — Tuning knobs for the lighting pipeline (resolution, falloff curves, bake cache key derivation).
- `render/lighting-geometry.ts` — Wall segment extraction, prop shadow zones, gobo segment zones, and window aperture math. `extractWallSegments()`, `extractPropShadowZones()`, `computePropShadowPolygon()`, `extractGoboZones()`, `computeGoboProjectionPolygon()`, `GoboIndex`.
- `render/gobo.ts`, `render/parse-gobo.ts` — Procedural gobo pattern rendering and `.gobo` file parsing.
- `render/gobo-registry.ts` — In-memory gobo definition registry. Populated by editor / Node-side catalog loaders.
- `render/gobo-catalog-node.ts` — Node-side gobo catalog loader for the CLI render pipeline.
- `editor/js/tools/tool-light.ts` — Light placement tool.
- `editor/js/tools/tool-window.ts` — Window placement (windows project gobos through the aperture).
- `editor/js/panels/lighting.ts` — Lighting panel UI (presets, ambient, groups, bloom, animations).
- `editor/js/panels/light-edit.ts` — Per-light editor dialog (cookies, group, animation, soft-shadow, darkness mode).
- `editor/js/light-catalog.ts` — Light preset catalog loading and caching.
- `editor/js/gobo-catalog.ts` — Gobo catalog loader (bundle-first, publishes into `render/gobo-registry`).
- `src/lights/manifest.json` + `*.light` — Light preset catalog (47 presets). Authoritative list — never hardcode.
- `src/gobos/manifest.json` + `*.gobo` — Gobo catalog (16 patterns). Schema documented in [src/themes/CLAUDE.md](src/themes/CLAUDE.md).

**Focus:** Wall extraction → visibility polygon → lightmap pipeline. The full Light shape (incl. `animation`, `group`, `cookie`, `darkness`, `softShadowRadius`, `presetId`, `propRef`) is in [src/types.ts](src/types.ts). Prop interaction modes: (a) `blocks_light: yes` hitboxes → wall-segment / z-shadow projection; (b) `lights:` → auto-attached emitters with optional cookies; (c) `gobos:` → upright patterned occluders that any nearby light projects as a multiply mask (see [src/props/CLAUDE.md](src/props/CLAUDE.md)). Windows (edge-level) project gobos through an aperture 4–6 ft above the floor, casting a sunpool on the far side. Lightmap is split into a cached static layer (ambient + non-animated lights) and a per-frame animated overlay rendered at screen resolution. Lights can be grouped (`metadata.disabledLightGroups[]`) and the entire scene can have ambient animation (`metadata.ambientAnimation` — e.g. lightning).

---

### Domain: props

**Keywords:** prop, furniture, object, place, footprint, blocks_light, shadow, catalog, hitbox, selection

**Root dirs:** `src/render/`, `src/props/`

**Known files:**
- `render/props.ts` — Barrel re-export: `parsePropFile()`, `renderProp()`, `renderAllProps()`, `extractPropLightSegments()`, `generateHitbox()`, `hitTestPropPixel()`.
- `render/parse-props.ts` — Prop file parsing and coordinate transforms.
- `render/hitbox-props.ts` — Hitbox generation, hit testing, light segment extraction.
- `render/render-props.ts` — Canvas rendering and tile caching for props.
- `render/prop-validate.ts` — Validates prop draw commands stay within footprint bounds.
- `editor/js/tools/tool-prop.ts` — Prop placement tool.
- `editor/js/prop-catalog.ts` — Loads `props/manifest.json` + all `.prop` files. Auto-generates hitboxes at load time via `generateHitbox()`.
- `render/prop-catalog-node.ts` — Node.js version for CLI rendering.
- `src/props/CLAUDE.md` — Prop creation guide: footprint conventions, draw command syntax, hitbox/selection commands, texture references, design patterns.

**Focus:** `.prop` file format (YAML header: name, category, footprint, facing, shadow, blocks_light + draw commands + hitbox/selection overrides), `PropDefinition` shape (includes `hitbox`, `selectionHitbox`, `autoHitbox` polygon arrays), cell.prop shape (`{type, span, facing, flipped}`).

---

### Domain: editor

**Keywords:** editor, state, UI, panel, tool, undo, save, canvas-view, automation, puppeteer, API

**Root dirs:** `src/editor/js/`

**Known files — Core:**
- `editor/js/state.ts` — Central store. `state`, `pushUndo()`, `undo()`, `redo()`, `markDirty()`, `notify()`, `subscribe()`, `getTheme()`, `mutate()`.
- `editor/js/canvas-view.ts` — Canvas render loop, pan/zoom, mouse event routing.
- `editor/js/main.ts` — App init. Loads catalogs, wires toolbar/sidebar, registers tools.
- `editor/js/editor-api.ts` — Puppeteer automation API loader; delegates to modules in `editor/js/api/`.
- `editor/js/io.ts` — File I/O. `loadDungeon()`, `saveDungeon()`, PNG export.
- `editor/js/utils.ts` — `toCanvas()`, `fromCanvas()`, `pixelToCell()`, `nearestEdge()`, `createEmptyDungeon()`.
- `editor/CLAUDE.md` — Workflow + high-traffic Puppeteer API. Full method index lives in the runtime discovery registry (`apiSearch`/`apiDetails`).

**Known files — API modules** (`editor/js/api/`):
`_shared.ts` / `_rect-utils.ts` (helpers), `errors.ts` (ApiValidationError + stable codes), `index.ts` (barrel + method registry).

Domain modules: `cells`, `walls-doors`, `fills`, `textures`, `labels`, `trims`, `props`, `lighting`, `stairs-bridges`, `spatial`, `convenience`, `map-management`, `levels`, `validation`, `weather`.

AI / bulk / inspection modules: `plan-brief` (layout planner), `furnish` (autofurnish + propose/commit), `inspect` (renderAscii, queryCells, getRoomSummary), `transforms` (clone, mirror, rotate, replace), `discovery` (apiSearch, apiDetails, apiCategories), `vocab` (room semantic library lookups), `preview` (prop thumbnails), `operational` (waitForEditor, eval, clearCaches, render, pauseForReview).

**Known files — Tools** (`editor/js/tools/`):
`tool-base`, `tool-room`, `tool-paint`, `tool-fill`, `tool-erase`, `tool-wall`, `tool-door`, `tool-window`, `tool-stairs`, `tool-bridge`, `tool-trim`, `tool-label`, `tool-prop`, `tool-light`, `tool-weather`, `tool-select`, `tool-range`, `tool-fog-reveal`

**Known files — Panels** (`editor/js/panels/`):
`toolbar`, `sidebar`, `right-sidebar`, `history`, `properties`, `metadata`, `textures`, `theme-editor`, `levels`, `lighting`, `weather`, `session`, `claude-chat`, `background-image`, `keybindings-helper`, `debug`, `prop-edit` (prop editor dialog), `light-edit` (light editor dialog)

**Focus:** State shape (dungeon.metadata, dungeon.cells), mutation pattern (`pushUndo → modify → markDirty → notify` or `mutate()` for automatic patch tracking), tool interface (`onMouseDown/Move/Up/activate/deactivate`).

**Discovering API methods.** The Puppeteer / `editorAPI` surface has 250+ methods; never enumerate them by hand. Use the runtime discovery API:

```json
["apiCategories"]
["apiSearch", "prop", { "category": "bulk-props", "limit": 10 }]
["apiDetails", "proposeFurnishing"]
```

The static reference at [src/editor/CLAUDE.md](src/editor/CLAUDE.md) documents the workflow + high-traffic methods only — `apiSearch`/`apiDetails` is the source of truth for the rest.

---

### Domain: textures

**Keywords:** texture, floor, blend, tile, normal map, polyhaven

**Root dirs:** `src/textures/`, `src/editor/js/`

**Known files:**
- `editor/js/texture-catalog.ts` — Browser texture catalog; fetches metadata from `/textures/` served by Express.
- `editor/js/panels/textures.ts` — Texture selector panel UI.
- `render/blend.ts` — Texture blending at cell edges and corners.
- `render/bridges.ts` — Bridge rendering with Polyhaven texture IDs (centralized in `constants.ts` as `BRIDGE_TEXTURE_IDS`).
- `render/texture-catalog-node.ts` — Node.js texture catalog for CLI rendering. Reads from `MAPWRIGHT_TEXTURE_PATH` (Electron userData) or `src/textures/` (CLI fallback). Looks for `manifest.json` first, then scans `.texture` files.
- `tools/download-textures.js` — CLI tool to download required or all Polyhaven textures.

**Note:** `src/textures/` is empty in the repo. In the desktop app, textures are downloaded to the user's AppData folder (`MAPWRIGHT_TEXTURE_PATH`). For CLI tools, run `node tools/download-textures.js --required` to populate `src/textures/` locally.

**Texture bundle (metadata one-shot).** The editor fetches `/textures/bundle.json` — a single file containing every `.texture` metadata body keyed by id, plus a content-hash version — instead of 700+ per-file requests. PNG images still load lazily per-texture via `Image.src`; only the small JSON metadata gets bundled. Both the server's download SSE endpoint and `tools/download-textures.js` regenerate `manifest.json` and `bundle.json` together after every download session, so newly downloaded textures appear in the bundle on the next client load. If the bundle is missing or malformed the client falls back to the old manifest + per-file fetch path.

**Focus:** Texture entry shape, how textures are stored on cells (`cell.texture = {id, opacity}`), blending logic.

---

### Domain: player-session

**Keywords:** player, DM, session, multiplayer, fog, WebSocket, fog-of-war, dm-view, reveal

**Root dirs:** `src/player/`, `src/editor/js/`

**Known files:**
- `player/player-main.ts` — Player view entry point; connects to WebSocket, drives player canvas.
- `player/player-canvas.ts` — Renders the player's view of the map with fog-of-war applied.
- `player/player-state.ts` — Shared state for the player view (revealed cells, current level).
- `player/fog.ts` — Strips invisible wall/door types (`iw`, `id`) from cells before sending to players; manages reveal state.
- `editor/js/dm-session.ts` — DM session state (`sessionState`), WebSocket relay logic, and the DM fog overlay. Key exports: `toggleDmView()`, `renderDmFogOverlay()`, `renderSessionOverlay()`.
- `editor/js/panels/session.ts` — Session panel UI (start/stop session, reveal controls, player count).
- `server.js` (`/ws` endpoint) — WebSocket relay: DM sends commands to all players; tracks player count and notifies DM on join/leave.

**DM fog overlay:** `sessionState.dmViewActive` toggles a dark tint over all unrevealed cells in the DM view. Rendered via `renderDmFogOverlay(ctx, transform, gridSize)` — registered with `setDmFogOverlay()` in `canvas-view.ts` and called each frame when active.

---

### Domain: utilities

**Keywords:** grid, geometry, range, distance, util, helper

**Root dirs:** `src/util/`

**Known files:**
- `util/grid.ts` — Grid utility functions shared across compile and render. `OPPOSITE`, `cellKey`, `parseCellKey`, `isInBounds`, `floodFillRoom`, `CARDINAL_OFFSETS`.
- `util/range-geometry.ts` — Range and distance geometry helpers.
- `util/polygon.ts` — `pointInPolygon`, `pointOnPolygonEdge`, `getBridgeCorners`.
- `util/cell-segments.ts` — Polygon-segment model for cells. `getSegments(cell)` synthesizes the implicit "full" segment when `cell.segments` is absent. Load-bearing for trim/diagonal/arc rendering.
- `util/cell-halves.ts` — Half-key helpers for diagonal-split cells (`'ne'`/`'sw'` or `'nw'`/`'se'`) and arc trims (`'interior'`/`'exterior'`).
- `util/trim-geometry.ts` — Geometry math for diagonal corner trims and curved arcs (anchors, sweep angles, chord polygons).
- `util/traverse.ts` — BFS / connectivity traversal across the segment graph (replaces the older cell-only flood fill for anything that has to respect interior walls).
- `util/migrate-segments.ts` — One-shot migration that upgrades legacy cells (top-level trim fields, diagonals) to the segment model on load. Don't call from new code; legacy field references in this file are intentionally suppressed (see `feedback_legacy_field_isolation`).
- `util/flood-debug.ts` — Visualizer for traverse() reachability (used by the debug panel).
- `util/log.ts` — Tagged logger with per-tag debug toggles (`enableDebugTag('lighting')`).

---

### Domain: room semantic library

**Keywords:** room type, vocab, semantic, palette, library, forge, throne, alchemy, autofurnish

**Root dirs:** `src/rooms/`, `src/editor/js/`

**Known files:**
- `src/rooms/<category>/<name>.room.json` — Per-room-type vocab files. 10 categories: `dungeon`, `industrial`, `naval`, `outdoor`, `planar`, `residential`, `sacred`, `underground`, `urban`, `wilderness`. Each spec is a *palette* (primary/secondary/scatter prop options + lighting + texture suggestions + story prompts), not a fixed template.
- `src/rooms/_missing-props-report.json` — Audit output from `tools/_scan-missing-props.cjs`: which props each spec asks for that the catalog doesn't yet have. Used to prioritize new prop authoring.
- `editor/js/room-vocab.ts` — Browser-side loader. Fetches `/api/rooms/manifest` (server scans `src/rooms/**/*.room.json` at startup; no build step). Lazily fetches individual specs.
- `editor/js/api/vocab.ts` — Puppeteer API surface: `listRoomTypes`, `searchRoomVocab`, `getRoomVocab`, `suggestRoomType`. Read by `proposeFurnishing` to drive semantic furnishing.

**Focus:** `.room.json` schema (`size_guidance`, `primary_palette`, `secondary_palette`, `scatter_palette`, `lighting_guidance`, `texture_options`, `story_prompts`). Adding a new room type = drop a file in the right category dir, restart server. No manifest regeneration required.

**See `mapwright/DESIGN.md` "Room Semantic Library"** for usage in the multi-agent map generation pipeline.

---

### Domain: weather

**Keywords:** weather, rain, snow, fog, lightning, particles, haze, storm

**Root dirs:** `src/render/`, `src/editor/js/`

**Known files:**
- `render/render-weather.ts` — Per-frame particle + haze overlay. Reads `metadata.weatherGroups[]` and per-cell `cell.segments[].weatherGroupId`.
- `editor/js/tools/tool-weather.ts` — Paint tool for assigning cells to a group. Same flood/rect/cell modes as the fill tool.
- `editor/js/panels/weather.ts` — Weather panel: create/edit groups (type, intensity, wind, lightning, haze, particle color).
- `editor/js/api/weather.ts` — Puppeteer API: `createWeatherGroup`, `setWeatherGroup`, `setWeatherCell`, `setWeatherRect`, `floodFillWeather`, `listWeatherGroups`, `getWeatherCell`.

**Focus:** Weather lives in two places — group config in `metadata.weatherGroups[]`, per-cell membership via `cell.segments[].weatherGroupId`. Lightning on a group spawns ephemeral lights at render time (drives the existing wall-shadow / falloff pipeline), so a strike inside a walled room flashes only that room. Allowed types: `rain`, `snow`, `ash`, `embers`, `sandstorm`, `fog`, `leaves`, `cloudy`.

---

### Domain: windows

**Keywords:** window, gobo, sunpool, mullion, stained glass, clerestory, aperture

**Root dirs:** `src/render/`, `src/editor/js/`, `src/gobos/`

**Known files:**
- `editor/js/tools/tool-window.ts` — Window placement tool. Click an edge → places a window with the currently selected gobo id.
- `editor/js/api/walls-doors.ts` — Window API: `setWindow`, `removeWindow`. (Co-located with walls/doors because they're all edge-level.)
- `render/lighting-geometry.ts` — Window aperture math. Windows are stored as edges flagged `"win"` and project a gobo through the aperture (4–6 ft above floor by default) onto the far side.
- `src/gobos/manifest.json` + `*.gobo` — 16 procedural gobos. Window-suitable: `arrow-slit`, `cathedral-glass`, `cruciform`, `diamond-lattice`, `double-hung`, `horizontal-clerestory`, `leaded-grid`, `narrow-casement`, `none`, `portcullis-window`, `rose-window`, `tall-lancet`, `window-mullions`. Plus three non-window gobos (`vertical-bars`, `horizontal-slats`, `ceiling-grate`) used by gobo-prop occluders.

**Focus:** Adjacent windows render as one continuous wide window; adjacent windows sharing a `goboId` merge their gobo projection. Direction is canonicalized to `"north"` or `"west"` in `metadata.windows[]` — south/east edges are stored on the neighbor's north/west.

---

### Domain: downloader

**Keywords:** download, polyhaven, texture-download, electron, SSE

**Root dirs:** `src/downloader/`

**Known files:**
- `src/downloader/downloader.ts` — SSE client for the texture download flow. Connects to `/api/textures/download?mode=required|all`, mirrors per-file progress (DIFF/DISP/NOR/ARM maps) and overall progress to the DOM.
- `src/downloader/index.html`, `downloader.scss` — Standalone window UI (not part of the main editor shell).
- `electron-main.cjs` — `openDownloaderWindow()` opens it as a non-modal Electron window. Auto-launched on first run if textures aren't installed.
- `tools/download-textures.js` — CLI alternative for dev mode. Both paths share the server-side handler at `/api/textures/download`.

**Focus:** Multiple downloader windows can observe the same in-flight download via SSE broadcast — closing a window does NOT cancel the download. Server-side download regenerates `manifest.json` + `bundle.json` on completion so newly-downloaded textures appear in the editor on next reload.

---

## Core Data Shapes

### Cell

Cells are polygon-segment containers. The cardinal edges (`north`/`south`/`east`/`west`) and corner-blend overlays live on the cell; everything else (per-region texture, voided sub-areas, weather, interior walls / arcs / diagonals) lives on `segments[]` and `interiorEdges[]`. When `segments` is absent, code reads it as a single implicit "full" segment via `getSegments(cell)` in `util/cell-segments.ts`.

```typescript
interface Cell {
  // Cardinal cell-to-cell edges. Diagonals (`nw-se` / `ne-sw`) and curved
  // arcs are NOT here — they live on `interiorEdges` between segments.
  north?, south?, east?, west?: EdgeValue;  // "w"|"d"|"s"|"iw"|"id"|"win"|null

  // Whole-cell properties
  fill?: FillType;       // "pit"|"water"|"lava"
  fillDepth?: number;    // 1-3 for water/lava
  hazard?: boolean;      // difficult terrain overlay
  waterDepth?: number;
  lavaDepth?: number;

  // Corner-blend texture overlays (per-corner, render-time)
  textureNE?, textureSW?, textureNW?, textureSE?: string;
  textureNEOpacity?, textureSWOpacity?, textureNWOpacity?, textureSEOpacity?: number;

  // Content
  center?: { label?, dmLabel?, 'stair-id'? };
  prop?: { type: string, span: [number, number], facing: number, flipped?: boolean };

  // Polygon-segment model
  segments?: Segment[];          // see below; absent ⇒ implicit full segment
  interiorEdges?: InteriorEdge[]; // intra-cell walls/arcs between segments
}

// Segment carries per-region state — texture, voided sub-areas, weather.
// See src/types.ts for the full shape.
interface Segment {
  polygon: number[][];           // CCW vertices in cell-local [0,1] coords
  texture?: string;              // e.g. "polyhaven/cobblestone_floor_03"
  textureOpacity?: number;
  voided?: boolean;              // segment renders as void (used for trims)
  weatherGroupId?: string;       // weather membership (segment-level)
}
```

**Migration note.** Legacy maps (top-level `texture`, `trimWall`, `trimRound`, `nw-se`, etc.) are upgraded to the segment model on load by `util/migrate-segments.ts`. New code must NOT read the legacy fields directly — only that one migration file references them.

### Edge value taxonomy

| Value | Name | BFS | Casts shadow | Player sees |
|-------|------|-----|--------------|-------------|
| `"w"` | Wall | Blocks always | Yes | Wall |
| `"d"` | Door | Blocks (passable with `traverseDoors`) | Yes | Door |
| `"s"` | Secret door | Blocks (passable with `traverseDoors`) | Yes | Wall until opened |
| `"win"` | Window | Blocks always | Yes (floor) + projects gobo from above | Wall with sunpool/pattern on far side |
| `"iw"` | Invisible wall | Blocks always | **No** | Nothing |
| `"id"` | Invisible door | Blocks (passable with `traverseDoors`) | **No** | Nothing (DM can open) |

Invisible types are stripped from player cells in `player/fog.ts` and excluded from shadow geometry in `render/lighting.ts` (`extractWallSegments`). The export pipeline (`compile.ts`) calls the same `renderLightmap` as the editor preview, so invisible-type exclusions apply uniformly.

### Metadata
```typescript
interface Metadata {
  dungeonName: string;
  dungeonLetter?: string;
  gridSize: number;
  resolution: number;
  theme: string | Theme;
  labelStyle: LabelStyle;        // "circled"|"plain"|"bold"
  features: {
    showGrid: boolean;
    compassRose: boolean;
    scale: boolean;
    border: boolean;
  };
  levels: Array<{ name: string; startRow: number; numRows: number }>;

  // Lighting
  lightingEnabled: boolean;
  ambientLight: number;          // 0.0-1.0
  ambientColor?: string;
  ambientAnimation?: LightAnimationConfig | null; // e.g. lightning storm flashes
  lights: Light[];               // see types.ts — incl. animation, group, cookie, darkness, softShadowRadius
  nextLightId: number;
  disabledLightGroups?: string[]; // groups whose lights are culled at render time
  bloomIntensity?: number;       // 0..1, screen-blended Gaussian bloom on top of lightmap

  // Stairs
  stairs: Array<{ id, points: [[r,c],[r,c],[r,c]], link?: string }>;
  nextStairId: number;

  // Bridges
  bridges: Array<{ id, type, points: [[r,c],[r,c],[r,c]] }>;
  nextBridgeId: number;

  // Windows (canonicalized to north/west — south/east are stored on the neighbor)
  windows?: Array<{ row, col, direction: 'north'|'west', goboId, tintColor?, floorHeight?, ceilingHeight? }>;

  // Weather groups (cells reference by `segment.weatherGroupId`)
  weatherGroups?: Array<{ id, name, type, intensity, wind, lightning, hazeDensity, particleColor?, colorIndex }>;

  // Overlay props (placed on metadata, not cells — e.g. multi-cell decorations)
  props?: Array<{ id, type, row, col, facing, flipped? }>;
  nextPropId?: number;

  // Appearance
  backgroundImage?: { src, opacity, x, y, width, height };
  savedThemeData?: { name?: string; theme: Record<string, unknown> };
  themeOverrides?: Record<string, unknown> | null;
  pixelsPerCell?: number;
  titleFontSize?: number;
  texturesVersion?: number;

  // Audio
  backgroundMusic?: string;

  [key: string]: unknown;        // extensible for future fields
}
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
- [ ] **Renderer** (`src/render/render-phases.ts`, `floors.ts`, `borders.ts`, `features.ts`, `decorations.ts`) — Add visual rendering. Determine which render pass the feature belongs in (floor fill, border, feature overlay, decoration).
- [ ] **Themes** (`src/render/themes.ts`) — If the feature introduces new colors, add properties to the theme object and update all existing theme presets.
- [ ] **Constants** (`src/render/constants.ts`) — If new magic numbers are needed, add them to the constants file.
- [ ] **Validation** — Add error messages for invalid configurations.

#### 2. Editor: Can users control this feature visually?

- [ ] **State** (`src/editor/js/state.ts`) — If the feature needs UI state, add it to the state object with a sensible default.
- [ ] **Tool** (`src/editor/js/tools/`) — If the feature is a new interactive tool or a sub-mode of an existing tool, create or update the tool class. Follow the `Tool` base class pattern.
- [ ] **Tool sub-options** — If the feature adds modes to an existing tool, add the button group to `index.html` and wire show/hide + active state in `toolbar.ts`.
- [ ] **Toolbar** (`src/editor/js/panels/toolbar.ts`) — Wire new buttons, mode selectors, or export actions.
- [ ] **Properties panel** (`src/editor/js/panels/properties.ts`) — If the feature is a cell-level property, add it to the properties inspector.
- [ ] **Metadata panel** (`src/editor/js/panels/metadata.ts`) — If the feature is a map-level setting, add a control to the metadata panel.
- [ ] **Canvas rendering** (`src/editor/js/canvas-view.ts`) — If the feature affects rendering, pass new parameters through to `renderDungeonToCanvas()`.
- [ ] **HTML** (`src/editor/index.html`) / **SCSS** (`src/editor/style.scss`) — Add and style new UI elements.
- [ ] **Keyboard shortcuts** — If the feature warrants a shortcut, add it to the key handler in `main.ts`.

#### 3. API: Can Claude control this feature programmatically?

- [ ] **Editor API** (`src/editor/js/api/`) — Add methods to the appropriate module (e.g. `cells.ts`, `props.ts`, `lighting.ts`). Pattern: validate inputs → `mutate()` or `pushUndo()` → modify state → `markDirty()` → `notify()` → return `{ success: true }`. Re-export from `editor-api.ts`. Register the method in `api/discovery.ts` (with category + 1-line intent) so `apiSearch` / `apiDetails` can surface it.
- [ ] **Puppeteer bridge** (`tools/puppeteer-bridge.js`) — Generic dispatcher; new API methods work automatically. Verify end-to-end.
- [ ] **API documentation** — Only update [src/editor/CLAUDE.md](src/editor/CLAUDE.md) if the new method belongs in the high-traffic surface (it appears in nearly every map workflow). Otherwise the discovery registry is the doc.
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
| Cell property | **Fills** (difficult-terrain, pit) | `render/features.ts` → `api/fills.ts:setFill` |
| Metadata setting | **Label style** (circled, plain, bold) | `render/decorations.ts` → `api/map-management.ts:setLabelStyle` |
| Interactive tool | **Door tool** | `editor/js/tools/tool-door.ts` → `api/walls-doors.ts:setDoor` |
| Decoration toggle | **Compass rose** | `render/decorations.ts:drawCompassRose()` → `api/map-management.ts:setFeature` |
| Asset catalog | **Props** | `src/props/*.prop` → `prop-catalog.ts` → `tool-prop.ts` → `render/props.ts` |
| Bulk rect operation | **Fill rect** | `api/fills.ts:setFillRect` pattern |

---

