import { scaleFactor } from './borders.js';
import { toCanvas } from './bounds.js';
import { GRID_SCALE } from './constants.js';
import { HATCH_TILE_SIZE, HATCH_PATTERNS, WATER_TILE_SIZE, WATER_PATTERNS, WATER_SPATIAL } from './patterns.js';

// ── Seeded LCG PRNG ─────────────────────────────────────────────────────────
// Returns a function yielding deterministic floats 0..1 for a given integer seed.
export function seededLcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

// ── Hex → rgba helper ───────────────────────────────────────────────────────
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Wall Drop Shadow ─────────────────────────────────────────────────────────
// Draws a soft shadow offset below-right of all wall segments.
// Called BEFORE the actual wall stroke so the shadow sits under the wall.
export function drawWallShadow(ctx, wallSegments, theme, transform) {
  if (!theme.wallShadow || wallSegments.length === 0) return;
  const s = scaleFactor(transform);
  const { color, blur, offsetX, offsetY } = theme.wallShadow;

  ctx.save();
  ctx.strokeStyle = theme.wallStroke;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * s;
  ctx.shadowOffsetX = offsetX * s;
  ctx.shadowOffsetY = offsetY * s;

  ctx.beginPath();
  for (const seg of wallSegments) {
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
  }
  ctx.stroke();

  // Reset shadow state
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.restore();
}

// ── Rough Wall Lines ─────────────────────────────────────────────────────────
// Hand-drawn wall effect using smooth quadratic Bézier curves through sparse
// control points with small perpendicular offsets. Deterministic per-segment
// seeding prevents shimmer during pan/zoom.
export function drawRoughWalls(ctx, wallSegments, theme, transform) {
  const s = scaleFactor(transform);
  const amp = theme.wallRoughness * s * 1.5;
  const spacing = 25; // pixels between control points

  ctx.strokeStyle = theme.wallStroke;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  for (const seg of wallSegments) {
    const { x1, y1, x2, y2, seed } = seg;
    const rand = seededLcg(seed);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;

    // Perpendicular unit vector
    const px = -dy / len;
    const py = dx / len;

    // Sparse control points with random perpendicular offsets
    const numCtrl = Math.max(1, Math.ceil(len / spacing));
    const pts = [{ x: x1, y: y1 }];
    for (let i = 1; i < numCtrl; i++) {
      const t = i / numCtrl;
      const offset = (rand() - 0.5) * 2 * amp;
      pts.push({
        x: x1 + dx * t + px * offset,
        y: y1 + dy * t + py * offset,
      });
    }
    pts.push({ x: x2, y: y2 });

    // Draw smooth curve through control points
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
    } else {
      // Quadratic Bézier through midpoints for C1 continuity
      for (let i = 1; i < pts.length - 1; i++) {
        const xMid = (pts[i].x + pts[i + 1].x) / 2;
        const yMid = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, xMid, yMid);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }
  }

  ctx.stroke();
}

// ── BFS Distance Map ─────────────────────────────────────────────────────────
// Builds an 8-connected Chebyshev distance map from all room cells.
// dist[r][c] = 0 for room cells, 1–maxDist for adjacent non-room cells,
// Infinity beyond maxDist. Shared by both line hatching and rock shading.
//
// Cached by (cells, roomCells, maxDist) reference — cells/roomCells are the
// same object references across all pan/zoom frames and only replaced when the
// map is edited, so cache hits eliminate the BFS entirely during panning.
let _distMapCache = { cells: null, roomCells: null, maxDist: -1, dist: null };

function buildDistMap(cells, roomCells, maxDist) {
  if (_distMapCache.cells === cells &&
      _distMapCache.roomCells === roomCells &&
      _distMapCache.maxDist === maxDist) {
    return _distMapCache.dist;
  }
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const dist = Array.from({ length: numRows }, () => new Float32Array(numCols).fill(Infinity));
  const queue = new Int32Array(numRows * numCols);
  let qHead = 0, qTail = 0;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (roomCells[r][c]) { dist[r][c] = 0; queue[qTail++] = r * numCols + c; }
    }
  }
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const r = (idx / numCols) | 0;
    const c = idx % numCols;
    const nd = dist[r][c] + 1;
    if (nd > maxDist) continue;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < numRows && nc >= 0 && nc < numCols && dist[nr][nc] === Infinity) {
          dist[nr][nc] = nd;
          queue[qTail++] = nr * numCols + nc;
        }
      }
    }
  }
  _distMapCache = { cells, roomCells, maxDist, dist };
  return dist;
}


