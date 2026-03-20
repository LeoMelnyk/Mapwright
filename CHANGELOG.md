# Changelog

## v0.7.0

### Onboarding

- Welcome modal on first launch with three options: interactive tutorial, example map gallery, or start fresh
- 5-step interactive tutorial with spotlight overlays that auto-advance as the user completes each action (create room → place door → add fill → place prop → add light)
- Example map gallery populated from `examples/` directory — thumbnail previews with click-to-load
- Contextual first-use tool hints — each of the 13 tools shows a dismissible tip toast the first time it's activated (persisted in localStorage)
- "Welcome Screen" option in the Help menu to re-open the onboarding modal at any time
- Tooltip hover delay reduced from 0.9s to 0.4s

### Keybindings Helper

- Floating contextual keybindings panel shows shortcuts for the currently active tool
- Updates instantly on tool switch and sub-mode changes (e.g. fill depth keys only shown in water/lava mode)
- Draggable — click and drag the header to reposition; position resets to default on close
- Toggle via View menu → Keybindings Helper checkbox; visibility persists across sessions via localStorage
- Shown by default on first launch

### Minimap

- Draggable — hover to reveal header, click and drag to reposition anywhere on the canvas

### Keyboard Shortcuts

- `/` now opens the keyboard shortcuts modal (in addition to existing `?`)

### File Format

- Example maps migrated from `.json` to `.mapwright` format
- Server `/api/examples` endpoint serves example map listing with PNG thumbnails

### Prop System — Free-Form Overlay

Props have been completely migrated from cell-locked grid storage (`cell.prop`) to a free-form overlay layer (`metadata.props[]`). Props are now "stickers" that can be placed at arbitrary positions, rotated to any angle, scaled, overlapped with z-ordering, and nudged with pixel precision.

#### Architecture

- **Overlay data model**: Props stored in `metadata.props[]` as `{ id, type, x, y, rotation, scale, zIndex, flipped }` — world-feet positioned with explicit z-ordering
- **Format version 2**: `.mapwright` files automatically migrated from v1 → v2 on load; `cell.prop` entries extracted into the overlay array and deleted
- **`cell.prop` fully removed**: The overlay is the sole source of truth — no dual-write, no cell-level prop storage. All API methods, rendering, lighting, and spatial queries read from `metadata.props[]`
- **App version stamped**: `.mapwright` files now include `metadata.createdWith` with the Mapwright version that last saved them

#### Free-Form Placement

- **Arbitrary rotation**: Props can be rotated to any angle (0–359°), not just 90° increments
- **Scaling**: Props can be scaled from 25% to 400% (`0.25x` to `4.0x`)
- **Freeform placement**: `Ctrl+Click` places props at exact cursor position (sub-cell precision); `Ctrl+Drag` moves props with sub-cell precision
- **Arrow key nudge**: `↑↓←→` nudges selected props by 1 foot; `Shift+↑↓←→` nudges by 1 full cell
- **Prop stacking**: Overlapping props are allowed — z-order determines visual layering

#### Z-Order Controls

- `]` key brings selected prop forward, `[` sends backward
- Z-order presets: `"floor"` (0), `"furniture"` (10), `"tall"` (20), `"hanging"` (30)
- API: `setPropZIndex(propId, zOrPreset)`, `bringForward(propId)`, `sendBackward(propId)`

#### Scroll-Wheel Controls

- `Alt+Scroll`: Fine rotation in 15° increments
- `Alt+Shift+Scroll`: Scale up/down in 0.1x increments
- Undo history debounced at 500ms — one undo reverses the entire scroll gesture
- Multi-prop: scroll-wheel rotation orbits props around the group's center pivot; scaling maintains relative prop distances

#### Multi-Prop Group Transforms

