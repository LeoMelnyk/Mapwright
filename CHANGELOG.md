# Changelog

## v0.9.0

### Round Trim System Overhaul

The round trim (arc wall) system has been completely rewritten. Each arc boundary cell now stores its own geometry data instead of referencing a shared arc center, eliminating an entire class of rendering, BFS, and texture bugs.

**New cell data model:**
- `trimClip` — floor polygon in cell-local coordinates (defines room vs void boundary)
- `trimWall` — arc polyline for wall rendering
- `trimCrossing` — 3x3 sub-grid crossing matrix for precise BFS traversal
- `trimCorner` — corner orientation (nw/ne/sw/se)

**What changed:**
- **Rendering**: Per-cell arc clipping replaces the old global canvas clip path. Each cell renders its own arc wall segment and floor polygon. Textures split precisely at the arc boundary (primary on room side, secondary on void side)
- **BFS / Flood Fill**: Arc walls use a per-cell crossing matrix instead of the old 200-line arc post-pass. The crossing matrix determines which exits are reachable from each entry direction, preventing leaking through the arc boundary
- **Texture flood fill**: Arc boundary cells correctly receive primary or secondary texture based on which side the fill originated from. Works consistently regardless of fill start position, handles multiple adjacent circles, and supports both inside and outside fills
- **Open trims**: Decorative arcs that don't void cells. The arc wall blocks texture flood fill but not structural BFS (fog reveal, room detection). Floor renders fully on both sides
- **Inverted trims**: Concave arcs that curve into the room. Void region extends beyond the original triangle into the room interior
- **Cell inspector**: Updated to show trim type, corner, wall points, clip points, and texture state. Raw JSON collapsed by default

**Removed:**
- `trimRound`, `trimArcCenterRow/Col`, `trimArcRadius`, `trimArcInverted`, `trimInsideArc`, `fogBoundary` cell properties
- `collectRoundedCorners()`, `buildArcVoidClip()`, `withArcClip()` render functions
- ~200 lines of arc geometry helpers and post-pass BFS in `grid.js`
- Arc bleed fix in player fog overlay

**Migration**: Old maps are automatically converted on load. The v3-to-v4 migration computes per-cell geometry from the old arc center/radius metadata.

### Player View Fog-of-War Overhaul

The player view rendering pipeline has been rebuilt with a layered compositing architecture. Fog, shading, hatching, and walls are now independent cached layers instead of being baked into a single map image.

**New layer stack (bottom to top):**
1. Full map cache (floors, props, lighting — no shading or hatching)
2. Fog overlay (theme-coloured, not black)
3. Outer shading composite (fog-edge masked)
4. Hatching composite (fog-edge masked)
5. Walls + doors overlay (revealed cells only)

**Fog-edge mask**: Shading and hatching appear in a band around revealed cells, using a Minkowski-sum (rolling ball) approach that produces naturally rounded outer edges instead of blocky cell-aligned rectangles. The mask rebuilds when fog changes; the shading and hatching canvases themselves are cached once per session and never recalculated.

**Theme-coloured fog**: The fog overlay and canvas background now use the theme's background colour instead of black, so the void around the dungeon matches the theme aesthetic.

**Walls overlay**: Walls and doors render above the fog and hatching layers so boundary walls are always visible. Uses a filtered cells grid containing only revealed cells — walls from unrevealed cells never render. Updated incrementally on reveal (dirty-region render); full rebuild on conceal.

**Performance**: Hatching and shading layers build once and are keyed by a theme-property signature — only a mid-session theme change triggers a rebuild. The fog-edge mask (shared by both composites) is the only work done per reveal. The walls overlay uses incremental dirty-region rendering. Fog reset and starting room selection no longer trigger a full map cache rebuild on the player — fog reset sends a lightweight `fog:reset` message that clears only the fog-related layers, and starting room reveal sends an incremental `fog:reveal` instead of a full `session:init`.

### Improvements

- **Fog Reveal Tool: right-click to re-fog**: Right-clicking a cell with the Fog Reveal tool (F) now re-applies fog of war to that cell, hiding it from players again. Left-click drag to reveal remains unchanged.

### Bug Fixes

- **Fixed double door buttons in DM session**: Adjacent doors that visually merge into a single double door now show one "open door" button instead of two separate buttons. Clicking the merged button opens all doors in the group at once.
- **Fixed blank right-sidebar panels**: Panels with render caching (Background Image, Lighting, Session, History) appeared completely empty when switching tabs, because the cache skipped DOM rebuilds even when the container had been cleared. Panels now detect an empty container and force a rebuild regardless of cached state.

