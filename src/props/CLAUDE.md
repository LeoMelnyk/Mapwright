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
placement: wall|corner|center|floor|any
room_types: comma, separated, room, types
typical_count: single|few|many
clusters_with: other-prop, another-prop
notes: Free-text placement guidance for Claude
---
# Comment describing visual group
shape x,y w,h style
```

The YAML header is separated from draw commands by `---`. Comments start with `#`.

### Placement Metadata

Every prop includes placement metadata that guides the AI during map generation:

| Field | Values | Purpose |
|-------|--------|---------|
| `placement` | `wall`, `corner`, `center`, `floor`, `any` | Where the prop typically goes in a room |
| `room_types` | comma-separated tags | Which room types this prop belongs in (e.g. `library, study, wizard-sanctum`) |
| `typical_count` | `single`, `few`, `many` | How many per room is typical |
| `clusters_with` | comma-separated prop names | What other props it commonly groups with |
| `notes` | free text | Placement guidance and tips |

**Placement conventions:**
- `wall` — prop is placed against a wall (bookshelf, weapon-rack, torch-sconce). For `facing: yes` wall props, the front faces south at rotation 0; `fillWallWithProps` auto-computes rotation per wall.
- `corner` — best in room corners (pillar, pillar-corner, ward-stone)
- `center` — room centerpiece (table, fountain, magic-circle, throne)
- `floor` — anywhere on the floor (rubble, mushroom, bone-pile, chair)
- `any` — no strong preference

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
rect x,y w,h               — Rectangle at (x,y) with width w, height h
circle cx,cy r              — Circle centered at (cx,cy) with radius r
ellipse cx,cy rx,ry         — Ellipse centered at (cx,cy) with x-radius rx, y-radius ry
poly x1,y1 x2,y2 ...       — Polygon with 3+ vertices (auto-closed)
line x1,y1 x2,y2           — Line segment from (x1,y1) to (x2,y2)
arc cx,cy r start end       — Arc/wedge centered at (cx,cy), angles in degrees
ring cx,cy outerR innerR    — Donut/annulus shape (transparent hole in center)
ering cx,cy outerRx,outerRy innerRx,innerRy — Elliptical ring/donut (non-circular annulus)
bezier x1,y1 cp1x,cp1y cp2x,cp2y x2,y2 — Cubic bezier curve (2 control points)
qbezier x1,y1 cpx,cpy x2,y2 — Quadratic bezier curve (1 control point)
cutout circle cx,cy r       — Punch a transparent hole (erases all pixels beneath)
cutout rect x,y w,h         — Punch a rectangular transparent hole
cutout ellipse cx,cy rx,ry  — Punch an elliptical transparent hole
clip-begin circle cx,cy r   — Start clipping region (only content inside is visible)
clip-begin rect x,y w,h     — Start rectangular clipping region
clip-begin ellipse cx,cy rx,ry — Start elliptical clipping region
clip-end                     — End clipping region (restore previous state)
```

### Hitbox & Selection Commands

Props automatically get a convex-hull hitbox generated from their draw commands at load time. This auto-hitbox is used for both mouse click detection and light occlusion. Manual overrides are available for props that need more accurate shapes:

```
hitbox rect x,y w,h         — Lighting occlusion rectangle
hitbox circle cx,cy r        — Lighting occlusion circle
hitbox poly x1,y1 x2,y2 ... — Lighting occlusion polygon (3+ vertices, auto-closed)
selection rect x,y w,h      — Mouse click detection rectangle
selection circle cx,cy r     — Mouse click detection circle
selection poly x1,y1 x2,y2 ...  — Mouse click detection polygon
```

**How hitboxes work:**

| Purpose | Priority | Fallback |
|---------|----------|----------|
| **Light occlusion** (`blocks_light: yes`) | Manual `hitbox` commands | Auto-generated convex hull |
| **Mouse click detection** | Manual `selection` commands | Auto-generated convex hull |

- **Auto-generated hitbox:** At load time, all draw commands are rasterized to a 32px-per-cell grid, the boundary is traced via Moore neighborhood contour, and the convex hull is computed and simplified with Douglas-Peucker. This produces ~6-20 vertex polygons.
- **Manual `hitbox`:** Overrides auto-hitbox for **lighting only**. Use when the auto-hull is too loose (e.g. an L-shaped prop that shouldn't cast shadow from its concavity). Multiple hitbox commands are combined into one shape.
- **Manual `selection`:** Overrides auto-hitbox for **click detection only**. Use when the clickable area should differ from the visual (e.g. a tree where only the trunk should be clickable, not the full canopy). Multiple selection commands are combined.
- **Rotation/scale:** Hitboxes are defined in prop-local coordinates (same as draw commands) and are automatically rotated, scaled, and flipped at placement time.

**When to add manual hitboxes:**

Most props work fine with auto-generated hitboxes. Add manual overrides when:
- The prop has concavities that create incorrect shadows (use `hitbox`)
- The clickable area should be much smaller than the visual (use `selection`)
- The prop extends significantly beyond its footprint and you want tighter bounds

**Examples:**
```
# Bookshelf — rectangular shadow is more accurate than the hull of all shelf details
hitbox rect 0.05,0.05 1.9,0.9

