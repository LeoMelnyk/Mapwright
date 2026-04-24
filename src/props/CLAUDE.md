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

Props have two independent hitboxes, serving different purposes:

| Command | Purpose | Required when |
|---|---|---|
| `hitbox` | **Light occlusion** — the polygon that casts a shadow | `blocks_light: yes` |
| `selection` | **Mouse click detection** — the polygon that registers clicks | Whenever the auto-hull is too loose (optional) |

**Rule (enforced by the validator):**
- `blocks_light: yes` → must define at least one `hitbox` command. The auto-hull is almost always too loose for accurate shadows on real furniture shapes.
- `blocks_light: no` → must not define any `hitbox` commands. `hitbox` is ignored by the renderer when the prop doesn't block light; if you want a custom click shape, use `selection` instead.

Both commands fall back to the same auto-generated convex hull when omitted.

```
hitbox rect x,y w,h [z bottom-top]         — Lighting occlusion rectangle
hitbox circle cx,cy r [z bottom-top]       — Lighting occlusion circle
hitbox poly x1,y1 x2,y2 ... [z bottom-top] — Lighting occlusion polygon (3+ vertices, auto-closed)
selection rect x,y w,h                     — Mouse click detection rectangle
selection circle cx,cy r                   — Mouse click detection circle
selection poly x1,y1 x2,y2 ...             — Mouse click detection polygon
```

**Z-zones (`z bottom-top`) — height range in feet.** Optional trailing `z 0-3` marks the hitbox as occluding light only between `bottom` and `top` feet of height. Used for props with tiered vertical profile — e.g. a devil's anvil whose waist is narrow (0–1.5ft) but whose top is wide (1.5–2.5ft):

```
hitbox rect 0.32,0.30 0.36,0.40 z 0-1.5   # narrow waist
hitbox rect 0.15,0.22 0.70,0.46 z 1.5-2.5 # wide top
```

Omit `z` on a hitbox and it occludes at **infinite height** (acts like a full wall). Set `zTop` to the prop's declared `height:` so shadow projection scales correctly. `zTop > height` or `zBottom > zTop` will fail validation.

**Auto-generated hitbox:** At load time, all draw commands are rasterized to a 32px-per-cell grid, the boundary is traced via Moore neighborhood contour, and the convex hull is computed and simplified with Douglas-Peucker. The auto-hull is used by both subsystems when the corresponding manual command is absent (hitbox for lighting, selection for clicks). Because it's a convex hull, it's frequently looser than the prop's visible silhouette — hence the requirement to define `hitbox` explicitly whenever the prop blocks light.

**Rotation/scale:** Hitboxes and selections are defined in prop-local coordinates (same as draw commands) and are automatically rotated, scaled, and flipped at placement time.

**Multiple commands:** You can emit several `hitbox` (or `selection`) lines; they combine into the union shape.

**When to add manual `selection`:** auto-hull covers more than the prop's real silhouette — e.g. a tree where clicking the canopy shouldn't select the trunk, or a banner whose flowing fabric extends past the hardware. When the visible prop fills its footprint tightly, the auto-hull is fine.

