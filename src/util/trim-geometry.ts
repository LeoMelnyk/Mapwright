/**
 * trim-geometry.ts — Pure geometry for computing per-cell round trim data.
 * Zero dependencies on editor state, canvas, or DOM.
 *
 * Each cell on the arc boundary gets:
 *   trimClip:     floor polygon in cell-local [0,1] coords (x=col dir, y=row dir)
 *   trimWall:     arc polyline in cell-local [0,1] coords
 *   BFS treats arc walls as virtual diagonals (NW/SE → ne-sw, NE/SW → nw-se)
 */

type TrimCorner = 'nw' | 'ne' | 'sw' | 'se';

interface ArcIntersection {
  x: number;
  y: number;
  edge: string;
}

interface ClipAndWall {
  clip: number[][];
  wall: number[][];
}

interface TrimCrossing {
  n: string;
  s: string;
  e: string;
  w: string;
}

interface TrimCellData {
  trimCorner: TrimCorner;
  trimWall: number[][];
  trimClip: number[][];
  trimCrossing: TrimCrossing;
  trimOpen?: boolean;
  trimInverted?: boolean;
  trimPassable?: boolean;
}

interface TrimPreview {
  hypotenuse: Array<{ row: number; col: number }>;
  voided: Array<{ row: number; col: number }>;
  insideArc?: Array<{ row: number; col: number }>;
  arcCenter: { row: number; col: number };
  size: number;
}

const TWO_PI: number = 2 * Math.PI;
const HALF_PI: number = Math.PI / 2;
const PI: number = Math.PI;

function normalizeAngle(a: number): number { return ((a % TWO_PI) + TWO_PI) % TWO_PI; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }

// ── Circle center computation ───────────────────────────────────────────────

/**
 * Compute the circle center for a round trim arc.
 * @param arcRow - Grid corner row (arcCenter.row from preview)
 * @param arcCol - Grid corner col (arcCenter.col from preview)
 * @param size   - Trim radius in cells
 * @param corner - 'nw'|'ne'|'sw'|'se'
 * @param inverted
 * @returns cx = column axis, cy = row axis
 */
export function computeCircleCenter(arcRow: number, arcCol: number, size: number, corner: TrimCorner, inverted: boolean): { cx: number; cy: number } {
  if (inverted) return { cx: arcCol, cy: arcRow };
  switch (corner) {
    case 'nw': return { cx: arcCol + size, cy: arcRow + size };
    case 'ne': return { cx: arcCol - size, cy: arcRow + size };
    case 'sw': return { cx: arcCol + size, cy: arcRow - size };
    case 'se': return { cx: arcCol - size, cy: arcRow - size };
  }
}

// ── Arc angle ranges (quarter circle) ───────────────────────────────────────

function getArcAngleRange(corner: TrimCorner, inverted: boolean): [number, number] {
  if (!inverted) {
    switch (corner) {
      case 'nw': return [PI, 1.5 * PI];
      case 'ne': return [1.5 * PI, TWO_PI];
      case 'sw': return [HALF_PI, PI];
      case 'se': return [0, HALF_PI];
    }
  } else {
    switch (corner) {
      case 'nw': return [0, HALF_PI];
      case 'ne': return [HALF_PI, PI];
      case 'sw': return [1.5 * PI, TWO_PI];
      case 'se': return [PI, 1.5 * PI];
    }
  }
}

function isAngleInRange(angle: number, [lo, hi]: [number, number]): boolean {
  const a = normalizeAngle(angle);
  const eps = 0.03; // ~1.7° tolerance for edge cells
  if (a >= lo - eps && a <= hi + eps) return true;
  // Handle wraparound: ranges ending at 2π (like NE [3π/2, 2π]) must also
  // accept angles near 0 (which is the same point as 2π on the circle).
  if (hi >= TWO_PI - eps && a <= eps) return true;
  return false;
}

// ── Point classification ────────────────────────────────────────────────────

function isRoomSide(x: number, y: number, cx: number, cy: number, R: number, inverted: boolean): boolean {
  const d2 = (x - cx) ** 2 + (y - cy) ** 2;
  return inverted ? d2 > R * R : d2 < R * R;
}

// ── Cell–arc intersection ───────────────────────────────────────────────────

/**
 * Find where the arc (quarter circle) intersects a cell's four edges.
 * Cell at (row, col) spans [col, col+1] × [row, row+1] in grid coords.
 * Returns array of { x, y, edge } in grid coords (filtered to arc range).
 */
