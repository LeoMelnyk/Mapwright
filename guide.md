# Mapwright Guide

## What This Tool Does

Generates print-ready PNG and SVG dungeon maps from `.map` files. The `.map` format uses an ASCII grid to define room shapes, a legend to assign room labels, and simple coordinate-based door and trim declarations. The compiler converts this into the matrix JSON format, and the renderer produces a styled map with grid overlays, labeled rooms, doors, secret doors, fill patterns, and thematic styling suitable for D&D 5e dungeon crawls.

## How to Run

```bash
# Single command: compile + render (recommended)
node build_map.js <name>.map

# With SVG output instead of PNG
node build_map.js <name>.map --svg

# Validate only (no output files)
node build_map.js <name>.map --check

# Watch mode (auto-rebuild on save)
node build_map.js <name>.map --watch

# Two-step pipeline (compile then render separately)
node compile_map.js <name>.map
node generate_dungeon.js <name>.json

# Validate only (compile step)
node compile_map.js <name>.map --check

# Render to SVG (render step)
node generate_dungeon.js <name>.json --svg
```

The single command (`build_map.js`) outputs both `.json` (for the editor) and `.png`/`.svg` (the rendered map). The two-step pipeline is still supported for cases where you only need to compile or only need to render.

---

## `.map` File Format

A `.map` file has four sections in order: **header**, **ASCII grid**, **legend**, and optionally **doors** and **trims**.

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
| `name` | Yes | Dungeon name. Rendered as the title at the top of the map. |
| `theme` | Yes | Theme preset name (see Themes section below). |
| `gridSize` | No | Feet per grid square. Default: 5. |
| `titleFontSize` | No | Font size override for the dungeon title in pixels. |
| `showGrid` | No | Show grid lines on background/non-room areas. Default: false (grid only appears inside rooms). |
| `compassRose` | No | Draw a compass rose in an empty corner. Default: false. |
| `scale` | No | Show a scale indicator at the bottom. Default: false. |
| `border` | No | Draw a decorative border around the map. Default: false. |
| `labelStyle` | No | Room label rendering style: `circled` (default), `plain`, or `bold`. |

#### Theme Overrides

To customize individual colors while keeping a base theme, add a `themeOverrides` block with indented key-value pairs:

```
---
name: Custom Crypt
theme: stone-dungeon
themeOverrides:
  wallFill: #444444
  background: #333333
---
```

Any theme color property can be overridden. See the Themes section for the full list of color properties.

### ASCII Grid

The grid appears after the header, before any section keywords. Each character defines one grid square (cell). All rows must be the same length — pad shorter rows with `.` on the right.

**Character types:**

| Character | Meaning |
|---|---|
| `.` | Void / empty space (no cell rendered) |
| `-` or `#` | Walled corridor. Generates walls on all sides facing other rooms. Requires doors to connect to adjacent rooms. Both characters are equivalent; `#` is visually more suggestive of walls. |
| `=` | Open corridor. No walls generated against adjacent rooms — creates seamless passage between connected spaces. |
| Any other character | Room cell. All contiguous cells of the same character form one room. |

**When to use `=` (open corridor):**

Use `=` to create passages through void space connecting rooms that aren't directly adjacent. The `=` cells suppress wall generation against any room they touch, creating a seamless transition.

```
AAAA....BBBB
AAAA====BBBB
AAAA....BBBB
```

Here, rooms A and B are separated by void (`.`) but the `=` corridor bridges them — no walls between A and the corridor, or between the corridor and B. Players walk freely from A through the corridor to B.

**Do not** place `=` between rooms that are already directly adjacent. Since `=` suppresses walls, placing it between two touching rooms just merges them visually — the corridor becomes indistinguishable from the rooms and adds no meaningful separation. Use `-` (walled corridor) with doors if you want a distinct passage between adjacent rooms.