## v0.8.0

### User-Saved Themes

Custom themes can now be saved, reused across maps, and shared between machines:

- **Save as Theme**: After customizing colors in the theme editor, click "Save as Theme" to persist the theme to disk with a name. Saved themes appear in the theme picker alongside built-in presets
- **Live editing**: Edits to a saved theme update the file on disk automatically — no need to re-save
- **Rename and delete**: Hover over a saved theme thumbnail to reveal rename (pencil) and delete (×) buttons
- **Cross-machine portability**: Maps embed the full theme data when a saved theme is active. Opening a map on a machine without the theme auto-installs it from the embedded data
- **Storage**: Saved themes live in `{userData}/themes/` (Electron) or `user-themes/` (dev mode), using the same `.theme` JSON format as built-in themes

### Label System Overhaul

Room labels are now freely positionable and visually prominent:

- **Free placement**: Labels can be placed at any position on the map, no longer snapped to cell centers. Click anywhere to place; drag to reposition freely
- **Doubled size**: Label circles, text, and backgrounds are all 2× larger for better readability at any zoom level (circled radius 15→30, font 14→28px)
- **Theme-controlled colors**: Labels now read `borderColor`, `fontColor`, and `backgroundColor` from a new `labels` block in each theme file. Default across all themes: black border, black font, white background
- **Proximity-based interaction**: Hover and selection highlights are now circles centered on the label's actual position instead of full-cell rectangles

### Z-Height Shadow Projection

Lights and props now have a vertical height dimension (`z` in feet above floor), enabling physically-based shadow projection:

- **Height-proportional shadows**: A 7ft torch casts short shadows from a 2ft chest, medium from a 3ft barrel, and long from a 6ft bookshelf. Shadow length = `zTop / |lightZ - zTop|`, capped at 20×
- **Three shadow cases**: Light above prop → short finite shadow with penumbra from the far face. Light within prop height range → long shadow from the far face, front of prop is lit. Light below prop bottom → no shadow (light passes underneath)
- **Multi-zone hitboxes**: Props can define multiple height zones with `hitbox rect x,y w,h z bottom-top` syntax. The statue demonstrates this with a wide pedestal (0–3ft) and narrower figure (3–6ft), each casting independently shaped shadows
- **All props assigned heights**: 206 light-blocking props have height values (0.5ft books to 15ft trees). 30 flat-on-floor props (carpets, magic circles, traps) remain non-blocking
- **All light presets have z values**: 30 presets with appropriate heights (1ft ground fires, 3ft braziers, 7ft torches, 20ft overhead/celestial lights)
- **Height slider in lighting panel**: New "Height (ft)" control for adjusting light z interactively
- **Prop scale affects height**: A 2× scaled pillar casts shadows as a 20ft prop instead of 10ft
- **Radius culling**: Props outside a light's effective radius are skipped during shadow computation
- **Light drag performance**: Light-only changes skip expensive wall segment and prop shadow zone recomputation; composite cache rebuilds are skipped when animated lights handle the overlay. Deferred undo snapshot — clicking a light to select it no longer triggers a cache rebuild
- **Cancellable light drag**: Escape or right-click during a light drag restores the original position with no undo entry

### Prop Art Overhaul

Comprehensive visual overhaul of the entire prop library — every prop reviewed, with ~100 props remade or significantly improved:

- **Perspective fixes**: Dozens of props corrected from front-facing to proper top-down perspective (notice board, scroll rack, shield rack, pot rack, portcullis, vault door, wine rack, trophy mount, etc.)
- **Visual quality improvements**: Props redesigned with richer detail, better textures, and consistent art style (treasure pile, skeleton, sarcophagus, throne, organ, magic circle, ritual circle, well, workbench, wardrobe, etc.)
- **New props**: Lumber Stack, Standing Mirror, Sarcophagus (Skull), Treasure Pile (Small/Large/Massive)
- **Removed redundant props**: Stable Partition, Summoning Cage, Zombie Pit, Well Windlass, Tapestry, Wood Pile
- **Resized props**: Obelisk (1x1→2x2), Training Dummy (1x1→2x2), Organ (3x3→4x3), Reliquary (1x1→2x3), Throne Dais (3x4→6x6), Wardrobe (2x2→3x2), Workbench (2x2→2x3), Ship Wheel (2x2→1x1)
- **Renamed**: Oil Cauldron → Cauldron (Oil), Stone Column → Column (Stone)