- **Group rotation** (R key or Alt+Scroll): props orbit around the group center while each prop also rotates individually
- **Group scaling** (Alt+Shift+Scroll): props scale individually while positions adjust to maintain relative distances from group center
- **Box-select**: drag from empty space selects all props whose visual bounds overlap the rectangle
- **Multi-drag**: click and drag any prop in a multi-selection to move the entire group, preserving relative positions and freeform offsets

#### Pixel-Perfect Hit Testing

- Hover and click detection uses geometric shape testing against prop draw commands (circles, rects, polygons) — not bounding boxes
- Shadows are excluded from hit testing — only actual prop art is clickable
- When props overlap, the smallest prop at the cursor position is preferred (most specific target)

#### API Enhancements

- `placeProp(row, col, type, facing, options)` now accepts `{ scale, zIndex, allowOverlap, x, y }` options
- `rotateProp(row, col, degrees)` accepts arbitrary degree values (default 90)
- `suggestPropPosition(roomLabel, propType)` — smart placement helper using prop `placement` metadata

#### Rendering

- Overlay renderer sorts by z-index before drawing
- Grid-aligned props at scale 1.0 reuse the tile cache for performance
- Arbitrary rotation and scale use canvas transforms (`save/translate/rotate/scale/restore`)
- Light-blocking segments computed from overlay props with full rotation and scale support

### Prop Library Audit & Expansion (164 → 196 props)

Holistic quality pass across the entire prop library — visual audit via Puppeteer screenshots, consistency fixes, and 32 new props.

#### Light Associations

Props that visually emit light now automatically place a light when used: floor-candelabra (candle), signal-fire (bonfire), lava-pool (lava-glow), lighthouse-lens (bright), necrotic-altar (necrotic), magic-circle (eldritch-glow), ritual-circle (infernal-flame), oven (fireplace).

#### Metadata & Drawing Fixes

- **statue**: now blocks light (tall solid object)
- **brazier**: swapped `rusty_metal` → `metal_plate` (no longer looks woody at small scale)
- **fountain**: recategorized Misc → Features
- **fireplace**: recategorized Kitchen → Furniture
- **altar**: fixed bare `fill 0.5` → explicit bone-white color
- **chair**: added shadow + leg shadow dots
- **bookshelf**: added colored book-spine rectangles across 3 shelves
- **lamp-post**: redrawn as ornate city lamp with octagonal pedestal (now distinct from lantern-post)

#### New Props — General (16)

bar-counter, keg, hay-bale, stable-partition, ladder, trapdoor, vanity-table, nightstand, wash-basin, cooking-spit, planter-box, organ, cage-large, well-windlass, dartboard, long-table

#### New Props — Trees & Nature (16)

Reworked the tree prop from a flat opaque disc to overlapping semi-transparent canopy lobes — floor shows through gaps. Added 4 tree variants and 12 nature/forest props.

- **Trees**: pine-tree, willow-tree, palm-tree, tree-small
- **Nature**: flowers, flower-patch, tall-grass, bush, fern, pond, lily-pads, reed-bed, bramble, moss-patch, log-pile, roots

### Clipboard Enhancements

- **Cut (Ctrl+X)** for cells (Select tool) and props (Prop tool) — copies to clipboard and deletes originals in one action
- **Light copy/cut/paste** — Ctrl+C copies the selected light, Ctrl+X cuts it, Ctrl+V enters paste mode with a radius/cone preview following the cursor; click to place, Shift+click to snap to grid

### Bug Fixes

- Loading a new map now fully invalidates all render caches (geometry, fluid, blend, floor, cell-edges, prop spatial hash) — fixes stale rendering artifacts when switching between maps
- Prop placement, movement, and deletion now always invalidate the lighting cache — fixes stale shadows from `blocksLight` props
- Right-click during drag or paste mode cancels the action instead of deleting props
- Fixed rotation direction mismatch between tile cache path and canvas transform path for non-grid-aligned angles

---

## v0.6.1

### Architecture Refactor

