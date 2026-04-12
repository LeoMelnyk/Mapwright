# Mapwright Design Guide

This guide teaches AI how to make **good** dungeon maps — not just technically correct ones. A good map tells the story of the space through props, fills, textures, lighting, and room shape. Read this before generating any map.

---

## CRITICAL: Iterative Build Protocol

**Never generate all commands at once and execute them in a single shot.** That approach produces maps with compounding coordinate errors, wrong prop positions, and lighting that blows out entire rooms — all invisible until the final render when it's too late to fix.

The correct workflow is **phase-by-phase with screenshots between each phase.** Use the MCP tool `mcp__mapwright__execute_commands` for each phase.

### Mandatory Build Phases

**Phase 1 — Layout** (use `planBrief` for single-level, manual `createRoom` for multi-level)
```json
["planBrief", { "name": "...", "theme": "...", "rooms": [...], "connections": [...] }]
```
After executing: take a screenshot. Verify room positions, connections, and door placements. Fix any issues before continuing.

**Room connectivity rule:** For structural buildings (keeps, temples, undercrofts), place rooms flush against each other and use `setDoorBetween`. For caves/tunnels, use `createCorridor`. See Spatial Rule #11 for the full decision guide.

**Phase 2 — Spatial Queries** (always do this before placing anything)
```json
["listRooms"]
```
This returns actual bounds for every room — use these coordinates for everything else. Never guess bounds from `planBrief` input.

**Phase 2b — Margin Normalization** (after layout is verified, before furnishing)
```json
["normalizeMargin", 2]
```
Call once after the layout screenshot is approved. This trims or expands the grid so every level has **exactly 2 cells of empty margin** around all structural content on all four sides. Columns are normalized globally (shared across all levels); rows are normalized per-level.

Check the return value — `adjustments.colShift` and `adjustments.levels[i].topShift` show what moved. **Always re-run `listRooms` after normalization** — room bounds shift with the grid, and any coordinates from Phase 2 are stale. Take a screenshot if the map shifted significantly.

> **When to skip:** Only skip if the brief explicitly sets a grid size for a specific reason and any margin change would break that constraint.

**Phase 3 — Textures** (after structure is verified)

First call `listTextures()` if unsure what's available — the catalog is dynamic and grows over time. Then flood-fill the entire room floor in one command, then refine individual cells as needed:

```json
["floodFillTexture", r1+1, c1+1, "polyhaven/cobblestone_floor_03", 0.85],
["waitForTextures"]
```

`floodFillTexture` fills all connected floor cells from the seed point — no need to calculate interior bounds. For fine detail (a dirt path through a stone room, a wood dais on cobblestone), follow up with individual `setTexture` calls on the specific cells. Screenshot and verify before moving to props.

**Phase 4 — Props** (use `getValidPropPositions` for every prop)
```json
["getValidPropPositions", "A1", "throne-dais", 180]
```
Pick from the returned valid positions — never guess. Screenshot after each room's props are placed.

**Phase 5 — Lighting**
```json
["placeLightInRoom", "A1", "torch", { "radius": 15, "intensity": 0.8 }]
```
Use `placeLightInRoom` for room lights — it handles world-feet conversion automatically. Screenshot final result.

**Phase 6 — Cleanup & Export**

After all phases are complete:

1. **Export the final PNG** using `export_png` (HQ lighting pipeline):
   ```json
   mcp__mapwright__execute_commands with load_file + export_png
   ```
2. **Save the final JSON** — this is the authoritative map file for the adventure. Name it descriptively (e.g., `vessel-den.json`, not `vessel-den-phase3.json`).
3. **Delete all intermediate files** — phase JSONs (`*-phase*.json`), screenshots (`*-screenshot*.png`, `*-phase*.png`, `*-test*.png`, `*-fix*.png`), and any other working files created during the build.
4. **Final deliverables** in the adventure directory:
   - `map-name.json` — loadable in the editor for tweaks
   - `map-name.png` — HQ export for use in the adventure document

```bash
# Example cleanup
rm -f adventure-dir/*-phase*.json adventure-dir/*-phase*.png adventure-dir/*-screenshot*.png adventure-dir/*-test*.png adventure-dir/*-fix*.png adventure-dir/*-export*.png
# Then rename/keep only the final files
```

### Rollback on Error
Before any risky batch, record undo depth: `["getUndoDepth"]`. If the result looks wrong, call `["undoToDepth", N]` to roll back.

---

## Inventing New Props

The catalog is **not** exhaustive and never will be. When a room genuinely needs something the library lacks (an astrolabe, a chaise lounge, a specific cult relic) — **create the prop**, don't substitute.

