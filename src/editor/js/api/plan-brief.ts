// plan-brief.js — Compute a complete dungeon layout from a high-level brief
// and return ready-to-execute command arrays.

import { ApiValidationError } from './_shared.js';

interface RoomDef {
  label: string;
  width: number;
  height: number;
  entrance?: boolean;
  [k: string]: unknown;
}
interface ConnDef {
  from: string;
  to: string;
  direction: string;
  corridorWidth?: number;
  type?: string;
}
interface Edge {
  to: string;
  dir: string;
  corrW: number;
  type: string;
}
interface Rect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/**
 * Compute a complete dungeon layout from a high-level brief and return ready-to-execute
 * command arrays. Claude provides room sizes and connection topology; this method handles
 * all coordinate math.
 *
 * Brief format:
 * {
 *   name, theme, gridSize, corridorWidth,
 *   rooms: [{ label, width, height, entrance? }],
 *   connections: [{ from, to, direction, corridorWidth?, type? }]
 * }
 *
 * direction is required per connection: 'north'|'south'|'east'|'west' (from → to).
 * type: 'door' (default) or 'secret'.
 * Same-direction siblings are placed side-by-side perpendicular to the travel axis.
 *
 * @param {Object} brief - Layout brief with rooms, connections, and map settings
 * @returns {{ success: boolean, commands: Array<Array>, mapSize: { rows: number, cols: number } }}
 */
