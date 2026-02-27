# Prop Creation Guide

This guide covers everything needed to create or edit `.prop` files for the dungeon map editor.

## File Format

```yaml
name: Display Name
category: Category
footprint: AxB
facing: yes|no
shadow: yes|no
blocks_light: yes|no
---
# Comment describing visual group
shape x,y w,h style
```

The YAML header is separated from draw commands by `---`. Comments start with `#`.

## Coordinate System (CRITICAL)

**`footprint: AxB` means rows × cols.** This determines the coordinate space:

| Footprint | Rows | Cols | x range | y range | Shape |
|-----------|------|------|---------|---------|-------|
| `1x1` | 1 | 1 | 0–1 | 0–1 | Square |
| `1x2` | 1 | 2 | 0–2 | 0–1 | Wide rectangle |
| `2x1` | 2 | 1 | 0–1 | 0–2 | Tall rectangle |
| `2x2` | 2 | 2 | 0–2 | 0–2 | Large square |
| `1x3` | 1 | 3 | 0–3 | 0–1 | Very wide |
| `2x3` | 2 | 3 | 0–3 | 0–2 | Wide rectangle |
| `3x3` | 3 | 3 | 0–3 | 0–3 | Large square |

**x = columns (horizontal), y = rows (vertical).** The origin (0,0) is the **top-left** corner.

### Facing Direction

For `facing: yes` props, the **front faces south** (toward high Y) in the default 0° rotation. So:
- North (low Y) = back / wall side
- South (high Y) = front / room side
- The player approaches from the south

Wall-mounted props (mirror, painting, hearth, weapon rack, etc.) have their "wall side" at low Y (north) and their "room side" at high Y (south).

## Draw Commands

### Shapes

```
rect x,y w,h          — Rectangle at (x,y) with width w, height h
circle cx,cy r         — Circle centered at (cx,cy) with radius r
ellipse cx,cy rx,ry    — Ellipse centered at (cx,cy) with x-radius rx, y-radius ry
poly x1,y1 x2,y2 ...  — Polygon with 3+ vertices (auto-closed)
line x1,y1 x2,y2      — Line segment from (x1,y1) to (x2,y2)
arc cx,cy r start end  — Arc centered at (cx,cy), angles in radians
```

### Styles (appended after shape)

```
fill [opacity]              — Fill with theme's wall color
fill #hexcolor [opacity]    — Fill with custom hex color
stroke                      — Stroke with theme's wall color
stroke #hexcolor            — Stroke with custom hex color
texfill textureId [opacity] — Fill with a texture image
```

If opacity is omitted, it defaults to 1.0.

### Rendering Order

Commands render in file order (top to bottom). **Draw background/base layers first, details on top.** Common pattern:

```
# 1. Shadow or ground effect (if any)
# 2. Main body shape with texfill
# 3. Same shape with stroke (outline)
# 4. Inner details, highlights
# 5. Small accent details last
```

## Texture Reference

### Wood (use for furniture, frames, posts, handles)

| Texture ID | Look | Best for |
|---|---|---|
| `polyhaven/dark_wood` | Dark rich brown | Frames, posts, fine furniture, racks |
| `polyhaven/weathered_planks` | Pale weathered boards | Rough construction, crates, platforms |
| `polyhaven/worn_planks` | Mid-tone worn wood | Flooring, secondary surfaces |
| `polyhaven/brown_planks_09` | Warm brown planks | Alternative plank surface |
| `polyhaven/wood_table` | Smooth tabletop grain | Tables, desks, benches |
| `polyhaven/wood_cabinet_worn_long` | Cabinet grain | Cabinets, wardrobes |

### Stone (use for walls, pillars, pedestals, architecture)

| Texture ID | Look | Best for |
|---|---|---|
| `polyhaven/stone_wall` | Grey stone masonry | Walls, pillars, heavy structures |
| `polyhaven/granite_tile` | Light grey polished | Pedestals, bases, trim |
| `polyhaven/marble_01` | White/pale marble | Altars, statues, fine stone |
| `polyhaven/cobblestone_floor_01` | Rough cobble | Hearths, wells, fire pits |
| `polyhaven/stone_floor` | Flat stone | Inlays, floor sections |
| `polyhaven/rock_boulder_cracked` | Cracked natural rock | Boulders, rubble, stalagmites |
| `polyhaven/brick_4` | Red/brown brick | Ovens, forges, fireboxes |