- Split `editor-api.js` (3083 lines) into 18 focused modules under `src/editor/js/api/` — each API category (cells, walls, props, spatial queries, lighting, etc.) is now its own file
- Standardized all API return values to `{ success: true, ...data }` / `{ success: false, error }` for consistent error handling
- Split `metadata.js` panel (1019 lines) into core settings (385 lines) + extracted theme editor (644 lines)
- Extracted `traceArcWedge()` helper in render.js to deduplicate arc void clip geometry
- Named all hardcoded rendering constants (rough wall spacing, buffer shading depth, compass rose size, etc.) across 5 render files

### Performance

- Added viewport culling to the editor canvas — walls, borders, and props outside the visible area are skipped during rendering, improving performance on large maps when zoomed in
- Replaced O(n²) prop collision detection with a spatial hash map — prop placement, hover, and bulk operations now use O(1) lookups instead of scanning a 4-cell search radius per footprint cell
- Added spatial grid acceleration to lighting raycasting — `computeVisibility()` now uses DDA grid traversal to test only wall segments along each ray path instead of scanning all segments linearly

### Error Reporting

- Added render warnings system (`src/render/warnings.js`) — collects deduplicated warnings during rendering and surfaces them as toast notifications in the editor
- Prop catalog and texture catalog load failures now show toast notifications instead of silently returning empty catalogs
- Unknown prop types and malformed prop light JSON now produce visible warnings instead of being silently skipped
- Bridge render errors now include bridge ID in the warning message

### Save Format

- Added `.mapwright` format versioning — save files now include a `formatVersion` field with migration support for future format changes
- Existing files without a version are treated as v0 and automatically migrated

### Testing

- Added Vitest test suite: 611 tests across 19 files covering API methods, spatial queries, utilities, and migrations
- Added visual snapshot tests — renders example maps via `@napi-rs/canvas` and compares against golden PNGs with `pixelmatch` (catches rendering regressions without a browser)
- Added E2E tests — full pipeline tests (create → save → load → modify → export) and room template validation via Puppeteer bridge
- Expanded GitHub Actions CI to run unit, snapshot, and E2E tests in parallel
- Added `npm run test:render` and `npm run test:e2e` scripts with separate Vitest configs

### Removed

- Removed the `.map` ASCII text format entirely — the editor API with `planBrief` fully supersedes it
- Removed `src/compile/` pipeline (parser, compiler, grid, trims, features, constants)
- Removed `tools/build_map.js`, `tools/compile_map.js` CLI tools
- Removed `importMapText`, `exportToMapFormat` API methods
- Removed `.map` export button from the editor UI
- Removed `build_map` MCP tool and `mapwright://map-format` resource

---

## v0.6.0

### `.mapwright` File Format

- Dungeon maps now save as `.mapwright` instead of `.json` — a custom file extension tied to the application
- Map data is minified (no whitespace) for smaller file sizes
- All tools accept both `.mapwright` and `.json` for backwards compatibility

### Windows Installer with File Association

- New NSIS installer build alongside the existing portable exe
- Installing via the installer registers `.mapwright` files with Windows — double-click to open directly in Mapwright
- Single-instance lock: opening a second `.mapwright` file loads it in the existing window
- macOS: `open-file` event support for Finder integration

### Auto-Update (Installer Only)

- NSIS installs check for updates on launch via `electron-updater`
- Native dialog prompts to download and restart when a new version is available
- Portable builds retain the existing toolbar link to the GitHub release page

### Editor Improvements

- Taskbar and title bar now show the Mapwright icon instead of the default Electron icon
- `Ctrl+Shift+S` keyboard shortcut for Save As

---

## v0.5.0

### Bulk Prop Placement API

Four new methods for placing props at scale without manual coordinate loops:

- `fillWallWithProps` — line a wall with repeated props (bookshelves, torch-sconces); auto-computes facing per wall
- `lineProps` — place props in a straight line (pillar colonnades, pew rows)
- `scatterProps` — randomly scatter props across a room (rubble, mushrooms, bone piles)
- `clusterProps` — place a furniture grouping at relative offsets from an anchor (desk + chair + book-pile)