**Example grid:**
```
EEEGGGGGFFF
EEEGGGGGFFF
CCCGGGGGDDD
CCCGGGGGDDD
CCCBBBBBDDD
...BBBBB...
...BBBBB...
...BBBBB...
....AAA....
....AAA....
```

Each unique character (`A` through `G`) defines one room. Contiguous cells of the same character are flood-filled into a single room. A labeled character that appears in disconnected groups is an error.

### Legend

Maps grid characters to room labels. Appears after the grid.

```
legend:
  A: A1
  B: A2
  C: A3
  D: A4
  E: A5
  F: A6
  G: A7
```

**Rules:**
- Characters with labels (e.g., `A: A1`) render circled labels on the map. Labels should follow the format letter+number (e.g., A1, K10).
- Characters without labels (e.g., `n:`) are unlabeled corridors — they exist as rooms but get no visible label.
- Every non-reserved character that appears in the grid **must** have a legend entry. Missing entries cause an error (this catches typos).
- The reserved characters `.`, `-`, `#`, and `=` cannot appear as legend keys.
- Legend entries for characters that don't appear in the grid produce a warning but not an error.

### Doors

Declares doors and secret doors at specific grid coordinates.

```
doors:
  5,8: door
  3,4 west: door
  7,4 east: door
  1,2: secret
```

**Format:** `col,row: type` or `col,row direction: type`

- Coordinates are **col,row** (x,y) matching the visual grid. Column 0 is the left edge, row 0 is the top edge.
- Types: `door` (standard door) or `secret` (secret door).
- **Auto-detection:** When no direction is specified, the compiler finds which wall at that cell faces a different room. If exactly one wall qualifies, the door is placed there automatically.
- **Direction override:** If the cell has walls facing multiple different rooms, you must specify a direction (`north`, `south`, `east`, `west`) to disambiguate. The compiler will error with the list of candidate directions if this is needed.
- The compiler places the door on **both sides** of the wall automatically — you only declare it once.
- **Double doors:** When two doors of the same type are placed on adjacent cells sharing the same wall direction, the renderer automatically combines them into a single double door spanning both cells. No special syntax needed — just place two `door` (or two `secret`) entries side by side. This works for cardinal walls and diagonal walls alike.

**Double door example** (two doors on adjacent cells create one double door):
```
doors:
  12,31: door
  13,31: door
```
Cells (12,31) and (13,31) both have a door on the same wall — the renderer detects the adjacency and draws a single double door spanning both cells instead of two separate single doors. The two door entries must be the same type (`door`+`door` or `secret`+`secret`); mismatched types render as two separate doors.

### Trims

Adds diagonal or curved walls to room corners, cutting off a triangular section. An optional size controls how many cells the trim spans, and an optional `r` suffix makes it rounded (quarter-circle arc) instead of straight.

```
trims:
  K7: nw
  K8: ne2
  K9: sw, se
  K10: nw3r
  K11: nw3ri
```

**Format:** `label: trim, trim, ...` where each trim is `corner[N][r|ri]`.

- References room labels from the legend (not grid characters).
- Valid corners: `nw`, `ne`, `sw`, `se`.
- **Size** (optional): Number of cells the trim spans. Default is 1.
  - `nw` or `nw1` — single-cell diagonal (cuts one corner cell)
  - `nw2` — two-cell diagonal, voids 1 cell and places 2 diagonal walls
  - `nw3` — three-cell diagonal, voids 3 cells and places 3 diagonal walls
- **Rounded** (optional): Append `r` or `ri` to make the trim a quarter-circle arc instead of a straight diagonal.
  - `r` — **Convex** (default rounded). The arc bows toward the corner, rounding it off. Use this for circular towers and rounded room shapes.
  - `ri` — **Inverted/concave**. The arc bows away from the corner, eating into the room. Use this for alcoves or scalloped edges.
  - `nw3r` — convex rounded three-cell trim (corner is rounded off outward)
  - `nw3ri` — inverted rounded three-cell trim (arc cuts into the room)
  - Apply `r` to all 4 corners with matching size to create a circular tower (e.g., `nw4r, ne4r, sw4r, se4r` on an 8×8 room)