**Examples:**
```
# Bookshelf — blocks light; rectangular shadow is more accurate than the hull of all shelf details
hitbox rect 0.05,0.05 1.9,0.9 z 0-6

# Tree — canopy blocks light, but only the trunk should register clicks
hitbox circle 0.5,0.5 0.45 z 0-20
selection circle 0.5,0.5 0.15

# L-shaped forge — two rectangles for accurate shadow
hitbox rect 0.1,0.1 0.8,1.8 z 0-3
hitbox rect 0.1,0.1 1.8,0.8 z 0-3

# Floor-level decal — flat, doesn't block light, tight click region
# (blocks_light: no in header)
selection circle 0.5,0.5 0.28
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
7. **Footprint matches GROUND extent, not height** — The footprint is the cells the prop occupies on the floor, seen from above. It has nothing to do with how tall the object is. A 10-foot radially-symmetric pillar is `1x1` because its floor footprint is a single cell-wide circle; a grandfather clock is `2x1` because its base is rectangular (tall + narrow on the floor plane). Use `2x1` / `3x1` only for ground-footprints that are genuinely longer in one axis (pews, coffins, siege engines, clocks). Tall cylindrical/polygonal columns (pillars, obelisks, basalt columns, cloud pillars, flame pillars, pearl obelisks) use `1x1` or `2x2` — see "Columns, Pillars, Obelisks" below.
8. **Side-elevation for tall verticals** — The most common batch-7 mistake: an agent told to draw a "tall pillar of X" draws the pillar rising from the bottom of the footprint to the top (base at high-Y, tip at low-Y, shaft crossing the footprint vertically). That is a side view. Top-down, a tall column is just the circle/polygon you see looking straight down the shaft — decorate with radial spokes, a central highlight, an outer halo, but never with a visible "height."
9. **Building facade as a prop** — Drawing a "crypt entrance" or small building with block courses arrayed on a vertical wall, an arched doorway shown as a ∩ bulge, a keystone above the arch, or a cross carved into the front wall. Those are architectural elevations, not top-down. From straight above you see the ROOF of the building plus any structures that protrude upward or outward. See "Buildings & Structures" below.
10. **Granite plinths under floor props** — A stone rectangle texfilled beneath a prop to make it look "elevated" is a side-view convention. The renderer already draws a radial shadow under any prop with `shadow: yes`; a manually-drawn plinth just clutters the cell with a grey patch. Props sit directly on the map floor.

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

Objects whose main feature is a vertically-oriented wheel, rod, or drum (spinning wheel, water wheel, cart wheel mounted upright, ceiling-hung curtain divider, concert harp) show the element *edge-on* from above — as a thin ellipse or line, not a full circle. The wheel's diameter appears as the long axis of that ellipse; its thickness is the short axis. Supporting hardware (axle hub, upright posts, base plank) surrounds it. Side-on circle drawings read as a flat plate lying on the floor, which is wrong.

See `harp.prop` (2x1 concert harp drawn as a thin edge-on profile — soundbox ellipse at the south, narrow pillar spine running north, strings as parallel lines along the spine).

### Tilted-Face Props (Wheels / Targets / Boards on an Easel or Stand)

A vertical wheel, target, or signboard tilted slightly toward the viewer on a freestanding stand (archery target, wheel of fortune, easel-mounted painting, chalkboard) shows its face as a **foreshortened ellipse** — the originally-round or square face appears wider than tall because we're looking at it from above at an angle:

- Stand legs angled from the back (low Y) outward to the viewer side (high Y), with a cross-brace spanning between them
- Optional back kickstand leg for easels (a single rect running south along the centerline behind the face)
- Face drawn as a filled ellipse with `rx > ry` — a 57° tilt (like `archery-target.prop`) corresponds to a ratio around `rx=0.65, ry=0.35`
- Concentric rings, wheel wedges, text panels, dart boards, etc. drawn as nested ellipses inside — match the outer ellipse's rx:ry ratio
- For wheel wedges: compute 12 edge points on the ellipse at 30° intervals (`x = cx + rx*cos(θ)`, `y = cy - ry*sin(θ)` since screen y is inverted) and draw each wedge as a triangular `poly` from center to two adjacent edge points. Circular `arc` wedges won't match the ellipse shape.
- Spoke dividers: straight `line` from center to each ellipse edge point
- Pointer / ticker at the 12 o'clock position (top edge of the face, where the ellipse intersects its short axis) as a small triangular `poly`

See `archery-target.prop` (canonical tilted-face on a tripod stand) and `fortune-wheel.prop` (wheel on an easel with 12 polygon wedges + radial spoke lines).

Never draw the face as a perfect circle with circular `arc` wedges — that reads as a flat disc lying on the floor, not a vertical face viewed at an angle.

### Columns, Pillars, Obelisks, Flame Columns

Radially-symmetric tall structures (pillars, obelisks, cloud/flame/coral pillars, silver-cord pylons, basalt columns, pearl obelisks) use a **square** footprint — `1x1` for a plain column, `2x2` when the object has a wider pedestal or pyramidion that spans more than one cell. Draw:
- An outer radial halo or heat/mist aura (thin, faint — just establishes presence)
- The shaft cross-section as a filled circle or polygon (hexagon for basalt, circle for marble, square for obsidian obelisks)
- Radial details — fluting lines, runes, magma cracks, facet ridges — emanating from the center
- The very top / apex highlighted as a bright center dot (where the tip catches light)
- For obelisk-style tips: four triangular facets meeting at the center, each shaded differently to imply the pyramidion's 3D form (see `obelisk.prop` and `obelisk-astral.prop` — the canonical 2x2 pattern)

Never draw the column as a vertical shaft crossing the footprint top-to-bottom.

### Overhead-Hanging / Strung Props

Bunting lines, strung banners between posts, overhead chandeliers, strung paper lanterns — things suspended in the air above the floor. From above you see:
- The rope / chain / rod as a thin line running across the footprint
- The **top edges only** of any flags, lanterns, or pendants (small triangular tips, tiny color dots)
- A subtle diffuse drape shadow beneath the line, hinting at the mass hanging below out-of-view
- `shadow: no` (the overhead prop doesn't sit on the floor, so the radial floor-shadow doesn't fit)

Never draw full hanging flag triangles, complete chandelier silhouettes, or dangling paper-lantern shapes. See `bunting-line.prop` for the canonical overhead-line pattern.

### Stuck / Embedded Weapons

A sword or spear driven into the ground is *not* the weapon lying flat — only the part sticking up above the impact point is visible. Top-down:
- Dirt/blood splatter ring around the impact point
- Small dark impact slot where the blade/shaft enters the ground
- A short foreshortened stub of blade/shaft poking toward the viewer
- The widest element (crossguard, spear feather tuft, leather binding) as the most prominent shape near the top
- Pommel / tip of weapon as a small circle at the very end

See `arrow-stuck.prop` (canonical foreshortened arrow), `weapon-stuck.prop` (stuck sword with crossguard + pommel), `spear-stuck.prop` (feather tuft + binding).

### Cave Mouths / Tunnel Openings

A hole in a rock wall, seen from above. Draw the rock mass as an irregular boulder outline, then cut a dark elliptical hole on the opening side. **No depth gradient, no tapered wedge receding into the rock** — that's a side/oblique view. From directly above, the tunnel opening is just a pitch-black shape, because you can't see down a horizontal tunnel from a vertical viewpoint.

See `cave-mouth-small.prop`. Framing boulders around the mouth and scattered rubble spilling out help establish the scene without implying depth.

### Fire & Flame Columns

A burning column — bonfire, flame pillar, efreet brazier — seen from above is **concentric rings**, not a tall flame silhouette:
- Outer heat halo (faint orange, widest)
- Outer flame ring (bright orange, slightly ragged edge with small flame-tongue polys radiating outward)
- Mid flame ring (yellow-orange)
- Inner core (yellow-white)
- Hottest center (white/near-white, smallest)
- Optional: tiny dark soot specks for rising updraft, small bright spark embers

See `flame-pillar.prop`, `fire-node-core.prop`, `bonfire-large.prop` for the canonical concentric-ring pattern. The temptation to draw a pointed flame shape (wide base, narrow tip) is always a side-elevation trap.

### Tileable / Modular Props (Channels, Tracks, Rails, Countertops)

**Whenever you author a tileable prop, author the full set of variants.** A single straight section is only useful if the map is a straight line — real layouts need turns, branches, crossings, endcaps. The minimum useful set for a linear tileable prop is:

| Variant | Purpose |
|---|---|
| Straight (long, 1x3 or 1x4) | Fast coverage for long runs |
| Straight (short, 1x1) | Fine-grained control — slot between turns/junctions where a long piece won't fit |
| Turn (90°) | L-shape at one cell corner (rotate to face any corner) |
| T-junction | Branch off a straight run (rotate for any side) |
| X-junction | Four-way crossing |
| End-cap | Closed terminus (for counters, fences, rails that stop mid-room) |

**Ship both a long and short straight.** A 1x3 straight alone forces the DM into awkward gaps when a turn lands mid-cell — a 1x1 straight fills the last cell between a turn and a junction without overshooting. See `cart-track.prop` (1x3) paired with `cart-track-short.prop` (1x1); same for `sewage-channel.prop` / `sewage-channel-short.prop`.

Do NOT ship just "sewage-channel" (straight) and call it done — the DM building a sewer then has nothing to do at corners or intersections. A countertop without corner and endcap variants can only form straight runs. When you identify a new tileable concept, plan and deliver the whole set in one pass.

Props designed to tile into chains or grids — sewage channels, mine-cart tracks, fence rails, sconce lines, bar counters, workshop counters — must use **identical edge geometry** on every cell edge that may connect to another piece. Otherwise the joint shows a visible mismatch.

The reference straight piece (`sewage-channel.prop`, 1x3) establishes:
- Stone lip 0.12 thick on both long sides (`y=0.08–0.20` and `y=0.80–0.92`)
- Fluid band 0.60 wide in the middle (`y=0.20–0.80`)
- Open cell-floor strip 0.08 thick at each far edge (`y=0.00–0.08` and `y=0.92–1.00`)

Every junction variant (turn, T, X) must reproduce those positions on every cell edge that carries an opening. A T-junction's south branch exit at `y=1.00` must have fluid at `x=0.20–0.80`, stone at `x=0.08–0.20` and `x=0.80–0.92`, cell floor at `x=0.00–0.08` and `x=0.92–1.00`. The cart-track variants follow the same convention for rail positions.

**Draw the fluid as a single polygon**, not as two overlapping rects. Overlapping rects with `stroke` will each draw their own outline, and those strokes will cut visible lines across the fluid where the rects cross (a plus-sign of dark lines inside the X junction is the telltale bug). For a plus/T/L fluid shape, express the entire outline as one `poly` and stroke it once.

See `sewage-channel-turn.prop`, `sewage-channel-t.prop`, `sewage-channel-x.prop`, and the matching `cart-track-*` variants for the canonical implementations.

### Buildings & Structures (Huts, Crypts, Towers, Outbuildings)

Full-size building props (toll-houses, ferry cabins, mausoleums, gatehouses, dovecotes) are drawn as if photographed from a hot-air balloon directly overhead — you see the ROOF and any features that protrude above or beyond its footprint. Never a front-facing facade with the door visible on a vertical wall.

**Do draw:**
- Rectangular roof silhouette filling most of the footprint (inset slightly so the roof overhang casts its shadow at the edge)
- For peaked roofs: a single ridge beam (thin `rect` running the length of the roof) with a lighter line along one side (highlight) and a darker line along the other (shadow) to imply the two slopes meeting at the apex
- Slab / shingle courses running perpendicular to the ridge, as thin horizontal `line`s spaced along the slope
- For flat roofs: a paver grid pattern of thin cross-hatched `line`s
- Ornamental cornice trim: a thin rect inset from the roof edge giving a moulding frame, optionally with small rosette medallion `circle`s at each corner
- Corner finial pillars as square `rect` cross-sections extending slightly beyond the building footprint at each corner, with an inner bevel `rect` for the capital and a `circle` cap on top (with a smaller bright inner dot as the spire tip)
- Carved reliefs on the roof (cross, sigil, family crest) as filled rects/polys or strokes — these are bas-reliefs on the flat roof surface, visible as embossed silhouettes
- Chimneys as small stone rects with a dark opening
- Dormers or skylights as small dark rectangles on the slope

**If you need to show an entrance:** build a protruding **porch or vestibule** sticking outward from one side of the building. From above it reads as a rectangular or arched structure extending beyond the main roofline — the "arch of the door" is the top-down silhouette of an arched porch, drawn as a south-pointing half-disc (`arc cx,cy r 0 180 texfill`). Add concentric arc bands for moulding trim and radial lines for slab courses on the porch roof.

**Never draw:**
- A front-elevation facade (vertical block courses, a door in the wall, an arched ∩ above the door, a keystone above the arch)
- The door opening itself as a rectangular dark hole in the building silhouette — doors are vertical features, invisible from directly above
- A granite / paved plinth extending around the building base — `shadow: yes` handles the elevation shadow
- Descending trapezoidal steps leading up to the south face — those read as a side-view staircase
- The interior of the building (a crypt shown as a floor-plan cutaway is a different class of prop, and buildings marked as "scenery only" should be solid and opaque from above)

See `toll-house.prop` (2x2 peaked-roof hut with chimney, dormer window, door placard), `ferry-cabin.prop` (2x2 shed with peaked roof + south door landing), and `crypt-entrance.prop` (8x8 solid mausoleum with corner finial pillars, cornice trim, carved cross relief, and an arched porch protruding south) for the canonical building patterns at different scales.

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

**When `blocks_light: yes`, always also set `height:`** — see the `height:` section below. Without a declared height, the prop casts an infinite shadow.

### `facing: yes|no`

Whether the prop can be rotated when placed. Use `yes` for:
- Anything directional (chairs, beds, doors, fireplaces)
- Anything wall-mounted (mirrors, paintings, racks)
- Anything with a clear front/back

Use `no` for:
- Symmetrical objects (barrels, pillars, wells, tables)
- Random scatter (rubble, bone piles, caltrops)

### `height:` (feet — REQUIRED when `blocks_light: yes`)

Prop height in feet. Used by the lighting engine to compute how far shadows extend when the prop's `blocks_light: yes`. A torch-sconce at `height: 1` casts a short shadow; a pillar at `height: 8` casts a long one.

- **`blocks_light: yes` without `height:`** is a bug — the shadow is treated as infinite, which tends to plunge the scene into darkness. Always declare one. The validator enforces this.
- **Floor decals / flat items** (scorch marks, rugs, puddles) should set `height: 0` or a small value like `0.1`.
- **Common heights:** floor clutter 0.1–0.5, low furniture 1–2, tables/chairs 3, counters 3.5, wardrobes 6, pillars 8–10, obelisks 12+.
- **Match any hitbox `z` zones** — every hitbox's `zTop` must be ≤ `height`.

### `lights:` (optional — OMIT if not emitting)

The `lights:` frontmatter key auto-attaches light emitters to the prop at placement time. If the prop doesn't glow, **omit the field entirely**.

**Format: a single line of inline JSON.** The header parser is single-line only — multi-line YAML formats silently fail to parse and the prop emits no light.

```yaml
# CORRECT — single-line JSON array
lights: [{"preset":"candle","x":0.5,"y":0.5}]
lights: [{"preset":"ember","x":0.5,"y":0.5,"radius":3,"color":"#cc2200","intensity":0.35}]
lights: [{"preset":"forge","x":0.5,"y":0.5},{"preset":"forge","x":1.5,"y":0.5}]