### Prop Placement Metadata

All 171 props now carry placement metadata in their `.prop` headers:

| Field | Purpose |
|-------|---------|
| `placement` | Where the prop goes: `wall`, `corner`, `center`, `floor`, `any` |
| `room_types` | Which room types it belongs in (e.g. `library, study, wizard-sanctum`) |
| `typical_count` | How many per room: `single`, `few`, `many` |
| `clusters_with` | Props it commonly groups with |
| `notes` | Free-text placement guidance |

New query methods:
- `getPropsForRoomType(roomType)` — find all props tagged for a room type
- `listProps()` now includes all metadata fields

### New Editor API Methods

- `getFullMapInfo` — comprehensive map snapshot (rooms with bounds, all props, doors, lights, stairs, bridges)
- `defineLevels` — set level boundaries on existing rows without adding new ones
- `partitionRoom` — add internal wall partitions across a room with optional door
- `validateDoorClearance` — check for props blocking door cells or approach cells
- `validateConnectivity` — BFS reachability check from entrance to all rooms

### Room Design Guide (`DESIGN.md`)

New design reference covering room semantic library (20+ room types with prop/fill/lighting specs), universal spatial rules, prop density guide, lighting design, multi-agent pipeline, and anti-patterns.

### Room Templates

Seven ready-to-run JSON templates in `room-templates/`: throne room, alchemist's lab, forge, crypt, temple, wizard's sanctum, prison block.

---

## v0.4.1

### New: MCP Server (`mcp/`)

Added a Model Context Protocol server that exposes the full Mapwright editor API to Claude Code and other MCP clients.

**Install:**
```bash
cd mcp && node install.js
```

**Tools:**

| Tool | Requires server? | Description |
|---|---|---|
| `execute_commands` | Yes | Run any editor API command via the Puppeteer bridge |
| `build_map` | No | Compile a `.map` text file to PNG |
| `render_json` | No | Render a dungeon `.json` to PNG |
| `check_server` | No | Health-check the editor server |

**Resources (auto-loaded into AI context):**

| Resource | Contents |
|---|---|
| `mapwright://editor-api` | Full ~70-method API reference |
| `mapwright://map-format` | `.map` text format syntax reference |
| `mapwright://workflow` | 3-step AI generation workflow |
| `mapwright://domain-routing` | Codebase architecture guide |

### Bug Fix

**Light options sub-bar visible in wrong state** — The light tool options strip was not being hidden when switching to session tools or changing away from the light tool. Fixed in `toolbar.js`.

---

## v0.4.0

### Background Image Overlay

- New side panel: upload/replace/clear a background image, set scale (px/cell), X/Y offset, opacity, and resize the dungeon to match
- Drag-to-measure tool lets you drag across grid squares on the uploaded image to auto-calculate px/cell scale
- Grid calculator: enter rows × cols to compute canvas size from the detected scale
- Center button + auto-fill floor cells under the image on upload, measure, and calc
- Background image visible in player view and PNG export
- Auto-detect grid scale and phase on upload: gradient autocorrelation detects pixels-per-cell and aligns the editor grid to image grid lines

### DM Session

- New fog reveal drag tool (key `3`): DM can click-and-drag a rectangle to reveal cells to connected players; fog overlay is forced on while active; revealed cells fade in over 500ms

---

## v0.3.1

### Lava Lighting Improvements

- Lava pools now auto-generate lights using a flood-fill algorithm that detects connected lava regions and places lights on an adaptive grid (spacing scales with pool area) — prevents brightness explosions on large pools
- Lava glow uses `radius:0 / dimRadius:4` for a pure ambient halo with no visible hotspot circle
- Added Light Color and Light Strength controls to the custom theme editor's Lava section
- Fixed divide-by-zero NaN in `falloffMultiplier` when `radius <= 0`

### Prop Fixes