// ── Wall Hatching Path2D Cache ───────────────────────────────────────────────
// Caches Path2D geometry in world coordinates per distance bucket. The expensive
// pattern iteration + path construction runs once; each frame just sets the
// canvas transform and strokes the cached paths at screen resolution.
let _hatchCache = null;

export function drawHatching(ctx, cells, roomCells, gridSize, theme, transform) {
  if (!theme.hatchOpacity) return;
  if (theme.hatchStyle === 'rocks') return;

  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  if (!numRows || !numCols) return;

  const MAX_DIST = Math.round(theme.hatchDistance ?? 1);
  const size = theme.hatchSize ?? 0.5;
  const color = theme.hatchColor || theme.wallStroke;
  const mapW = numCols * gridSize, mapH = numRows * gridSize;

  // Rebuild Path2D cache if map data or relevant theme params changed.
  // roomCells is derived from cells, so cells ref-equality is sufficient.
  const hc = _hatchCache;
  if (!hc || hc.cells !== cells ||
      hc.gridSize !== gridSize || hc.size !== size ||
      hc.maxDist !== MAX_DIST) {

    const dist = buildDistMap(cells, roomCells, MAX_DIST);
    const tileWorld = gridSize * (1.5 + size * 3);
    const patternScale = tileWorld / HATCH_TILE_SIZE;

    const bucketPaths = Array.from({ length: MAX_DIST + 1 }, () => new Path2D());
    const txMax = Math.ceil(mapW / tileWorld);
    const tyMax = Math.ceil(mapH / tileWorld);

    for (let ty = -1; ty <= tyMax; ty++) {
      for (let tx = -1; tx <= txMax; tx++) {
        const offsetX = tx * tileWorld;
        const offsetY = ty * tileWorld;
        for (const p of HATCH_PATTERNS) {
          const cWorldX = p.centre[0] * patternScale + offsetX;
          const cWorldY = p.centre[1] * patternScale + offsetY;
          const cellCol = Math.floor(cWorldX / gridSize);
          const cellRow = Math.floor(cWorldY / gridSize);
          if (cellRow < 0 || cellRow >= numRows || cellCol < 0 || cellCol >= numCols) continue;
          const d = dist[cellRow][cellCol];
          if (d > MAX_DIST) continue;
          const path = bucketPaths[d];
          for (const line of p.cellLines) {
            path.moveTo(
              line[0][0] * patternScale + offsetX,
              line[0][1] * patternScale + offsetY
            );
            path.lineTo(
              line[1][0] * patternScale + offsetX,
              line[1][1] * patternScale + offsetY
            );
          }
        }
      }
    }

    const paths = [];
    const opacities = [];
    for (let d = 0; d <= MAX_DIST; d++) {
      paths.push(bucketPaths[d]);
      opacities.push(d === 0 ? 1.0 : Math.pow((MAX_DIST - d + 1) / MAX_DIST, 1.5));
    }

    _hatchCache = { cells, gridSize, size, maxDist: MAX_DIST, paths, opacities };
  }

  // Stroke cached Path2D objects at screen resolution
  ctx.save();
  const _h0 = toCanvas(0, 0, transform);
  const _h1 = toCanvas(mapW, mapH, transform);
  ctx.beginPath();
  ctx.rect(_h0.x, _h0.y, _h1.x - _h0.x, _h1.y - _h0.y);
  ctx.clip();
  ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5 / transform.scale, 1 / GRID_SCALE);
  ctx.lineCap = 'round';
  for (let d = 0; d <= MAX_DIST; d++) {
    ctx.globalAlpha = theme.hatchOpacity * _hatchCache.opacities[d];
    ctx.stroke(_hatchCache.paths[d]);
  }
  ctx.restore();
}

// ── Arc Void Hatching Path2D Cache ──────────────────────────────────────────
// Caches one Path2D per rounded corner in world coordinates. Each frame sets up
// the arc clip in canvas space, then uses setTransform to stroke the cached path.
let _arcVoidCache = null;