### Prop DSL Enhancements

New drawing primitives for richer prop artwork:

- **Gradient fills**: `gradient-radial` and `gradient-linear` styles on any shape, with configurable start/end colors, opacity, and angle
- **Bezier curves**: `bezier` (cubic, 2 control points) and `qbezier` (quadratic, 1 control point) for organic shapes and scrollwork
- **Elliptical ring**: `ering` command for non-circular donut/annulus shapes
- **Clipping masks**: `clip-begin`/`clip-end` blocks to restrict rendering to a shaped region
- All new primitives support rotation, flipping, fill/stroke/texfill styles, and the `width` modifier
- **Hitbox commands**: `hitbox rect/circle/poly` defines custom lighting occlusion shapes; `selection rect/circle/poly` defines custom click-detection shapes. Both are optional — auto-generated convex hulls are used as defaults

### Prop Tooling

- **Prop footprint validator** (`tools/validate-props.js`): CLI tool that scans all `.prop` files and reports coordinates exceeding declared footprint bounds. Catches clipping issues before they reach the renderer
- **Prop preview API** (`renderPropPreview`): Editor API method that renders a single prop to a data URL image — enables agents to visually self-correct prop designs. Accepts catalog names or raw `.prop` text. Callable via puppeteer bridge

### Half-Cell Resolution

The grid system now supports half-cell precision. Internally, each display cell (5ft) is divided into 4 sub-cells (2.5ft each), allowing walls, doors, rooms, and features to be placed at half-cell boundaries. This gives map authors the same kind of freedom found in other map editors that divide cells into quarters.

- **Coordinate system**: The API uses half-step coordinates (0, 0.5, 1, 1.5, ...) — existing integer coordinates remain fully compatible
- **Internal storage**: Grid dimensions are doubled internally (`metadata.resolution = 2`, `gridSize` halved to 2.5ft) while the display grid stays at 5ft
- **Auto-migration**: Existing `.mapwright` files seamlessly upgrade from format v2 to v3 on load — each cell splits into 4 sub-cells with walls, fills, textures, trims, stairs, and bridges correctly replicated
- **Grid lines**: Primary grid drawn at 5ft display-cell boundaries
- **Scale indicator**: Correctly shows "1 square = 5 feet" (display grid size)

### Rendering Performance