- Audited `blocks_light` flags across all props: removed from 18 props that aren't floor-to-ceiling (altars, boulders, statues, etc.), kept on tall/structural props only
- Redesigned vault door from a 2×2 ground-hatch to a 1×2 top-down door with flanking pillar lock columns, locking bolts, and a center valve wheel

### Bug Fix

- **Right-click always triggering delete** — `rightDragged` was reset before the guard check, so delete fired even after a pan-drag. Fixed by capturing the flag before resetting.

---

## v0.3.0

### Ollama AI Integration

- Replaced Anthropic Claude API with local [Ollama](https://ollama.com) (Qwen3.5:9b) — no API key required
- AI now writes a plan before executing (plan mode), with an Execute Plan button to confirm
- Streaming text bubble UI with live cursor animation
- Strips Qwen3 `<think>` reasoning blocks from responses

### `.map` Workflow for AI

- `loadMapText` / `exportMapText` as the primary AI dungeon workflow — build or replace full dungeons from `.map` text in a single call
- New `/api/compile-map` server endpoint for AI-generated `.map` compilation

### Expanded AI Tool Surface

15+ new tools added including:
- Prop/stair removal
- Lighting controls: `getLights`, `removeLight`, `setAmbientLight`, `setLightingEnabled`, `listLightPresets`
- Level management: `getLevels`, `addLevel`, `renameLevel`, `resizeLevel`
- Spatial utilities: `findCellByLabel`, `shiftCells`, `listRooms`, `placeLightInRoom`
- `listThemes`, `setLabelStyle`

---

## v0.2.1

### Claude AI Dungeon Assistant

- Embedded Claude AI chat panel: describe a dungeon in natural language and have Claude build or modify it directly via tool calls against the Editor API
- Full read/write access: create rooms, corridors, set properties, change themes, inspect state
- Server-side Anthropic proxy endpoint keeps the API key off the client
- Streaming-style message UI with tool-call status display and stop/retry controls
- Warning modal shown when enabling the AI agent

---

## v0.2.0

### Editor UX

- Props, bridges, labels, and lights support hover-to-highlight and drag-to-move without switching modes; removed legacy place/select mode toggles
- Box-select on empty drag selects multiple props; all selected props move together
- All tools show contextual status bar instructions
- Toolbar update notification badge when a newer GitHub release is available

### DM Session

- Fog overlay toggle visualizes which cells are unrevealed to players
- Invisible walls (`iw` type): block movement but hidden from the player view

### Infrastructure

- ESLint flat config
- GitHub Actions CI workflow (blocks PRs on lint failure)
- Azure Trusted Signing for Windows builds
- Electron desktop app with bundled texture downloader
- Auto-install Node.js if missing
- Release build workflow: auto-build and attach portable `.exe` on publish
- Universal Mac DMG (arm64 + x64) for Intel and Apple Silicon

### Lighting System

- Animated lights: flicker, pulse, strobe
- D&D 5e bright/dim light radii with unified gradient
- Inverse-square falloff option
- Colored ambient light
- Prop-bundled lights: placing a torch/candle/etc. auto-creates a linked light; erasing the prop removes the light
- Light names/labels in the lighting panel
- Shift+click snap-to-grid placement
- Dim radius overlay circle in editor

### Map Format

- Bridge support in `.map` format (`wood`, `stone`, `rope`, `dock` types)
- Invisible walls and doors for fog-of-war segmentation
- `mapwright/CLAUDE.md` — domain routing table and full dev guide
- `src/editor/CLAUDE.md` — Puppeteer automation API reference

---

## v0.1.0 — Initial Release

- Dungeon map editor with room, wall, door, stairs, trim, fill, prop, label, and light tools
- 16 themes
- `.map` ASCII text format with compile pipeline (`.map` → JSON → PNG)
- Puppeteer automation bridge for programmatic map generation
- Player session view with WebSocket fog-of-war reveal
- Polyhaven texture support with download tooling
- Prop catalog with 100+ props across 15 categories