# BROKEN — multi-line YAML. Parser reads the first `lights:` line as empty, prop emits no light.
lights:
  - preset: candle
    x: 0.5
    y: 0.5

# BROKEN — wrong key name. Preset lookup fails; light falls back to defaults.
lights: [{"type":"candle","x":0.5,"y":0.5}]
#         ^^^^^^ must be "preset", not "type"

# BROKEN — boolean/empty values break JSON.parse; the prop drops out of the catalog.
lights: no
lights: []
lights: false
```

**Required fields per entry:**
| Field | Type | Meaning |
|---|---|---|
| `preset` | string | Preset name from `src/lights/manifest.json` (see list below) |
| `x` | number | Column offset inside the footprint (0 to cols) |
| `y` | number | Row offset inside the footprint (0 to rows) |

**Optional inline overrides** (take precedence over the preset's defaults):
| Field | Type | Notes |
|---|---|---|
| `color` | `#rrggbb` | Override hex color |
| `radius` | number (feet) | Override bright radius. Cap: 15 for small lights, 30 for strong indoor. |
| `intensity` | number (0–2) | Override brightness |
| `falloff` | `smooth` / `linear` / `quadratic` / `sharp` / `step` / `inverse-square` | Override falloff curve |
| `dimRadius` | number (feet) | Override dim radius |
| `angle` | number (degrees) | For directional presets only |
| `spread` | number (degrees) | For directional presets only |
| `cookie` | object | Procedural mask (gobo) projected through the light. See below. |