function findCellArcIntersections(row: number, col: number, cx: number, cy: number, R: number, arcRange: [number, number]): ArcIntersection[] {
  const hits: ArcIntersection[] = [];
  const eps = 1e-9;

  function tryEdge(name: string, fixed: number, isHoriz: boolean, lo: number, hi: number): void {
    const d = fixed - (isHoriz ? cy : cx);
    const disc = R * R - d * d;
    if (disc < -eps) return;
    const s = Math.sqrt(Math.max(0, disc));
    const center = isHoriz ? cx : cy;
    for (const v of [center - s, center + s]) {
      if (v < lo - eps || v > hi + eps) continue;
      const cv = Math.max(lo, Math.min(hi, v));
      const px = isHoriz ? cv : fixed;
      const py = isHoriz ? fixed : cv;
      if (!isAngleInRange(Math.atan2(py - cy, px - cx), arcRange)) continue;
      hits.push({ x: px, y: py, edge: name });
    }
  }

  tryEdge('north', row,     true,  col, col + 1);
  tryEdge('south', row + 1, true,  col, col + 1);
  tryEdge('west',  col,     false, row, row + 1);
  tryEdge('east',  col + 1, false, row, row + 1);

  // Deduplicate corner hits (same point on two adjacent edges)
  const unique: ArcIntersection[] = [];
  for (const p of hits) {
    if (!unique.some(u => Math.abs(u.x - p.x) < 1e-6 && Math.abs(u.y - p.y) < 1e-6))
      unique.push(p);
  }
  return unique;
}

// ── Boundary parametric position ────────────────────────────────────────────

/**
 * Clockwise parametric position on cell boundary (0–4).
 * 0–1: north edge (L→R), 1–2: east (T→B), 2–3: south (R→L), 3–4: west (B→T).
 */
function edgeParam(gx: number, gy: number, col: number, row: number): number {
  const lx = gx - col, ly = gy - row;
  const eps = 1e-6;
  // Check edges in priority order (N, E, S, W)
  if (Math.abs(ly) < eps)     return Math.max(0, Math.min(1, lx));
  if (Math.abs(lx - 1) < eps) return 1 + Math.max(0, Math.min(1, ly));
  if (Math.abs(ly - 1) < eps) return 2 + Math.max(0, Math.min(1, 1 - lx));
  if (Math.abs(lx) < eps)     return 3 + Math.max(0, Math.min(1, 1 - ly));
  return -1;
}

// ── Clip polygon + wall polyline construction ───────────────────────────────

interface CellCorner {
  lx: number;
  ly: number;
  p: number;
  gx: number;
  gy: number;
}

/**
 * Build clip polygon and wall polyline for a cell intersected by the arc.
 * @returns clip and wall in cell-local [0,1] coords, or null.
 */