- Size-1 trims replace the two straight walls at the bounding-box corner with a single diagonal (or arc if `r`/`ri` is used).
- Larger trims void all cells inside the triangle and place walls along the hypotenuse.
- A room can have multiple trimmed corners (comma-separated). You can mix straight, rounded, and inverted trims on the same room.
- Trims must not overlap — two trims on the same room cannot affect the same cell.
- Trim cells that are already void (`.`) or out of bounds are silently skipped — only cells belonging to a different room cause an error. This means you can apply trims to rooms that don't fill their full bounding-box corners.

### Stairs

Declares stair icons on the map. Stairs can reference explicit grid coordinates or room labels (auto-placed). They can be standalone visual markers or linked pairs that connect two cells for reachability validation.

```
stairs:
  4,2: down                        # explicit coordinate, standalone
  8,6: up                          # explicit coordinate, standalone
  2,0: down - 10,8: up             # explicit coordinates, linked pair
  A1: up - L2:B1: down             # room-relative, cross-level linked
  A1: up - B1: down                # room-relative, same-level linked
  A1: up                           # room-relative, standalone
  A1: up - L2:8,1: down            # mixed: one room-relative, one explicit
```

#### Explicit Coordinate Syntax

**Standalone:** `col,row: type`

Places a stair icon on the cell. Visual only — the reachability checker does not treat it as a passage.

**Linked:** `col,row: type - col,row: type`

Places stair icons on both cells and creates a bidirectional connection between them. The reachability checker treats the two cells as connected, so rooms that are only accessible via stairs won't trigger an "unreachable" warning.

**Cross-level linked (multi-level maps only):** `col,row: type - L#:col,row: type`

Links stairs across levels. The `L#:` prefix specifies which level the linked end belongs to (L1, L2, L3, etc.). Both coordinates are relative to their respective level's grid. See the [Levels](#levels) section for details.

```
stairs:
  8,10: up - L2:8,10: down
```

This places stairs-up at (8,10) in the current level and stairs-down at (8,10) in Level 2.

#### Room-Relative Syntax

**Format:** `RoomLabel: type` (standalone) or `RoomLabel: type - RoomLabel: type` (linked)

Instead of specifying exact coordinates, reference a room label from the legend. The compiler automatically finds a suitable cell near the room's center, avoiding diagonal trim cells and existing labels/stairs.

```
stairs:
  A1: up - L2:B1: down
```

This places stairs-up somewhere in room A1 (current level) and stairs-down somewhere in room B1 (Level 2), with both auto-placed at optimal positions.

**Auto-placement algorithm:** Finds the cell closest to the room's centroid that (1) has no diagonal border from a trim, (2) has no existing label or stair, and (3) is within the room's boundary.

**Cross-level alignment:** When room-relative stairs link across levels, the compiler tries to place the linked side at the same level-relative position as the resolved side — so the stairwell occupies the same physical column in the building. If that cell is invalid (trimmed, occupied, or outside the room), it falls back to centroid placement. This also works for mixed pairs: if one side is explicit and the other room-relative, the auto side tries to match the explicit side's position.

**Mixing formats:** You can mix explicit coordinates and room-relative references in the same linked pair:

```
stairs:
  A1: up - L2:3,2: down            # left side auto-placed, right side explicit
  3,2: up - L2:B1: down            # left side explicit, right side auto-placed
```

#### When to Use Each Format

- **Explicit coordinates** — When you need exact control over placement.
- **Room-relative** — When trim resilience matters. Changing a trim size (e.g., `se3r` to `se5r`) can invalidate explicit stair coordinates that fall on newly trimmed cells. Room-relative stairs automatically dodge trim cells and align across levels, so they survive trim changes without manual adjustment.

#### Rules