**Cookie / gobo (`cookie`)** — declare a grayscale pattern that gets multiplied into the light's gradient. Useful for any prop that should project a *pattern* rather than a uniform glow: stained-glass windows, barred grates, magical sigils, lattices, water surfaces above a sunlit pool, tree canopies, etc. The placed light inherits the cookie verbatim; the prop is the natural place to declare it because the cookie is a property of the *fixture*, not the light source.

```yaml
# Stained-glass window casting colored shards on the floor (1×2 wall prop)
lights: [{"preset":"daylight","x":1.0,"y":0.5,"cookie":{"type":"stained-glass","focusRadius":1.5,"strength":0.9}}]

# Barred prison window — vertical slats projected across one cell
lights: [{"preset":"daylight","x":0.5,"y":0.5,"cookie":{"type":"slats","focusRadius":0.7}}]

# Slowly rotating summoning sigil (3×3 floor prop)
lights: [{"preset":"arcane-blue","x":1.5,"y":1.5,"cookie":{"type":"sigil","focusRadius":1.5,"rotationSpeed":8}}]
```

**Cookie fields** (all optional except `type`):
| Field | Type | Notes |
|---|---|---|
| `type` | `slats` / `dapple` / `caustics` / `sigil` / `grid` / `stained-glass` | Pattern. Procedural — no asset files. |
| `focusRadius` | feet | **Set this for prop-attached cookies.** Hard cap on cookie projection — outside this radius, the gradient is preserved unchanged. Models the top-down reality that a window/grate only projects its pattern onto the floor area immediately beneath it, not the whole light radius. Sensible value: roughly half the prop's longest footprint dimension. Without `focusRadius`, the cookie spans the full light bbox (only sensible for free-floating magical effects, never for physical fixtures). |
| `scale` | number | Pattern density inside the focus area. 1.0 = one cookie texture across the focus diameter; >1 zooms in (denser pattern), <1 zooms out. Default 1. |
| `strength` | number 0–1 | Mask opacity. 1 = full pattern, 0 = no cookie effect. Default 1. |
| `rotation` | degrees | Static rotation. Default 0. |
| `scrollX` / `scrollY` | number | Static scroll offset (0–1 wraps). |
| `rotationSpeed` | deg/sec | Animate rotation (e.g. summoning sigils). |
| `scrollSpeedX` / `scrollSpeedY` | per sec | Animate scroll (e.g. canopy dapple, water caustics). |