export function drawArcVoidHatching(ctx, roundedCorners, gridSize, theme, transform) {
  if (!theme.hatchOpacity || roundedCorners.size === 0) return;
  if (theme.hatchStyle === 'rocks') return;

  const size = theme.hatchSize ?? 0.5;
  const color = theme.hatchColor || theme.wallStroke;

  // Rebuild Path2D cache if corner data or theme params changed
  const ac = _arcVoidCache;
  if (!ac || ac.roundedCorners !== roundedCorners ||
      ac.gridSize !== gridSize || ac.size !== size) {

    const tileWorld = gridSize * (1.5 + size * 3);
    const patternScale = tileWorld / HATCH_TILE_SIZE;

    const cornerPaths = new Map();

    for (const [key, rc] of roundedCorners.entries()) {
      if (rc.inverted) continue;

      const R = rc.radius * gridSize;
      let bboxWorldX, bboxWorldY;
      switch (rc.corner) {
        case 'nw': bboxWorldX = rc.centerCol * gridSize;                   bboxWorldY = rc.centerRow * gridSize;                   break;
        case 'ne': bboxWorldX = (rc.centerCol - rc.radius) * gridSize;     bboxWorldY = rc.centerRow * gridSize;                   break;
        case 'sw': bboxWorldX = rc.centerCol * gridSize;                   bboxWorldY = (rc.centerRow - rc.radius) * gridSize;     break;
        case 'se': bboxWorldX = (rc.centerCol - rc.radius) * gridSize;     bboxWorldY = (rc.centerRow - rc.radius) * gridSize;     break;
      }

      const txMin = Math.floor(bboxWorldX / tileWorld) - 1;
      const txMax = Math.ceil((bboxWorldX + R) / tileWorld) + 1;
      const tyMin = Math.floor(bboxWorldY / tileWorld) - 1;
      const tyMax = Math.ceil((bboxWorldY + R) / tileWorld) + 1;

      const path = new Path2D();
      for (let ty = tyMin; ty <= tyMax; ty++) {
        for (let tx = txMin; tx <= txMax; tx++) {
          const offsetX = tx * tileWorld;
          const offsetY = ty * tileWorld;
          for (const p of HATCH_PATTERNS) {
            const cWorldX = p.centre[0] * patternScale + offsetX;
            const cWorldY = p.centre[1] * patternScale + offsetY;
            if (cWorldX < bboxWorldX || cWorldX > bboxWorldX + R) continue;
            if (cWorldY < bboxWorldY || cWorldY > bboxWorldY + R) continue;
            for (const line of p.cellLines) {
              path.moveTo(
                line[0][0] * patternScale + offsetX,
                line[0][1] * patternScale + offsetY
              );
              path.lineTo(
                line[1][0] * patternScale + offsetX,
                line[1][1] * patternScale + offsetY
              );
            }
          }
        }
      }
      cornerPaths.set(key, path);
    }

    _arcVoidCache = { roundedCorners, gridSize, size, cornerPaths };
  }

  // Stroke cached Path2D per corner with arc clip
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.globalAlpha = theme.hatchOpacity;

  for (const [key, rc] of roundedCorners.entries()) {
    if (rc.inverted) continue;

    const path = _arcVoidCache.cornerPaths.get(key);
    if (!path) continue;

    const R = rc.radius * gridSize;
    const Rpx = R * transform.scale;
    const ocp = toCanvas(rc.centerCol * gridSize, rc.centerRow * gridSize, transform);

    let acx, acy;
    switch (rc.corner) {
      case 'nw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
      case 'ne': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
      case 'sw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
      case 'se': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
    }
    const acp = toCanvas(acx, acy, transform);

    // Clip to the arc void shape in canvas coordinates
    ctx.save();
    ctx.beginPath();
    switch (rc.corner) {
      case 'nw':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, 3 * Math.PI / 2, Math.PI, true);
        ctx.lineTo(ocp.x, ocp.y); break;
      case 'ne':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, 3 * Math.PI / 2, 0, false);
        ctx.lineTo(ocp.x, ocp.y); break;
      case 'sw':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, Math.PI, false);
        ctx.lineTo(ocp.x, ocp.y); break;
      case 'se':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, 0, true);
        ctx.lineTo(ocp.x, ocp.y); break;
    }
    ctx.closePath();
    ctx.clip();

    // Stroke world-space cached path at screen resolution
    ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
    ctx.lineWidth = Math.max(0.5 / transform.scale, 1 / GRID_SCALE);
    ctx.stroke(path);
    ctx.restore();
  }

  ctx.restore();
}

