# Theme & Light File Formats

## Theme Files (`.theme`)

Theme files are JSON files in `src/themes/` that control the visual appearance of dungeon maps.

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

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | string | Name shown in the editor theme picker |
| `background` | hex color | Canvas background / void area color |
| `gridLine` | hex color | Grid line color |
| `wallStroke` | hex color | Wall line color |
| `wallFill` | hex color | Room floor background color |
| `textColor` | hex color | Room label text color |
| `borderColor` | hex color | Map border decoration color |
| `doorFill` | hex color | Door gap fill color |
| `doorStroke` | hex color | Door symbol stroke color |
| `trapColor` | hex color | Trap marker color |
| `secretDoorColor` | hex color | Secret door symbol color |
| `compassRoseFill` | hex color | Compass rose fill |
| `compassRoseStroke` | hex color | Compass rose outline |
| `wallRoughness` | 0-1 | Jitter amount for rough wall lines (0 = clean) |
| `wallShadow` | object | Drop shadow behind walls |
| `wallShadow.color` | rgba | Shadow color with alpha |
| `wallShadow.blur` | number | Shadow blur radius in pixels |
| `wallShadow.offsetX/Y` | number | Shadow offset |
| `hatchColor` | hex color | Cross-hatching line color for void areas |
| `hatchSize` | number | Hatching line density |
| `hatchOpacity` | 0-1 | Hatching opacity (0 = no hatching) |
| `bufferShadingOpacity` | 0-1 | Dark gradient opacity at wall-adjacent floor edges |
| `outerShading` | object | Colored blob wrapping around room exterior |
| `outerShading.color` | hex color | Shading color |
| `outerShading.size` | number | Shading spread in pixels |
| `outerShading.roughness` | 0-1 | Edge noise |
| `textureBlendWidth` | number | Texture splatting blend zone width (fraction of cell) |

### Available Themes (16)

`blue-parchment`, `sepia-parchment`, `grasslands`, `desert`, `swamp`, `snow-tundra`, `stone-dungeon`, `earth-cave`, `ice-cave`, `water-temple`, `dirt`, `crypt`, `volcanic`, `arcane`, `underdark`, `alien`

### Adding a New Theme

1. Create `your-theme.theme` in `src/themes/`
2. Add `"your-theme"` to `src/themes/manifest.json`
3. Include all required color fields (see schema above)

---

## Light Files (`.light`)

Light preset files are JSON files in `src/lights/` that define reusable light configurations.

### Schema

```json
{
  "displayName": "Torch",
  "category": "Fire & Flame",
  "description": "A standard wall torch with warm, dancing firelight",
  "type": "point",
  "color": "#ff8833",
  "radius": 20,
  "intensity": 1.0,
  "falloff": "smooth"
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | string | Name shown in the editor light picker |
| `category` | string | Grouping category (Fire & Flame, Magical, etc.) |
| `description` | string | Brief description of the light source |
| `type` | `"point"` or `"directional"` | Light emission type |
| `color` | hex color | Light color |
| `radius` | number | Light range in feet |
| `intensity` | 0-1+ | Brightness multiplier |
| `falloff` | string | Attenuation curve: `"smooth"`, `"quadratic"`, `"linear"` |
| `angle` | number | (directional only) Cone direction in degrees |
| `spread` | number | (directional only) Cone width in degrees |

### Available Presets (32)

**Fire & Flame:** `candle`, `oil-lamp`, `lantern`, `torch`, `wall-sconce`, `campfire`, `fireplace`, `brazier`, `bonfire`, `forge`

**Magical:** `light-cantrip`, `dancing-lights`, `continual-flame`, `faerie-fire`, `moonbeam`, `daylight`, `eldritch-glow`, `divine-radiance`, `infernal-flame`, `necrotic`

**Natural:** `moonlight`, `starlight`, `bioluminescence`, `lava-glow`, `phosphorescent-fungi`, `sunbeam`

**Utility:** `dim`, `bright`, `spotlight`, `ambient-glow`

### Adding a New Light Preset

1. Create `your-light.light` in `src/lights/`
2. Add `"your-light"` to `src/lights/manifest.json`
3. Include all required fields (displayName, category, type, color, radius, intensity, falloff)
