import fs from 'fs';
import { RESERVED_CHARS } from './constants.js';

// ── File Parser ──────────────────────────────────────────────────────

const SECTION_KEYWORDS = ['legend:', 'doors:', 'trims:', 'stairs:', 'fills:', 'props:', 'textures:', 'lights:'];

/** Strip inline # comments from a line (e.g. "5,10 east : door  # A1 east wall" → "5,10 east : door"). */
function stripComment(line) {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}
const LEVEL_MARKER_RE = /^===\s*(.+?)\s*===$/;

/**
 * Parse one side of a stair entry — either coordinate-based or room-relative.
 * Returns { row, col, type, autoPlace: false } for coordinates,  (row,col order — matches the API)
 *         { room, type, autoPlace: true } for room labels,
 *         or null if the string doesn't match.
 */
function parseStairSide(str) {
  const coordMatch = str.match(/^(\d+)\s*,\s*(\d+)\s*:\s*(up|down)$/);
  if (coordMatch) {
    return { row: parseInt(coordMatch[1]), col: parseInt(coordMatch[2]), type: coordMatch[3], autoPlace: false };
  }
  const roomMatch = str.match(/^([A-Za-z]\w*)\s*:\s*(up|down)$/);
  if (roomMatch) {
    return { room: roomMatch[1], type: roomMatch[2], autoPlace: true };
  }
  return null;
}

/**
 * Parse a block of lines into grid + sections (legend, doors, trims, stairs).
 * Used both for single-level maps and per-level parsing in multi-level maps.
 * Returns { gridLines, legend, doors, trims, stairs }.
 */