# Tree — only trunk should be clickable, but full canopy blocks light
hitbox circle 0.5,0.5 0.45
selection circle 0.5,0.5 0.15

# L-shaped forge — two rectangles for accurate shadow
hitbox rect 0.1,0.1 0.8,1.8
hitbox rect 0.1,0.1 1.8,0.8
```

### Styles (appended after shape)

```
fill [opacity]              — Fill with theme's wall color
fill #hexcolor [opacity]    — Fill with custom hex color
stroke                      — Stroke with theme's wall color
stroke #hexcolor            — Stroke with custom hex color
texfill textureId [opacity] — Fill with a texture image
gradient-radial #start #end [opacity] — Radial gradient fill (center to edge)
gradient-linear #start #end [opacity] [angle N] — Linear gradient fill (default top-to-bottom)
```

If opacity is omitted, it defaults to 1.0.

### Modifiers (appended after style)

```
width N                     — Stroke line width in pixels (default: 2). Works on any shape with stroke.
rotate N                    — Rotate a rect by N degrees around its center. Only works on rect.
angle N                     — Direction for gradient-linear in degrees (0=top-to-bottom, 90=left-to-right).
```

Examples:
```
circle 0.5,0.5 0.3 stroke #ff0000 width 4    — thick red outline
rect 0.2,0.2 0.6,0.6 fill #8b6914 rotate 45  — diamond shape (rotated square)
line 0.1,0.5 0.9,0.5 stroke #555555 width 3   — thick iron bar
```

### Special Shapes

**Ring (donut):** Draws a filled annulus with a transparent center hole. Useful for life rings, wreaths, wheel rims.
```
ring 0.5,0.5 0.4 0.2 fill #cc2200 0.9       — red ring, outer r=0.4, inner r=0.2
ring 0.5,0.5 0.4 0.2 texfill polyhaven/rusty_metal 0.8
```

**Cutout (transparent eraser):** Punches a hole through everything drawn before it in the prop. The map floor/texture shows through. Use after drawing filled shapes to create windows, holes, or transparent centers.
```
circle 0.5,0.5 0.4 fill #cc2200 0.9   — draw red circle
cutout circle 0.5,0.5 0.2             — punch transparent hole in center
```

**Arc (wedge/pie slice):** With `fill` or `texfill`, draws a filled pie-slice wedge from center. With `stroke`, draws just the curved arc line. Angles are in degrees (0° = east/right, 90° = south/down).
```
arc 0.5,0.5 0.3 0 90 fill #ff0000 0.5        — filled quarter-circle wedge
arc 0.5,0.5 0.3 315 45 fill #ffffff 0.85      — filled wedge spanning NE
arc 0.5,0.5 0.3 0 360 stroke #666666          — full circle outline (same as circle stroke)
```

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
6. **Manually drawing drop shadows** — Do NOT add `# Shadow` ellipses or rects offset south of a prop. That's an oblique/isometric-view trick, not top-down. Set `shadow: yes` in the frontmatter and let the render pipeline draw a proper radial shadow under the prop.
7. **Footprint orientation mismatch** — A tall vertical prop (grandfather clock, broom handle, spinning wheel, curtain rail, standing stone) needs a tall footprint (`2x1`, `3x1`). A wide wall-mounted prop (shelf, tapestry, cupboard, sideboard) needs a wide footprint (`1x2`, `1x3`). Getting this wrong makes the validator emit hundreds of out-of-bounds warnings.