Cookies work on both point and directional lights. For window props, pair with a directional preset (`daylight`, `sunbeam`) so the projection has a clear direction. Animated cookies (`rotationSpeed` / `scrollSpeed*`) bypass the per-light bake cache, so use them sparingly on prop-heavy maps.

**Use cookies for:** floor-level pattern effects (water caustics, tree dapple, magical sigils, stained-glass pool). **Use `gobos:` (below) for:** upright patterned occluders (window mullions, prison bars, lattice walls). Gobos are physically projected by any nearby light the same way prop z-shadows are, so the pattern falls on the far side of the fixture.

### `gobos:` (optional — OMIT if the prop isn't a patterned occluder)

Declare upright patterned planes on the prop. Any light that clears the gobo's `zBottom` projects the pattern onto the floor on the FAR SIDE of the segment from the light — same projection math as the z-height prop shadow system, but with a multiply-blended pattern mask instead of uniform darkening.

**Format: single-line JSON array** (same constraint as `lights:`).

```yaml
# Clerestory window — 1×2 wall prop, mullions between floor+4ft and floor+7ft
gobos: [{"x1":0.15,"y1":0.05,"x2":1.85,"y2":0.05,"zBottom":4,"zTop":7,"gobo":"window-mullions"}]

# Wall-mounted prison grate — 1×1, vertical bars from knee height to head height
gobos: [{"x1":0.20,"y1":0.18,"x2":0.80,"y2":0.18,"zBottom":1,"zTop":4,"gobo":"vertical-bars"}]
```