- Coordinates are **col,row** (x,y), same convention as doors.
- Types: `up` (stairs leading up) or `down` (stairs leading down).
- Stairs render as a stepped icon with a directional arrow.
- A cell **cannot have both stairs and a room label** — they overlap visually. Place stairs on an adjacent unlabeled cell within the same room.
- Stairs **cannot be placed on diagonal trim cells** (hypotenuse cells from trims). The compiler will error if explicit coordinates land on a trim diagonal. Room-relative stairs automatically avoid these cells.

### Fills

Assigns visual fill patterns to rooms, rendered as subtle overlays on the room floor.

```
fills:
  A3: pit
  A5: difficult-terrain
```

**Format:** `roomLabel: fillType`

| Fill Type | Rendering | Use Case |
|---|---|---|
| `pit` | Dark filled floor | Pits, chasms, bottomless drops |
| `difficult-terrain` | Diagonal cross-hatching (thin lines, very subtle) | Rubble, overgrown areas, rough ground |
| `water` | Water depth shading — shallow/medium/deep layers using the theme's water color palette | Lakes, rivers, ocean tiles, flooded rooms |

- References room labels from the legend (same as trims).
- Fill patterns render after the floor color but before grid lines and walls — they appear as a background indicator.
- Fills are visible in the editor via the Properties panel (select a cell to change its fill).

### Props (Furniture & Objects)

Props are furniture and objects that can be placed on map cells via the editor or automation API. Props are defined as `.prop` files in `src/props/` — drop a new file there and add its name to `manifest.json` to extend the catalog.

**Available props:** pillar, table, bed, throne, bookshelf, chair, chest, barrel, sarcophagus, altar, statue, well, brazier, rubble.

#### `.prop` File Format

```
name: Pillar
category: Structure
footprint: 1x1
facing: no
---
circle 0.5,0.5 0.35 fill
circle 0.5,0.5 0.35 stroke
```

**Header** (key-value pairs before `---`):
- `name`: Display name
- `category`: Grouping for the explorer panel (Structure, Furniture, Containers, Features)
- `footprint`: `WxH` in cells (e.g., `1x1`, `2x1`, `2x2`)
- `facing`: `yes` or `no` — whether rotation is meaningful

**Body** (after `---`): Draw commands using normalized coordinates (0-1 per cell).

| Command | Syntax | Example |
|---|---|---|
| `rect` | `x,y w,h [fill\|stroke] [opacity]` | `rect 0.1,0.1 0.8,0.8 fill 0.3` |
| `circle` | `cx,cy radius [fill\|stroke] [opacity]` | `circle 0.5,0.5 0.4 stroke` |
| `ellipse` | `cx,cy rx,ry [fill\|stroke] [opacity]` | `ellipse 0.5,0.5 0.4,0.25 fill` |
| `line` | `x1,y1 x2,y2 [stroke] [opacity]` | `line 0.2,0.2 0.8,0.8 stroke` |
| `poly` | `x1,y1 x2,y2 x3,y3... [fill\|stroke] [opacity]` | `poly 0.5,0.1 0.9,0.9 0.1,0.9 fill` |
| `arc` | `cx,cy radius startAngle endAngle [fill\|stroke] [opacity]` | `arc 0.5,0.5 0.4 0 180 stroke` |

Colors are theme-derived (wallStroke for stroke, semi-transparent wallStroke for fill). Coordinates rotate automatically with the prop's facing.

#### Editor Usage

- Select a prop from the **Prop Explorer** panel (right side) to activate the prop tool in place mode
- **R** key: rotate 90° clockwise, **F** key: flip 180°
- **Tab** key: toggle between Place and Select sub-modes
- **Select mode**: click props or drag a bounding box to select, then R/Delete to manipulate

#### Adding New Props

1. Create a `yourprop.prop` file in `src/props/`
2. Add `"yourprop"` to `src/props/manifest.json`
3. Refresh the editor — the new prop appears in the explorer