- **HiDPI / devicePixelRatio support**: The editor canvas now renders at native physical resolution on high-DPI displays (e.g. 125%, 150%, 200% Windows scaling). Canvas backing store is sized to physical pixels with a DPR transform applied to all drawing operations. Automatically re-renders when moving between monitors with different scaling
- **Configurable render quality**: New "Render Quality" dropdown in the View menu controls the offscreen cache resolution (Low 10 / Medium 15 / High 20 / Ultra 30 px/ft). Default is High. Setting persists across maps via localStorage. Higher quality gives crisper textures, props, and walls at the cost of more GPU memory
- **Minimap caching**: The minimap now caches its cell rendering to an offscreen bitmap, only rebuilding on data changes — the single biggest performance win, boosting fps from 37 to 240 on a 100×100 map
- **Two-tier offscreen map cache**: Cell rendering (floors, walls, props) is cached separately from the composite (cells + lighting). Cell cache persists across animation ticks; composite rebuilds only when lighting animates or data changes
- **Content-driven cache invalidation**: Map cache rebuilds are driven by `smartInvalidate()` content versioning instead of undo stack signatures, ensuring every cell mutation (including mid-drag wall placement) triggers an immediate visual update
- **Iterative flood fill**: Converted recursive `floodFillOutside` in floor rendering to an iterative stack-based approach, fixing stack overflow crashes on large grids (100×100+)
- **Viewport culling**: Floor rendering and editor dots now skip off-screen cells
- **Display-cell coalescing**: Floor base fill draws one display-cell-sized rect instead of 4 sub-cell rects where possible (4× fewer GPU commands)
- **Editor dots**: Only drawn at display-cell boundaries with viewport culling (was iterating every internal cell)
- **Outer shading Path2D**: Steps by resolution — ~2,500 arcs instead of ~10,000 for a 50×50 map
- **Diagonal wall merging**: Consecutive diagonal wall sub-cells are merged into single long segments, reducing GPU draw commands and eliminating visible joints between sub-cell diagonals
- **Static/animated lightmap split**: Lightmap rendering now separates static lights (cached once) from animated lights (re-rendered per frame). Static light contributions, ambient fill, and normal map bump are cached and reused — only animated light intensities update each frame
- **Screen-resolution animated lighting**: When animated lights exist, the lightmap is rendered at screen resolution and composited directly onto the viewport instead of rebuilding the full 5000×5000 offscreen composite every animation tick. Eliminates the per-frame 25-megapixel cache rebuild that was dropping frame rate from 240Hz to 13Hz
- **Configurable light quality**: New "Light Quality" dropdown in the View menu (Low 5 / Medium 10 / High 15 / Ultra 20 px/ft). Controls lightmap rendering resolution independently from the cell cache. Lower settings dramatically improve animated lighting performance on large maps with minimal visual impact (lightmaps are smooth gradients)
- **Reusable lightmap canvas**: The lightmap OffscreenCanvas is cached and reused across frames instead of allocating a new 100MB+ VRAM buffer every frame
- **Auto-generated prop hitboxes**: Every prop now has a pre-computed convex hull polygon generated at load time by rasterizing draw commands onto a binary grid and tracing the boundary. Replaces per-query iteration of all draw commands for both click detection (`hitTestPropPixel`) and light occlusion (`extractPropLightSegments`). A prop with 91 draw commands that previously generated 200+ light-blocking segments now produces ~6-10 segments from a single polygon
- **Separate lighting and selection hitboxes**: Props support independent `hitbox` (lighting occlusion) and `selection` (click detection) shapes. Lighting hitboxes can be manually overridden in `.prop` files for props where the convex hull is too loose. Selection always uses the auto-generated hull unless a manual `selection` command is specified
- **Subscriber state-diff guards**: All panel `notify()` callbacks now check whether their relevant state actually changed before doing DOM work. Metadata skips if `metadata` ref unchanged; toolbar skips if `activeTool`/`lightingEnabled` unchanged; lighting skips if `lights`/`selectedLightId` unchanged; history skips if stack depths unchanged; properties skips if `selectedProp`/`selectedCells` unchanged; session skips if `sessionState` unchanged; background-image skips if `backgroundImage` ref unchanged. Reduces idle-frame notify cost from ~1ms to ~0.1ms
- **Raised offscreen cache limit**: Maximum cache canvas dimension increased from 8000px to 16384px, allowing large maps (e.g. 66×84 prop showcase) to use the offscreen cache instead of falling back to expensive per-frame direct rendering
- **Incremental cell cache updates**: Changing a cell's texture, fill, or erasing a cell no longer rebuilds the entire offscreen map cache. A dirty-region tracker in `smartInvalidate()` records which cells changed, and the cells cache redraws only a padded bounding rect around them — reducing cache rebuild cost from O(all cells) to O(dirty region) for single-cell edits
- **Incremental blend topology updates**: Texture changes now patch only the affected blend edges/corners via `patchBlendRegion()` instead of rebuilding the full blend topology and all ImageBitmaps. Single-cell texture edits drop from ~70ms to <2ms
- **Incremental fluid layer updates**: Fill removal patches the rendered fluid layer in-place — clears the dirty region and locally rebuilds Voronoi geometry for just the surrounding cells. Fill addition does the same local rebuild. Eliminates the full-map Voronoi tessellation that previously caused multi-second hitches on large maps
- **Stale blend cache fix**: The blend topology cache key now properly invalidates on in-place cell texture mutations. Previously the `cells` reference equality check allowed stale blend edges to persist after texture reassignment
- **Fill light invalidation**: Adding or removing fills (especially lava) now invalidates the static lightmap so fill-emitted lights update immediately in the dirty region
- **Canvas context**: Uses `{ alpha: false, desynchronized: true }` for reduced compositor overhead
- **GPU flags**: Electron configured with `ignore-gpu-blocklist`, `enable-accelerated-2d-canvas`, `enable-gpu-rasterization`, and `use-angle=gl` for maximum GPU utilization

### Performance Diagnostics