Read [src/props/CLAUDE.md](src/props/CLAUDE.md) for the format. Every prop gets the full treatment: footprint, hitbox, shadow, `blocks_light`, `height`, `lights:` if applicable, `placement`, `room_types`, `typical_count`, `clusters_with`, and notes. Author the draw commands as vector primitives (rectangles, circles, lines, polys, texfills) — same approach as existing props. **Do not generate raster/PNG props** — they will look uncanny next to vector neighbors and degrade catalog cohesion.

**Budget is not a constraint; thoroughness is.** Spend tokens liberally:
- Reference the closest existing prop (e.g. `throne-dais.prop`, `brazier.prop`, `forge.prop`) for layering style, opacity, and stroke conventions
- Render a single-prop test and screenshot before placing in the map
- Compare quality side-by-side against neighbors in the same category
- Iterate until it fits — 3-5 revisions is normal for a new prop

A well-authored prop is reused across many maps. Cutting corners here pollutes the entire catalog.

---

## Hard Limits

### Textures
**Texture IDs are full polyhaven paths.** Short IDs like `"cobblestone"` do NOT exist and silently do nothing. Always use the full path form.

**Always call `listTextures()` before a texture pass.** The catalog is dynamic — new textures are added regularly. Don't rely on a memorized shortlist; query for what's actually available and pick the best match for the room's material. The command returns all IDs with display names and categories.

Common defaults (but verify with `listTextures()` first):

| Purpose | Texture ID |
|---------|-----------|
| Dungeon stone floors | `polyhaven/cobblestone_floor_03` |
| Cave / cell / earth floors | `polyhaven/dirt_floor` |
| Barracks / office / interior wood | `polyhaven/wood_floor` |
| Old wooden planks | `polyhaven/wooden_planks` |
| Dark stone / crypt | `polyhaven/cobblestone_floor_08` |

The server must be started with `MAPWRIGHT_TEXTURE_PATH` set for textures to appear in export PNGs.

### Light Radius
| Source | Max Radius | Notes |
|--------|-----------|-------|
| Candle | 10 | Desk, altar, intimate |
| Torch / Sconce | 15 | Standard room light |
| Brazier / Campfire | 22 | Large ceremonial rooms |
| Any single light | 28 | Hard cap — never exceed for indoor rooms |

A single light with radius 50 covers the entire dungeon. Multiple weak lights (radius 12–18) are always more atmospheric than one large one.

### `setTextureRect` Interior Bounds
`createRoom(r1, c1, r2, c2)` puts walls **on** r1/r2/c1/c2. Interior cells are `r1+1` to `r2-1`, `c1+1` to `c2-1`. Always apply textures to the interior, not the wall row/col.

---

## Philosophy

Every room should answer two questions: **who uses this space**, and **what do they do here**? The props, fills, and lighting are the answer. A throne room without pillars flanking the dais, without carpet runners leading to the throne, without chandelier light pooling at the center — that's not a throne room, it's a box with a chair.

**Maps are read spatially.** Players notice patterns: rows of pews toward an altar signal religion; chains and iron bars signal imprisonment; scattered bone piles and a necrotic altar signal undead. Use that language deliberately.

---

## Universal Spatial Rules

These rules apply to every room, every time.

### 1. Anchor First
Place the **primary feature** before anything else. The primary feature is the thing that defines the room's purpose: the throne, the forge, the altar, the magic circle. Everything else orbits it.

### 2. Hug Walls
Secondary props belong against walls. This keeps the center open for movement, combat, and visual clarity. Exception: centrepiece props (fountain, magic circle, ritual circle, pillar clusters) go in the center by design.

### 3. Door Clearance
Leave 1 cell (5 ft) of clear floor in front of every door. Never place a prop directly against a door cell — players need room to step through.

### 4. Cluster by Function
Group semantically related props together. A `forge + bellows + anvil + workbench` cluster reads as "smithy." A `alchemy-bench + alembic + ingredient-rack + specimen-jar` cluster reads as "alchemist lives here." Mixed clusters read as storage chaos — only use that if that's your intent.

### 5. Primary → Secondary → Scatter
Every room has three prop layers:
- **Primary** (1): The dominant feature — large, central, immediately legible
- **Secondary** (2–4): Support items that reinforce the primary's purpose
- **Scatter** (1–3): Small accent props adding life — a candle, a bone pile, an hourglass

### 6. Lighting Anchors
Lights should explain themselves. A `torch-sconce` prop should have a corresponding point light at that cell. A `brazier` should glow. A `forge` should cast heat-orange light. Players (and AI) notice when light exists with no source, or sources exist with no light.