function buildClipAndWall(row: number, col: number, cx: number, cy: number, R: number, inverted: boolean, arcRange: [number, number], numSamples: number = 24): ClipAndWall | null {
  const ints = findCellArcIntersections(row, col, cx, cy, R, arcRange);
  if (ints.length < 2) return null;

  // Sort by arc angle for consistent pair selection
  ints.sort((a, b) =>
    normalizeAngle(Math.atan2(a.y - cy, a.x - cx)) -
    normalizeAngle(Math.atan2(b.y - cy, b.x - cx))
  );
  const [i1, i2] = ints;

  // Parametric positions on cell boundary
  const p1 = edgeParam(i1.x, i1.y, col, row);
  const p2 = edgeParam(i2.x, i2.y, col, row);
  if (p1 < 0 || p2 < 0) return null; // not on boundary

  // Sort so pa < pb
  let pa: number, pb: number, ia: ArcIntersection, ib: ArcIntersection;
  if (p1 < p2) { pa = p1; pb = p2; ia = i1; ib = i2; }
  else          { pa = p2; pb = p1; ia = i2; ib = i1; }

  // Cell corners in clockwise order
  const corners: CellCorner[] = [
    { lx: 0, ly: 0, p: 0, gx: col,     gy: row     }, // TL
    { lx: 1, ly: 0, p: 1, gx: col + 1, gy: row     }, // TR
    { lx: 1, ly: 1, p: 2, gx: col + 1, gy: row + 1 }, // BR
    { lx: 0, ly: 1, p: 3, gx: col,     gy: row + 1 }, // BL
  ];

  // Segment A: corners between pa and pb (clockwise)
  const segA = corners.filter(c => c.p > pa + 1e-6 && c.p < pb - 1e-6);
  // Segment B: corners outside [pa, pb] — sorted clockwise from pb
  const segB = corners
    .filter(c => c.p > pb + 1e-6 || c.p < pa - 1e-6)
    .sort((a, b) => ((a.p - pb + 4) % 4) - ((b.p - pb + 4) % 4));

  // Decide which segment is on the room side
  let roomCorners: CellCorner[], roomStart: ArcIntersection, roomEnd: ArcIntersection;
  const probe = segA.length > 0 ? segA : segB;
  if (probe.length > 0) {
    const testRoom = isRoomSide(probe[0].gx, probe[0].gy, cx, cy, R, inverted);
    const segAIsRoom = segA.length > 0 ? testRoom : !testRoom;
    if (segAIsRoom) { roomCorners = segA; roomStart = ia; roomEnd = ib; }
    else            { roomCorners = segB; roomStart = ib; roomEnd = ia; }
  } else {
    // Both intersections very close — use cell center to decide
    roomCorners = [];
    if (isRoomSide(col + 0.5, row + 0.5, cx, cy, R, inverted)) {
      roomStart = ia; roomEnd = ib;
    } else {
      roomStart = ib; roomEnd = ia;
    }
  }

  // ── Wall polyline: arc samples from roomEnd → roomStart ──
  const a1 = Math.atan2(roomEnd.y - cy, roomEnd.x - cx);
  const a2 = Math.atan2(roomStart.y - cy, roomStart.x - cx);
  let da = a2 - a1;
  if (da > PI) da -= TWO_PI;
  if (da < -PI) da += TWO_PI;

  const wall: number[][] = [[round3(roomEnd.x - col), round3(roomEnd.y - row)]];
  for (let i = 1; i < numSamples; i++) {
    const t = i / numSamples;
    const a = a1 + da * t;
    wall.push([round3(cx + R * Math.cos(a) - col), round3(cy + R * Math.sin(a) - row)]);
  }
  wall.push([round3(roomStart.x - col), round3(roomStart.y - row)]);

  // ── Clip polygon: roomStart → room corners → roomEnd → arc → roomStart ──
  const clip: number[][] = [[round3(roomStart.x - col), round3(roomStart.y - row)]];
  for (const c of roomCorners) clip.push([c.lx, c.ly]);
  clip.push([round3(roomEnd.x - col), round3(roomEnd.y - row)]);
  // Interior arc samples (endpoints already in clip)
  for (let i = 1; i < numSamples; i++) {
    const t = i / numSamples;
    const a = a1 + da * t;
    clip.push([round3(cx + R * Math.cos(a) - col), round3(cy + R * Math.sin(a) - row)]);
  }

  return { clip, wall };
}

// ── Crossing matrix from clip polygon (3×3 sub-grid approach) ───────────────

/**
 * Compute which cell edge a point [x,y] in cell-local [0,1] coords lies on.
 * Returns 'n','s','e','w' or null if not on an edge.
 */
function whichEdge(x: number, y: number): string | null {
  const eps = 0.05;
  if (Math.abs(y) < eps)     return 'n';
  if (Math.abs(y - 1) < eps) return 's';
  if (Math.abs(x) < eps)     return 'w';
  if (Math.abs(x - 1) < eps) return 'e';
  return null;
}

/**
 * Clockwise parametric position on cell boundary (0–4).
 * 0–1: north (L→R), 1–2: east (T→B), 2–3: south (R→L), 3–4: west (B→T).
 */
function _edgeParam(x: number, y: number): number {
  const eps = 0.05;
  if (Math.abs(y) < eps)     return Math.max(0, Math.min(1, x));
  if (Math.abs(x - 1) < eps) return 1 + Math.max(0, Math.min(1, y));
  if (Math.abs(y - 1) < eps) return 2 + Math.max(0, Math.min(1, 1 - x));
  if (Math.abs(x) < eps)     return 3 + Math.max(0, Math.min(1, 1 - y));
  return -1;
}

/**
 * Compute a crossing matrix from the trimWall arc endpoints.
 * The arc enters and exits the cell at two boundary points, dividing the
 * cell perimeter into two arcs. Edges on the same arc are reachable from
 * each other; edges on opposite arcs are not (the arc wall separates them).
 *
 * Returns { n: "nsw", s: "nsw", e: "e", w: "nsw" } — for each entry direction,
 * which exits are reachable without crossing the arc wall.
 */
