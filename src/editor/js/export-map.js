// Exports the current dungeon state as .map text format.
// Used by both io.js (File > Export to .map menu) and editor-api.js (Puppeteer bridge).
import { cellKey, parseCellKey, floodFillRoom } from '../../util/index.js';

/**
 * Convert a dungeon JSON object to .map text format.
 * @param {object} dungeon - A valid dungeon object with metadata + cells.
 * @returns {{ success: true, mapText: string } | { success: false, error: string }}
 */
export function exportDungeonToMapFormat(dungeon) {
  const meta = dungeon.metadata;
  const cells = dungeon.cells;
  const totalRows = cells.length;
  const totalCols = cells[0]?.length || 0;
  const levels = meta.levels || [{ name: 'Level 1', startRow: 0, numRows: totalRows }];
  const isMultiLevel = levels.length > 1;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Column ruler comment: # 0    5    10   15   ... */
  function columnRuler(numCols) {
    let ruler = '# col: ';
    for (let c = 0; c < numCols; c += 5) {
      ruler += String(c).padEnd(5);
    }
    return ruler.trimEnd();
  }

  // ── Per-level export ──────────────────────────────────────────────────────

  const levelSections = [];

  for (const level of levels) {
    const levelStartRow = level.startRow;
    const levelEndRow = level.startRow + level.numRows - 1;
    const levelRows = level.numRows;
    const levelCols = totalCols;

    // Step 1: Discover regions via BFS (within this level's row range)
    const visitedGlobal = new Set();
    // regions: [{ cells: Set<"r,c">, label: string|null, r1,c1,r2,c2 }]
    const regions = [];

    for (let r = levelStartRow; r <= levelEndRow; r++) {
      for (let c = 0; c < levelCols; c++) {
        const key = cellKey(r, c);
        if (visitedGlobal.has(key)) continue;
        if (!cells[r]?.[c]) continue; // void

        // BFS — diagonal-aware, stops at doors, constrained to this level's row range
        const regionCells = floodFillRoom(cells, r, c, {
          rowMin: levelStartRow,
          rowMax: levelEndRow,
        });
        for (const k of regionCells) visitedGlobal.add(k);

        // Find label for this region
        let regionLabel = null;
        let r1 = Infinity, c1 = Infinity, r2 = -Infinity, c2 = -Infinity;
        for (const rkey of regionCells) {
          const [rr, rc] = parseCellKey(rkey);
          r1 = Math.min(r1, rr); c1 = Math.min(c1, rc);
          r2 = Math.max(r2, rr); c2 = Math.max(c2, rc);
          const label = cells[rr]?.[rc]?.center?.label;
          if (label != null) regionLabel = String(label);
        }

        regions.push({ cells: regionCells, label: regionLabel, r1, c1, r2, c2 });
      }
    }

    // Step 2: Assign ASCII chars
    // Map from char → region index and regionLabel → char
    const usedChars = new Set(['.', '#', '-', '=', ' ', '\t']);
    const regionChar = new Array(regions.length).fill('');
    const labelToChar = {};

    // Prefer uppercase letters, then lowercase
    const charPool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let charIdx = 0;

    for (let i = 0; i < regions.length; i++) {
      let ch;
      do {
        ch = charPool[charIdx++ % charPool.length];
      } while (usedChars.has(ch));
      usedChars.add(ch);
      regionChar[i] = ch;
      if (regions[i].label) labelToChar[regions[i].label] = ch;
    }

    // Build cell → char map
    const cellToChar = {};
    for (let i = 0; i < regions.length; i++) {
      for (const key of regions[i].cells) {
        cellToChar[key] = regionChar[i];
      }
    }

    // Step 3: Build ASCII grid (local coords: localR = r - levelStartRow)
    // Each row gets an inline # comment with its row number for easy coordinate reference.
    const gridLines = [];
    const rowNumWidth = String(levelRows - 1).length; // pad width: 1 digit for <10 rows, 2 for <100, etc.
    for (let r = levelStartRow; r <= levelEndRow; r++) {
      let row = '';
      for (let c = 0; c < levelCols; c++) {
        row += cellToChar[cellKey(r, c)] || '.';
      }
      const localR = r - levelStartRow;
      gridLines.push(`${row}  # ${String(localR).padStart(rowNumWidth)}`);
    }

    // Step 4: Build legend (labeled rooms only)
    const legendLines = [];
    for (let i = 0; i < regions.length; i++) {
      if (regions[i].label) {
        legendLines.push(`  ${regionChar[i]}: ${regions[i].label}`);
      }
    }
    // Unlabeled regions (corridors) — no legend entry needed

    // Step 5: Collect doors (row,col — LOCAL to this level, same as parse.js expects)
    // Only emit from the cell where direction is south or east to avoid duplicates
    const doorLines = [];
    for (let r = levelStartRow; r <= levelEndRow; r++) {
      for (let c = 0; c < levelCols; c++) {
        const cell = cells[r]?.[c];
        if (!cell) continue;
        const localR = r - levelStartRow;
        // Check south and east walls (avoid duplicate pairs)
        for (const dir of ['south', 'east']) {
          const wallType = cell[dir];
          if (wallType !== 'd' && wallType !== 's') continue;
          const typeStr = wallType === 'd' ? 'door' : 'secret';
          doorLines.push(`  ${localR},${c} ${dir}: ${typeStr}`);
        }
      }
    }

    // Step 6: Collect trims
    // Group trim cells by their region/corner, find the tip corner cell
    const trimGroups = new Map(); // key: "regionIdx-corner" → { corner, round, inverted, cells }
    for (let r = levelStartRow; r <= levelEndRow; r++) {
      for (let c = 0; c < levelCols; c++) {
        const cell = cells[r]?.[c];
        if (!cell?.trimCorner) continue;
        // Find which region this belongs to — but trim cells are on the hypotenuse,
        // so they may be isolated or part of a labeled region. Use label if present.
        // Find which label this trim is adjacent to
        let regionLabel = null;
        for (const dir of ['north', 'south', 'east', 'west']) {
          const [dr, dc] = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] }[dir];
          const nrr = r + dr, ncc = c + dc;
          const neighbor = cells[nrr]?.[ncc];
          if (neighbor?.center?.label) { regionLabel = neighbor.center.label; break; }
        }
        // Also check this cell itself
        if (!regionLabel && cell.center?.label) regionLabel = cell.center.label;
        const trimKey = `${regionLabel || cellToChar[cellKey(r, c)]}-${cell.trimCorner}`;
        if (!trimGroups.has(trimKey)) {
          trimGroups.set(trimKey, {
            label: regionLabel,
            corner: cell.trimCorner,
            round: !!(cell.trimRound),
            inverted: !!(cell.trimArcInverted),
            size: 0,
          });
        }
        trimGroups.get(trimKey).size++;
      }
    }

    const trimLines = [];
    for (const [key, grp] of trimGroups) {
      let trimSpec = grp.corner;
      if (grp.size > 1) trimSpec += grp.size;
      if (grp.round) trimSpec += 'r';
      if (grp.inverted) trimSpec += 'i';
      if (grp.label) {
        trimLines.push(`  ${grp.label}: ${trimSpec}`);
      } else {
        // Corridor trim — use cell-coordinate syntax (row,col relative to level)
        // Find the tip cell for this trim group (the cell furthest into the corner)
        for (let r = levelStartRow; r <= levelEndRow; r++) {
          for (let c = 0; c < levelCols; c++) {
            const cell = cells[r]?.[c];
            if (!cell?.trimCorner || cell.trimCorner !== grp.corner) continue;
            // Match by checking the trim group key
            const thisCellKey = `${cellToChar[cellKey(r, c)]}-${cell.trimCorner}`;
            if (thisCellKey === key) {
              const localR = r - levelStartRow;
              trimLines.push(`  ${localR},${c}: ${trimSpec}`);
              break;  // Only emit once per group — the first cell found
            }
          }
        }
      }
    }

    // Step 7: Collect stairs from metadata.stairs (new format)
    // Export 3-point shapes with level-relative row offsets
    const allStairs = dungeon.metadata?.stairs || [];
    const stairLines = [];
    const processedStairLinks = new Set();

    // Find stairs whose bounding box overlaps this level
    for (const stairDef of allStairs) {
      // Check if any point falls within this level's row range
      const inLevel = stairDef.points.some(([r]) => r >= levelStartRow && r <= levelEndRow + 1);
      if (!inLevel) continue;

      // Convert to level-relative row coordinates
      const pts = stairDef.points.map(([r, c]) => `${r - levelStartRow},${c}`).join(' ');

      if (stairDef.link && !processedStairLinks.has(stairDef.link)) {
        processedStairLinks.add(stairDef.link);
        // Find partner
        const partner = allStairs.find(s => s.link === stairDef.link && s.id !== stairDef.id);
        if (partner) {
          // Determine partner's level
          const partnerMinRow = Math.min(...partner.points.map(([r]) => r));
          let partnerLevelIdx = 0;
          for (let li = 0; li < levels.length; li++) {
            const lvl = levels[li];
            if (partnerMinRow >= lvl.startRow && partnerMinRow < lvl.startRow + lvl.numRows) {
              partnerLevelIdx = li;
              break;
            }
          }
          const partnerOffset = levels[partnerLevelIdx].startRow;
          const partnerPts = partner.points.map(([r, c]) => `${r - partnerOffset},${c}`).join(' ');
          const myLevelIdx = levels.indexOf(level);
          if (partnerLevelIdx !== myLevelIdx) {
            stairLines.push(`  ${pts} - L${partnerLevelIdx + 1}: ${partnerPts}`);
          } else {
            stairLines.push(`  ${pts} - ${partnerPts}`);
          }
          continue;
        }
      }
      if (!stairDef.link || !processedStairLinks.has(stairDef.link)) {
        if (stairDef.link) processedStairLinks.add(stairDef.link);
        stairLines.push(`  ${pts}`);
      }
    }

    // Legacy fallback: old per-cell stairs (if metadata.stairs is empty)
    if (allStairs.length === 0) {
      for (let r = levelStartRow; r <= levelEndRow; r++) {
        for (let c = 0; c < levelCols; c++) {
          const cell = cells[r]?.[c];
          if (!cell?.center) continue;
          const up = cell.center['stairs-up'];
          const down = cell.center['stairs-down'];
          if (up || down) {
            const dir = up ? 'up' : 'down';
            stairLines.push(`  ${r - levelStartRow},${c}: ${dir}`);
          }
        }
      }
    }

    // Step 8: Collect fills
    // Uniform room fills use "Label: fillType", mixed/corridor fills use per-cell "row,col: fillType"
    const fillLines = [];
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      // Collect fill types across the region
      const fillCells = []; // { localR, c, fill }
      for (const key of region.cells) {
        const [rr, rc] = parseCellKey(key);
        const fill = cells[rr]?.[rc]?.fill;
        if (fill) fillCells.push({ localR: rr - levelStartRow, c: rc, fill });
      }
      if (fillCells.length === 0) continue;

      const fillTypes = new Set(fillCells.map(f => f.fill));
      if (region.label && fillTypes.size === 1) {
        // Uniform labeled room — use room-label syntax
        fillLines.push(`  ${region.label}: ${[...fillTypes][0]}`);
      } else {
        // Mixed fills or unlabeled corridors — use per-cell syntax
        for (const { localR, c, fill } of fillCells) {
          fillLines.push(`  ${localR},${c}: ${fill}`);
        }
      }
    }

    // Step 9: Props (local coords, anchor cells only)
    // Only the anchor cell has cell.prop set — no need for multi-cell anchor detection.
    const propLines = [];
    for (let r = levelStartRow; r <= levelEndRow; r++) {
      for (let c = 0; c < levelCols; c++) {
        const cell = cells[r]?.[c];
        if (!cell?.prop) continue;
        const { type, facing } = cell.prop;
        const localR = r - levelStartRow;
        const facingStr = facing !== undefined && facing !== 0 ? ` facing:${facing}` : '';
        propLines.push(`  ${localR},${c}: ${type}${facingStr}`);
      }
    }

    // Step 10: Textures (per-cell, local coords)
    const textureLines = [];
    for (let r = levelStartRow; r <= levelEndRow; r++) {
      for (let c = 0; c < levelCols; c++) {
        const cell = cells[r]?.[c];
        if (!cell?.texture) continue;
        const localR = r - levelStartRow;
        const opacity = cell.textureOpacity ?? 1.0;
        const opacityStr = opacity !== 1.0 ? ` ${opacity}` : '';
        textureLines.push(`  ${localR},${c}: ${cell.texture}${opacityStr}`);
      }
    }

    // Step 11: Lights (world-feet coordinates, local to this level)
    const allLights = dungeon.metadata?.lights || [];
    const lightLines = [];
    const gridSz = meta.gridSize || 5;
    for (const light of allLights) {
      // Check if light falls within this level's row range (convert y feet to rows)
      const lightRow = light.y / gridSz;
      if (lightRow < levelStartRow || lightRow > levelEndRow + 1) continue;
      const localY = light.y - levelStartRow * gridSz;
      const parts = [];
      if (light.type && light.type !== 'point') parts.push(`type:${light.type}`);
      if (light.color) parts.push(`color:${light.color.replace('#', '')}`);
      if (light.radius != null) parts.push(`radius:${light.radius}`);
      if (light.intensity != null && light.intensity !== 1.0) parts.push(`intensity:${light.intensity}`);
      if (light.falloff && light.falloff !== 'smooth') parts.push(`falloff:${light.falloff}`);
      if (light.angle != null) parts.push(`angle:${light.angle}`);
      if (light.spread != null) parts.push(`spread:${light.spread}`);
      lightLines.push(`  ${light.x},${localY}: ${parts.join(' ')}`);
    }

    // Step 12: Bridges (global corner coords → level-local row coords)
    const allBridges = dungeon.metadata?.bridges || [];
    const bridgeLines = [];
    for (const bridge of allBridges) {
      // Assign bridge to the level whose row range contains its first point
      const firstRow = bridge.points[0][0];
      if (firstRow < levelStartRow || firstRow > levelEndRow) continue;
      const pts = bridge.points.map(([r, c]) => `${r - levelStartRow},${c}`).join(' ');
      bridgeLines.push(`  ${bridge.type} ${pts}`);
    }

    // ── Assemble level section ─────────────────────────────────────────────

    const lines = [];

    // Level header (only for multi-level)
    if (isMultiLevel) {
      lines.push(`=== ${level.name} ===`);
      lines.push('');
    }

    // Room summary block
    const labeledRegions = regions.filter(rg => rg.label);
    if (labeledRegions.length > 0) {
      lines.push('# ROOMS  (row,col — same as Puppeteer API, row increases downward)');
      for (const rg of labeledRegions) {
        const localR1 = rg.r1 - levelStartRow;
        const localR2 = rg.r2 - levelStartRow;
        const ctrR = Math.round((rg.r1 + rg.r2) / 2) - levelStartRow;
        const ctrC = Math.round((rg.c1 + rg.c2) / 2);
        lines.push(`# ${rg.label.padEnd(4)} rows ${localR1}-${localR2}, cols ${rg.c1}-${rg.c2}  center row ${ctrR}, col ${ctrC}`);
      }
      lines.push('#');
    }

    // Column ruler
    lines.push(columnRuler(levelCols));

    // ASCII grid (local rows within level)
    for (const row of gridLines) {
      lines.push(row);
    }
    lines.push('');

    // Legend
    if (legendLines.length > 0) {
      lines.push('legend:');
      for (const ll of legendLines) lines.push(ll);
      lines.push('');
    }

    // Doors
    if (doorLines.length > 0) {
      lines.push('doors:');
      for (const dl of doorLines) lines.push(dl);
      lines.push('');
    }

    // Trims
    if (trimLines.length > 0) {
      lines.push('trims:');
      for (const tl of trimLines) lines.push(tl);
      lines.push('');
    }

    // Stairs
    if (stairLines.length > 0) {
      lines.push('stairs:');
      for (const sl of stairLines) lines.push(sl);
      lines.push('');
    }

    // Fills
    if (fillLines.length > 0) {
      lines.push('fills:');
      for (const fl of fillLines) lines.push(fl);
      lines.push('');
    }

    // Props
    if (propLines.length > 0) {
      lines.push('props:');
      for (const pl of propLines) lines.push(pl);
      lines.push('');
    }

    // Textures
    if (textureLines.length > 0) {
      lines.push('textures:');
      for (const tl of textureLines) lines.push(tl);
      lines.push('');
    }

    // Lights
    if (lightLines.length > 0) {
      lines.push('lights:');
      for (const ll of lightLines) lines.push(ll);
      lines.push('');
    }

    // Bridges
    if (bridgeLines.length > 0) {
      lines.push('bridges:');
      for (const bl of bridgeLines) lines.push(bl);
      lines.push('');
    }

    levelSections.push(lines.join('\n'));
  }

  // ── Assemble full document ─────────────────────────────────────────────────

  const features = meta.features || {};
  const headerLines = [
    '---',
    `name: ${meta.dungeonName || 'Untitled'}`,
    `theme: ${meta.theme || 'stone-dungeon'}`,
  ];
  if (meta.gridSize && meta.gridSize !== 5) headerLines.push(`gridSize: ${meta.gridSize}`);
  if (meta.labelStyle && meta.labelStyle !== 'circled') headerLines.push(`labelStyle: ${meta.labelStyle}`);
  if (meta.titleFontSize) headerLines.push(`titleFontSize: ${meta.titleFontSize}`);
  if (features.showGrid === true) headerLines.push('showGrid: true');
  if (features.compassRose === true) headerLines.push('compassRose: true');
  if (features.scale === true) headerLines.push('scale: true');
  if (features.border === true) headerLines.push('border: true');
  if (meta.themeOverrides && Object.keys(meta.themeOverrides).length > 0) {
    headerLines.push('themeOverrides:');
    for (const [key, val] of Object.entries(meta.themeOverrides)) {
      headerLines.push(`  ${key}: ${val}`);
    }
  }
  headerLines.push('---');
  headerLines.push('');

  const fullText = headerLines.join('\n') + '\n' + levelSections.join('\n');
  return { success: true, mapText: fullText };
}