// ── Rock Shading Path2D Cache ────────────────────────────────────────────────
// Caches Path2D geometry in world coordinates. The expensive work (spatial index
// lookup, vertex transforms, path construction) is done once; each frame just
// sets the canvas transform and strokes the cached paths at screen resolution.
let _rockCache = null;

export function drawRockShading(ctx, cells, roomCells, gridSize, theme, transform) {
  if (!theme.hatchOpacity) return;
  if (theme.hatchStyle !== 'rocks' && theme.hatchStyle !== 'both') return;

  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  if (!numRows || !numCols) return;

  const MAX_DIST = Math.round(theme.hatchDistance ?? 1);
  const size = theme.hatchSize ?? 0.5;
  const color = theme.hatchColor || theme.wallStroke || '#000000';
  const mapW = numCols * gridSize, mapH = numRows * gridSize;

  // Rebuild Path2D cache if map data or relevant theme params changed.
  // roomCells is derived from cells, so cells ref-equality is sufficient.
  const rc = _rockCache;
  if (!rc || rc.cells !== cells ||
      rc.gridSize !== gridSize || rc.size !== size ||
      rc.maxDist !== MAX_DIST) {

    const dist = buildDistMap(cells, roomCells, MAX_DIST);
    const tileWorld = gridSize * (8 + size * 8);
    const patternScale = tileWorld / WATER_TILE_SIZE;

    // Build one Path2D per distance bucket in world coordinates
    const paths = [];
    const opacities = [];
    const bucketPaths = Array.from({ length: MAX_DIST + 1 }, () => new Path2D());

    const { bins: spatialBins, N: binCount, binSize } = WATER_SPATIAL;
    const txMax = Math.ceil(mapW / tileWorld);
    const tyMax = Math.ceil(mapH / tileWorld);

    for (let ty = -1; ty <= tyMax; ty++) {
      for (let tx = -1; tx <= txMax; tx++) {
        const offsetX = tx * tileWorld;
        const offsetY = ty * tileWorld;
        const colMin = Math.max(0, Math.floor(offsetX / gridSize));
        const colMax = Math.min(numCols - 1, Math.floor((offsetX + tileWorld) / gridSize));
        const rowMin = Math.max(0, Math.floor(offsetY / gridSize));
        const rowMax = Math.min(numRows - 1, Math.floor((offsetY + tileWorld) / gridSize));
        if (colMin > colMax || rowMin > rowMax) continue;

        for (let r = rowMin; r <= rowMax; r++) {
          for (let col = colMin; col <= colMax; col++) {
            const d = dist[r][col];
            if (d > MAX_DIST) continue;
            const txl0 = (col * gridSize - offsetX) / patternScale;
            const txl1 = ((col + 1) * gridSize - offsetX) / patternScale;
            const tyl0 = (r * gridSize - offsetY) / patternScale;
            const tyl1 = ((r + 1) * gridSize - offsetY) / patternScale;
            const bxMin = Math.max(0, Math.floor(txl0 / binSize));
            const bxMax = Math.min(binCount - 1, Math.ceil(txl1 / binSize) - 1);
            const byMin = Math.max(0, Math.floor(tyl0 / binSize));
            const byMax = Math.min(binCount - 1, Math.ceil(tyl1 / binSize) - 1);
            if (bxMin > bxMax || byMin > byMax) continue;

            const path = bucketPaths[d];
            for (let by = byMin; by <= byMax; by++) {
              for (let bx = bxMin; bx <= bxMax; bx++) {
                for (const p of spatialBins[by * binCount + bx]) {
                  if (Math.floor((p.centre[0] * patternScale + offsetX) / gridSize) !== col) continue;
                  if (Math.floor((p.centre[1] * patternScale + offsetY) / gridSize) !== r) continue;
                  const verts = p.verts;
                  const wx0 = verts[0][0] * patternScale + offsetX;
                  const wy0 = verts[0][1] * patternScale + offsetY;
                  path.moveTo(wx0, wy0);
                  for (let vi = 1; vi < verts.length; vi++) {
                    path.lineTo(
                      verts[vi][0] * patternScale + offsetX,
                      verts[vi][1] * patternScale + offsetY
                    );
                  }
                  path.closePath();
                }
              }
            }
          }
        }
      }
    }

    for (let d = 0; d <= MAX_DIST; d++) {
      paths.push(bucketPaths[d]);
      opacities.push(d === 0 ? 1.0 : Math.pow((MAX_DIST - d + 1) / MAX_DIST, 1.5));
    }

    _rockCache = { cells, gridSize, size, maxDist: MAX_DIST, paths, opacities };
  }

  // Stroke cached Path2D objects at screen resolution
  ctx.save();
  const _r0 = toCanvas(0, 0, transform);
  const _r1 = toCanvas(mapW, mapH, transform);
  ctx.beginPath();
  ctx.rect(_r0.x, _r0.y, _r1.x - _r0.x, _r1.y - _r0.y);
  ctx.clip();
  ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
  ctx.strokeStyle = color;
  ctx.lineWidth = (1.5 + size * 0.5) / GRID_SCALE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let d = 0; d <= MAX_DIST; d++) {
    ctx.globalAlpha = theme.hatchOpacity * _rockCache.opacities[d];
    ctx.stroke(_rockCache.paths[d]);
  }
  ctx.restore();
}