**Many props auto-emit light on placement** — `placeProp` adds the light for you. Call `listLightEmittingProps()` for the full list, or check the `lights:` field in any `.prop` file. When `placeProp` returns `lightsAdded: [...]`, the prop already brought its own light; do NOT also call `placeLight` or `placeLightInRoom` at that cell or you'll double up. Examples that auto-light: `brazier`, `forge`, `fireplace`, `hearth`, `chandelier`, `torch-sconce`, `candelabra`, `candle-cluster`, `wall-lantern`, `floor-candelabra`, `signal-fire`, `campfire`, `lantern-post`, `lava-pool`. Props that do NOT auto-light still need a manual `placeLight` if you want them illuminated.

### 7. Symmetry vs. Organic
- **Formal/ceremonial spaces** (throne room, temple, audience hall): bilateral symmetry. Matching pillars, matching braziers, centered primary feature.
- **Lived-in spaces** (kitchen, workshop, scholar's study, barracks): asymmetric and organic. Props clustered by use, not mirrored.

### 8. Fill Before Props
Place fills (`setFillRect` for water/pit/lava, `setHazardRect` for difficult terrain) before placing props. Props render on top of fills correctly.

### 9. Texture Tells Material
Call `listTextures()` to see the full current catalog — it grows over time. Choose based on what makes sense for the space:
- Stone/cobblestone: dungeons, crypts, formal halls, guard posts
- Wood planks: barracks, libraries, offices, upper-story rooms
- Dirt/earth: caves, prison cells, rough tunnels, servant areas
- Marble/tile: temples, throne rooms, wealthy interiors

Use `floodFillTexture` to cover the whole room floor, then override individual cells for material variation (dirt path through stone, wood dais on cobblestone). Always call `waitForTextures()` before any screenshot after a texture command.

### 10. Stair Pockets
Stairs need 3 walls around them to communicate direction to the reader — the open side is the entry, the 3 walled sides form the stairwell pocket.

```
  W W W      ← north, east, west walls set
  W ↑ ↑      ← stair cells (no south wall — that's the room entry)
```

After `addStairs`, place walls on 3 sides using `setWall`. Leave the side facing the connected room open. The hatch lines in the stair graphic already show descent direction; the walls make the stairwell legible as a physical space.

**Never place a prop on a stair cell.** `getValidPropPositions` does not automatically exclude stair cells (stairs store `center["stair-id"]`, not `cell.prop`). Before placing props in a room, identify stair cell coordinates from the `addStairs` return value and avoid them explicitly.

### 11. Room Connectivity — Shared Walls vs. Corridors

How rooms connect depends on the **type of structure**, not on API convenience.

**Structural buildings** (keeps, undercrofts, temples, mansions, guild halls, warehouses):
- Rooms share walls directly — place them **flush against each other** with no gap.
- Connect with `setDoorBetween(label1, label2)` on the shared wall.
- Result: rooms feel like they belong to one building.

**Natural/underground** (caves, mines, tunnels, sewers, catacombs):
- Gaps between rooms are appropriate — these spaces were carved or eroded, not built.
- Use `createCorridor(label1, label2)` to bridge gaps with connector rooms.
- Result: rooms feel like they were discovered, not designed.

**Hallway buildings** (castles, mansions, large temples):
- Create the hallway as a **proper elongated room** (e.g., 2×12 cells) with its own label.
- Place doors from the hallway to each adjacent room.
- Do NOT use `createCorridor` — that creates 1-2 cell stubs that look like airlocks.

**How to build flush rooms:**
```json
["createRoom", 2, 2, 10, 12],
["setLabel", 6, 7, "A1"],
["createRoom", 2, 13, 10, 22],
["setLabel", 6, 17, "A2"],
["setDoorBetween", "A1", "A2"]
```
Note: A1 ends at col 12, A2 starts at col 13 — they share the wall at col 12/13. No gap, no corridor stub.

**When NOT to use `createCorridor`:**
- Between rooms in a building that should share a wall
- When the corridor would be ≤2 cells long (looks like an airlock)
- When the connection is just a door in a wall

**When to use `createCorridor`:**
- Between rooms separated by natural terrain (cave tunnels)
- When the corridor is a meaningful space (≥4 cells long, has its own purpose)
- When rooms on different levels need a winding connection

### 12. Shape Variety — Not Every Room Is a Square

Real spaces have variety. A throne room is long and narrow, not square. A guard alcove is a small nook, not a 10×10 box. A temple nave is 3:1. A wizard's study in a tower is circular.

**Aspect ratio guide:**
| Ratio | Shape Name | Good For |
|-------|-----------|----------|
| 1:1 | Square | Small utility rooms, vaults, wells, single-purpose chambers |
| 3:2 | Wide rect | Barracks, workshops, kitchens — workable multi-station rooms |
| 2:1 | Long rect | Throne rooms, galleries, dining halls — processional spaces |
| 3:1+ | Narrow | Temple naves, corridors-as-rooms, hallways, bridges |
| Irregular | L/T/U | Guard posts with alcoves, kitchens with pantries, natural caves |
| Rounded | Circle/oval | Towers, shrines, ritual chambers, wells, arcane rooms |

**How to build each shape:**
- **Rectangles**: `createRoom(r1, c1, r2, c2)` — vary width and height deliberately
- **L/T/U shapes**: Two overlapping `createRoom` calls with `"merge"` mode, or `createPolygonRoom`
- **Rounded**: `createRoom` + `roundRoomCorners(label, trimSize)`
- **Alcoves**: Main room + small `createRoom(..., "merge")` extending off one side
- **Irregular**: `createPolygonRoom([[r,c], ...])` with a hand-crafted cell list

**The test:** Before finalizing a layout, scan the room list. If every room is within 2 cells of square (e.g., all 8×10, 10×10, 10×12), the map will look like a grid of boxes. Vary at least 2-3 rooms to have distinct aspect ratios or non-rectangular shapes.

---

## Prop Density Guide

**Primary rule: the room description is the guide.** Use as many or as few props as needed to accurately represent what the description says. There is no upper limit — if the description says "crates stacked along three walls from floor to rafters," fill three walls with crates. If it says "a bare cell with a pallet and a bucket," place exactly those two things.

The table below is a **baseline for rooms with no specific description** (e.g., unnamed corridors, generic guard posts):

| Room Size | Interior Cells | Props | Notes |
|-----------|---------------|-------|-------|
| Tiny (<4×4) | ~9–12 | 0–1 | Basically a closet |
| Small (4×6 to 6×6) | 12–25 | 1–3 | 1 primary, 1–2 scatter |
| Medium (6×8 to 8×10) | 30–60 | 3–6 | 1 primary, 2–3 secondary, 1–2 scatter |
| Large (10×12 to 12×14) | 80–130 | 5–9 | 1–2 primary, 3–4 secondary, 2–3 scatter |
| Boss Chamber (14×16+) | 150+ | 5–8 | Fewer, larger props — leave room for combat |

**Description-driven rooms:** Read the adventure text literally. Count distinct elements ("a long table, ten chairs, a corkboard" = place all of them). Phrases like "stacked along three walls" mean fill those walls. "From floor to rafters" means dense, back-to-back placement — not one crate per wall. Pack the wall cells.

**Missing props:** If the description calls for something not in the prop catalog, **create it.** Read `mapwright/src/props/CLAUDE.md` for the full format, then write the `.prop` file and call `clearCaches()` before placing it. Do not substitute a different prop — make the right one.

---

## Description → Prop Workflow

When furnishing a room from adventure text, follow this sequence every time:

**Step 1 — Parse the description**
Extract every distinct furnishing element as a list:
> *"Crates stacked along three walls, a lamp hanging from the central beam, two barrels near the door"*
→ `crates × north wall`, `crates × east wall`, `crates × west wall`, `chandelier × center`, `barrel × south-west`, `barrel × south-east`

**Step 2 — Map to props (or create)**
For each element, find the matching prop ID. If no match exists in the catalog, create the prop file before continuing. Never skip an element or substitute something similar.

**Step 3 — Determine rotation for wall-hugging props**

Footprint is **R×C (rows × cols)**:
- At rotation `0`: prop extends **C cols east** and **R rows south** from anchor
- At rotation `90`: dimensions swap — extends **C rows south** and **R cols east**

| Placing along… | Want long axis to run… | Use rotation where… |
|----------------|----------------------|---------------------|
| North / South wall | East–west | cols ≥ rows after rotation |
| West / East wall | North–south | rows ≥ cols after rotation |

**Quick rule:** `1×2` prop (1R, 2C) → north/south wall: rot `0` (wide); west/east wall: rot `90` (tall). `2×1` prop (2R, 1C) → north/south wall: rot `90`; west/east wall: rot `0`. Verify with `getPropFootprint(propType, rotation)`.

**Step 4 — Place at wall cells, not interior cells**
Props placed "against a wall" should anchor at the actual wall cell row/col (`r1`, `r2`, `c1`, `c2`) — **not** at `r1+1` or `c1+1`. Wall cells are valid placement positions. `getValidPropPositions` excludes wall cells only because they may already be occupied, not because they are structurally invalid.

**Step 5 — Screenshot and verify before moving to next room**

---

## Pre-flight Layout Approval

Before running any `execute_commands` call that creates rooms or structure, show the user a plain-text layout and wait for approval:

```
Zone 1 — Warehouse (top)
  A1  Loading Dock     7×9   NW corner      rect
  A2  Main Floor      12×16  center         rect
  A3  Foreman Office   5×6   NE corner      rect
  ↕ Stair A (A2 NW ↔ B4)

Zone 2 — Undercroft (middle)
  B4  Guard Post   6×4+alcove  NW           L-shape
  B5  Barracks     6×14        center       long rect (2:1)
  B6  Mess Hall    8×12        south        rect (3:2)
  B7  Chapel       6×16        SE           long nave + rounded apse
  ...
```

Include the **shape** column — it forces you to think about aspect ratio and non-rectangular layouts before committing to code. If every entry says "rect", reconsider.

This takes 30 seconds and prevents scrapping a 200-command build because a zone was placed side-by-side instead of stacked.

---

## Room Shape Vocabulary

Rectangular rooms are the default — use other shapes when they serve the narrative.

| Shape | How | When |
|-------|-----|------|
| Single corner cut | `trimCorner(label, "nw", size)` | Fortress alcoves, guard stations, sightline cuts |
| Single rounded corner | `trimCorner(label, "nw", size, {round: true})` | Tower stairwell, apse, rounded alcove |
| Full rounded room | `roundRoomCorners(label, trimSize)` | Towers, circular shrines, arcane chambers, ritual rooms |
| L-shape | `createPolygonRoom([cells])` or two `createRoom` calls with `"merge"` | Natural caves, organic layouts, rooms wrapping corners |
| Irregular cave | `createPolygonRoom` with a ragged cell list | Natural caverns, collapsed areas |

**Prefer `trimCorner` over `createTrim` for single corners.** It takes a room label + compass direction (or `[row, col]` cell) + size — no coordinate math, no tip/extent reasoning. Works on irregular rooms (L, U, +, polygon) because it resolves the corner from the room's actual cell set.

```json
["trimCorner", "A1", "nw", 3, {"round": true}]
["trimCorner", "A1", [5, 12], 3, {"round": true}]    ← cell-based: finds nearest convex corner
```

**`roundRoomCorners`** rounds all 4 corners of a rectangular room in one call:
```json
["roundRoomCorners", "A10", 4]
```

**Trim size guide:** Size 2 = modest corner cut. Size 3–4 = significant bevel. For a near-circular room, use `trimSize = floor(min(width, height) / 2)`.

**Verify shape after trims.** `previewShape(label)` returns ASCII of the room's current cells — confirm the geometry without a full screenshot.

**Legacy `createTrim`** still works for coordinate-based edits but requires manual tip/extent math. Prefer `trimCorner`.

---

## Lighting Design

### Ambient Level
| Setting | Ambient | Feel |
|---------|---------|------|
| Normal dungeon | 0.35–0.45 | Dim but navigable |
| Dark dungeon | 0.15–0.25 | Tense, shadowy |
| Horror/undead | 0.0–0.15 | Near-pitch black |
| Outdoor/lit hall | 0.6–0.8 | Bright and open |

### Preset Selection
| Preset | Color | Radius | Best For |
|--------|-------|--------|----------|
| `torch` | Warm orange | ~15 | Individual torches, sconces |
| `brazier` | Amber | ~20 | Large ceremonial rooms, guard posts |
| `candle` | Soft yellow | ~8 | Desks, altars, intimate spaces |
| `lantern` | Warm white | ~15 | Outdoor posts, entrances |
| `campfire` | Deep orange | ~20 | Caves, outdoor areas |

### Placement Patterns
- **Prefer light-emitting props.** Placing a `torch-sconce`, `brazier`, `chandelier`, `fireplace`, `hearth`, `candelabra`, or `lantern-post` auto-adds a light. This is the most natural way to light a room — pick the prop, the light follows.
- **Multiple weak > one strong**: A room with 3 torches (radius 15, intensity 0.7) is more atmospheric than one large light (radius 45, intensity 1.0).
- **Match light color to theme**: Forge/kitchen rooms = orange-red (`#ff4400`). Undead/crypt = pale blue-white (`#aabbff`). Arcane = violet (`#cc88ff`). Ice = cold blue (`#88aaff`).
- **Unlit rooms are valid.** Caves, abandoned buildings, sealed crypts, and places without a living occupant can and should be dark. Don't force a light into every room — check the room vocab's `lighting_notes.ambient_is` field: `required` → light it, `optional` → your call, `discouraged` → leave it dark.

### Lighting World Coordinates
Light `x = col * gridSize`, `y = row * gridSize`. Prefer `placeLightInRoom(label, preset)` to avoid coordinate math.

---

## Fill Usage Patterns

| Fill | Command | Use When |
|------|---------|----------|
| `water` depth 1 | `setFillRect(..., "water", 1)` | Shallow puddles, stream crossings |
| `water` depth 2 | `setFillRect(..., "water", 2)` | Wading pools, flooded cells, moats |
| `water` depth 3 | `setFillRect(..., "water", 3)` | Deep channels, cisterns, underwater sections |
| `pit` | `setFillRect(..., "pit")` | Chasms, open shafts, bottomless drops |
| `lava` depth 1–3 | `setFillRect(..., "lava", 2)` | Volcanic areas, infernal planes |
| Hazard | `setHazardRect(...)` | Difficult terrain: rubble, ice, mud, grease |

**Water room pattern**: Fill 60–80% of the room with water (depth 2–3), leave a walkable perimeter of 1–2 clear cells. Place `rope-coil` or `dock-post` props on the dry edge.

**Moat pattern**: Create a ring of water cells around a central feature. Use `setFillRect` for the whole room then `removeFillRect` for the center island.

**Pit trap pattern**: Single `pit` cell in a corridor. Place `pressure-plate` prop on the adjacent trigger cell.

---

## Room Semantic Library — Queryable Vocab API

The Room Semantic Library lives in `src/rooms/**/*.room.json` and is accessed through API methods, **not** preloaded prose. Each spec is a **palette of options** (multiple primary choices, multiple secondary options, story prompts) — two instances of the same room type will look meaningfully different because you compose a specific layout from the palette.

### Discovery flow

```json
["listRoomTypes"]                                  // all types: name, category, tags, summary
["searchRoomVocab", {"tags": ["arcane"]}]         // filtered discovery
["suggestRoomType", {"description": "smoky room full of pipes"}]   // prose → ranked candidates
["getRoomVocab", "throne-room"]                   // full palette for one type
```

### What a spec contains

Every `.room.json` file has these fields:
- `primary_palette` — options for the room's dominant feature. **Pick ONE.** Each entry can suggest flanking props (`surrounded_by`) and a creative context note.
- `secondary_palette` — 2-4 supporting props. Compose your own arrangement.
- `scatter_palette` — 1-3 accent props for life.
- `size_guidance` — min/typical sizes and aspect ratio advice.
- `texture_options` — floor + accent texture IDs.
- `shape_guidance` — preferred/discouraged shapes (trims, rounds, L-shapes, etc.).
- `story_prompts` — seed phrases to vary the room's narrative feel. Pick one, invent your own, or ignore.
- `lighting_notes.ambient_is` — `required` | `optional` | `discouraged`. Drives whether unlit rooms are appropriate.
- `anti_patterns` — type-specific mistakes to avoid.

### Composition rule

The library is **vocabulary, not a recipe.** Two throne rooms built from `throne-room.room.json` should still feel different: different primary (throne-dais vs bone-throne), different secondaries (pillars + brazier vs chandelier + curtain), different story (cold queen vs usurper). The spec tells you what pieces exist. You decide which, how many, where, and what story they tell.

### Extending the library

If no existing spec fits, author a new one:
1. Place it under `src/rooms/<category>/<name>.room.json`
2. Follow the schema of any existing spec (throne-room is the reference)
3. The server's `/api/rooms/manifest` picks it up on next request — no rebuild needed
4. Categories on disk match the `category` field (but tags are the primary discovery axis)

The goal is breadth: ~100-150 specs across dungeon, residential (variations: cabin/house/mansion/etc.), wilderness, urban, industrial, sacred, naval, planar. Variety of coverage matters more than variety within one type — that comes from composition.

---

## Anti-Patterns to Avoid

These are the most common ways maps fail to feel real:

1. **Props in doorways**: Never place a prop on or immediately adjacent to a door cell. Leave clearance.
2. **Centred furniture in every room**: Only formal/ceremonial rooms have central furniture. Lived-in spaces cluster against walls.
3. **Identical room fills**: Don't give every room the same texture and no fills. Vary materials and fill types.
4. **Lights with no source**: Every light should have a corresponding prop that would cast it (sconce, brazier, campfire). Exception: magical ambient glows.
5. **Under-lit large rooms**: A 12×14 room with one candle light (radius 8) is too dark to navigate — feel free to add multiple light sources, OR check `lighting_notes.ambient_is` in the room vocab — some rooms (caves, ruins) are meant to be dark.
6. **Random prop selection**: Props must reflect room purpose. A tomb with a kitchen table breaks immersion. A forge with a magic circle creates a story question worth answering.
7. **Symmetric organic spaces**: Natural caves and lived-in spaces shouldn't have bilateral symmetry. Only formal/military/religious spaces should mirror.
8. **Fills that block all passage**: Water fills and pit fills must leave at least 1-cell walkable paths through them (unless the point is that the room is impassable without magic).
9. **Props outside room bounds**: All prop anchors and their full footprint must be within the room's interior (not on wall cells). Use `getValidPropPositions` when uncertain.
10. **Same-vocab rooms feeling identical**: Two rooms of the same type should feel different. Pull different `primary_palette` options, different secondaries, different story prompts. If two throne rooms in one dungeon look the same, the vocab is being stamped instead of composed.
11. **One-shot 100+ command batches**: Generating all commands blindly and executing once guarantees invisible coordinate errors. Use the Iterative Build Protocol.
12. **Using short texture names**: `"cobblestone"`, `"dirt"`, `"wood"` are NOT valid IDs. Use full polyhaven paths: `polyhaven/cobblestone_floor_03`, `polyhaven/dirt_floor`, `polyhaven/wood_floor`. Wrong IDs silently do nothing.
13. **Oversized light radius**: A `radius: 50` indoor light turns the entire dungeon into a glowing blob. Cap at 28 for any indoor room.
14. **Guessing wall positions for doors**: Always use `findWallBetween(label1, label2)` to find door positions. Never guess.
15. **Manual world-feet lighting math**: Use `placeLightInRoom(label, preset)` instead of computing `x = col * gridSize` by hand — it's error-prone on multi-level maps.
16. **Large light batches cause Puppeteer navigation timeout**: Placing more than ~6–8 lights in a single `execute_commands` call can time out. Split lighting into batches of ≤6 `placeLight`/`placeLightInRoom` calls per MCP invocation.
17. **Props on stair cells**: `getValidPropPositions` does NOT exclude stair cells. Record stair coordinates from `addStairs` return values and skip them manually during prop placement.
18. **Stairs without pocket walls**: Naked stairs (no surrounding walls) are ambiguous — the reader can't tell which way is up or down. Always add 3 `setWall` calls after `addStairs` to form the stairwell pocket.
19. **Using `setTextureRect` to fill a room**: Use `floodFillTexture` from any interior floor cell instead — it covers the whole connected area automatically without bound calculation.
20. **Picking texture IDs from memory**: The texture catalog is dynamic. Always call `listTextures()` and pick the best match for the room's material — don't assume a shortlist is current.
21. **Corridor stubs between building rooms**: Using `createCorridor` between rooms in a structural building (keep, temple, undercroft) creates tiny 1-2 cell connector rooms that look like airlocks. Instead, place rooms flush (adjacent columns/rows) and use `setDoorBetween` for a door on the shared wall. Reserve `createCorridor` for natural tunnels and caves. See Spatial Rule #11.
22. **All rooms are squares**: If every room in the dungeon is 8×10 or 10×10, the map looks like a grid of boxes. Vary aspect ratios (2:1 for throne rooms, 3:1 for temple naves), use L-shapes for kitchens and labs, rounded corners for arcane rooms, and alcoves for guard posts. See Spatial Rule #12 and the room vocab's `shape_guidance` field.
23. **Forcing lighting into rooms meant to be dark**: A collapsed watchtower, an abandoned cabin, or a sealed crypt is *supposed* to be dark. Read `lighting_notes.ambient_is` in the room vocab — if it says `discouraged`, leave it unlit. Darkness is a design tool, not a failure mode.

---

## Multi-Agent Map Generation Pipeline

> **For single-agent builds (Claude working alone), use the Iterative Build Protocol at the top of this file, not this section.** This pipeline is for cases where parallel decorator agents are explicitly launched.

When building complex multi-room dungeons with parallel agents, they coordinate by **producing command arrays**, never by writing to the map concurrently. Only the final execution step touches Puppeteer. Even with this approach, Phase 5 execution should still use `--continue-on-error` and take intermediate screenshots.

### Phase 1 — Planner Agent (Serial)

**Input:** Adventure context — dungeon purpose, enemy faction, level tier, room count, tone.

**Output:** `room_plan.json` — an array of room descriptors:

```json
[
  {
    "label": "A1",
    "name": "Entrance Hall",
    "type": "entrance",
    "size": "medium",
    "width": 10,
    "height": 8,
    "entrance": true,
    "connections": [
      { "to": "A2", "direction": "north", "type": "door" },
      { "to": "A3", "direction": "east", "type": "secret" }
    ],
    "notes": "Guard post feel. Portcullis visible from entrance."
  }
]
```

Room `type` values come from `listRoomTypes` — the planner picks the closest vocab entry for each room, and decorators fetch the full palette with `getRoomVocab(type)`.

### Phase 2 — Layout Agent (Serial)

**Input:** `room_plan.json`

**Process:** Call `planBrief` with the room list and connection topology. The editor computes all spatial positions.

**Output:**
- `layout_commands.json` — the full `planBrief` result (ready-to-execute)
- `layout_info.json` — room label → bounds lookup for decorators:
```json
{
  "A1": { "r1": 2, "c1": 2, "r2": 11, "c2": 13, "centerRow": 6, "centerCol": 7 },
  "A2": { "r1": 2, "c1": 16, "r2": 13, "c2": 27 }
}
```

Get bounds by running: `node tools/puppeteer-bridge.js --commands-file layout_commands.json --save layout_base.json`, then `--commands '[["listRooms"]]'` to retrieve bounds.

### Phase 2b — Margin Normalization (Serial, after layout, before decoration)

After executing `layout_commands.json` and saving the base map, call:
```bash
node tools/puppeteer-bridge.js --load layout_base.json \
  --commands '[["normalizeMargin", 2]]' \
  --save layout_base.json \
  --screenshot layout_normalized.png
```

This ensures every level has exactly 2 cells of empty margin around all structure. **Re-run `listRooms` after normalization** — room bounds shift with the grid, so decorators must use the post-normalization coordinates in `layout_info.json`.

### Phase 3 — Decorator Agents (Parallel)

Launch one agent per room (or per cluster of small rooms). Each agent:

1. **Reads:** Its room label, type, bounds from `layout_info.json`, and this DESIGN.md
2. **Looks up:** Full palette with `getRoomVocab(type)` — never prose from this file
3. **Produces:** A command array for its room ONLY

**Strict rules for decorator agents:**
- ONLY call: `placeProp`, `removeProp`, `setFill`, `setFillRect`, `removeFill`, `setHazard`, `setHazardRect`, `setTexture`, `setTextureRect`, `placeLight`, `setLabel`, `createTrim`, `trimCorner`, `setDoor`, `setAmbientLight`
- NEVER call: `newMap`, `createRoom`, `setTheme`, `setName`, `setFeature`, `addLevel`, or any structural commands
- ALL coordinates must fall within the room's assigned bounds
- Produce output as a JSON file: `decorator_A1.json`, `decorator_A2.json`, etc.

### Phase 4 — Integration Agent (Serial)

**Input:** `layout_commands.json` + all `decorator_*.json` files

**Process:** Concatenate into one array:
1. First: all layout commands (room creation, corridors, doors, map metadata)
2. Then: all decorator commands, in room label order (A1 → A2 → ...)
3. Final commands: `["setAmbientLight", 0.3]`, `["setLightingEnabled", true]`, `["waitForTextures", 5000]`

**Output:** `final_commands.json`

### Phase 5 — Execution

```bash
# Normal (headless)
node tools/puppeteer-bridge.js \
  --commands-file final_commands.json \
  --save dungeon.json \
  --export-png dungeon.png

# Debug mode (visible browser, slow execution — you can watch the map build)
node tools/puppeteer-bridge.js \
  --commands-file final_commands.json \
  --visible \
  --slow-mo 100 \
  --save dungeon.json \
  --export-png dungeon.png

# Validate first
node tools/puppeteer-bridge.js \
  --commands-file final_commands.json \
  --dry-run --continue-on-error
```

### Coordination Rules

- Agents don't interfere because they produce **text files**, not map edits
- The Puppeteer server handles only one browser session at a time — all execution is sequential
- If a decorator agent fails to produce valid commands, re-run that agent only; the integration agent merges fresh output
- Use `--continue-on-error` during debugging to see which commands fail without stopping the build

---

## Room Design Reference

The Room Semantic Library is queryable data — `listRoomTypes` + `getRoomVocab(type)`. Each spec is a palette of options. Compose a specific room by picking from `primary_palette` (one), `secondary_palette` (2-4), `scatter_palette` (1-3), and optionally a `story_prompts` seed. Two rooms of the same type should feel different because you chose differently, not because the library forced a different layout.