### Metal (use for weapons, armor, iron fittings, cages)

| Texture ID | Look | Best for |
|---|---|---|
| `polyhaven/metal_plate` | Clean grey steel | Anvils, weapon blades, shields, clean metal |
| `polyhaven/metal_plate_02` | Slightly different plate | Locking bolts, fittings |
| `polyhaven/rusty_metal` | Brown rusty iron | Cauldrons, old iron, chains, cages |
| `polyhaven/rusty_metal_02` | Darker rust | Hinges, brackets, aged fittings |
| `polyhaven/metal_grate_rusty` | Open grate pattern | Grates, cage floors, drains |

**Warning:** `rusty_metal` looks brownish/woody at small scale. Use `metal_plate` for things that should read as clearly metallic (anvils, shields, clean weapons).

### Fabric & Organic

| Texture ID | Look | Best for |
|---|---|---|
| `polyhaven/rough_linen` | Coarse linen | Bedding, woven cloth, sacks |
| `polyhaven/velour_velvet` | Rich velvet | Tapestries, throne upholstery |
| `polyhaven/floral_jacquard` | Patterned fabric | Carpet inners, tapestry bands |
| `polyhaven/dirty_carpet` | Worn rug | Carpet/rug base layer |
| `polyhaven/brown_leather` | Tanned hide | Bellows, tanning rack hides |
| `polyhaven/brown_mud` | Brown dirt | Grave mounds, mud |

### Nature

| Texture ID | Look | Best for |
|---|---|---|
| `polyhaven/bark_brown_01` | Light bark | Branches, smaller wood |
| `polyhaven/bark_brown_02` | Dark bark | Tree trunks, logs |
| `polyhaven/forest_leaves_02` | Green foliage | Tree canopy |
| `polyhaven/volcanic_rock_tiles` | Dark volcanic rock | Lava pools (use with orange fill overlays) |

## Top-Down Perspective Rules

**ALL props must be drawn from a bird's eye (top-down) view.** Ask yourself: "If I were floating directly above this object looking straight down, what would I see?"

### What You See From Above

| Object type | Top-down appearance |
|---|---|
| Barrel | Circular lid with plank seams and metal bands |
| Table | Rectangular surface with leg shadows in corners |
| Chair | Seat with backrest as strip along north edge |
| Chest | Rectangular lid, hinge line, clasp |
| Pillar | Circular or square cross-section |
| Mirror/Painting | Thin frame edge along wall (almost invisible) |
| Fireplace/Hearth | U-shaped stone walls, fire pit, chimney hole |
| Weapon rack | Thin bar along wall with pommel circles poking up |
| Tree | Round canopy covering trunk |
| Gibbet | Post square, cage circle, arm beam |

### Common Mistakes to Avoid

1. **Side-view rendering** — Drawing a bookshelf with shelves visible, a mirror showing its glass face, or a portcullis showing bars hanging down. From above you see the TOP of things.
2. **Coordinate axis swap** — `footprint: 1x2` means x goes to 2, y goes to 1. Not the reverse.
3. **Exceeding footprint bounds** — All coordinates must stay within 0–cols (x) and 0–rows (y).
4. **Wrong facing direction** — Front faces south (high Y). Wall-mounted items have their wall at the north (low Y) edge.
5. **Using rusty_metal for clean metal** — It looks like wood at small scales. Use `metal_plate` instead.

### Wall-Mounted Props

Props that lean against or hang on a wall (mirror, painting, weapon rack, shield rack, tapestry, torch sconce) should have `facing: yes` and be drawn with:
- The wall attachment along the **north edge** (low Y)
- Only the top edge of the frame/rack visible from above
- Very minimal visual footprint (you can barely see a flat wall-hung object from above)

## Header Fields

### `shadow: yes|no`

Renders a soft radial gradient shadow behind the prop (makes it look elevated/3D). Use `yes` for:
- Furniture that sits on the floor (tables, chairs, barrels, chests)
- Structures with height (pillars, obelisks, posts)
- Heavy objects (anvils, cauldrons, statues)