// ── Arc Void Outer Shading ───────────────────────────────────────────────────
// Fills the convex arc void corner (the region between the arc wall and the
// outer room corner that carveRoundedVoid() exposes) with the outer shading
// colour.  Must be called AFTER carveRoundedVoid so the shading is visible in
// the carved area, and BEFORE drawArcVoidHatching so hatching sits on top.
export function drawArcVoidOuterShading(ctx, roundedCorners, gridSize, theme, transform) {
  if (!theme.outerShading?.color || !(theme.outerShading?.size > 0)) return;
  if (roundedCorners.size === 0) return;

  const { color } = theme.outerShading;
  ctx.save();
  ctx.fillStyle = color;

  for (const rc of roundedCorners.values()) {
    if (rc.inverted) continue; // inverted arcs have no convex void corner

    const R = rc.radius * gridSize;
    const Rpx = R * transform.scale;
    const ocp = toCanvas(rc.centerCol * gridSize, rc.centerRow * gridSize, transform);

    let acx, acy;
    switch (rc.corner) {
      case 'nw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
      case 'ne': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
      case 'sw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
      case 'se': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
    }
    const acp = toCanvas(acx, acy, transform);

    // Fill the void corner shape — identical path to carveRoundedVoid
    ctx.beginPath();
    switch (rc.corner) {
      case 'nw':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, 3 * Math.PI / 2, Math.PI, true);
        ctx.lineTo(ocp.x, ocp.y); break;
      case 'ne':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, 3 * Math.PI / 2, 0, false);
        ctx.lineTo(ocp.x, ocp.y); break;
      case 'sw':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, Math.PI, false);
        ctx.lineTo(ocp.x, ocp.y); break;
      case 'se':
        ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, 0, true);
        ctx.lineTo(ocp.x, ocp.y); break;
    }
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

// ── Outer Shading ────────────────────────────────────────────────────────────
// Draws a filled blob around the outside of the dungeon by placing a circle of
// radius (cellPx/2 + sizePx) on every room-cell centre and filling the union in
// one pass.  This Minkowski-sum approach gives naturally rounded outer edges at
// roughness = 0 (no seam artefacts) and organic jagged edges at higher roughness.
// The floor fills that follow paint over the room interior, leaving only the halo.
let _outerShadingCache = null;