- **Collapsible overlay**: Click the header `[+]/[-]` to toggle between compact (Hz/draw/gap) and expanded view
- **Hz display**: Shows rAF probe rate instead of fps — more meaningful for an on-demand renderer
- **Categorized sections**: Metrics grouped into Map, Caches, Render, Undo, and Memory categories
- **Map info**: Cell count, prop count, light count, grid dimensions with display/internal distinction
- **Per-phase render timings**: Timing breakdown for every render phase: Mouse, Dots, RoomCells, Shading, Floors, Arcs, Blend, Fills, Walls, Bridges, Grid, Props, Hazard, Lighting, Decor
- **Cache diagnostics**: Cache dimensions, cells rebuild count, composite rebuild count, rebuild time
- **Undo diagnostics**: Serialize time, total time, undo/redo stack depth
- **Interaction timing**: `mouseMove` handler cost
- **Subscriber timing (Notify section)**: Per-subscriber callback cost breakdown — every `notify()` listener is labeled and timed, sorted by cost descending. Identifies expensive panel updates at a glance
- **Frame total**: Shows previous frame's complete render time including diagnostics, minimap, and post-draw work — reveals hidden per-frame costs not captured by individual phase timers
- **Post-frame busy probe**: `setTimeout(0)` probe measures main-thread blocking after `render()` returns, distinguishing JS bottlenecks from GPU compositor latency
- **Phase skip debugging**: `window._skipPhases = { cells: true }` in console to disable render phases and isolate GPU bottlenecks
- **Debug panel**: New right-sidebar panel (View > Developer > Debug Panel) with toggles to show hitbox overlays (cyan = lighting, yellow = selection) and enable/disable individual render layers without the console. Hitbox visibility persists across reloads

### Prop Sizing Overhaul

All 204 props reviewed and resized for the 2.5ft cell grid using real-world reference dimensions:

- **84 props scaled up** to correct real-world proportions (e.g. throne 1x1→2x2, bed 2x1→3x2, forge 2x2→3x3, fountain 2x2→3x3, tree 2x2→3x3)
- **120 props unchanged** — small items that fit naturally at 2.5ft (pillar, brazier, chair, candle, barrel, caltrops, etc.)
- **Rowboat redesigned**: New 8x2 hull (20ft×5ft) with proper tapered shape, thwarts, oarlocks, and gunwale detail
- **New prop: Boat** — 8x4 (20ft×10ft) sailing/fishing vessel with stern transom, mast step, rudder, and hull plank seams
- Automated resize script (`tools/resize-props.js`) scales both footprints and draw commands proportionally

### API Coordinate Translation

All ~20 API methods now accept half-step display coordinates and convert to internal indices transparently:

- **Input conversion**: `createRoom(2, 2, 4.5, 6.5)` creates a room with half-cell precision
- **Output conversion**: `getRoomBounds`, `findWallBetween`, `listRooms`, `getMapInfo`, `getLevels` etc. return display coordinates
- **Backward compatible**: Integer coordinates work identically to before
- `getMapInfo` returns display dimensions (`rows`, `cols`, `gridSize`) plus new `resolution` field

### Door Rendering at Half-Cell Resolution

- **Cardinal doors**: Adjacent sub-cell doors automatically coalesce — 2 sub-cell doors render as one 5ft single door, 4 as a double door. Odd leftovers render as small sub-cell doors
- **Diagonal doors**: Same coalescing logic with `sqrt(2)` compensation for diagonal length — doors fill 80% of the diagonal segment
- **Diagonal wall merging**: Continuous diagonal wall lines drawn as single merged segments, with door gaps painted on top — eliminates fragmented wall artifacts between doors

### Trim & Lighting Fixes

- **Rounded trim migration**: Arc trims re-compute void boundaries at sub-cell precision after migration — eliminates chunky 2×2 void blocks, producing smooth arcs. Diagonal walls removed from rounded trim hypotenuse cells (arc wall drawn from metadata)
- **Straight trim migration**: Correctly voids the corner sub-cell on the void side of diagonal trims; sets `trimCorner` on diagonal sub-cells for proper triangle clipping
- **Lighting trim cleanup**: After lightmap compositing, void triangles of trim cells are erased with `destination-out` — prevents light brightness from bleeding into the void side of diagonal trims

### Prop Ghost Improvements

- **Rotate and scale ghosts**: Alt+Scroll fine-rotates (15° steps) and Alt+Shift+Scroll scales both placement ghosts and drag ghosts. `[`/`]` adjusts z-order during drag. Changes apply directly to ghost state with no undo overhead
- **Ghost tooltip**: Placement and drag ghosts now show a name label with rotation, scale (when non-default), and z-height (when non-default) — matching the existing selection label format
- **Placement scale**: New `propScale` state allows pre-scaling props before placement. Scale and rotation reset on Escape