### Wall-Mounted Props

Props that lean against or hang on a wall (mirror, painting, weapon rack, shield rack, tapestry, banner, torch sconce) should have `facing: yes` and be drawn with:
- The wall attachment along the **north edge** (low Y)
- Only the top edge of the frame/rack visible from above
- Very minimal visual footprint (you can barely see a flat wall-hung object from above)

**Reference convention for flat wall-hung textiles (tapestry, banner, painting):**
- Brass/wooden rod (thin rect along the wall edge, widest element)
- Finial caps at rod ends (small brass circles)
- Thin fabric top edge strip just south of rod (only a few rows of pixels deep)
- Subtle drop-shadow rect south of the fabric strip indicating the drape hanging below out-of-view
- Do NOT draw the full fabric drape with tassels, pleats, emblem, bottom fringe — that's a side elevation

### Cabinet & Wardrobe Furniture

Large wall-parallel furniture (cupboard, wardrobe, sideboard, bookshelf, grandfather clock) seen from above shows ONLY the flat top:
- Crown molding / slight overhang at north (wall side)
- Wood grain on the flat top surface
- Slight trim or shadow line at south edge where the face panel begins below
- Items placed on top (jar, bowl, candlestick, books) are visible; doors, handles, keyholes, clock faces, pendulums, drawer pulls are on the SOUTH front face and are **hidden from the top-down view** — do not draw them

See `wardrobe.prop`, `bookshelf.prop`, and `component-shelf.prop` for the canonical implementation.

### Stacked / Elevated Furniture

Bunk beds, loft beds, and similar multi-tier furniture show only the UPPER tier from a top-down view — the lower tier is directly beneath and obscured. Signal the second level exists with:
- Tall corner posts that extend down past the upper tier
- Guard rail / safety rail along one edge (visible as a thick strip with spindles)
- Ladder rung ends protruding beyond the footprint
- Do NOT draw two stacked mattresses separated by a gap — that's a front elevation

### Vertical Wheels & Rods

Objects whose main feature is a vertically-oriented wheel, rod, or drum (spinning wheel, water wheel, cart wheel mounted upright, ceiling-hung curtain divider) show the element *edge-on* from above — as a thin ellipse or line, not a full circle. The wheel's diameter appears as the long axis of that ellipse; its thickness is the short axis. Supporting hardware (axle hub, upright posts, base plank) surrounds it. Side-on circle drawings read as a flat plate lying on the floor, which is wrong.

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

### Pattern: Transparent hole (life ring, window, keyhole)
```
# Draw the solid shape first
circle 0.5,0.5 0.4 fill #cc2200 0.9
circle 0.5,0.5 0.4 stroke #991100
# Punch transparent hole — map floor shows through
cutout circle 0.5,0.5 0.2
# Stroke the hole edge (drawn after cutout, so it's visible)
circle 0.5,0.5 0.2 stroke #991100
```

### Pattern: Ring/donut (single command alternative to cutout)
```
# Simpler than fill + cutout for basic donut shapes
ring 0.5,0.5 0.4 0.2 fill #cc2200 0.9
ring 0.5,0.5 0.4 0.2 stroke #991100
```

### Pattern: Filled wedge (pie slice, decorative panel)
```
# Filled quarter-circle wedge (0° to 90°)
arc 0.5,0.5 0.3 0 90 fill #ffffff 0.85
# Two opposing wedges (like life ring white panels)
arc 0.5,0.5 0.4 315 45 fill #ffffff 0.85
arc 0.5,0.5 0.4 135 225 fill #ffffff 0.85
```

### Pattern: Thick iron bands / heavy strokes
```
# Use width modifier for thick lines instead of faking with filled rects
line 0.1,0.3 0.9,0.3 stroke #555555 width 4
circle 0.5,0.5 0.3 stroke #daa520 width 3
```

### Pattern: Rotated rectangle (diamond, angled plank)
```
# 45° diamond shape
rect 0.2,0.2 0.6,0.6 fill #8b6914 0.7 rotate 45
# Angled wooden plank
rect 0.1,0.3 0.8,0.1 texfill polyhaven/dark_wood 0.85 rotate 15
```