export function drawOuterShading(ctx, cells, roomCells, gridSize, theme, transform) {
  if (!theme.outerShading?.color || !(theme.outerShading?.size > 0)) return;

  const { color, size, roughness = 0 } = theme.outerShading;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  // Rebuild Path2D cache if map data or shading params changed
  const oc = _outerShadingCache;
  if (!oc || oc.cells !== cells || oc.gridSize !== gridSize ||
      oc.size !== size || oc.roughness !== roughness) {

    const path = new Path2D();
    const worldRadius = gridSize * (0.5 + size / 10);
    const roughAmp = roughness * 0.2 * gridSize;

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        if (!roomCells[row][col]) continue;

        const cx = (col + 0.5) * gridSize;
        const cy = (row + 0.5) * gridSize;

        let radius = worldRadius;
        if (roughAmp > 0) {
          const rand = seededLcg(row * 1337 + col * 7919 + 54321);
          radius += (rand() - 0.5) * 2 * roughAmp;
          if (radius <= 0) continue;
        }

        path.moveTo(cx + radius, cy);
        path.arc(cx, cy, radius, 0, Math.PI * 2);
      }
    }

    _outerShadingCache = { cells, gridSize, size, roughness, path };
  }

  // Fill cached path at screen resolution
  ctx.save();
  const _os0 = toCanvas(0, 0, transform);
  const _os1 = toCanvas(numCols * gridSize, numRows * gridSize, transform);
  ctx.beginPath();
  ctx.rect(_os0.x, _os0.y, _os1.x - _os0.x, _os1.y - _os0.y);
  ctx.clip();
  ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
  ctx.fillStyle = color;
  ctx.fill(_outerShadingCache.path);
  ctx.restore();
}

// ── Buffer Shading (Inner AO) ────────────────────────────────────────────────
// Draws a dark gradient along the inside edges of room cells that border walls.
// Gives depth by simulating the shadow a wall casts onto the floor.
export function drawBufferShading(ctx, cells, roomCells, gridSize, theme, transform) {
  if (!theme.bufferShadingOpacity) return;

  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const depthFraction = 0.35; // gradient extends 35% into the cell

  // Viewport culling: only process cells visible on screen
  const _bvx0 = -transform.offsetX / transform.scale;
  const _bvy0 = -transform.offsetY / transform.scale;
  const _bvx1 = (ctx.canvas.width - transform.offsetX) / transform.scale;
  const _bvy1 = (ctx.canvas.height - transform.offsetY) / transform.scale;
  const rowMin = Math.max(0, Math.floor(_bvy0 / gridSize) - 1);
  const rowMax = Math.min(numRows - 1, Math.ceil(_bvy1 / gridSize) + 1);
  const colMin = Math.max(0, Math.floor(_bvx0 / gridSize) - 1);
  const colMax = Math.min(numCols - 1, Math.ceil(_bvx1 / gridSize) + 1);

  ctx.save();
  ctx.globalAlpha = theme.bufferShadingOpacity;

  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      if (!roomCells[row][col]) continue;
      const cell = cells[row][col];
      if (!cell) continue;

      const p1 = toCanvas(col * gridSize, row * gridSize, transform);
      const p2 = toCanvas((col + 1) * gridSize, (row + 1) * gridSize, transform);
      const cellPx = p2.x - p1.x;
      const depthPx = cellPx * depthFraction;
      const darkColor = hexToRgba(theme.wallStroke, 0.5);
      const clearColor = hexToRgba(theme.wallStroke, 0);

      if (cell.north === 'w') {
        const grad = ctx.createLinearGradient(p1.x, p1.y, p1.x, p1.y + depthPx);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p1.x, p1.y, cellPx, depthPx);
      }
      if (cell.south === 'w') {
        const grad = ctx.createLinearGradient(p1.x, p2.y, p1.x, p2.y - depthPx);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p1.x, p2.y - depthPx, cellPx, depthPx);
      }
      if (cell.west === 'w') {
        const grad = ctx.createLinearGradient(p1.x, p1.y, p1.x + depthPx, p1.y);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p1.x, p1.y, depthPx, cellPx);
      }
      if (cell.east === 'w') {
        const grad = ctx.createLinearGradient(p2.x, p1.y, p2.x - depthPx, p1.y);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p2.x - depthPx, p1.y, depthPx, cellPx);
      }
    }
  }

  ctx.restore();
}

/**
 * Invalidate all geometry/shading caches in this module.
 * Call whenever cell structure changes in-place (rooms created/destroyed, walls added/removed).
 */
export function invalidateEffectsCache() {
  _hatchCache = null;
  _rockCache = null;
  _outerShadingCache = null;
  _arcVoidCache = null;
}
