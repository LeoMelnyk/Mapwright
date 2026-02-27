# Compile Pipeline

## Overview

The compile pipeline converts `.map` text files into JSON grid data for the renderer and editor.

```
.map text file
    ↓ parseMapFile()        [parse.js]
{ header, levels[] }
    ↓ compileLevel()        [compile.js]  (per level)
{ grid, rooms, diagonals }
    ↓ combine + placeStairs [compile.js]
{ metadata, cells[][] }     → JSON output
```

## Modules

### parse.js

Parses `.map` text format into structured data.

**Exports:** `parseMapFile(filePath)`, `parseLevelContent(lines, label, offset)`, `parseHeader(lines)`, `parseStairSide(str)`

**Section keywords:** `legend:`, `doors:`, `trims:`, `stairs:`, `fills:`, `props:`, `textures:`, `lights:`

**Return structure:**
```js
{
  header: { dungeonName, gridSize, theme, labelStyle, features, themeOverrides },
  levels: [{
    name,        // level name (null for single-level)
    gridLines,   // string[] — ASCII grid rows
    legend,      // { char: label }
    doors,       // [{ row, col, direction?, type }]
    trims,       // { label: [{ corner, size, round, inverted }] }
    stairs,      // [{ row, col, type, autoPlace, room?, linked? }]
    fills,       // { label: fillType }
    cellFills,   // [{ row, col, fill }]  — per-cell fills
    props,       // [{ row, col, type, facing }]
    textures,    // [{ row, col, texture, opacity }]
    lights,      // [{ x, y, type, color, radius, intensity, falloff, angle?, spread? }]
  }]
}
```

### grid.js

Grid construction from parsed ASCII data.

**Exports:** `Grid`, `parseGrid(gridLines, legend)`, `buildGrid(rooms, numRows, numCols)`, `computeBorders(grid)`

**Grid class:**
- `cells[][]` — 2D array of cell objects (null = void)
- `cellToRoom` — Map of `"row,col"` → room ID
- `cellToChar` — Map of `"row,col"` → ASCII character
- `inBounds(row, col)` — bounds check
- `getRoom(row, col)` — room ID lookup

### trims.js

Diagonal corner trimming logic.

**Exports:** `computeTrimCells(corner, size, minR, maxR, minC, maxC)`, `applyTrims(grid, rooms, trimConfig)`

Converts corner specs (e.g., `nw2r`) into voided cells and diagonal wall hypotenuse cells. Sets `trimCorner`, `trimRound`, `trimArcCenterRow/Col`, `trimArcRadius`, `trimArcInverted` on cells.

### features.js

Door placement, room labeling, stair resolution, reachability validation.

**Exports:** `placeDoors()`, `placeLabels()`, `placeStairs()`, `validateReachability()`, `isValidStairCell()`, `findBestStairCell()`

### constants.js

Shared constants for the compile pipeline.

**Exports:** `RESERVED_CHARS` — Set of characters that cannot be used in legend mappings (`.`, `#`, `-`, `=`, ` `, `\t`)

### compile.js

Main orchestrator that combines all modules.

**Exports:** `compileLevel(levelData, levelIndex)`, `compileMap(mapPath)`

## Cell Object Shape

Each non-void cell in `cells[][]` can contain:

```js
{
  // Walls/doors (cardinal)
  north: 'w' | 'd' | 's',     // wall, door, secret
  south: 'w' | 'd' | 's',
  east: 'w' | 'd' | 's',
  west: 'w' | 'd' | 's',

  // Diagonal walls
  'nw-se': 'w' | 'd' | 's',
  'ne-sw': 'w' | 'd' | 's',

  // Trim (diagonal corner cut)
  trimCorner: 'nw' | 'ne' | 'sw' | 'se',
  trimRound: boolean,
  trimArcCenterRow: number,
  trimArcCenterCol: number,
  trimArcRadius: number,
  trimArcInverted: boolean,

  // Room center features
  center: {
    label: 'A',
    dmLabel: 'DM note',
  },

  // Fill pattern
  fill: 'difficult-terrain' | 'pit' | 'water' | 'lava',
  waterDepth: 1 | 2 | 3,    // only when fill === 'water'
  lavaDepth: 1 | 2 | 3,     // only when fill === 'lava'

  // Prop
  prop: { type: 'barrel', facing: 0 },

  // Texture
  texture: 'stone-floor-1',
  textureOpacity: 0.8,
  textureNE: 'wood-planks',     // half-cell texture (diagonal split)
  textureSW: 'stone-floor-1',
}
```

## Coordinate Conventions

- **Row/col** — 0-indexed, row increases downward
- **Feet** — `col * gridSize`, `row * gridSize` (gridSize default: 5)
- Stair points use `[row, col]` arrays
- Light positions use feet coordinates `(x, y)` where `x = col * gridSize`

## Multi-Level Maps

- Levels separated by `=== Level Name ===` markers
- Combined grid has 1 void separator row between levels
- Row offsets computed: level 1 at 0, level 2 at (rows1 + 1), etc.
- Cross-level stair links use `L#:` prefix: `0,5: down - L2: 0,5: up`