---

## Themes

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

Custom themes can be passed as an object with color properties instead of a preset name. In `.map` files, use `themeOverrides` to customize individual colors (see Header section).

### Theme Color Properties

| Property | Description |
|---|---|
| `background` | Canvas background color |
| `gridLine` | Grid line color |
| `wallStroke` | Wall outline color |
| `wallFill` | Room floor fill color |
| `textColor` | Text color for labels, titles, scale |
| `borderColor` | Decorative border color |
| `doorFill` | Door rectangle fill color |
| `doorStroke` | Door rectangle outline color |
| `trapColor` | Trap indicator color |
| `secretDoorColor` | Secret door "S" color |
| `compassRoseFill` | Compass rose fill color |
| `compassRoseStroke` | Compass rose outline color |

---

## Sizing Rooms for Combat

Every room that will have a combat encounter must be large enough for the combatants to fight tactically. Size rooms based on what's in them.

### Creature Space Requirements

| Size | Space | Grid Squares (5 ft) |
|---|---|---|
| Medium (humanoid, skeleton, zombie) | 5x5 ft | 1x1 |
| Large (ogre, dire wolf, warhorse) | 10x10 ft | 2x2 |
| Huge (giant, treant, young dragon) | 15x15 ft | 3x3 |
| Gargantuan (ancient dragon, kraken) | 20x20 ft | 4x4 |

### Minimum Room Sizing

Count the total occupied space, then **add tactical breathing room** — space for movement, flanking, kiting, cover, and terrain features.

**Formula:** Total creature squares + 50-100% extra space for movement.

**Examples:**
- 4 PCs vs 4 medium enemies = 8 squares occupied -> minimum 16 squares (e.g. 20x20 ft, 15x30 ft, or an L-shape)
- 4 PCs vs 1 Large boss + 3 medium minions = 4 + 4 + 3 = 11 squares -> minimum 25 squares
- 4 PCs vs 1 Huge creature = 4 + 9 = 13 squares -> minimum 36 squares

Rooms don't need to be square — a long rectangle, L-shape, or any layout works as long as the total area meets the minimum. Shape the room to suit the encounter: a narrow hall favors chokepoint tactics, an L-shape creates corners for ambushes, a wide chamber allows flanking.

**Non-combat rooms** can be smaller — a 2x2 (10x10 ft) closet or a 3x2 (15x10 ft) antechamber is fine for atmosphere, loot, or puzzle rooms.

---

## Room Numbering

Number ALL spaces (rooms and corridors) in **exploration order from the entrance**, not by spatial position on the map.

### Rules

1. **A1 is always the entrance** — the first room players enter
2. **Number sequentially along the main path** — A1, A2, A3... following the most likely route
3. **Include corridors in the numbering** — corridors are numbered spaces just like rooms. A corridor connecting A1 to A5 might be A13 if it comes after all major rooms in exploration order
4. **Branch rooms get the next available number** when the branch is encountered — if the main path goes A1 -> A2 -> A3 and A2 has a side door, the side room is A4 (or wherever it falls in sequence)
5. **Secret/optional spaces get the highest numbers** — a hidden room behind the boss chamber should be the last numbered space on that branch, since players may never find it
6. **Dead-end branches before continuing rooms** — when two doors lead from a room, number the dead-end branch first, then continue the main path
7. **Corridors typically get higher numbers** — number all main rooms first, then assign numbers to connecting corridors in the order they're encountered

### Examples

**Example 1: Traditional sequential numbering**
```
Entrance -> Hall -> [branches to Armory (dead end) and Corridor]
                   Corridor -> Boss Room -> [secret door to Vault]

Numbering: A1 (Entrance) -> A2 (Hall) -> A3 (Armory) -> A4 (Corridor) -> A5 (Boss Room) -> A6 (Vault)
```

