import { Grid, parseGrid, buildGrid, computeBorders } from './grid.js';
import { cellKey, parseCellKey } from '../util/index.js';
import { parseMapFile } from './parse.js';
import { applyTrims } from './trims.js';
import { placeDoors, placeLabels, placeStairs, validateReachability, isValidStairCell, findBestStairCell } from './features.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Apply a fill type to a cell. 'hazard' and legacy 'difficult-terrain' set cell.hazard; others set cell.fill. */
function applyFill(cell, fillType) {
  if (fillType === 'hazard' || fillType === 'difficult-terrain') {
    cell.hazard = true;
  } else {
    cell.fill = fillType;
  }
}

// ── Main Compilation ─────────────────────────────────────────────────

/**
 * Compile a single level: parseGrid → buildGrid → computeBorders → applyTrims → placeDoors → placeLabels.
 * Returns { grid, rooms, diagonals, numRows, numCols }.
 */
function compileLevel(levelData, levelIndex) {
  const { name, gridLines, legend, doors, trims, fills, cellFills, props, textures, lights, bridges } = levelData;
  const prefix = name ? `Level ${levelIndex + 1} (${name})` : '';

  const { rooms, numRows, numCols } = parseGrid(gridLines, legend);

  // Prefix corridor IDs to avoid collisions across levels
  if (levelIndex > 0) {
    const remap = new Map();
    for (const [id, room] of rooms) {
      if (id.startsWith('_c')) {
        const newId = `_L${levelIndex + 1}${id}`;
        remap.set(id, newId);
        room.id = newId;
      }
    }
    for (const [oldId, newId] of remap) {
      rooms.set(newId, rooms.get(oldId));
      rooms.delete(oldId);
    }
  }

  const grid = buildGrid(rooms, numRows, numCols);
  computeBorders(grid);

  // Resolve cell-coordinate trims (@row,col keys) to room IDs
  const resolvedTrims = { ...trims };
  for (const key of Object.keys(resolvedTrims)) {
    if (!key.startsWith('@')) continue;
    const match = key.match(/^@(\d+),(\d+)$/);
    if (!match) continue;
    const row = parseInt(match[1]), col = parseInt(match[2]);
    const roomId = grid.getRoom(row, col);
    if (!roomId) {
      console.warn(`${prefix ? prefix + ': ' : ''}⚠ Cell-coordinate trim at ${row},${col}: cell is not in any room. Skipping.`);
      delete resolvedTrims[key];
      continue;
    }
    // Merge into room's trims (may already have trims from label-based syntax)
    if (resolvedTrims[roomId]) {
      resolvedTrims[roomId] = [...resolvedTrims[roomId], ...resolvedTrims[key]];
    } else {
      resolvedTrims[roomId] = resolvedTrims[key];
    }
    delete resolvedTrims[key];
  }

  const { diagonals, totalVoided, trimDetails } = applyTrims(grid, rooms, resolvedTrims);
  placeDoors(grid, doors);
  placeLabels(grid, rooms, diagonals);

  // Apply fills to room cells
  if (fills) {
    for (const [label, fillType] of Object.entries(fills)) {
      const room = rooms.get(label);
      if (!room) {
        console.warn(`${prefix ? prefix + ': ' : ''}⚠ Fill references unknown room '${label}' — check your fills: section for typos. Skipping.`);
        continue;
      }
      for (const key of room.cells) {
        const [r, c] = parseCellKey(key);
        const cell = grid.cells[r]?.[c];
        if (cell) applyFill(cell, fillType);
      }
    }
  }

  const indent = prefix ? '    ' : '  ';

  // Apply per-cell fills (in addition to room-label fills above)
  if (cellFills && cellFills.length > 0) {
    for (const { row, col, fill } of cellFills) {
      if (!grid.inBounds(row, col)) continue;
      const cell = grid.cells[row]?.[col];
      if (cell) applyFill(cell, fill);
    }
  }

  // Apply props to cells
  if (props && props.length > 0) {
    let placed = 0;
    for (const p of props) {
      const { row, col, type, facing } = p;
      if (!grid.inBounds(row, col)) {
        console.warn(`${prefix ? prefix + ': ' : ''}⚠ Prop '${type}' at ${row},${col}: out of bounds (grid is ${grid.numRows}×${grid.numCols}). Skipping.`);
        continue;
      }
      if (!grid.cells[row][col]) {
        console.warn(`${prefix ? prefix + ': ' : ''}⚠ Prop '${type}' at ${row},${col}: void cell — paint the cell first, then place the prop. Skipping.`);
        continue;
      }
      // Store type and facing; span is resolved by the renderer via prop catalog.
      grid.cells[row][col].prop = { type, facing };
      placed++;
    }
    if (placed > 0) console.log(`${indent}${placed} prop(s) placed`);
  }

  // Apply textures to cells
  if (textures && textures.length > 0) {
    for (const { row, col, texture, opacity } of textures) {
      if (!grid.inBounds(row, col)) continue;
      const cell = grid.cells[row]?.[col];
      if (cell) {
        cell.texture = texture;
        if (opacity !== 1.0) cell.textureOpacity = opacity;
      }
    }
  }

  const labeledCount = [...rooms.values()].filter(r => r.label).length;
  const corridorCount = [...rooms.values()].filter(r => !r.label).length;

  if (prefix) console.log(`  ${prefix}:`);
  console.log(`${indent}${labeledCount} labeled room(s), ${corridorCount} corridor(s), ${numCols}×${numRows} cells`);
  if (diagonals.size > 0) {
    const voidMsg = totalVoided > 0 ? ` (${totalVoided} cell(s) voided)` : '';
    console.log(`${indent}${diagonals.size} diagonal trim(s) applied${voidMsg}`);
    for (const d of trimDetails) {
      console.log(`${indent}  ${d.label}:${d.spec} — voided ${d.voidedCount}, hypotenuse at ${d.hypotenuseCoords.join(' ')}`);
    }
  }
  if (doors.length > 0) {
    console.log(`${indent}${doors.length} door(s) placed`);
  }

  return { grid, rooms, diagonals, numRows, numCols, lights, bridges: bridges || [] };
}

