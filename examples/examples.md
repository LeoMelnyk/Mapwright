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