**Fields per entry:**
| Field | Type | Meaning |
|---|---|---|
| `x1`, `y1`, `x2`, `y2` | number | Segment endpoints in prop-local cell coordinates (0..cols, 0..rows). Defines the gobo's footprint on the prop. |
| `zBottom` | feet | Gobo base height above the floor. Lights below this height pass underneath and don't project. |
| `zTop` | feet | Gobo top height. Projection length scales with `zTop / (lz - zTop)` — higher lights cast shorter projections. |
| `gobo` | string | Id in `src/gobos/manifest.json`. Shipped gobos: `window-mullions`, `vertical-bars`, `horizontal-slats`, `ceiling-grate`. |
| `density` | number (optional) | Override the gobo catalog's default density (grid divisions / slat bands). Useful when the same pattern fits a small and a large window. |
| `strength` | 0..1 (optional, default 1) | Pattern opacity. 1 = full multiply mask, 0 = no effect. |

**When to use cookies vs gobos:**
- **Cookie** — pattern is part of the LIGHT, always visible at the light source. Use for floor-level phenomena (water caustics, tree-dapple, runic sigils, stained-glass pools) and for props whose "sunlight pool" is the whole visual.
- **Gobo** — pattern is part of the PROP, projected only when a light hits it from the correct side. Use for physical occluders where the pattern's position depends on the light (prison bars, overhead lattices, barred windows seen from inside when a torch is behind them).