function compileMap(mapPath) {
  console.log(`Loading map: ${mapPath}`);

  const { header, levels } = parseMapFile(mapPath);
  const isMultiLevel = levels.length > 1;

  if (isMultiLevel) {
    console.log(`  ${levels.length} level(s)`);
  }

  // Compile each level independently
  const compiledLevels = levels.map((level, i) => compileLevel(level, i));

  // Compute row offsets for combining levels (1 void row between each level)
  const rowOffsets = [];
  let currentRow = 0;
  for (let i = 0; i < compiledLevels.length; i++) {
    rowOffsets.push(currentRow);
    currentRow += compiledLevels[i].numRows;
    if (i < compiledLevels.length - 1) currentRow += 1; // void separator row
  }

  // Determine combined grid dimensions
  const totalRows = currentRow;
  const totalCols = Math.max(...compiledLevels.map(l => l.numCols));

  // Build combined grid
  const combinedGrid = new Grid(totalRows, totalCols);
  const allRooms = new Map();

  for (let li = 0; li < compiledLevels.length; li++) {
    const { grid: levelGrid, rooms, numRows, numCols } = compiledLevels[li];
    const rowOffset = rowOffsets[li];

    // Copy cells into combined grid
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const cell = levelGrid.cells[r][c];
        if (!cell) continue;
        // Offset rounded trim arc center rows for the combined grid
        if (cell.trimArcCenterRow !== undefined) {
          cell.trimArcCenterRow += rowOffset;
        }
        combinedGrid.cells[r + rowOffset][c] = cell;

        const key = cellKey(r, c);
        const roomId = levelGrid.cellToRoom.get(key);
        const roomChar = levelGrid.cellToChar.get(key);
        if (roomId) {
          combinedGrid.cellToRoom.set(cellKey(r + rowOffset, c), roomId);
          combinedGrid.cellToChar.set(cellKey(r + rowOffset, c), roomChar);
        }
      }
    }

    // Merge rooms
    for (const [id, room] of rooms) {
      if (allRooms.has(id)) {
        throw new Error(`Duplicate room label '${id}' across levels. Use unique labels per level (e.g. A1, A2 for level 1; B1, B2 for level 2).`);
      }
      // Offset room cell keys for the combined grid
      const offsetCells = new Set();
      for (const key of room.cells) {
        const [r, c] = parseCellKey(key);
        offsetCells.add(cellKey(r + rowOffset, c));
      }
      allRooms.set(id, { ...room, cells: offsetCells });
    }
  }

  // Resolve and place stairs (supports both coordinate and room-relative syntax)
  // Cross-level linked stairs try to align at the same level-relative position
  // (same physical column in the building) before falling back to centroid placement.
  const allStairs = [];
  for (let li = 0; li < levels.length; li++) {
    const rowOffset = rowOffsets[li];
    for (const stair of levels[li].stairs) {
      const resolved = { type: stair.type };

      // Determine linked level info upfront
      let linkedLevelIndex = li;
      if (stair.linked) {
        linkedLevelIndex = stair.linked.level ? stair.linked.level - 1 : li;
        if (linkedLevelIndex < 0 || linkedLevelIndex >= levels.length) {
          throw new Error(`Stairs reference L${stair.linked.level} but only ${levels.length} level(s) exist`);
        }
      }
      const linkedRowOffset = rowOffsets[linkedLevelIndex];
      const crossLevel = stair.linked && (linkedLevelIndex !== li);

      // Resolve primary side
      if (stair.autoPlace) {
        let placed = false;
        // If cross-level and linked side is explicit, try to match its position
        if (crossLevel && stair.linked && !stair.linked.autoPlace) {
          const tryRow = stair.linked.row + rowOffset; // linked's level-relative row, on primary's level
          const tryCol = stair.linked.col;
          if (isValidStairCell(combinedGrid, allRooms, stair.room, tryRow, tryCol)) {
            resolved.col = tryCol;
            resolved.row = tryRow;
            placed = true;
          }
        }
        if (!placed) {
          const best = findBestStairCell(combinedGrid, allRooms, stair.room);
          resolved.col = best.col;
          resolved.row = best.row;
        }
        // Reserve this cell so other auto-placed stairs skip it
        if (!combinedGrid.cells[resolved.row][resolved.col].center) {
          combinedGrid.cells[resolved.row][resolved.col].center = {};
        }
        combinedGrid.cells[resolved.row][resolved.col].center._reserved = true;
      } else {
        resolved.col = stair.col;
        resolved.row = stair.row + rowOffset;
      }

      // Resolve linked side (if present)
      if (stair.linked) {
        const linked = stair.linked;

        if (linked.autoPlace) {
          let placed = false;
          // Try to match primary's level-relative position on linked level
          if (crossLevel) {
            const primaryLevelRelRow = resolved.row - rowOffset;
            const tryRow = primaryLevelRelRow + linkedRowOffset;
            const tryCol = resolved.col;
            if (isValidStairCell(combinedGrid, allRooms, linked.room, tryRow, tryCol)) {
              resolved.linkedCol = tryCol;
              resolved.linkedRow = tryRow;
              placed = true;
            }
          }
          if (!placed) {
            const best = findBestStairCell(combinedGrid, allRooms, linked.room);
            resolved.linkedCol = best.col;
            resolved.linkedRow = best.row;
          }
          if (!combinedGrid.cells[resolved.linkedRow][resolved.linkedCol].center) {
            combinedGrid.cells[resolved.linkedRow][resolved.linkedCol].center = {};
          }
          combinedGrid.cells[resolved.linkedRow][resolved.linkedCol].center._reserved = true;
        } else {
          resolved.linkedCol = linked.col;
          resolved.linkedRow = linked.row + linkedRowOffset;
        }
        resolved.linkedType = linked.type;
      }

      allStairs.push(resolved);
    }
  }

  // Clean up reservation markers before placing stairs
  for (const stair of allStairs) {
    for (const [r, c] of [[stair.row, stair.col], [stair.linkedRow, stair.linkedCol]]) {
      if (r === undefined || c === undefined) continue;
      const cell = combinedGrid.cells[r]?.[c];
      if (cell?.center?._reserved) {
        delete cell.center._reserved;
        if (Object.keys(cell.center).length === 0) delete cell.center;
      }
    }
  }

  placeStairs(combinedGrid, allStairs);
  if (allStairs.length > 0) {
    console.log(`  ${allStairs.length} stair(s) placed`);
  }

  // Print combined dimensions
  console.log(`  Grid: ${totalCols}×${totalRows} cells (${totalCols * header.gridSize}×${totalRows * header.gridSize} ft)`);

  // Validate reachability on combined grid
  validateReachability(combinedGrid, allRooms);

  // Build levels metadata for the renderer (names + row boundaries)
  const levelsMeta = levels.map((level, i) => ({
    name: level.name || `Level ${i + 1}`,
    startRow: rowOffsets[i],
    numRows: compiledLevels[i].numRows
  }));

  // Collect lights from all levels (offset y by rowOffset * gridSize)
  const allLights = [];
  let nextLightId = 1;
  for (let li = 0; li < compiledLevels.length; li++) {
    const levelLights = compiledLevels[li].lights || [];
    const rowOffset = rowOffsets[li];
    for (const light of levelLights) {
      allLights.push({
        ...light,
        id: nextLightId++,
        y: light.y + rowOffset,
      });
    }
  }

  // Collect bridges from all levels (offset point rows by rowOffset)
  const allBridges = [];
  let nextBridgeId = 0;
  for (let li = 0; li < compiledLevels.length; li++) {
    const rowOffset = rowOffsets[li];
    for (const bridge of compiledLevels[li].bridges) {
      allBridges.push({
        id: nextBridgeId++,
        type: bridge.type,
        points: bridge.points.map(([r, c]) => [r + rowOffset, c]),
      });
    }
  }
  if (allBridges.length > 0) {
    console.log(`  ${allBridges.length} bridge(s) placed`);
  }

  const result = {
    metadata: { ...header, levels: levelsMeta },
    cells: combinedGrid.cells
  };

  if (allLights.length > 0) {
    result.metadata.lights = allLights;
    result.metadata.nextLightId = nextLightId;
    result.metadata.lightingEnabled = true;
  }

  if (allBridges.length > 0) {
    result.metadata.bridges = allBridges;
    result.metadata.nextBridgeId = nextBridgeId;
  }

  return result;
}

export { compileLevel, compileMap };