function parseLevelContent(lines, levelLabel, lineOffset = 0) {
  const prefix = levelLabel ? `${levelLabel}: ` : '';
  const srcLine = (i) => `(line ${lineOffset + i + 1}) `;
  const gridLines = [];
  let i = 0;

  // Skip blank lines at start
  while (i < lines.length && lines[i].trim() === '') i++;

  // Collect grid lines until we hit a section keyword, level marker, or end
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (SECTION_KEYWORDS.includes(trimmed)) break;
    if (LEVEL_MARKER_RE.test(trimmed)) break;
    if (trimmed === '') { i++; continue; }
    if (trimmed.startsWith('#')) { i++; continue; } // full-line comment
    gridLines.push(stripComment(lines[i]).trimEnd()); // strip inline # comments (e.g. row annotations)
    i++;
  }

  if (gridLines.length === 0) {
    throw new Error(`${prefix}No grid found`);
  }

  // Parse sections
  const legend = {};
  const doors = [];
  const trims = {};
  const stairs = [];
  const fills = {};
  const cellFills = [];
  const props = [];
  const textures = [];
  const lights = [];

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (LEVEL_MARKER_RE.test(trimmed)) break; // stop at next level marker

    if (trimmed === 'legend:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;
        if (line.startsWith('#')) continue; // full-line comment (after stripComment, shouldn't occur, but safe)
        const match = line.match(/^(.)\s*:\s*(.*)$/);
        if (match) {
          const char = match[1];
          const label = match[2].trim() || null;
          if (RESERVED_CHARS.has(char)) {
            throw new Error(`${prefix}${srcLine(li)}Legend cannot map reserved character '${char}'`);
          }
          legend[char] = label;
        }
      }
    } else if (trimmed === 'doors:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;
        const match = line.match(/^(\d+)\s*,\s*(\d+)\s*(\w+)?\s*:\s*(door|secret)$/);
        if (match) {
          doors.push({
            row: parseInt(match[1]),  // row,col order — matches the API
            col: parseInt(match[2]),
            direction: match[3] || null,
            type: match[4]
          });
        } else {
          throw new Error(`${prefix}${srcLine(li)}Invalid door entry: "${line}"`);
        }
      }
    } else if (trimmed === 'trims:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;
        const match = line.match(/^(\S+)\s*:\s*(.+)$/);
        if (match) {
          const label = match[1];
          const rawCorners = match[2].split(',').map(c => c.trim()).filter(Boolean);
          const corners = rawCorners.map(token => {
            const m = token.match(/^(nw|ne|sw|se)(\d+)?(ri|r)?$/);
            if (!m) {
              throw new Error(`${prefix}${srcLine(li)}Room ${label}: invalid trim '${token}' (valid: nw, ne, sw, se, optionally followed by size and/or r/ri e.g. nw2, nw2r, nw2ri)`);
            }
            const size = m[2] ? parseInt(m[2]) : 1;
            if (size < 1) throw new Error(`${prefix}${srcLine(li)}Room ${label}: trim size must be at least 1, got '${token}'`);
            return { corner: m[1], size, round: !!m[3], inverted: m[3] === 'ri' };
          });
          // Cell-coordinate trim: "row,col: corner[size][r][i]" — label is "row,col"
          const coordMatch = label.match(/^(\d+),(\d+)$/);
          if (coordMatch) {
            // Store with a special key so compile.js can differentiate
            const coordKey = `@${coordMatch[1]},${coordMatch[2]}`;
            trims[coordKey] = corners;
          } else {
            trims[label] = corners;
          }
        }
      }
    } else if (trimmed === 'fills:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;
        // Per-cell fill: row,col: fillType
        const cellMatch = line.match(/^(\d+)\s*,\s*(\d+)\s*:\s*(hazard|difficult-terrain|pit|water|lava)$/);
        if (cellMatch) {
          cellFills.push({ row: parseInt(cellMatch[1]), col: parseInt(cellMatch[2]), fill: cellMatch[3] });
          continue;
        }
        // Room-label fill: Label: fillType
        const match = line.match(/^(\S+)\s*:\s*(hazard|difficult-terrain|pit|water|lava)$/);
        if (match) {
          fills[match[1]] = match[2];
        } else {
          throw new Error(`${prefix}${srcLine(li)}Invalid fill entry: "${line}" (expected: RoomLabel: hazard|pit|water|lava  or  row,col: hazard|pit|water|lava)`);
        }
      }
    } else if (trimmed === 'stairs:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;

        // Try linked pair: side - [L#:]side  (each side can be coord or room-relative)
        const dashIdx = line.indexOf(' - ');
        if (dashIdx !== -1) {
          const leftStr = line.substring(0, dashIdx).trim();
          let rightStr = line.substring(dashIdx + 3).trim();
          let linkedLevel = null;

          // Check for L#: prefix on right side — only accept if remainder is a valid side
          const lvlMatch = rightStr.match(/^L(\d+)\s*:\s*(.+)$/);
          if (lvlMatch) {
            const remainder = lvlMatch[2];
            if (parseStairSide(remainder)) {
              linkedLevel = parseInt(lvlMatch[1]);
              rightStr = remainder;
            }
          }

          const left = parseStairSide(leftStr);
          const right = parseStairSide(rightStr);
          if (left && right) {
            const stair = { ...left, linked: { ...right } };
            if (linkedLevel !== null) stair.linked.level = linkedLevel;
            stairs.push(stair);
            continue;
          }
        }

        // Try standalone: coord or room-relative
        const side = parseStairSide(line);
        if (side) {
          stairs.push(side);
        } else {
          throw new Error(
            `${prefix}${srcLine(li)}Invalid stairs entry: "${line}" ` +
            `(expected: col,row: up|down  or  RoomLabel: up|down  or  linked pair with " - ")`
          );
        }
      }
    } else if (trimmed === 'props:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;
        // Format: row,col: proptype  or  row,col: proptype facing:N
        const match = line.match(/^(\d+)\s*,\s*(\d+)\s*:\s*(\S+)(?:\s+facing:\s*(\d+))?$/);
        if (match) {
          const facing = match[4] ? parseInt(match[4]) : 0;
          if (![0, 90, 180, 270].includes(facing)) {
            throw new Error(`${prefix}${srcLine(li)}Invalid prop facing: ${facing} (use 0, 90, 180, or 270)`);
          }
          props.push({ row: parseInt(match[1]), col: parseInt(match[2]), type: match[3], facing });
        } else {
          throw new Error(`${prefix}${srcLine(li)}Invalid props entry: "${line}" (expected: row,col: proptype [facing:N])`);
        }
      }
    } else if (trimmed === 'textures:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;
        // Format: row,col: textureId [opacity]
        const match = line.match(/^(\d+)\s*,\s*(\d+)\s*:\s*(\S+)(?:\s+([\d.]+))?$/);
        if (match) {
          const opacity = match[4] ? parseFloat(match[4]) : 1.0;
          textures.push({ row: parseInt(match[1]), col: parseInt(match[2]), texture: match[3], opacity });
        } else {
          throw new Error(`${prefix}${srcLine(li)}Invalid textures entry: "${line}" (expected: row,col: textureId [opacity])`);
        }
      }
    } else if (trimmed === 'lights:') {
      i++;
      while (i < lines.length && !SECTION_KEYWORDS.includes(lines[i].trim()) && !LEVEL_MARKER_RE.test(lines[i].trim())) {
        const line = stripComment(lines[i]).trim();
        const li = i;
        i++;
        if (!line) continue;
        // Format: x,y: type color radius intensity falloff [angle spread]
        const match = line.match(/^([\d.]+)\s*,\s*([\d.]+)\s*:\s*(.+)$/);
        if (match) {
          const x = parseFloat(match[1]);
          const y = parseFloat(match[2]);
          const parts = match[3].trim().split(/\s+/);
          const light = { x, y };
          // Parse key:value pairs
          for (const part of parts) {
            const kv = part.match(/^(\w+):([\w#.]+)$/);
            if (kv) {
              const key = kv[1], val = kv[2];
              if (key === 'type') light.type = val;
              else if (key === 'color') light.color = val.startsWith('#') ? val : '#' + val;
              else if (key === 'radius') light.radius = parseFloat(val);
              else if (key === 'intensity') light.intensity = parseFloat(val);
              else if (key === 'falloff') light.falloff = val;
              else if (key === 'angle') light.angle = parseFloat(val);
              else if (key === 'spread') light.spread = parseFloat(val);
            }
          }
          if (!light.type) light.type = 'point';
          lights.push(light);
        } else {
          throw new Error(`${prefix}${srcLine(li)}Invalid lights entry: "${line}" (expected: x,y: type:point color:#ff9944 radius:30 intensity:1.0 falloff:smooth)`);
        }
      }
    } else {
      i++;
    }
  }

  return { gridLines, legend, doors, trims, stairs, fills, cellFills, props, textures, lights };
}

function parseMapFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  // Parse header (between --- delimiters)
  let headerStart = -1, headerEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (headerStart === -1) headerStart = i;
      else { headerEnd = i; break; }
    }
  }

  if (headerStart === -1 || headerEnd === -1) {
    throw new Error('Missing header (delimit with --- lines)');
  }

  const header = parseHeader(lines.slice(headerStart + 1, headerEnd));

  // Everything after header
  const bodyLines = lines.slice(headerEnd + 1);
  const bodyOffset = headerEnd + 1; // 0-based index of first body line in source file

  // Check for level markers
  const levelIndices = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const match = bodyLines[i].trim().match(LEVEL_MARKER_RE);
    if (match) {
      levelIndices.push({ index: i, name: match[1] });
    }
  }

  if (levelIndices.length === 0) {
    // Single-level map (backward compatible) — wrap as one level
    const level = parseLevelContent(bodyLines, null, bodyOffset);
    return { header, levels: [{ name: null, ...level }] };
  }

  // Multi-level map — parse each level section
  const levels = [];
  for (let li = 0; li < levelIndices.length; li++) {
    const start = levelIndices[li].index + 1; // line after the === marker
    const end = li + 1 < levelIndices.length ? levelIndices[li + 1].index : bodyLines.length;
    const levelLines = bodyLines.slice(start, end);
    const levelName = levelIndices[li].name;
    const level = parseLevelContent(levelLines, `Level ${li + 1} (${levelName})`, bodyOffset + start);
    levels.push({ name: levelName, ...level });
  }

  return { header, levels };
}