Use `no` for:
- Flat floor items (carpets, magic circles, caltrops)
- Overhead items (chandeliers — shadow would be wrong)
- Wall-mounted items (mirrors, paintings, tapestries)
- Things at ground level (campfire, shackles, corpse)

### `blocks_light: yes|no`

Whether the prop blocks line-of-sight for future lighting calculations. Use `yes` for:
- Solid tall objects (pillars, columns, obelisks, statues)
- Thick structures (stone walls, vault doors, fireplaces)
- Tall furniture (bookshelves, wardrobes)
- Deep wells

Use `no` for:
- Low/flat items (carpets, caltrops, corpse)
- Open/thin items (weapon rack, brazier, table)
- Transparent items (portcullis, chain-wall)

### `facing: yes|no`

Whether the prop can be rotated when placed. Use `yes` for:
- Anything directional (chairs, beds, doors, fireplaces)
- Anything wall-mounted (mirrors, paintings, racks)
- Anything with a clear front/back

Use `no` for:
- Symmetrical objects (barrels, pillars, wells, tables)
- Random scatter (rubble, bone piles, caltrops)

## Common Color Palette

### Fire & Heat
```
#e85500  — deep orange flame
#ff6600  — bright orange
#ff8800  — amber
#ffaa00  — warm yellow-orange
#ffcc00  — bright yellow
#cc3300  — deep red glow
#1a0800  — charred/soot
#2a1500  — dark ember base
```

### Metal
```
#666666  — medium grey iron
#555555  — dark iron
#444444  — very dark iron
#333333  — near-black metal
#222222  — darkest metal (stroke outlines)
#8899aa  — blue-grey steel highlight
#667788  — subtle steel accent
#777777  — light grey metal
```

### Gold & Brass
```
#daa520  — gold
#ffd700  — bright gold
#8b6914  — dark gold / brass
#5a3a00  — dark brass stroke
```

### Wood (non-texture accents)
```
#3a1f00  — dark wood stroke
#2a1400  — very dark wood
#1a1208  — near-black wood
#4a2800  — medium dark wood
#5c3a1e  — warm brown stroke
#6b4e2e  — light brown
#8b7355  — pale wood/rope
```

### Bone & Skin
```
#e8dcc8  — bone white
#d4c4a8  — aged bone
#c8b898  — dark bone / thread
#d4a574  — skin tone
```

## Design Patterns

### Pattern: texfill + stroke (most common)
```
circle 0.5,0.5 0.35 texfill polyhaven/dark_wood 0.85
circle 0.5,0.5 0.35 stroke #3a1f00
```
Draw the shape twice — once with texture fill, once with outline. This gives definition at all zoom levels.

### Pattern: Layered fire glow
```
circle 0.5,0.5 0.3 fill #1a1a1a 0.4    — charred base
circle 0.5,0.5 0.2 fill #e85500 0.3     — outer glow
circle 0.5,0.5 0.12 fill #ffaa00 0.4    — inner glow
circle 0.5,0.5 0.06 fill #ffcc00 0.6    — hot center
```

### Pattern: Concentric rings (barrel, well, wheel)
```
circle 0.5,0.5 0.40 texfill texture 0.85  — outer surface
circle 0.5,0.5 0.40 stroke                 — outer edge
circle 0.5,0.5 0.32 stroke                 — inner detail ring
circle 0.5,0.5 0.24 texfill texture2 0.85  — inner surface
```

### Pattern: Table/furniture surface with leg shadows
```
rect 0.1,0.1 1.8,1.8 texfill polyhaven/wood_table 0.85
rect 0.1,0.1 1.8,1.8 stroke #5c3a1e
circle 0.22,0.22 0.06 fill #3a1f00 0.5    — leg shadow NW
circle 1.78,0.22 0.06 fill #3a1f00 0.5    — leg shadow NE
circle 0.22,1.78 0.06 fill #3a1f00 0.5    — leg shadow SW
circle 1.78,1.78 0.06 fill #3a1f00 0.5    — leg shadow SE
```

### Pattern: Wall-mounted prop (facing south)
```
# Frame top edge along north wall
rect 0.2,0.06 1.6,0.10 texfill polyhaven/dark_wood 0.9
rect 0.2,0.06 1.6,0.10 stroke #3a1f00
# Shadow below frame
rect 0.22,0.16 1.56,0.04 fill #000000 0.15
```

