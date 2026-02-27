# Mapwright

A dungeon map editor built for AI-assisted map generation. Describe a dungeon to Claude and get a finished, themed map — or draw it yourself in the browser-based visual editor.

![Example dungeon map](examples/island.png)

---

## AI Map Generation

Mapwright is designed from the ground up to be driven by AI. Claude can generate complete, detailed dungeon maps without any manual GUI work:

1. **Write a `.map` file** from a natural language description — a plain-text format that's easy for both humans and AI to author
2. **Compile to PNG** via `build_map.js` — renders the map to a print-ready image
3. **Control the visual editor** via the Puppeteer bridge — load maps, issue editor commands, take screenshots, and save programmatically

```bash
# Compile a .map file to PNG
node build_map.js my-dungeon.map

# Control the editor headlessly (load, command, screenshot, save)
node puppeteer-bridge.js --load map.json --screenshot output.png
```

Full AI editor API reference: [`src/editor/CLAUDE.md`](src/editor/CLAUDE.md)

---

## Features

- **AI-driven generation** — full Puppeteer bridge and text-based `.map` format for programmatic map creation
- **`.map` text format** — describe dungeons in plain ASCII, compile to PNG or SVG
- **Browser-based visual editor** — draw rooms, place doors, add furniture and lights, undo/redo
- **16 themes** — stone dungeon, ice cave, underdark, volcanic, arcane, alien, and more
- **Hundreds of props** — furniture, containers, nautical items, arcane objects, structural elements
- **Multi-level dungeons** — towers, multi-floor buildings, stacked cave systems in one file
- **Doors & secret doors** — single, double, and secret doors with auto-detection
- **Diagonal & curved walls** — trim room corners with straight diagonals or quarter-circle arcs
- **Stairs** — up/down stair icons with cross-level linking and reachability validation
- **Fills** — pit, difficult terrain, and water fills with shallow/medium/deep depth rendering
- **Point light system** — per-light color, radius, intensity, and falloff
- **Per-cell textures** — 700+ free CC0 textures from [Polyhaven](https://polyhaven.com), downloadable on demand
- **Watch mode** — auto-rebuild on save for fast iteration
- **DM player view** — real-time fog-of-war session mode via WebSocket
- **Import** — load maps from Donjon and OpenDungeonPlanner

---

## Getting Started

You need [Node.js](https://nodejs.org/) (version 18 or newer — download the **LTS** version).

### Windows

1. Double-click **`install.bat`** — installs dependencies
2. Double-click **`start.bat`** — starts the editor and opens your browser

### Mac

Open Terminal in the project folder, then run:

```bash
chmod +x install.sh start.sh
./install.sh
./start.sh
```

The editor opens at **http://localhost:3000/editor/**. Press `Ctrl+C` in the terminal to stop.

### Textures (Optional)

Textures are not included in the repo. The editor works fine without them — textures only affect the per-cell texture painting feature and prop rendering.

The install script (`install.bat` / `./install.sh`) prompts you to download textures after installing dependencies. You can re-run it at any time to download more. There are two options:

- **Required** — only the textures used by built-in props and example maps
- **All** — the full [Polyhaven](https://polyhaven.com) library (700+, free CC0)

To download outside the install script:

```bash
node tools/download-textures.js --required
node tools/download-textures.js --all
node tools/download-textures.js --check   # check what's missing, no download
```

---

## Two Ways to Make Maps

### 1. Write a `.map` File

Describe your dungeon in a plain text file:

```
---
name: The Forgotten Crypt
theme: stone-dungeon
compassRose: true
scale: true
border: true
---

....AAA....
....AAA....
...BBBBB...
...BBBBB...
CCCBBBBBDDD
CCCBBBBBDDD
CCCEEEEEDDD
...EEEEE...
...EEEEE...

legend:
  A: A1
  B: A2
  C: A3
  D: A4
  E: A5

doors:
  3,4 east: door
  7,4 west: door
  3,6 east: door
  7,6 west: door
  4,2 south: door
```

Build it:

```bash
node build_map.js my-dungeon.map
```

Outputs `my-dungeon.json` and `my-dungeon.png`. Use `--svg` for vector output, `--watch` to auto-rebuild on save.

### 2. Use the Visual Editor

Start the server (`start.bat` / `./start.sh`) and open **http://localhost:3000/editor/**.

The editor has 14 tools: **Room, Paint, Wall, Door, Label, Stairs, Trim, Select, Prop, Light, Fill, Erase, Border, Bridge** — with full undo/redo, pan/zoom, and multi-level support. Maps save and load as JSON and can be exported back to `.map` format.

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

Individual colors can be overridden with `themeOverrides` in the `.map` header.

---

## Examples

A reference map is in [`examples/`](examples/):

| Example | Description |
|---|---|
| `island` | Coastal island encounter — water fills, rounded trims, 40+ props, lights, per-cell textures |

Build it:

```bash
node build_map.js examples/island.map
```

Or render the pre-compiled JSON directly:

```bash
node generate_dungeon.js examples/island.json
```

See [examples/examples.md](examples/examples.md) for a full breakdown of every feature it demonstrates.

---

## Documentation

Full reference for the `.map` format, all options, validation errors, and CLI flags: **[guide.md](guide.md)**

Topics covered:
- Complete `.map` file format (header, grid, legend, doors, trims, stairs, fills, props)
- All 16 theme names and color properties
- Room sizing for combat encounters
- Room numbering conventions
- Multi-level dungeon syntax
- Compiler validation errors and common mistakes

---

## Requirements

- Node.js 18 or newer ([nodejs.org](https://nodejs.org/))
- No other installs needed — all dependencies are bundled via `npm install`