**Gobo props are passive — do not add `lights:`.** A window/grate/lattice doesn't emit light, it modulates incoming light. Drop the prop with only a `gobos:` declaration and let any nearby torch, daylight source, or magical light supply the actual illumination. The shipped `clerestory-window`, `stern-window`, `sun-window`, and `grate-wall` follow this convention — place them and then place a separate light source on whichever side should be the "outside."

**Adding a new gobo:** drop a `.gobo` YAML file into `src/gobos/` with `name`, `description`, `pattern` (`grid`/`slats`/`sigil`/`caustics`/`dapple`/`stained-glass`), `density`, and optionally `orientation: horizontal`. Run `node tools/update-gobo-manifest.js` to regenerate the manifest + bundle.

**Available presets** (see `src/lights/manifest.json` for the authoritative list):

| Category | Presets |
|---|---|
| Fire & flame | `candle`, `oil-lamp`, `lantern`, `torch`, `wall-sconce`, `campfire`, `fireplace`, `brazier`, `bonfire`, `forge`, `ember` |
| Magical | `light-cantrip`, `dancing-lights`, `continual-flame`, `faerie-fire`, `moonbeam`, `daylight`, `eldritch-glow`, `divine-radiance`, `infernal-flame`, `necrotic`, `arcane-blue`, `astral`, `silvery`, `faerzress` |
| Natural | `moonlight`, `starlight`, `bioluminescence`, `lava-glow`, `phosphorescent-fungi`, `sunbeam` |
| Utility | `dim`, `bright`, `spotlight`, `ambient-glow` |

**Picking the right preset:** the preset controls color, falloff, animation (flicker/pulse), and z-height. Match the preset to the prop concept, then use inline overrides to tune radius/intensity. Quick guide:

- Small burning thing → `candle` (r=10), `oil-lamp` (r=15), `ember` (r=5, dim red)
- Wall-mounted burning thing → `torch-sconce` style: `torch` (r=20) or `wall-sconce` (r=15)
- Metal bowl of coals → `brazier` (r=25)
- Hearth / indoor fire → `fireplace` (r=25)
- Outdoor camp fire → `campfire` (r=30), `bonfire` (big — r=40)
- Forge / furnace / smelter → `forge` (r=20, intense)
- Glowing hot metal / embers / molten → `ember` (dim red) or `lava-glow`
- Daylight spilling in (grate, window, shaft) → `daylight` (r=60, point) for floor pools; `sunbeam` (directional) for angled beams
- Crystals / magical motes → `arcane-blue` (blue-white), `astral` (violet), `silvery` (silver-white), `eldritch-glow` (green), `faerie-fire` (pink-violet)
- Fungal / bioluminescent → `phosphorescent-fungi` (green) or `bioluminescence` (teal)
- Divine / celestial → `divine-radiance` (warm gold)
- Infernal / devilish → `infernal-flame` (deep red)
- Drow / Underdark → `faerzress` (deep purple)
- Undead / necromantic → `necrotic` (sickly purple)

**Wrong-preset pitfalls:**
- Don't use `candle` for daylight — it's orange fire.
- Don't use `torch` for a bonfire — torch has small radius; use `bonfire` or `campfire`.
- Don't use `sunbeam` (directional) for floor-pool props — use `daylight` instead.

**Validating:** run `node tools/validate-props.js` — it will flag broken `lights:` entries before they reach the editor.

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

After adding, removing, or renaming props, run:

```bash
node mapwright/tools/update-manifest.js
```

This scans all `.prop` files and regenerates **two** derived files in one pass:
- `src/props/manifest.json` — flat array of prop names (used by per-file fallback + Node-side rendering).
- `src/props/bundle.json` — every prop's raw text keyed by name plus a content-hash version. The editor fetches this in one HTTP request at startup (avoids 1100+ roundtrips) and falls back to per-file fetches if the bundle is missing.

**The editor will serve stale props until you run this script.** If you edit a `.prop` file and don't see the change in the editor, re-run `update-manifest.js` and hard-reload (the bundle's version hash busts the localStorage cache automatically).

## Validating Props

Run the validator before committing prop changes. Exit 0 means clean, 1 means warnings.

```bash
node mapwright/tools/validate-props.js              # Validate all props
node mapwright/tools/validate-props.js pillar.prop   # Validate specific files
```

The validator enforces:
- **Required header fields:** `name`, `category`, `footprint`
- **Unknown header fields** (typos like `heights:` or `block_light:`) are flagged
- **Enumerated values:** `placement` ∈ {wall, corner, center, floor, any}; `typical_count` ∈ {single, few, many}; `facing`/`shadow`/`blocks_light` ∈ {yes, no, true, false}
- **Duplicate entries** in `clusters_with` and `room_types`
- **Draw-command bounds:** coordinates must stay within footprint (+ `padding:` if declared)
- **Lights:** single-line JSON only; preset must exist in the manifest; `x`/`y` inside footprint; `color` is `#rrggbb`; no unknown fields; no `"type"` key (must be `"preset"`)
- **Hitbox / selection:** coordinates in footprint; z-zones obey `0 ≤ zBottom ≤ zTop ≤ height`; `blocks_light: yes` requires at least one `hitbox`; `blocks_light: no` forbids `hitbox` (use `selection`)
- **Height:** non-negative; required when `blocks_light: yes`

**Separate backlog tool:** the validator deliberately ignores `clusters_with` refs that point to non-existent props — there are ~200 such refs that represent prop ideas we haven't created yet. Surface them explicitly with:

```bash
node mapwright/tools/lint-cluster-refs.js           # frequency-sorted list of missing props
node mapwright/tools/lint-cluster-refs.js --by-file # grouped by source prop
```

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