**Example 2: Rooms first, then corridors (recommended for complex maps)**
```
Entry Hall -> Corridor -> Living Room -> Corridor -> Kitchen
         |                    |
    Coat Closet          Dining Room

Numbering:
- A1 (Entry Hall)
- A2 (Coat Closet)
- A3 (Living Room)
- A4 (Dining Room)
- A5 (Kitchen)
- A6 (Corridor between Entry and Living)
- A7 (Corridor between Living and Kitchen)
```

This approach keeps related rooms grouped numerically and makes corridor references clearer.

---

## Levels

Multi-level dungeons (towers, multi-floor buildings, stacked cave systems) use `=== Level Name ===` markers to define separate floors in one `.map` file. Each level has its own grid, legend, doors, trims, and stairs — all with coordinates relative to that level. The compiler builds each level independently and combines them into one output image with automatic void separation.

### Level Syntax

Place a `=== Name ===` marker before each level's content. The global header (`---` block) comes first and applies to the entire map.

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

doors:
  4,0 east: door

stairs:
  8,1: up - L2:8,1: down

=== Upper Floor ===

CCCCCDDDDDD
CCCCCDDDDD

legend:
  C: B1
  D: B2

doors:
  4,0 east: door
```

### Key Rules

- **Levels are numbered implicitly**: The first `===` section is L1, the second is L2, etc. The name after `===` is for documentation.
- **Coordinates are level-relative**: Row 0 is always the top of that level's grid. No absolute coordinate math needed.
- **Characters can be reused across levels**: Each level has its own legend. Level 1 can use character `A` for room A1, and Level 2 can reuse `A` for room B1.
- **Room labels must be unique across all levels**: The compiler errors if two levels define the same label (e.g., both having `A1`).
- **Void separation is automatic**: The compiler inserts one void row between each level in the output — you don't need to add void rows manually.

### Cross-Level Stairs

Use the `L#:` prefix to link stairs across levels. Both explicit coordinates and room-relative labels work:

```
stairs:
  8,1: up - L2:8,1: down           # explicit coordinates on both sides
  A1: up - L2:B1: down             # room-relative on both sides
  A1: up - L2:8,1: down            # mixed: room-relative + explicit
```

Coordinates are relative to their own level's grid. Room-relative labels reference that level's legend. The reachability checker treats linked cells as connected.

**Design tip**: Place stairs-up and stairs-down in different quadrants across levels to force players to explore each floor before reaching the next staircase. Use explicit coordinates when stairwells need to align visually across floors; use room-relative labels when trim resilience is more important.

### Labeling Convention

Use a different letter prefix per level to keep room references unambiguous in adventure text:

- **Level 1 rooms:** A1, A2, A3, etc.
- **Level 2 rooms:** B1, B2, B3, etc.
- **Level 3 rooms:** C1, C2, C3, etc.

### Backward Compatibility

Files without `===` markers are parsed as single-level maps using the original format. No changes needed for existing maps.

---

## Compiler Output

When compiling a `.map` file, the compiler prints a summary of what it processed. This output helps debug layout issues and understand what the compiler did.

**Per-trim detail report:** For each trim applied, the compiler shows which cells were voided and which became hypotenuse (diagonal border) cells:

```
  20 diagonal trim(s) applied (40 cell(s) voided)
    A1:se5r — voided 10, hypotenuse at (11,7) (10,8) (9,9) (8,10) (7,11)
    A2:sw5r — voided 10, hypotenuse at (0,7) (1,8) (2,9) (3,10) (4,11)
    A3:nw5r — voided 10, hypotenuse at (0,4) (1,3) (2,2) (3,1) (4,0)
    A3:ne5r — voided 10, hypotenuse at (11,4) (10,3) (9,2) (8,1) (7,0)
```

The hypotenuse coordinates use `(col,row)` convention matching `.map` file coordinates. These are the cells where stairs and labels cannot be placed — useful for choosing explicit stair coordinates or understanding why a room-relative placement landed where it did.

---

## Workflow