### UX

- **PNG export progress overlay**: Exporting to PNG now shows a full-screen overlay with a spinner and status message ("Rendering PNG...") instead of freezing the UI with no feedback. The overlay dismisses automatically when the render completes or on error

### Bug Fixes

- **Prop drag hitch eliminated**: Picking up, cancelling, or dropping a prop no longer causes a visible frame hitch. Previously, drag start serialized the entire dungeon for the undo stack, forced a full wall segment + lightmap rebuild, and cancel/drop deserialized the whole snapshot back. Now drag operates without undo snapshots — props are removed from state on pickup, re-inserted directly on cancel (no deserialization), and `pushUndo` only fires on successful drop. Lightmap invalidation during prop operations skips wall segment extraction (only prop shadow zones are cleared, since walls don't change)
- Fixed Ctrl+freeform prop placement: the placement ghost now tracks the exact cursor position instead of snapping to cell grid, and the prop is placed where the ghost shows
- Fixed linked lights on freeform-placed props snapping to the anchor cell instead of following the prop's actual world position
- Fixed bridge textures missing in PNG export — bridge texture IDs weren't collected by the texture loader, and `DOMMatrix` (needed for pattern scaling) wasn't available in the Node.js render path
- **Export quality doubled**: `GRID_SCALE` increased from 10 to 20 px/ft — exported PNGs are now 4× the pixels for sharper prints and VTT use
- **Texture loading bar never completing**: Fixed race condition where `loadTextureImages()` returned an instantly-resolved promise for textures already in flight, causing `ensureTexturesLoaded()` to resolve before images finished loading. The progress bar also failed to track images started by `preloadPropTextures()`, leaving the loading overlay stuck indefinitely on maps with many props
- **Unknown prop type spam**: Props with unrecognized types (e.g. from removed or renamed props) now get purged from the map data on first encounter instead of logging a warning every frame
- **Prop-linked lights cleaned up on deletion**: Deleting a prop with a built-in light source (via `removePropAt` or `removePropsInRect`) now also removes the associated lights. Previously only `removeProp` cleaned up linked lights; the other two deletion paths left orphaned lights in the metadata
- **Viewport not centered on new map**: Creating a new map no longer leaves the viewport at the previous pan/zoom position — the map now auto-centers (zoom-to-fit) after creation, matching the existing behavior when loading a map
- **Erase tool not removing props**: The erase tool now removes overlay props (`metadata.props[]`) whose anchor falls within the erased rectangle. Previously only cell data was nulled — overlay prop entries persisted and continued rendering
- **Trim tool drag not cancellable**: Right-click or Escape during a trim drag now cancels the operation without applying any changes, matching the existing behavior of the light drag tool

### Migration

- Format version bumped to 3 (v2→v3 migration)
- Migration splits each cell into 4 sub-cells: replicates fill/texture/hazard, distributes outer walls to correct sub-cell edges, handles diagonal walls, trims, arc metadata, labels, stairs, and bridges
- Rounded trims: re-voids cells at sub-cell precision using doubled arc geometry; removes staircase-causing diagonal walls from hypotenuse
- Straight trims: voids the corner sub-cell in the void zone; preserves diagonal walls on the two hypotenuse sub-cells with correct `trimCorner`
- Props and lights unchanged (already stored in world-feet coordinates)

---

## v0.7.1

### Bug Fixes

- Fixed props being visible through fog of war in the player view — props now respect revealed cells, matching the existing behavior of stairs and bridges

### Testing

- Added player view unit tests (18 tests) covering fog-of-war cell filtering, prop/bridge visibility, secret door handling, and invisible wall stripping
- Added player view visual snapshot tests (6 tests) — fully revealed, partial fog, and fully fogged renders for each example map
- Added headless `renderPlayerViewToCanvas()` in the compile pipeline for player-view snapshot rendering

### Keybindings Helper

- Keybindings helper panel now shows DM tool shortcuts when in session mode (Doors, Range, Fog Reveal) instead of the editor tool binds
- Header displays "DM: Doors (1)" / "DM: Range (2)" / "DM: Fog Reveal (3)" with tool-specific actions
- Automatically switches back to editor keybinds when leaving session mode

---

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
