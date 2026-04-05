// Anthropic tool definitions for the Mapwright editor API.
// These let Claude read and modify dungeon maps directly via editorAPI.

export const TOOL_DEFINITIONS = [
  {
    name: 'getMapInfo',
    description: 'Get current map metadata: name, dimensions, theme, room count, etc. Call this first to understand the current state of the map.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'newMap',
    description: 'Create a new empty dungeon map, replacing the current one.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Dungeon name' },
        rows: { type: 'integer', description: 'Grid height in cells' },
        cols: { type: 'integer', description: 'Grid width in cells' },
        gridSize: { type: 'integer', description: 'Feet per grid square (default 5)' },
        theme: { type: 'string', description: 'Theme name, e.g. "stone-dungeon", "crypt", "earth-cave", "ice-cave", "volcanic", "arcane"' },
      },
      required: ['name', 'rows', 'cols'],
    },
  },
  {
    name: 'createRoom',
    description: 'Create a walled rectangular room. Coordinates are row, col (0-indexed, row 0 = top). Use mode "merge" when adding a room adjacent to an existing one to avoid double walls.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer', description: 'Top row' },
        c1: { type: 'integer', description: 'Left col' },
        r2: { type: 'integer', description: 'Bottom row (inclusive)' },
        c2: { type: 'integer', description: 'Right col (inclusive)' },
        mode: { type: 'string', enum: ['room', 'merge'], description: '"room" walls all edges (default). "merge" only walls edges facing void.' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'setLabel',
    description: 'Set a room reference label at a cell. MUST be {Letter}{Number} format (e.g. "A1", "B3", "C12") — NO descriptive names like "Guard Room". The next available label is shown in the map context as "Next room label". Place at the cell closest to the room center.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        text: { type: 'string', description: 'Room label in {Letter}{Number} format, e.g. "A1". Use the "Next room label" value from the map context.' },
      },
      required: ['row', 'col', 'text'],
    },
  },
  {
    name: 'setDoor',
    description: 'Place a door on a wall between two rooms. The door is placed on the shared wall. Use type "d" for a normal door, "s" for a secret door.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer', description: 'Row of the cell containing the wall' },
        col: { type: 'integer', description: 'Col of the cell containing the wall' },
        direction: { type: 'string', enum: ['north', 'south', 'east', 'west'], description: 'Which wall of the cell to place the door on' },
        type: { type: 'string', enum: ['d', 's'], description: '"d" = normal door (default), "s" = secret door' },
      },
      required: ['row', 'col', 'direction'],
    },
  },
  {
    name: 'setWall',
    description: 'Place a wall on a cell edge (and its reciprocal on the neighboring cell).',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'] },
      },
      required: ['row', 'col', 'direction'],
    },
  },
  {
    name: 'removeWall',
    description: 'Remove a wall from a cell edge (and its reciprocal).',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'] },
      },
      required: ['row', 'col', 'direction'],
    },
  },
  {
    name: 'setFill',
    description: 'Apply a fill type to a cell (difficult-terrain, pit, water, lava).',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        fillType: { type: 'string', enum: ['difficult-terrain', 'pit', 'water', 'lava'] },
        depth: { type: 'integer', description: 'Depth 1-3 for water/lava (default 1)' },
      },
      required: ['row', 'col', 'fillType'],
    },
  },
  {
    name: 'setFillRect',
    description: 'Apply a fill type to every cell in a rectangle (one undo step).',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
        fillType: { type: 'string', enum: ['difficult-terrain', 'pit', 'water', 'lava'] },
        depth: { type: 'integer', description: 'Depth 1-3 for water/lava (default 1)' },
      },
      required: ['r1', 'c1', 'r2', 'c2', 'fillType'],
    },
  },
  {
    name: 'setTheme',
    description: 'Change the visual theme of the map.',
    input_schema: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: 'Theme name: "stone-dungeon", "crypt", "earth-cave", "ice-cave", "water-temple", "underdark", "volcanic", "swamp", "desert", "dirt", "grasslands", "snow-tundra", "arcane", "alien", "blue-parchment", "sepia-parchment"' },
      },
      required: ['theme'],
    },
  },
  {
    name: 'setName',
    description: 'Set the dungeon name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'setFeature',
    description: 'Toggle a map decoration feature on or off.',
    input_schema: {
      type: 'object',
      properties: {
        feature: { type: 'string', enum: ['grid', 'compass', 'scale', 'border'] },
        enabled: { type: 'boolean' },
      },
      required: ['feature', 'enabled'],
    },
  },
  {
    name: 'getCellInfo',
    description: 'Inspect a specific cell to see its walls, doors, fill, label, and props.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'getRoomBounds',
    description: 'Get the bounding box and center of a labeled room. Use to find good positions for doors, props, and labels.',
    input_schema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'Room label text, e.g. "A1"' } },
      required: ['label'],
    },
  },
  {
    name: 'findWallBetween',
    description: 'Find all wall positions on the shared boundary between two labeled rooms. Use to pick the best door location.',
    input_schema: {
      type: 'object',
      properties: {
        label1: { type: 'string' },
        label2: { type: 'string' },
      },
      required: ['label1', 'label2'],
    },
  },
  {
    name: 'addStairs',
    description: 'Place stairs using 3 corner points (grid-corner coordinates, not cell centers). P1→P2 = base edge (hatch lines start here); P3 = depth target. Examples: 3-cell rectangle stair facing south — p1r=5,p1c=2, p2r=5,p2c=5, p3r=4,p3c=5. Single-cell stair — p1r=5,p1c=5, p2r=5,p2c=6, p3r=4,p3c=6.',
    input_schema: {
      type: 'object',
      properties: {
        p1r: { type: 'integer' }, p1c: { type: 'integer' },
        p2r: { type: 'integer' }, p2c: { type: 'integer' },
        p3r: { type: 'integer' }, p3c: { type: 'integer' },
      },
      required: ['p1r', 'p1c', 'p2r', 'p2c', 'p3r', 'p3c'],
    },
  },
  {
    name: 'placeProp',
    description: 'Place a furniture/object prop at a cell. Call listProps first to see available prop names.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        propType: { type: 'string', description: 'Prop name, e.g. "map-table", "throne", "bone-pile", "torch-wall"' },
        facing: { type: 'integer', enum: [0, 90, 180, 270], description: 'Rotation in degrees (default 0)' },
      },
      required: ['row', 'col', 'propType'],
    },
  },
  {
    name: 'listProps',
    description: 'List all available prop types organized by category. Call this before using placeProp to see valid prop names.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'placeLight',
    description: 'Place a light source at world-feet coordinates. IMPORTANT: x = col × gridSize, y = row × gridSize — NOT raw row/col. For a 5ft grid, cell (row=3, col=5) → x=25, y=15. Use preset names like "torch", "candle", "brazier" — call listLightPresets for all names.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'World X in feet (col * gridSize)' },
        y: { type: 'number', description: 'World Y in feet (row * gridSize)' },
        config: {
          type: 'object',
          description: 'Light config. Use preset: "torch" to apply preset defaults.',
          properties: {
            preset: { type: 'string', description: 'Preset name: "torch", "candle", "brazier", "lantern", etc.' },
            radius: { type: 'number' },
            color: { type: 'string' },
            intensity: { type: 'number' },
          },
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mergeRooms',
    description: 'Remove all walls on the shared boundary between two labeled rooms, merging them into one open space.',
    input_schema: {
      type: 'object',
      properties: {
        label1: { type: 'string' },
        label2: { type: 'string' },
      },
      required: ['label1', 'label2'],
    },
  },
  {
    name: 'createTrim',
    description: 'Cut a diagonal corner from a room. r1,c1 is the corner tip; r2,c2 determines the size.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer', description: 'Corner tip row' },
        c1: { type: 'integer', description: 'Corner tip col' },
        r2: { type: 'integer', description: 'Size reference row' },
        c2: { type: 'integer', description: 'Size reference col' },
        options: {
          type: 'object',
          properties: {
            corner: { type: 'string', enum: ['auto', 'nw', 'ne', 'sw', 'se'] },
            round: { type: 'boolean' },
            inverted: { type: 'boolean' },
          },
        },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'listTextures',
    description: 'List all available texture IDs with display names and categories. Call this before using setTexture or setTextureRect to find valid texture IDs.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'setTexture',
    description: 'Apply a texture to a single cell. Call listTextures first to find valid texture IDs.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        textureId: { type: 'string', description: 'Texture ID from listTextures' },
        opacity: { type: 'number', description: 'Opacity 0.0–1.0 (default 1.0)' },
      },
      required: ['row', 'col', 'textureId'],
    },
  },
  {
    name: 'setTextureRect',
    description: 'Apply a texture to every cell in a rectangle. One undo step. Call listTextures first to find valid texture IDs.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
        textureId: { type: 'string', description: 'Texture ID from listTextures' },
        opacity: { type: 'number', description: 'Opacity 0.0–1.0 (default 1.0)' },
      },
      required: ['r1', 'c1', 'r2', 'c2', 'textureId'],
    },
  },
  {
    name: 'floodFillTexture',
    description: 'Flood-fill a texture starting from a cell, spreading to all connected non-void cells that share the same current texture state (including cells with no texture). Click any cell in a room to paint the entire connected floor area in one call. Call listTextures first for valid IDs.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        textureId: { type: 'string', description: 'Texture ID from listTextures' },
        opacity: { type: 'number', description: 'Opacity 0.0–1.0 (default 1.0)' },
      },
      required: ['row', 'col', 'textureId'],
    },
  },
  {
    name: 'removeTexture',
    description: 'Remove the texture from a single cell.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'removeTextureRect',
    description: 'Remove textures from every cell in a rectangle. One undo step.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'paintCell',
    description: 'Paint a single cell as a floor (makes it non-void). Use this to carve irregular room shapes or corridors cell by cell.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'paintRect',
    description: 'Paint all cells in a rectangle as floor (makes them non-void). Use for open areas without walls.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'eraseCell',
    description: 'Erase a single cell back to void (removes all walls, fill, props, and label from that cell).',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'eraseRect',
    description: 'Erase all cells in a rectangle back to void. One undo step.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'removeDoor',
    description: 'Remove a door from a wall, reverting it to a plain wall.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
      },
      required: ['row', 'col', 'direction'],
    },
  },
  {
    name: 'removeLabel',
    description: 'Remove the label from a cell.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'removeFill',
    description: 'Remove the fill (water, pit, lava, difficult terrain) from a single cell.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'removeFillRect',
    description: 'Remove fill from every cell in a rectangle. One undo step.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'rotateProp',
    description: 'Rotate an already-placed prop 90° clockwise. Returns the new facing angle.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'setHazard',
    description: 'Mark or unmark a cell as a hazard (shown with a warning indicator on the map).',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
        enabled: { type: 'boolean', description: 'true to mark hazard, false to clear it (default true)' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'setHazardRect',
    description: 'Mark or unmark every cell in a rectangle as a hazard. One undo step.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
        enabled: { type: 'boolean', description: 'true to mark hazard, false to clear it (default true)' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'addBridge',
    description: 'Place a bridge using 3 corner points (same system as addStairs). P1→P2 = bridge span; P3 = depth (typically 1 row beyond P2). Example: 3-cell wood bridge spanning east across row 5 — type="wood", p1r=5,p1c=3, p2r=5,p2c=6, p3r=4,p3c=6. Good for crossing water, pits, or chasms.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['wood', 'stone', 'rope', 'dock'], description: 'Bridge material' },
        p1r: { type: 'integer' }, p1c: { type: 'integer' },
        p2r: { type: 'integer' }, p2c: { type: 'integer' },
        p3r: { type: 'integer' }, p3c: { type: 'integer' },
      },
      required: ['type', 'p1r', 'p1c', 'p2r', 'p2c', 'p3r', 'p3c'],
    },
  },
  {
    name: 'removeBridge',
    description: 'Remove the bridge whose definition overlaps the given cell.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'getBridges',
    description: 'List all bridges currently on the map.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'linkStairs',
    description: 'Link two stair objects together (they share a letter label like A, B, C to show they connect). Pass the row/col of each stair.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer', description: 'Row of first stair' },
        c1: { type: 'integer', description: 'Col of first stair' },
        r2: { type: 'integer', description: 'Row of second stair' },
        c2: { type: 'integer', description: 'Col of second stair' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  {
    name: 'getRoomContents',
    description: 'Get all contents of a labeled room: props, fills (water/pit/lava), textures, and doors. Use this before modifying a room to avoid duplicating existing elements.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Room label, e.g. "A1"' },
      },
      required: ['label'],
    },
  },
  {
    name: 'suggestPlacement',
    description: 'Find a free rectangular area of the given size on the map. Use this before createRoom to avoid placing rooms in occupied space. Returns { r1, c1, r2, c2 } of a valid placement.',
    input_schema: {
      type: 'object',
      properties: {
        rows: { type: 'integer', description: 'Height of the room in cells' },
        cols: { type: 'integer', description: 'Width of the room in cells' },
        adjacentTo: { type: 'string', description: 'Optional room label — if given, prefers placements adjacent to that room' },
      },
      required: ['rows', 'cols'],
    },
  },
  {
    name: 'createCorridor',
    description: 'Create a walled 2-cell-wide corridor connecting two labeled rooms. Rooms must be axis-aligned with perpendicular overlap. Automatically assigns the next room label and places doors at both ends. Use this instead of manually computing corridor coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        label1: { type: 'string', description: 'First room label' },
        label2: { type: 'string', description: 'Second room label' },
        width: { type: 'integer', description: 'Corridor width in cells (default 2)' },
      },
      required: ['label1', 'label2'],
    },
  },
  // ── Props ─────────────────────────────────────────────────────────────────
  {
    name: 'removeProp',
    description: 'Remove the prop at a cell.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  {
    name: 'removePropsInRect',
    description: 'Remove all props from every cell in a rectangle. One undo step.',
    input_schema: {
      type: 'object',
      properties: {
        r1: { type: 'integer' }, c1: { type: 'integer' },
        r2: { type: 'integer' }, c2: { type: 'integer' },
      },
      required: ['r1', 'c1', 'r2', 'c2'],
    },
  },
  // ── Stairs ────────────────────────────────────────────────────────────────
  {
    name: 'removeStairs',
    description: 'Remove the stairs at or overlapping a given cell.',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        col: { type: 'integer' },
      },
      required: ['row', 'col'],
    },
  },
  // ── Lighting ─────────────────────────────────────────────────────────────
  {
    name: 'listLightPresets',
    description: 'List all available light presets (torch, candle, brazier, lantern, etc.) with their properties. Call this before placeLight to find valid preset names.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getLights',
    description: 'List all lights currently on the map with their IDs, positions, colors, and radii.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'removeLight',
    description: 'Remove a light by its numeric ID (use getLights to find IDs).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Light ID from getLights' },
      },
      required: ['id'],
    },
  },
  {
    name: 'setAmbientLight',
    description: 'Set the ambient light level (0.0 = pitch black, 1.0 = fully lit, 0.1–0.3 typical for a dark dungeon). Only affects maps with lighting enabled.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Ambient light 0.0–1.0' },
      },
      required: ['level'],
    },
  },
  {
    name: 'setLightingEnabled',
    description: 'Enable or disable the lighting system for the map.',
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
      },
      required: ['enabled'],
    },
  },
  // ── Label style ───────────────────────────────────────────────────────────
  {
    name: 'setLabelStyle',
    description: 'Set the room label rendering style.',
    input_schema: {
      type: 'object',
      properties: {
        style: { type: 'string', enum: ['circled', 'plain', 'bold'], description: '"circled" = number in a circle (default), "plain" = plain text, "bold" = bold text' },
      },
      required: ['style'],
    },
  },
  // ── Themes ────────────────────────────────────────────────────────────────
  {
    name: 'listThemes',
    description: 'List all available themes with their display names.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  // ── Levels ────────────────────────────────────────────────────────────────
  {
    name: 'getLevels',
    description: 'List all levels in a multi-level map with their names, startRow, and numRows.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'addLevel',
    description: 'Add a new level to the map below the existing ones.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Level name, e.g. "Basement"' },
        numRows: { type: 'integer', description: 'Height of the new level in rows (default 15)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'renameLevel',
    description: 'Rename an existing level.',
    input_schema: {
      type: 'object',
      properties: {
        levelIndex: { type: 'integer', description: '0-based level index' },
        name: { type: 'string', description: 'New level name' },
      },
      required: ['levelIndex', 'name'],
    },
  },
  {
    name: 'resizeLevel',
    description: 'Change the row height of an existing level, adding or removing void rows at the bottom.',
    input_schema: {
      type: 'object',
      properties: {
        levelIndex: { type: 'integer', description: '0-based level index' },
        numRows: { type: 'integer', description: 'New row count' },
      },
      required: ['levelIndex', 'numRows'],
    },
  },
  // ── Spatial utilities ─────────────────────────────────────────────────────
  {
    name: 'findCellByLabel',
    description: 'Find the row/col of the cell containing a given room label text (e.g. "A1"). Returns { row, col } or null.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Room label text, e.g. "A1"' },
      },
      required: ['label'],
    },
  },
  {
    name: 'shiftCells',
    description: 'Shift all map content by dr rows and dc cols. Expands the grid if needed. Use this to reposition the entire dungeon on the canvas.',
    input_schema: {
      type: 'object',
      properties: {
        dr: { type: 'integer', description: 'Row offset (positive = shift down)' },
        dc: { type: 'integer', description: 'Col offset (positive = shift right)' },
      },
      required: ['dr', 'dc'],
    },
  },
  // ── AI convenience tools ──────────────────────────────────────────────────
  {
    name: 'listRooms',
    description: 'List all labeled rooms on the map with their bounding boxes and centers. Returns [{label, r1, c1, r2, c2, center:{row,col}}]. Use this to find room positions before placing props, lights, or routing corridors.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'placeLightInRoom',
    description: 'Place a light at the center of a labeled room. Handles world-feet coordinate conversion automatically — no math needed. Use a preset name like "torch", "candle", "brazier" — call listLightPresets for valid names.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Room label, e.g. "A1"' },
        preset: { type: 'string', description: 'Light preset name: "torch", "candle", "brazier", "lantern", etc.' },
      },
      required: ['label', 'preset'],
    },
  },
];