1. **Sketch the dungeon layout** — decide room count, connections, and which rooms have combat. Size combat rooms using the creature space requirements above.
2. **Draw the ASCII grid** in a `.map` file. Use unique characters for each room, `.` for void, `#` or `-` for walled corridors, `=` for open corridors. Pad all rows to the same length.
3. **Add the legend** mapping each grid character to a room label (e.g., `A: A1`). Use empty labels for unlabeled corridors (e.g., `n:`).
4. **Add doors** at wall coordinates. Use `col,row: door` for unambiguous walls, or `col,row direction: door` when a cell borders multiple rooms.
5. **Add trims** if you want diagonal corners on any rooms.
6. **Add stairs** if any rooms connect to another floor (`col,row: up` or `col,row: down`).
7. **Add fills** for pit or difficult terrain rooms (e.g., `A3: pit`).
8. **Build:** `node build_map.js <name>.map`
9. **Inspect the output** and iterate. Use `--watch` for auto-rebuild on save, `--check` for fast validation.

---

## Validation

The compiler validates the `.map` file before producing JSON and gives specific error messages.

| Error | Cause | Fix |
|---|---|---|
| `Missing header (delimit with --- lines)` | No `---` delimiters found | Wrap header fields between two `---` lines |
| `Header missing "name"` | No `name` field in header | Add `name: Your Dungeon Name` to the header |
| `Header missing "theme"` | No `theme` field in header | Add `theme: stone-dungeon` (or another preset) |
| `Character 'X' appears in grid but is not in legend` | Grid uses a character with no legend entry | Add the character to the legend, or replace it with `.` if it was a typo |
| `Legend cannot map reserved character '.'` | Used `.`, `-`, `#`, or `=` as a legend key | Use a different character in the grid |
| `Character 'X' has disconnected cells` | Same labeled character appears in two separate groups | Make the cells contiguous or use different characters for each group |
| `Door at col,row: out of bounds` | Door coordinates outside the grid | Check col,row values (col is x, row is y) |
| `Door at col,row: cell is void` | Door placed on a `.` cell | Move the door to an adjacent non-void cell |
| `Door at col,row: no wall facing another room` | Cell only borders void or its own room | Place the door on a cell that shares a wall with a different room |
| `Door at col,row: ambiguous` | Cell has walls facing multiple different rooms | Add a direction: `col,row north: door` |
| `Door at col,row direction: neighbor is the same room` | Direction points at a cell in the same room | Change the direction to face the intended neighboring room |
| `Trim references unknown room label` | Trim uses a label not found in the legend | Check the label matches a legend value exactly |
| `invalid trim 'xx'` | Invalid corner name or syntax in trims | Use `nw`, `ne`, `sw`, or `se`, optionally followed by a size (e.g. `nw2`) |
| `trim extends beyond the room at cell` | Trim size too large for the room | Reduce the trim size or enlarge the room so all affected cells are part of it |
| `trim overlaps with another trim at cell` | Two trims on the same room affect the same cell | Reduce trim sizes so they don't overlap |
| `Unreachable rooms from X` | Labeled room has no path to the first room | Add doors or corridors to connect isolated rooms |
| `Stairs at col,row: out of bounds` | Stair coordinates outside the grid | Check col,row values (col is x, row is y) |
| `Stairs at col,row: cell is void` | Stairs placed on a `.` cell | Move stairs to a non-void cell |
| `Stairs at col,row: cell already has label` | Stairs and room label overlap visually | Place stairs on an adjacent unlabeled cell in the same room |
| `Stairs at col,row: cell has a diagonal border from a trim` | Explicit stair coordinates land on a hypotenuse cell from a trim | Move the stair to a non-trimmed cell, or use room-relative syntax (`RoomLabel: up`) to auto-place |
| `Stairs reference unknown room label: "X"` | Room-relative stair uses a label not found in the legend | Check that the label matches a legend value exactly |
| `Stairs in room "X": no valid cell` | All cells in the room have diagonals or existing content | Enlarge the room or reduce trims to free up a non-diagonal cell |