### Pattern: Two-board restraint (stocks/pillory)
```
# Top board (hinge side, north)
rect 0.2,0.3 1.6,0.15 texfill polyhaven/weathered_planks 0.85
# Bottom board (latch side, south)
rect 0.2,0.55 1.6,0.15 texfill polyhaven/weathered_planks 0.85
# Holes formed at the gap between boards
arc cx,0.45 r PI TWO_PI stroke    — top semi-circle
arc cx,0.55 r 0 PI stroke         — bottom semi-circle
circle cx,0.5 r fill #1a1a1a 0.35 — dark hole fill
# Gap line between boards
line 0.2,0.5 0.6,0.5 stroke #1a1a1a
```

## Prop Complexity Guidelines

| Footprint | Draw commands | Notes |
|---|---|---|
| 1x1 | 8–20 | Simple objects, don't over-detail |
| 1x2 | 12–25 | Room for detail across width |
| 2x1 | 12–25 | Tall props, directional detail |
| 2x2 | 15–30 | Large props, multiple visual features |
| 3x3 | 15–30 | Magic circles, patterns — use symmetry |

Keep texture opacity between **0.6–0.9** for fills (0.85 is the sweet spot). Lower opacity textures look washed out; 1.0 can look overpowering.

## Current Prop Count

There are **164 props** in the manifest across 20 categories: Alchemy, Combat, Containers, Decorative, Features, Furniture, Kitchen, Library & Study, Lighting, Magical, Misc, Nautical, Prison & Torture, Religious, Structure, Terrain, Traps, Undead & Dark, and Workshop.

### New Categories (added 2024-02)

| Category | Count | Props |
|---|---|---|
| **Alchemy** | 6 | alchemy-bench, alembic, crucible, ingredient-rack, mortar-pestle, specimen-jar |
| **Library & Study** | 4 | book-pile, globe, scroll-case, scroll-rack |
| **Lighting** | 5 | crystal-torch, floor-candelabra, lantern-post, signal-fire, wall-lantern |
| **Traps** | 5 | arrow-trap, bear-trap, pit-trap, pressure-plate, spike-trap |
| **Undead & Dark** | 5 | bone-throne, burial-urn, canopic-jar, necrotic-altar, zombie-pit |

### Additions to Existing Categories (2024-02)

| Category | New Props |
|---|---|
| Decorative | banner, display-case, flag-pole |
| Features | candle-cluster |
| Kitchen | chopping-block, kitchen-table, pot-rack, spice-shelf |
| Magical | arcane-pedestal, component-shelf, summoning-cage, ward-stone |
| Misc | birdcage, hourglass, notice-board, telescope |
| Nautical | binnacle, capstan, ships-hammock |
| Religious | censer, kneeling-bench, offering-plate, reliquary |
| Structure | chain-hoist, trophy-head |
| Workshop | workbench |

## Testing Props

Use the Puppeteer bridge to render and screenshot:

```bash
cd dungeon
# Place a single prop close-up
node puppeteer-bridge.js \
  --commands '[["newMap","Test",8,8],["createRoom",1,1,6,6],["placeProp",2,2,"prop-name"],["waitForTextures",3000]]' \
  --screenshot test.png

# Place many props in a showcase grid
node puppeteer-bridge.js \
  --commands '[["newMap","Showcase",30,40],["createRoom",1,1,28,38],["placeProp",2,2,"prop-a"],["placeProp",2,5,"prop-b"],...]' \
  --screenshot showcase.png
```

Always call `waitForTextures` before taking a screenshot to ensure textures have loaded.

## Quick Checklist for New Props

- [ ] Top-down perspective (bird's eye view, NOT side view)
- [ ] Coordinates within footprint bounds
- [ ] Facing direction correct (front = south = high Y)
- [ ] Appropriate texture chosen (metal_plate not rusty_metal for clean metal)
- [ ] texfill shapes have matching stroke for definition
- [ ] Comments grouping visual elements
- [ ] shadow/blocks_light set appropriately
- [ ] 10–25 draw commands (not too sparse, not too busy)
- [ ] Tested with Puppeteer screenshot at actual render scale