// All tools are exported as TOOL_DEFINITIONS. CORE_TOOL_DEFINITIONS kept for
// backwards-compatibility (Puppeteer scripts, tests) but the chat panel now
// sends the full TOOL_DEFINITIONS set.
const CORE_TOOL_NAMES = new Set([
  'getMapInfo',
]);
export const CORE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(t => CORE_TOOL_NAMES.has(t.name));

// ── Tool execution ────────────────────────────────────────────────────────────

/** Validate that required fields are present. Returns an error string or null. */
function requireFields(input: any, ...fields: any[]) {
  for (const f of fields) {
    if (input[f] === undefined || input[f] === null) {
      return `Missing required argument "${f}". Got: ${JSON.stringify(input)}`;
    }
  }
  return null;
}

const VALID_DIRECTIONS = new Set(['north', 'south', 'east', 'west']);
const VALID_FILLS = new Set(['difficult-terrain', 'pit', 'water', 'lava']);

/**
 * Execute a single tool call against window.editorAPI.
 * Returns the API result (or an error object with a descriptive message).
 */
export function executeTool(name: string, input: Record<string, any>): any {
  if (!(window as any).editorAPI) return { error: 'editorAPI not available' };
  const fn = (window as any).editorAPI[name]?.bind((window as any).editorAPI);
  if (typeof fn !== 'function') return { error: `Unknown tool: "${name}". Check tool name spelling.` };

  // Per-tool argument validation — gives the model actionable error messages
  let err;
  switch (name) {
    case 'createRoom':
      err = requireFields(input, 'r1', 'c1', 'r2', 'c2');
      if (err) return { error: `createRoom: ${err}` };
      if (input.r1 > input.r2) return { error: `createRoom: r1 (${input.r1}) must be ≤ r2 (${input.r2})` };
      if (input.c1 > input.c2) return { error: `createRoom: c1 (${input.c1}) must be ≤ c2 (${input.c2})` };
      break;
    case 'setLabel':
      err = requireFields(input, 'row', 'col', 'text');
      if (err) return { error: `setLabel: ${err}` };
      if (!/^[A-Z]\d+$/.test(String(input.text))) {
        return { error: `setLabel: "${input.text}" is not valid. Must be {UppercaseLetter}{Number} format (e.g. A1, B3). Use the "Next room label" value from the map context.` };
      }
      break;
    case 'setDoor': case 'removeDoor':
      err = requireFields(input, 'row', 'col', 'direction');
      if (err) return { error: `${name}: ${err}` };
      if (!VALID_DIRECTIONS.has(input.direction)) {
        return { error: `${name}: direction must be "north", "south", "east", or "west". Got "${input.direction}".` };
      }
      break;
    case 'setWall': case 'removeWall':
      err = requireFields(input, 'row', 'col', 'direction');
      if (err) return { error: `${name}: ${err}` };
      if (!VALID_DIRECTIONS.has(input.direction) && input.direction !== 'nw-se' && input.direction !== 'ne-sw') {
        return { error: `${name}: direction must be "north", "south", "east", "west", "nw-se", or "ne-sw". Got "${input.direction}".` };
      }
      break;
    case 'setFill':
      err = requireFields(input, 'row', 'col', 'fillType');
      if (err) return { error: `setFill: ${err}` };
      if (!VALID_FILLS.has(input.fillType)) {
        return { error: `setFill: fillType must be one of: ${[...VALID_FILLS].join(', ')}. Got "${input.fillType}".` };
      }
      break;
    case 'setFillRect':
      err = requireFields(input, 'r1', 'c1', 'r2', 'c2', 'fillType');
      if (err) return { error: `setFillRect: ${err}` };
      if (!VALID_FILLS.has(input.fillType)) {
        return { error: `setFillRect: fillType must be one of: ${[...VALID_FILLS].join(', ')}. Got "${input.fillType}".` };
      }
      break;
    case 'setTextureRect': case 'setTexture':
      err = requireFields(input, 'textureId');
      if (err) return { error: `${name}: ${err}. Call listTextures first to get valid IDs.` };
      break;
    case 'placeProp':
      err = requireFields(input, 'row', 'col', 'propType');
      if (err) return { error: `placeProp: ${err}. Call listProps first to get valid prop names.` };
      break;
    case 'getRoomBounds': case 'getRoomContents': case 'removeLabel':
      err = requireFields(input, 'label');
      if (err) return { error: `${name}: ${err}` };
      break;
    case 'findWallBetween': case 'mergeRooms': case 'createCorridor':
      err = requireFields(input, 'label1', 'label2');
      if (err) return { error: `${name}: ${err}` };
      break;
    case 'suggestPlacement':
      err = requireFields(input, 'rows', 'cols');
      if (err) return { error: `suggestPlacement: ${err}` };
      break;
    case 'getCellInfo': case 'removeFill': case 'removeTexture': case 'rotateProp':
    case 'eraseCell': case 'paintCell': case 'removeBridge': case 'removeLabel':
    case 'removeProp': case 'removeStairs':
      err = requireFields(input, 'row', 'col');
      if (err) return { error: `${name}: ${err}` };
      break;
    case 'findCellByLabel':
      err = requireFields(input, 'label');
      if (err) return { error: `findCellByLabel: ${err}` };
      break;
    case 'placeLightInRoom':
      err = requireFields(input, 'label', 'preset');
      if (err) return { error: `placeLightInRoom: ${err}` };
      break;
    case 'removeLight':
      err = requireFields(input, 'id');
      if (err) return { error: `removeLight: ${err}` };
      break;
    case 'setAmbientLight':
      err = requireFields(input, 'level');
      if (err) return { error: `setAmbientLight: ${err}` };
      if (typeof input.level !== 'number' || input.level < 0 || input.level > 1)
        return { error: `setAmbientLight: level must be a number 0.0–1.0. Got ${input.level}` };
      break;
    case 'renameLevel':
      err = requireFields(input, 'levelIndex', 'name');
      if (err) return { error: `renameLevel: ${err}` };
      break;
    case 'resizeLevel':
      err = requireFields(input, 'levelIndex', 'numRows');
      if (err) return { error: `resizeLevel: ${err}` };
      break;
    case 'addLevel':
      err = requireFields(input, 'name');
      if (err) return { error: `addLevel: ${err}` };
      break;
    case 'shiftCells':
      err = requireFields(input, 'dr', 'dc');
      if (err) return { error: `shiftCells: ${err}` };
      break;
  }

  try {
    switch (name) {
      case 'getMapInfo':    return fn();
      case 'listProps':     return fn();
      case 'listTextures':  return fn();
      case 'getBridges':    return fn();
      case 'newMap':        return fn(input.name, input.rows, input.cols, input.gridSize, input.theme);
      case 'createRoom': {
        const roomResult = fn(input.r1, input.c1, input.r2, input.c2, input.mode);
        // Honour optional label field — model often passes label directly to createRoom.
        // Auto-apply at room center so createCorridor can find the room immediately.
        if (roomResult?.success && input.label && /^[A-Z]\d+$/.test(String(input.label))) {
          try {
            const cr = Math.floor((input.r1 + input.r2) / 2);
            const cc = Math.floor((input.c1 + input.c2) / 2);
            (window as any).editorAPI.setLabel(cr, cc, String(input.label));
          } catch { /* room may not have center cell yet — model should call setLabel separately */ }
        }
        return roomResult;
      }
      case 'setLabel':      return fn(input.row, input.col, input.text);
      case 'setDoor':       return fn(input.row, input.col, input.direction, input.type);
      case 'setWall':       return fn(input.row, input.col, input.direction);
      case 'removeWall':    return fn(input.row, input.col, input.direction);
      case 'setFill':       return fn(input.row, input.col, input.fillType, input.depth);
      case 'setFillRect':   return fn(input.r1, input.c1, input.r2, input.c2, input.fillType, input.depth);
      case 'setTheme':      return fn(input.theme);
      case 'setName':       return fn(input.name);
      case 'setFeature':    return fn(input.feature, input.enabled);
      case 'getCellInfo':   return fn(input.row, input.col);
      case 'getRoomBounds': return fn(input.label);
      case 'findWallBetween': return fn(input.label1, input.label2);
      case 'addStairs':     return fn(input.p1r, input.p1c, input.p2r, input.p2c, input.p3r, input.p3c);
      case 'placeProp':     return fn(input.row, input.col, input.propType, input.facing);
      case 'placeLight':    return fn(input.x, input.y, input.config);
      case 'mergeRooms':    return fn(input.label1, input.label2);
      case 'createTrim':    return fn(input.r1, input.c1, input.r2, input.c2, input.options);
      case 'setTexture':        return fn(input.row, input.col, input.textureId, input.opacity);
      case 'setTextureRect':    return fn(input.r1, input.c1, input.r2, input.c2, input.textureId, input.opacity);
      case 'floodFillTexture':  return fn(input.row, input.col, input.textureId, input.opacity);
      case 'removeTexture':     return fn(input.row, input.col);
      case 'removeTextureRect': return fn(input.r1, input.c1, input.r2, input.c2);
      case 'paintCell':         return fn(input.row, input.col);
      case 'paintRect':         return fn(input.r1, input.c1, input.r2, input.c2);
      case 'eraseCell':         return fn(input.row, input.col);
      case 'eraseRect':         return fn(input.r1, input.c1, input.r2, input.c2);
      case 'removeDoor':        return fn(input.row, input.col, input.direction);
      case 'removeLabel':       return fn(input.row, input.col);
      case 'removeFill':        return fn(input.row, input.col);
      case 'removeFillRect':    return fn(input.r1, input.c1, input.r2, input.c2);
      case 'rotateProp':        return fn(input.row, input.col);
      case 'setHazard':         return fn(input.row, input.col, input.enabled);
      case 'setHazardRect':     return fn(input.r1, input.c1, input.r2, input.c2, input.enabled);
      case 'addBridge':         return fn(input.type, input.p1r, input.p1c, input.p2r, input.p2c, input.p3r, input.p3c);
      case 'removeBridge':      return fn(input.row, input.col);
      case 'linkStairs':        return fn(input.r1, input.c1, input.r2, input.c2);
      case 'getRoomContents':   return fn(input.label);
      case 'suggestPlacement':  return fn(input.rows, input.cols, input.adjacentTo);
      case 'createCorridor':    return fn(input.label1, input.label2, input.width);
      // Props
      case 'removeProp':        return fn(input.row, input.col);
      case 'removePropsInRect': return fn(input.r1, input.c1, input.r2, input.c2);
      // Stairs
      case 'removeStairs':      return fn(input.row, input.col);
      // Lighting
      case 'listLightPresets':  return fn();
      case 'getLights':         return fn();
      case 'removeLight':       return fn(input.id);
      case 'setAmbientLight':   return fn(input.level);
      case 'setLightingEnabled': return fn(input.enabled);
      // Label style
      case 'setLabelStyle':     return fn(input.style);
      // Themes
      case 'listThemes':        return fn();
      // Levels
      case 'getLevels':         return fn();
      case 'addLevel':          return fn(input.name, input.numRows);
      case 'renameLevel':       return fn(input.levelIndex, input.name);
      case 'resizeLevel':       return fn(input.levelIndex, input.numRows);
      // Spatial
      case 'findCellByLabel':   return fn(input.label);
      case 'shiftCells':        return fn(input.dr, input.dc);
      // AI convenience
      case 'listRooms':         return fn();
      case 'placeLightInRoom':  return fn(input.label, input.preset);
      default:                  return { error: `No dispatch for tool: "${name}". This tool exists but has no handler — report this bug.` };
    }
  } catch (err) {
    return { error: `${name} failed: ${(err as any).message}` };
  }
}