---

## Common Mistakes

### Duplicate Grid Characters for Separate Rooms

**Problem:** Using the same character for two rooms that aren't connected causes a "disconnected cells" error.

Wrong:
```
AAA...AAA
```
The two groups of `A` aren't contiguous — the compiler rejects this.

**Fix:** Use different characters for distinct rooms:
```
AAA...BBB
```

### Missing Legend Entries

**Problem:** A character appears in the grid but has no legend entry. This is usually a typo.

Wrong:
```
AABBA
```
If `B` isn't in the legend, the compiler errors. This catches cases where you accidentally typed the wrong character.

**Fix:** Add the character to the legend:
```
legend:
  A: A1
  B: A2
```

### Row Length Mismatches

**Problem:** Grid rows have different lengths, making column coordinates unreliable.

Wrong:
```
AAABBB
AAA
```

**Fix:** Pad shorter rows with `.` to match the longest row:
```
AAABBB
AAA...
```

The compiler auto-pads rows, but relying on this makes column-based door coordinates harder to reason about. Always pad explicitly.

### Doors Pointing at Void

**Problem:** Placing a door on a cell that only borders void or its own room.

Wrong (door at 2,0 when north is out of bounds and east/west are the same room):
```
AAA
```
```
doors:
  2,0: door
```

**Fix:** Doors must be placed on cells that share a wall with a different room. Move the door to a boundary cell between two rooms.

### Wrong Coordinate Order

**Problem:** Using row,col instead of col,row for door coordinates.

The door format is `col,row` (x,y), matching the visual grid where column is the horizontal position and row is the vertical position. Column 0 is the leftmost character, row 0 is the topmost line.

### Ambiguous Door Placement

**Problem:** A cell borders multiple different rooms and the compiler can't determine which wall to place the door on.

**Fix:** Add a direction to disambiguate:
```
doors:
  3,4 west: door
```

---

## Examples

Example maps are in the `examples/` directory. See [examples/examples.md](examples/examples.md) for detailed documentation of what each map demonstrates.

| Example | Key Features |
|---|---|
| `island` | Water fills, large rounded arc trims, 40+ props, point lights, per-cell textures, custom theme |

Build the example:
```bash
node build_map.js examples/island.map
```

Or render the pre-compiled JSON:
```bash
node generate_dungeon.js examples/island.json
```

---

## Visual Editor & Automation API

For maps that need fine-grained visual tweaking beyond what the `.map` format supports, or for AI-assisted map editing, the project includes a browser-based WYSIWYG editor with a programmatic automation API.

### Interactive Editor

```bash
npm start
# Open http://localhost:3000/editor/ in a browser
```

The editor provides 14 tools (Room, Paint, Wall, Door, Label, Stairs, Trim, Select, Prop, Light, Fill, Erase, Border, Bridge) with full undo/redo, pan/zoom, and multi-level support. Maps are saved and loaded as the same JSON format used by the renderer.

### Automation API (for Claude / Puppeteer)

The editor exposes a programmatic API that allows Claude to create and modify maps via Puppeteer without simulating mouse events. See **[src/editor/CLAUDE.md](src/editor/CLAUDE.md)** for the full command reference and usage guide.

```bash
# Install puppeteer (one-time)
cd dungeon && npm install

# Create a map programmatically
node puppeteer-bridge.js \
  --commands '[["newMap","My Dungeon",20,30],["createRoom",2,2,8,12],["setDoor",5,12,"east"]]' \
  --screenshot output.png --save output.json

# Edit an existing map
node puppeteer-bridge.js \
  --load output.json \
  --commands '[["createRoom",10,5,15,10,"merge"]]' \
  --screenshot updated.png --save output.json
```

The API reuses the editor's internal tool logic (room auto-walling, trim arc calculations) so programmatic edits are identical to manual ones.