export function computeTrimCrossing(clip: number[][], wall: number[][]): TrimCrossing {
  // Determine arc entry/exit edges from trimWall endpoints
  if (!wall || wall.length < 2) return { n: 'nsew', s: 'nsew', e: 'nsew', w: 'nsew' };
  const startPt = wall[0];
  const endPt = wall[wall.length - 1];
  const startEdge = whichEdge(startPt[0], startPt[1]);
  const endEdge = whichEdge(endPt[0], endPt[1]);
  if (!startEdge || !endEdge) return { n: 'nsew', s: 'nsew', e: 'nsew', w: 'nsew' };

  // Parametric positions of the two arc endpoints on the cell boundary
  const pStart = _edgeParam(startPt[0], startPt[1]);
  const pEnd = _edgeParam(endPt[0], endPt[1]);
  if (pStart < 0 || pEnd < 0) return { n: 'nsew', s: 'nsew', e: 'nsew', w: 'nsew' };

  // Edge parametric ranges: [start, end) going clockwise
  const edgeRanges: Record<string, [number, number]> = { n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 4] };

  // The two arc endpoints divide the perimeter into two arcs.
  // Arc A: clockwise from pStart to pEnd (shorter or longer path)
  // Arc B: clockwise from pEnd to pStart
  // Determine which edges are on which arc.
  const pLo = Math.min(pStart, pEnd);
  const pHi = Math.max(pStart, pEnd);

  // An edge is on "side A" (between pLo and pHi) or "side B" (wrapping around).
  // For split edges (where the arc point lies), the edge belongs to BOTH sides.
  function edgeSide(dir: string): 'A' | 'B' {
    const [lo, hi] = edgeRanges[dir];
    const midParam = (lo + hi) / 2;
    // Is the midpoint between pLo and pHi?
    if (midParam > pLo && midParam < pHi) return 'A';
    return 'B';
  }

  // Assign each edge to a side. Split edges (containing an arc point) get both sides.
  const sides: Record<string, 'A' | 'B'> = {};
  for (const dir of ['n', 'e', 's', 'w']) {
    sides[dir] = edgeSide(dir);
  }

  // Check if both sides have at least one edge. If one side has all 4,
  // the arc barely clips a corner — fall back to virtual diagonal blocking
  // based on trimCorner so the cell still acts as a boundary.
  const sideA = ['n','e','s','w'].filter(d => sides[d] === 'A');
  const sideB = ['n','e','s','w'].filter(d => sides[d] === 'B');
  if (sideA.length === 0 || sideB.length === 0) {
    // Fallback: all edges on one side. Use the arc endpoints' edges as the split.
    // Block crossing between the two edges the arc touches.
    // Treat as a diagonal: startEdge/endEdge on one side, others on the other.
    const arcEdges = new Set<string>([startEdge, endEdge]);
    const result: Record<string, string> = {};
    for (const dir of ['n', 's', 'e', 'w']) {
      let exits = '';
      for (const d2 of ['n', 's', 'e', 'w']) {
        // Same group = both arc-edges or both non-arc-edges
        if (arcEdges.has(dir) === arcEdges.has(d2)) exits += d2;
      }
      result[dir] = exits;
    }
    // @ts-expect-error — strict-mode migration
    return result as TrimCrossing;
  }

  // Build crossing: entry from dir → can reach all edges on the same side
  const result: Record<string, string> = {};
  for (const dir of ['n', 's', 'e', 'w']) {
    const mySide = sides[dir];
    let exits = '';
    for (const d2 of ['n', 's', 'e', 'w']) {
      if (sides[d2] === mySide) exits += d2;
    }
    result[dir] = exits;
  }

  // @ts-expect-error — strict-mode migration
  return result as TrimCrossing;
}

// ── Single-cell computation (for migration) ────────────────────────────────

/**
 * Compute arc data for a single cell given explicit arc parameters.
 * Used by the migration to convert old-format cells.
 * @returns null if arc doesn't intersect cell.
 */
export function computeArcCellData(row: number, col: number, cx: number, cy: number, R: number, corner: TrimCorner, inverted: boolean): { trimClip: number[][]; trimWall: number[][]; trimCrossing: TrimCrossing } | null {
  const arcRange = getArcAngleRange(corner, inverted);
  const data = buildClipAndWall(row, col, cx, cy, R, inverted, arcRange);
  if (!data) return null;
  return { trimClip: data.clip, trimWall: data.wall, trimCrossing: computeTrimCrossing(data.clip, data.wall) };
}

// ── Public batch function ───────────────────────────────────────────────────

