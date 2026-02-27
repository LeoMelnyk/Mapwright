# Example Maps

JSON maps can be loaded directly into the dungeon editor or rendered with:

```bash
node generate_dungeon.js examples/<name>.json
```

Export a JSON map back to `.map` text format with:

```bash
node puppeteer-bridge.js --load examples/<name>.json --export-map examples/<name>.map
```

---

## Island

**File:** `island.json` / `island.map` | **Grid:** 50×50 | **Rooms:** 9 | **Levels:** 1

A coastal island encounter map. The island is surrounded by a water-fill room (A7) and contains a central hall (A1) with satellite buildings — a watchtower (A9), quarters (A3/A2), a common room (A5/A6), and a dock area (A4). Good reference for outdoor/overworld maps with rich interior dressing.

### Features demonstrated

- **Water terrain fill** — `A7: water` sets the surrounding ocean as a water-fill room; water cells carry `waterDepth` 1–3 for shallow/medium/deep rendering with the theme's `waterShallowColor`/`waterDeepColor` palette
- **Large rounded arc trims** — room A9 (the watchtower) uses size-6 trims: straight `nw6` on the west-facing corners and rounded `ne6r`, `sw6r`, `se6r` arcs for the curved exterior walls
- **Props with facing** — 40+ placed props using `facing:90/180/270` for rotation: furniture (bed, desk, wardrobe, hearth), nautical items (anchor, ship-wheel, lobster-trap, rope-coil, dock-cleat, rowboat), outdoor scenery (tree, dead-tree, campfire, ritual-circle)
- **Double doors** — `31,19 south: door` + `31,20 south: door` are adjacent and auto-combine into a double door
- **Directional door placement** — all 9 doors use explicit direction (`south:`, `east:`) because rooms share walls on multiple sides
- **Per-cell Polyhaven textures** — each zone uses a different texture (e.g., `damp_sand` for the shoreline ring, `aerial_grass_rock` for the interior, `grass_path_2` for paths, `wood_floor_deck` for buildings); outer deep-water row uses `blue_metal_plate`
- **Point light system** — 9 placed lights with individual `color`, `radius`, `intensity`, and `falloff` (`linear` vs `smooth`); ambient light at 0.35
- **Custom theme** — full custom color palette with water color sets (`waterShallowColor`, `waterMediumColor`, `waterDeepColor`, `waterCausticColor`), outer vignette shading, and wall roughness/shadow settings

### Layout notes

The entire active area (rows/cols 4–45) is enclosed in room A7 (water). The island landmass occupies the center with buildings clustered in the lower-center. A9 (watchtower) sits isolated in the northeast. A1 (central hall) is the hub with doors connecting to A3/A2 (quarters) to the west, A5 (common room) to the south, and A4 (dock) to the southeast. A6 is a small outbuilding southwest of A5.

---

## Mines

**File:** `mines.map` | **Grid:** 50×50 | **Rooms:** 13 | **Levels:** 1

An underground mine complex with organic, irregular room shapes. A surface entrance (A1) transitions into a network of excavated tunnels and chambers on the left, while a vast central cavern (A10) dominates the map. A secondary cluster of side chambers (A12–A15) on the right contains a burial/ritual area. A diagonal band of pit and water fills cuts through A10, representing a collapsed mineshaft or underground stream.

### Features demonstrated

- **Diagonal fill bands** — hundreds of `pit` and `water` fills placed in a diagonal stripe across A10 to simulate a mineshaft chasm; small pit clusters also appear in A8 (lower tunnel)
- **Organic irregular shapes** — rooms like A3, A7, A8, and A10 have non-rectangular, jagged boundaries formed by partial-row ASCII coverage, producing natural-looking cave and tunnel outlines
- **Size-3 trims** — `se3` and `nw` trims on A3/A5 boundary corners (`12,9`, `13,8`, `16,7`, `13,9`) for larger diagonal wall cuts between adjacent rooms
- **Double doors** — `5,11 south` + `5,12 south` are adjacent doors that auto-combine into a double door at the entrance; `32,7 south` + `32,8 south` do the same deeper in the complex; `37,14 east` + `38,14 east` pair for a wide east-facing passage
- **Mixed terrain fills** — `pit` for shafts and drop-offs, `water` for the underground stream/flooded section; both used together to create gradated hazard zones
- **Burial/ritual dressing** — A12 contains coffins, candelabras, a skeleton, benches, and an altar; A13/A14 hold additional coffins and a spice-shelf, showing a complete religious or tomb sub-area
- **Surface-to-underground texture transition** — A1 uses `leafy_grass` and `red_dirt_mud_01` (outdoor entrance), transitioning through `dirt` border cells into `dirt_floor` and `flower_scattered_dirt` for interior tunnels
- **Tree props at entrance** — two `tree facing:90` props placed in A1 mark the outdoor mine entrance area

### Layout notes

A1 (surface entrance, rows 0–5, top-center) connects south via a double door into A2 (rows 6–10). A2 branches west into A3 (rows 9–16) and southeast into A5 (rows 10–20). A3 continues south through A4 (rows 17–23) and A7 (rows 23–34) to A8 (rows 33–46, bottom-left). A5 connects south through A6 (rows 21–30) to rejoin A7. A10 (the massive central cavern, rows 4–46, cols 15–40) runs the full height of the map and is accessed via doors from A5 and A7. On the right side, A12 (rows 19–28) is the main ritual chamber accessed from A10, with small antechambers A13 (rows 18–21), A14 (rows 22–25), and A15 (rows 26–29) branching off it.
