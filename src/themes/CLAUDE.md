# Theme, Light, and Gobo File Formats

This directory owns the documentation for the three lighting/visual asset file formats used by the editor:

- **`.theme` files** — `src/themes/` — visual style of dungeon maps (colors, hatching, shadow, texture blending).
- **`.light` files** — `src/lights/` — reusable light presets (torch, brazier, daylight…).
- **`.gobo` files** — `src/gobos/` — procedural light projection patterns (window mullions, prison bars, caustics…).

All three load via the same one-shot bundle pattern: editor fetches `bundle.json` (every file's body keyed by id, plus a content-hash version) on startup. PNGs / per-file fetches are fallbacks.

---

## `.theme` files

JSON files in `src/themes/` controlling the visual appearance of dungeon maps.

### Schema

```json
{
  "displayName": "Stone Dungeon",
  "background": "#48464a",
  "gridLine": "#000000",
  "wallStroke": "#20201c",
  "wallFill": "#585858",
  "textColor": "#e0e0e0",
  "borderColor": "#70706c",
  "doorFill": "#585858",
  "doorStroke": "#e0e0e0",
  "trapColor": "#ff6b6b",
  "secretDoorColor": "#e0e0e0",
  "compassRoseFill": "#e0e0e0",
  "compassRoseStroke": "#e0e0e0",
  "wallRoughness": 0.8,
  "wallShadow": { "color": "rgba(0,0,0,0.35)", "blur": 12, "offsetX": 5, "offsetY": 7 },
  "hatchColor": "#20201c",
  "hatchSize": 0.5,
  "hatchOpacity": 0,
  "bufferShadingOpacity": 0.20,
  "outerShading": { "color": "#38363a", "size": 11, "roughness": 0.5 },
  "textureBlendWidth": 0.35
}
```

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | string | Name shown in the editor theme picker |
| `background` | hex | Canvas background / void area color |
| `gridLine` | hex | Grid line color |
| `gridStyle` | string | `"lines"`, `"dotted"`, `"corners-x"`, `"corners-dot"` |
| `gridLineWidth` | number | Grid line/dot width in pixels (1–8) |
| `gridOpacity` | 0–1 | Grid overlay opacity |
| `gridCornerLength` | number | Cross arm length as fraction of cell size (corners-x only) |
| `gridNoise` | 0–1 | Wobble amount for hand-drawn feel (lines/dotted only) |
| `wallStroke` | hex | Wall line color |
| `wallFill` | hex | Room floor background color |
| `textColor` | hex | Room label text color |
| `borderColor` | hex | Map border decoration color |
| `doorFill` | hex | Door gap fill color |
| `doorStroke` | hex | Door symbol stroke color |
| `trapColor` | hex | Trap marker color |
| `secretDoorColor` | hex | Secret door symbol color |
| `compassRoseFill` / `compassRoseStroke` | hex | Compass rose colors |
| `wallRoughness` | 0–1 | Jitter amount for rough wall lines (0 = clean) |
| `wallShadow` | object | `{ color: rgba, blur, offsetX, offsetY }` — drop shadow behind walls |
| `hatchColor` / `hatchSize` / `hatchOpacity` | — | Cross-hatching for void areas (opacity 0 = no hatching) |
| `bufferShadingOpacity` | 0–1 | Dark gradient at wall-adjacent floor edges |
| `outerShading` | object | `{ color, size, roughness }` — colored blob wrapping room exteriors |
| `textureBlendWidth` | 0–1 | Texture splatting blend zone width (fraction of cell) |

### Available themes (16)

`alien`, `arcane`, `blue-parchment`, `crypt`, `desert`, `dirt`, `earth-cave`, `grasslands`, `ice-cave`, `sepia-parchment`, `snow-tundra`, `stone-dungeon`, `swamp`, `underdark`, `volcanic`, `water-temple`.

(Authoritative list: `src/themes/manifest.json`. Use `listThemes()` from the editor API at runtime.)

### Adding a new theme

1. Create `your-theme.theme` in `src/themes/` with all fields from the schema.
2. Run `node mapwright/tools/update-themes-manifest.js` — regenerates `manifest.json` (sorted key list) and `bundle.json` (one-shot client load with all theme bodies + content-hash version).

**The editor serves stale themes until the manifest tool runs.** The client fetches `bundle.json` first and falls back to per-file fetches if it's missing. User-created themes (under `MAPWRIGHT_THEME_PATH`) are not part of the bundle — they always load dynamically.

---

## `.light` files

JSON files in `src/lights/` defining reusable light presets.

### Schema

```json
{
  "displayName": "Torch",
  "category": "Fire & Flame",
  "description": "A standard wall torch with warm, dancing firelight",
  "type": "point",
  "color": "#ff8833",
  "radius": 20,
  "dimRadius": 40,
  "intensity": 1.0,
  "falloff": "smooth",
  "z": 7,
  "animation": { "type": "flicker", "speed": 1.5, "amplitude": 0.25, "radiusVariation": 0 }
}
```

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | string | Name shown in the picker |
| `category` | string | Grouping (`Fire & Flame`, `Magical`, `Natural`, `Utility`) |
| `description` | string | Brief description |
| `type` | `"point"` \| `"directional"` | Emission type |
| `color` | hex | Light color |
| `radius` | number (feet) | Bright radius |
| `dimRadius` | number (feet) | Optional dim falloff radius |
| `intensity` | number | Brightness multiplier (0..2 typical) |
| `falloff` | string | `smooth` \| `linear` \| `sharp` \| `step` \| `quadratic` \| `inverse-square` |
| `z` | number | Source height in feet (used for prop / window shadow projection) |
| `angle` | number (deg) | Directional only — cone direction (0 = north, CW) |
| `spread` | number (deg) | Directional only — cone width |
| `animation` | object | Optional. `{ type: "flicker"\|"pulse"\|"strike", speed, amplitude, radiusVariation }` |

### Available presets (47)

**Fire & Flame:** `candle`, `oil-lamp`, `lantern`, `torch`, `wall-sconce`, `campfire`, `fireplace`, `brazier`, `bonfire`, `forge`, `ember`, `windblown-torch`, `dying-candle`.

**Magical:** `light-cantrip`, `dancing-lights`, `continual-flame`, `faerie-fire`, `moonbeam`, `daylight`, `eldritch-glow`, `divine-radiance`, `infernal-flame`, `necrotic`, `arcane-blue`, `astral`, `silvery`, `faerzress`, `magical-ward`, `malfunctioning-portal`, `arcing-crystal`, `summoning-sigil`.

**Natural:** `moonlight`, `starlight`, `bioluminescence`, `lava-glow`, `phosphorescent-fungi`, `sunbeam`, `lighthouse-beam`.

**Utility:** `dim`, `bright`, `spotlight`, `ambient-glow`, `nervous-lantern`, `stained-glass-window`, `prison-bars-light`, `canopy-dapple`, `water-caustics`.

(Authoritative list: `src/lights/manifest.json`. Use `listLightPresets()` from the editor API at runtime — never hardcode preset names in tooling code.)

### Picking a preset

The preset controls color, falloff, animation (flicker/pulse), and source z-height. Match concept to preset, then use inline overrides at placement time to tune `radius` / `intensity`. Quick guide:

- Small burning thing → `candle` (r=10), `oil-lamp` (r=15), `ember` (r=5, dim red)
- Wall torch → `torch` (r=20), `wall-sconce` (r=15)
- Coals / fire bowl → `brazier` (r=25)
- Hearth → `fireplace` (r=25)
- Outdoor fire → `campfire` (r=30), `bonfire` (r=40)
- Forge / smelter → `forge` (r=20, intense)
- Hot metal / molten → `ember` or `lava-glow`
- Daylight pool (window, grate) → `daylight` (r=60, point)
- Angled shaft → `sunbeam` (directional)
- Crystals / motes → `arcane-blue`, `astral`, `silvery`, `eldritch-glow`, `faerie-fire`
- Fungal → `phosphorescent-fungi`, `bioluminescence`
- Divine → `divine-radiance`. Infernal → `infernal-flame`. Drow → `faerzress`. Undead → `necrotic`.

**Wrong-preset traps:** `candle` for daylight (too orange); `torch` for a bonfire (too small); `sunbeam` for floor pools (use `daylight`).

### Adding a new light preset

1. Create `your-light.light` in `src/lights/`.
2. Add `"your-light"` to `src/lights/manifest.json`.
3. Restart server (or call `clearCaches()` from the editor API).

---

## `.gobo` files

YAML-headered files in `src/gobos/` declaring procedural projection patterns. A gobo is a "shape that gets multiplied into a light" — used for window mullions, prison bars, caustics, summoning sigils, etc.

### When to use a gobo (vs cookie)

- **Cookie** — pattern is part of the LIGHT, always visible at the source. Use for floor-level effects (water caustics, tree dapple, runic sigils, stained-glass pools).
- **Gobo** — pattern is part of a PROP or WINDOW, projected only when a light hits it from the correct side. Use for physical occluders (prison bars, lattices, barred windows seen from inside when a torch is behind them, mullioned windows).

Cookies are declared inline on a light's `cookie:` field; gobos are referenced by id from a prop's `gobos:` field or a window's `goboId`.

### Schema

```yaml
name: Window Mullions
description: Six-pane window grid cast by a mullioned wall window.
pattern: grid
density: 6
```

```yaml
name: Horizontal Slats
description: Horizontal blinds, louvered shutters, ladder rungs.
pattern: slats
density: 6
orientation: horizontal
```

```yaml
name: Cathedral Glass
description: Stained-glass cathedral window with primary jewel tones.
pattern: stained-glass
density: 4
colors: #cc2233, #2266cc, #cce033, #5b3aa0
```

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name |
| `description` | string | Brief description |
| `pattern` | enum | `plain`, `grid`, `slats`, `slot`, `mosaic`, `sigil`, `caustics`, `dapple`, `stained-glass`, `diamond`, `cross`. Unknown values fall back to `grid`. |
| `density` | number | Pattern divisions / band count. Default 6. Lower = sparser; higher = denser |
| `orientation` | `vertical` \| `horizontal` | Optional. Only meaningful for `slats` / `slot` patterns |
| `colors` | comma-list of hex | Optional. Only meaningful for `stained-glass` / `mosaic` patterns. Cycled across the cells |

### Available gobos (16)

Window-style: `arrow-slit`, `cathedral-glass`, `cruciform`, `diamond-lattice`, `double-hung`, `horizontal-clerestory`, `leaded-grid`, `narrow-casement`, `none` (clear aperture, no tracery), `portcullis-window`, `rose-window`, `tall-lancet`, `window-mullions`.

Occluder-style (used by gobo-prop occluders, not windows): `vertical-bars`, `horizontal-slats`, `ceiling-grate`.

(Authoritative list: `src/gobos/manifest.json`.)

### Adding a new gobo

1. Drop a `.gobo` file into `src/gobos/` with `name`, `description`, `pattern`, `density`, optional `orientation` / `colors`.
2. Run `node mapwright/tools/update-gobo-manifest.js` — regenerates `manifest.json` and `bundle.json`.
3. Reload the editor (or call `clearCaches()`).

---

## See also

- [`src/props/CLAUDE.md`](../props/CLAUDE.md) — `.prop` file format, including how props use `lights:` (cookies) and `gobos:` (segment occluders).
- [`mapwright/CLAUDE.md`](../../CLAUDE.md) — Lighting domain routing and pipeline overview.
- [`src/editor/CLAUDE.md`](../editor/CLAUDE.md) — Editor API for placing lights, windows, and querying the catalogs at runtime.
