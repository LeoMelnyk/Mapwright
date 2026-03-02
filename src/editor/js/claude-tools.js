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
    description: 'Place stairs defined by 3 corner points in grid-corner coordinates. P1→P2 is the base edge; P3 sets the depth/shape.',
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
    description: 'Place a light source at world-feet coordinates (x = col * gridSize, y = row * gridSize). Use preset names like "torch", "candle", "brazier".',
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
    description: 'Flood-fill a texture starting from a cell, spreading to all connected cells with the same texture. Useful for painting large areas like dungeon floors or water.',
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
    description: 'Place a bridge defined by 3 corner points (same coordinate system as addStairs). P1→P2 is the base edge; P3 sets depth. Good for crossing pits, chasms, or water.',
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
];

/**
 * Execute a single tool call against window.editorAPI.
 * Returns the API result (or an error object).
 */
export function executeTool(name, input) {
  if (!window.editorAPI) return { error: 'editorAPI not available' };
  const fn = window.editorAPI[name];
  if (typeof fn !== 'function') return { error: `Unknown tool: ${name}` };

  try {
    // Most tools take positional args matching the schema property order.
    // Reconstruct the call based on known tool signatures.
    switch (name) {
      case 'getMapInfo':    return fn();
      case 'listProps':     return fn();
      case 'newMap':        return fn(input.name, input.rows, input.cols, input.gridSize, input.theme);
      case 'createRoom':    return fn(input.r1, input.c1, input.r2, input.c2, input.mode);
      case 'setLabel': {
        if (!/^[A-Z]\d+$/.test(String(input.text))) {
          return { error: `setLabel only accepts {Letter}{Number} format (e.g. A1, B3). Got: "${input.text}". Use the "Next room label" shown in the map context.` };
        }
        return fn(input.row, input.col, input.text);
      }
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
      case 'mergeRooms':       return fn(input.label1, input.label2);
      case 'createTrim':       return fn(input.r1, input.c1, input.r2, input.c2, input.options);
      case 'listTextures':      return fn();
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
      case 'getBridges':        return fn();
      case 'linkStairs':        return fn(input.r1, input.c1, input.r2, input.c2);
      case 'getRoomContents':   return fn(input.label);
      case 'suggestPlacement':  return fn(input.rows, input.cols, input.adjacentTo);
      case 'createCorridor':    return fn(input.label1, input.label2, input.width);
      default:                  return { error: `No dispatch for tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}