/**
 * Compute per-cell trim data for all cells in a round trim zone.
 *
 * @param preview - From _updatePreview: { hypotenuse, voided, insideArc, arcCenter: {row,col}, size }
 * @param corner   - 'nw'|'ne'|'sw'|'se'
 * @param inverted
 * @param open
 * @returns Map where values are:
 *   - null      → void the cell (set cells[r][c] = null)
 *   - 'interior'→ regular floor cell (clear any old trim flags)
 *   - Object    → arc boundary cell: { trimCorner, trimClip?, trimWall, trimPassable?, trimOpen?, trimInverted? }
 */
export function computeTrimCells(preview: TrimPreview, corner: TrimCorner, inverted: boolean, open: boolean): Map<string, TrimCellData | null | 'interior'> {
  const { hypotenuse, voided, insideArc, arcCenter, size } = preview;
  const result = new Map<string, TrimCellData | null | 'interior'>();
  const { cx, cy } = computeCircleCenter(arcCenter.row, arcCenter.col, size, corner, inverted);
  const R = size;
  const arcRange = getArcAngleRange(corner, inverted);

  // ── Default classifications ──
  for (const { row, col } of voided) {
    result.set(`${row},${col}`, open ? 'interior' : null);
  }
  for (const { row, col } of (insideArc || [])) {
    result.set(`${row},${col}`, 'interior');
  }
  for (const { row, col } of hypotenuse) {
    if (inverted) {
      // Inverted: hypotenuse cells are in the void zone (the arc is the boundary,
      // not the diagonal). Void them for closed trims; floor for open.
      result.set(`${row},${col}`, open ? 'interior' : null);
    } else {
      // Non-inverted: hypotenuse cells are at the arc boundary — 'interior' by
      // default, will be overridden with trimClip if the arc passes through them.
      result.set(`${row},${col}`, 'interior');
    }
  }

  // ── Gather candidate cells to check for arc intersection ──
  const candidateKeys = new Set<string>();
  const allCells = [...hypotenuse, ...voided, ...(insideArc || [])];
  for (const { row, col } of allCells) {
    candidateKeys.add(`${row},${col}`);
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      candidateKeys.add(`${row + dr},${col + dc}`);
    }
  }

  // For inverted trims the arc curves INTO the room, so boundary cells are
  // room cells far outside the void triangle. Scan the full arc bounding box.
  if (inverted) {
    let r0: number, r1: number, c0: number, c1: number;
    switch (corner) {
      case 'nw': r0 = arcCenter.row; r1 = arcCenter.row + size; c0 = arcCenter.col; c1 = arcCenter.col + size; break;
      case 'ne': r0 = arcCenter.row; r1 = arcCenter.row + size; c0 = arcCenter.col - size; c1 = arcCenter.col; break;
      case 'sw': r0 = arcCenter.row - size; r1 = arcCenter.row; c0 = arcCenter.col; c1 = arcCenter.col + size; break;
      case 'se': r0 = arcCenter.row - size; r1 = arcCenter.row; c0 = arcCenter.col - size; c1 = arcCenter.col; break;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = `${r},${c}`;
        candidateKeys.add(key);
        // Void cells whose center is inside the arc circle. Cells at the arc
        // boundary (partially inside) will be overridden with trimClip by the
        // arc intersection check below.
        if (!result.has(key)) {
          const d2 = (c + 0.5 - cx) ** 2 + (r + 0.5 - cy) ** 2;
          if (d2 < R * R) {
            result.set(key, open ? 'interior' : null);
          }
        }
      }
    }
  }

  // ── Override with arc intersection data ──
  for (const key of candidateKeys) {
    const [row, col] = key.split(',').map(Number);
    const data = buildClipAndWall(row, col, cx, cy, R, inverted, arcRange);
    if (!data) continue;

    if (open) {
      // Open trims: wall line + clip (for texture split) + BFS crossing.
      // trimOpen flag tells renderer not to void the floor.
      result.set(key, {
        trimCorner: corner, trimWall: data.wall, trimClip: data.clip, trimOpen: true,
        trimCrossing: computeTrimCrossing(data.clip, data.wall),
        ...(inverted ? { trimInverted: true } : {}),
      });
    } else {
      // Closed trims: full clip polygon for rendering + crossing for BFS
      const entry: TrimCellData = { trimCorner: corner, trimWall: data.wall, trimClip: data.clip,
        trimCrossing: computeTrimCrossing(data.clip, data.wall) };
      if (inverted) entry.trimInverted = true;
      result.set(key, entry);
    }
  }

  return result;
}