export function planBrief(
  brief: Record<string, string | number | boolean | Record<string, unknown>[] | Record<string, unknown>>,
): { success: true; commands: (string | number | boolean)[][]; mapSize: { rows: number; cols: number } } {
  const {
    name = 'Dungeon',
    theme = 'stone-dungeon',
    gridSize = 5,
    corridorWidth: defaultCorrW = 3,
    rooms: roomDefs = [],
    connections = [],
  } = brief;

  if (!Array.isArray(roomDefs) || roomDefs.length === 0) {
    throw new ApiValidationError('NO_ROOMS', 'planBrief requires at least one room in brief.rooms', {
      rooms: roomDefs,
    });
  }
  for (const r of roomDefs) {
    if (!r.label) throw new ApiValidationError('MISSING_ROOM_LABEL', 'Each room must have a label', { room: r });
    if (!r.width || !r.height)
      throw new ApiValidationError('MISSING_ROOM_DIMENSIONS', `Room "${r.label}" must have width and height`, {
        room: r.label,
        width: r.width,
        height: r.height,
      });
  }

  const roomMap = Object.fromEntries((roomDefs as RoomDef[]).map((r) => [r.label, r]));
  const ODIR = { north: 'south', south: 'north', east: 'west', west: 'east' };

  // Build directed adjacency list
  const adj: Record<string, Edge[]> = Object.fromEntries((roomDefs as RoomDef[]).map((r) => [r.label, []]));
  for (const conn of connections as unknown as ConnDef[]) {
    const corrW = conn.corridorWidth ?? (defaultCorrW as number);
    const type = conn.type === 'secret' ? 's' : 'd';
    if (!conn.direction)
      throw new ApiValidationError(
        'MISSING_CONNECTION_DIRECTION',
        `Connection from "${conn.from}" to "${conn.to}" must specify direction`,
        { from: conn.from, to: conn.to },
      );
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    (adj[conn.from] = adj[conn.from] || []).push({ to: conn.to, dir: conn.direction, corrW, type });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    (adj[conn.to] = adj[conn.to] || []).push({
      to: conn.from,
      dir: ODIR[conn.direction as keyof typeof ODIR],
      corrW,
      type,
    });
  }

  // BFS layout
  const rootLabel = ((roomDefs as RoomDef[]).find((r) => r.entrance) ?? (roomDefs as RoomDef[])[0]).label;
  const positions: Record<string, Rect> = {};
  const corridorRects: Rect[] = [];
  const doorCmds: { row: number; col: number; dir: string; type: string }[] = [];
  const visited = new Set([rootLabel]);

  const rootDef = roomMap[rootLabel];
  positions[rootLabel] = { r1: 1, c1: 1, r2: rootDef.height, c2: rootDef.width };

  const queue = [rootLabel];
  while (queue.length) {
    const pLabel = queue.shift();
    const pPos = positions[pLabel!];
    const pCenterRow = Math.floor((pPos.r1 + pPos.r2) / 2);
    const pCenterCol = Math.floor((pPos.c1 + pPos.c2) / 2);

    // Group unvisited children by direction
    const byDir: Record<string, Edge[]> = {};
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    for (const edge of adj[pLabel!] || []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      queue.push(edge.to);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
      (byDir[edge.dir] = byDir[edge.dir] || []).push(edge);
    }

    for (const [dir, edges] of Object.entries(byDir)) {
      const isNS = dir === 'north' || dir === 'south';

      if (isNS) {
        // Side-by-side horizontally, each corridor centered on its child
        const totalW = edges.reduce((s: number, e: Edge) => s + roomMap[e.to].width, 0) + (edges.length - 1);
        let startCol = pCenterCol - Math.floor(totalW / 2);

        for (const edge of edges) {
          const cDef = roomMap[edge.to];
          const corrW = edge.corrW;
          let cR1, corrR1, corrR2;

          if (dir === 'north') {
            corrR2 = pPos.r1 - 1;
            corrR1 = corrR2 - corrW + 1;
            cR1 = corrR1 - cDef.height;
          } else {
            corrR1 = pPos.r2 + 1;
            corrR2 = corrR1 + corrW - 1;
            cR1 = corrR2 + 1;
          }

          const cCenterCol = startCol + Math.floor(cDef.width / 2);
          const corrC1 = cCenterCol - Math.floor(corrW / 2);
          const corrC2 = corrC1 + corrW - 1;
          const corrMidCol = Math.floor((corrC1 + corrC2) / 2);

          positions[edge.to] = { r1: cR1, c1: startCol, r2: cR1 + cDef.height - 1, c2: startCol + cDef.width - 1 };
          corridorRects.push({ r1: corrR1, c1: corrC1, r2: corrR2, c2: corrC2 });

          if (dir === 'north') {
            doorCmds.push({ row: pPos.r1, col: corrMidCol, dir: 'north', type: edge.type });
            doorCmds.push({ row: corrR1, col: corrMidCol, dir: 'north', type: edge.type });
          } else {
            doorCmds.push({ row: pPos.r2, col: corrMidCol, dir: 'south', type: edge.type });
            doorCmds.push({ row: corrR2, col: corrMidCol, dir: 'south', type: edge.type });
          }
          startCol += cDef.width + 1;
        }
      } else {
        // Side-by-side vertically, each corridor centered on its child
        const totalH = edges.reduce((s: number, e: Edge) => s + roomMap[e.to].height, 0) + (edges.length - 1);
        let startRow = pCenterRow - Math.floor(totalH / 2);

        for (const edge of edges) {
          const cDef = roomMap[edge.to];
          const corrW = edge.corrW;
          let cC1, corrC1, corrC2;

          if (dir === 'east') {
            corrC1 = pPos.c2 + 1;
            corrC2 = corrC1 + corrW - 1;
            cC1 = corrC2 + 1;
          } else {
            corrC2 = pPos.c1 - 1;
            corrC1 = corrC2 - corrW + 1;
            cC1 = corrC1 - cDef.width;
          }

          const cCenterRow = startRow + Math.floor(cDef.height / 2);
          const corrR1 = cCenterRow - Math.floor(corrW / 2);
          const corrR2 = corrR1 + corrW - 1;
          const corrMidRow = Math.floor((corrR1 + corrR2) / 2);

          positions[edge.to] = { r1: startRow, c1: cC1, r2: startRow + cDef.height - 1, c2: cC1 + cDef.width - 1 };
          corridorRects.push({ r1: corrR1, c1: corrC1, r2: corrR2, c2: corrC2 });

          if (dir === 'east') {
            doorCmds.push({ row: corrMidRow, col: pPos.c2, dir: 'east', type: edge.type });
            doorCmds.push({ row: corrMidRow, col: corrC2, dir: 'east', type: edge.type });
          } else {
            doorCmds.push({ row: corrMidRow, col: pPos.c1, dir: 'west', type: edge.type });
            doorCmds.push({ row: corrMidRow, col: corrC1, dir: 'west', type: edge.type });
          }
          startRow += cDef.height + 1;
        }
      }
    }
  }

  // Place any disconnected rooms to the right of everything, stacked
  let farRight = 1,
    stackRow = 1;
  for (const pos of Object.values(positions)) farRight = Math.max(farRight, pos.c2 + 2);
  for (const corr of corridorRects) farRight = Math.max(farRight, corr.c2 + 2);
  for (const rDef of roomDefs as RoomDef[]) {
    if (!visited.has(rDef.label)) {
      positions[rDef.label] = {
        r1: stackRow,
        c1: farRight,
        r2: stackRow + rDef.height - 1,
        c2: farRight + rDef.width - 1,
      };
      stackRow += rDef.height + 1;
    }
  }

  // Normalize: shift everything so minimum is at (1, 1)
  let minR = Infinity,
    minC = Infinity;
  for (const pos of Object.values(positions)) {
    minR = Math.min(minR, pos.r1);
    minC = Math.min(minC, pos.c1);
  }
  for (const corr of corridorRects) {
    minR = Math.min(minR, corr.r1);
    minC = Math.min(minC, corr.c1);
  }
  for (const d of doorCmds) {
    minR = Math.min(minR, d.row);
    minC = Math.min(minC, d.col);
  }

  const or = 1 - minR,
    oc = 1 - minC;
  for (const pos of Object.values(positions)) {
    pos.r1 += or;
    pos.c1 += oc;
    pos.r2 += or;
    pos.c2 += oc;
  }
  for (const corr of corridorRects) {
    corr.r1 += or;
    corr.c1 += oc;
    corr.r2 += or;
    corr.c2 += oc;
  }
  for (const d of doorCmds) {
    d.row += or;
    d.col += oc;
  }

  // Compute map dimensions
  let maxR = 0,
    maxC = 0;
  for (const pos of Object.values(positions)) {
    maxR = Math.max(maxR, pos.r2);
    maxC = Math.max(maxC, pos.c2);
  }
  for (const corr of corridorRects) {
    maxR = Math.max(maxR, corr.r2);
    maxC = Math.max(maxC, corr.c2);
  }
  const mapRows = maxR + 2,
    mapCols = maxC + 2;

  // Assemble commands
  const commands: (string | number | boolean)[][] = [
    ['newMap', name as string, mapRows, mapCols, gridSize as number, theme as string],
  ];

  // Rooms in input order
  for (const rDef of roomDefs as RoomDef[]) {
    const pos = positions[rDef.label];
    commands.push(['createRoom', pos.r1, pos.c1, pos.r2, pos.c2]);
    commands.push(['setLabel', Math.floor((pos.r1 + pos.r2) / 2), Math.floor((pos.c1 + pos.c2) / 2), rDef.label]);
  }

  // Corridors
  for (const corr of corridorRects) {
    commands.push(['createRoom', corr.r1, corr.c1, corr.r2, corr.c2]);
  }

  // Doors
  for (const d of doorCmds) {
    commands.push(['setDoor', d.row, d.col, d.dir, d.type]);
  }

  return { success: true, commands, mapSize: { rows: mapRows, cols: mapCols } };
}