### Pattern: Gradient glow (magical effects, fire, light sources)
```
# Radial glow — bright center fading to dark edges
circle 0.5,0.5 0.4 gradient-radial #ffcc00 #000000 0.6
# Linear gradient — top-down color transition
rect 0.1,0.1 0.8,0.8 gradient-linear #4422aa #000000 0.5
# Angled linear gradient (45° diagonal)
rect 0.1,0.1 0.8,0.8 gradient-linear #ff0000 #0000ff 0.7 angle 45
```

### Pattern: Bezier curves (organic shapes, scrollwork, tentacles)
```
# Cubic bezier — S-curve
bezier 0.1,0.5 0.3,0.1 0.7,0.9 0.9,0.5 stroke #5c3a1e width 3
# Quadratic bezier — simple arc
qbezier 0.2,0.8 0.5,0.2 0.8,0.8 stroke #4a2800 width 2
# Filled bezier shape (closes the path before filling)
bezier 0.2,0.5 0.3,0.2 0.7,0.2 0.8,0.5 fill #3a7a28 0.5
```

### Pattern: Elliptical ring (oval donut, decorative frames)
```
# Oval ring — like ring but with independent x/y radii
ering 0.5,0.5 0.4,0.3 0.3,0.2 fill #daa520 0.8
ering 0.5,0.5 0.4,0.3 0.3,0.2 stroke #8b6914
```

### Pattern: Clipping mask (shaped windows, partial reveals)
```
# Only draw inside a circular region
clip-begin circle 0.5,0.5 0.3
rect 0.0,0.0 1.0,1.0 texfill polyhaven/dark_wood 0.85
circle 0.5,0.5 0.1 fill #ffcc00 0.8
clip-end
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

## Minimum Visible Size Reference

At normal map zoom, very small details become invisible. Use this guide to avoid wasting draw commands on things that won't render visibly:

| Element | Minimum visible radius/size | Notes |
|---|---|---|
| Circle detail (fill) | r ≥ 0.03 | Below 0.03 it's a sub-pixel dot |
| Circle detail (stroke) | r ≥ 0.04 | Stroke circles need slightly more |
| Line length | ≥ 0.08 | Very short lines vanish |
| Fill opacity | ≥ 0.15 | Below 0.15 it's invisible against most backgrounds |
| Ember spark / tiny accent | r = 0.015–0.02 | Visible only at high zoom; don't rely on these for key details |
| Text-like detail (runes, cracks) | Use stroke width ≥ 2 | Default width is fine; width 1 can vanish |

**Rule of thumb:** If a detail is smaller than 0.03 radius or lower than 0.15 opacity, it's decorative at best and invisible at worst. Key visual identity should use elements ≥ 0.05 radius and ≥ 0.3 opacity.

## Updating the Manifest

After adding, removing, or renaming props, update the manifest:

```bash
node mapwright/tools/update-manifest.js
```

This scans all `.prop` files and regenerates `src/props/manifest.json` automatically.

## Validating Props

Run the bounds validator to check all props have coordinates within their declared footprint:

```bash
node mapwright/tools/validate-props.js              # Validate all props
node mapwright/tools/validate-props.js pillar.prop   # Validate specific prop
```

Output shows `✓` for valid props, `✗` with details for any out-of-bounds coordinates.

## Previewing Props

Use the editor API to render a single prop preview (requires the editor server running):

```bash
node tools/puppeteer-bridge.js \
  --commands '[["renderPropPreview", "pillar", {"scale": 256}]]'
```

Or preview raw prop text (useful during development):
```bash
node tools/puppeteer-bridge.js \
  --commands '[["renderPropPreview", "name: Test\nfootprint: 1x1\n---\ncircle 0.5,0.5 0.3 fill #ff0000", {"scale": 256}]]'
```

Returns `{ success, dataUrl, name, footprint, warnings }`.

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
- [ ] If `blocks_light: yes`, verify auto-hitbox is reasonable (enable Show Hitboxes in Debug panel)
- [ ] For complex shapes with `blocks_light: yes`, consider manual `hitbox` commands
- [ ] 10–25 draw commands (not too sparse, not too busy)
- [ ] Tested with Puppeteer screenshot at actual render scale