function parseHeader(lines) {
  const header = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Check for themeOverrides block
    const overrideMatch = line.match(/^themeOverrides\s*:\s*$/);
    if (overrideMatch) {
      const overrides = {};
      i++;
      while (i < lines.length) {
        const indented = lines[i].match(/^\s+(\w+)\s*:\s*(.+)$/);
        if (!indented) break;
        overrides[indented[1]] = indented[2].trim();
        i++;
      }
      header.themeOverrides = overrides;
      continue;
    }
    const match = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();
      // Parse booleans
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      // Parse numbers
      else if (/^\d+$/.test(value)) value = parseInt(value);
      header[key] = value;
    }
    i++;
  }

  if (!header.name) throw new Error('Header missing "name"');
  if (!header.theme) throw new Error('Header missing "theme"');

  // Validate labelStyle if provided
  const validLabelStyles = ['circled', 'plain', 'bold'];
  const labelStyle = validLabelStyles.includes(header.labelStyle) ? header.labelStyle : 'circled';

  const result = {
    dungeonName: header.name,
    gridSize: header.gridSize || 5,
    titleFontSize: header.titleFontSize || undefined,
    theme: header.theme,
    labelStyle,
    features: {
      showGrid: header.showGrid ?? false,
      compassRose: header.compassRose ?? false,
      scale: header.scale ?? false,
      border: header.border ?? false
    }
  };

  if (header.themeOverrides) {
    result.themeOverrides = header.themeOverrides;
  }

  return result;
}

export { parseStairSide, parseLevelContent, parseMapFile, parseHeader };
