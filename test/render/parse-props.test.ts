/**
 * Unit tests for parse-props.js — prop file parsing and coordinate transformations.
 *
 * All functions under test are pure (no side effects, no mocking needed).
 */
import { describe, it, expect } from 'vitest';

import {
  parsePropFile,
  parseCommand,
  parseCoord,
  parseOpacity,
  parseHexColor,
  parseStyleExtended,
  scanKeyword,
  scaleFactor,
  isGradient,
  rotatePoint,
  flipCommand,
  transformCommand,
} from '../../src/render/parse-props.js';

// ── parseCoord ─────────────────────────────────────────────────────────────

describe('parseCoord', () => {
  it('parses a normal "x,y" string', () => {
    expect(parseCoord('3,4')).toEqual([3, 4]);
  });

  it('parses decimal coordinates', () => {
    expect(parseCoord('0.5,1.25')).toEqual([0.5, 1.25]);
  });

  it('returns [0,0] for undefined/null', () => {
    expect(parseCoord(undefined)).toEqual([0, 0]);
    expect(parseCoord(null)).toEqual([0, 0]);
  });

  it('returns [0,0] for empty string', () => {
    expect(parseCoord('')).toEqual([0, 0]);
  });

  it('handles negative coordinates', () => {
    expect(parseCoord('-1,-2.5')).toEqual([-1, -2.5]);
  });
});

// ── parseOpacity ───────────────────────────────────────────────────────────

describe('parseOpacity', () => {
  it('returns null for undefined', () => {
    expect(parseOpacity(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseOpacity(null)).toBeNull();
  });

  it('parses a valid float string', () => {
    expect(parseOpacity('0.5')).toBe(0.5);
  });

  it('parses integer string', () => {
    expect(parseOpacity('1')).toBe(1);
  });

  it('returns null for non-numeric string', () => {
    expect(parseOpacity('fill')).toBeNull();
  });

  it('returns null for keyword starting with #', () => {
    expect(parseOpacity('#FF0000')).toBeNull();
  });
});

// ── parseHexColor ──────────────────────────────────────────────────────────

describe('parseHexColor', () => {
  it('parses #RRGGBB', () => {
    expect(parseHexColor('#FF8000')).toEqual({ r: 255, g: 128, b: 0 });
  });

  it('parses #RGB shorthand', () => {
    expect(parseHexColor('#F00')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses lowercase hex', () => {
    expect(parseHexColor('#0a1b2c')).toEqual({ r: 10, g: 27, b: 44 });
  });

  it('parses black', () => {
    expect(parseHexColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('parses white shorthand', () => {
    expect(parseHexColor('#FFF')).toEqual({ r: 255, g: 255, b: 255 });
  });
});

// ── scanKeyword ────────────────────────────────────────────────────────────

describe('scanKeyword', () => {
  it('finds a keyword and returns its value', () => {
    expect(scanKeyword(['fill', 'width', '3'], 'width')).toBe(3);
  });

  it('returns null when keyword is absent', () => {
    expect(scanKeyword(['fill', '#FF0000'], 'width')).toBeNull();
  });

  it('returns null when keyword is last token (no value)', () => {
    expect(scanKeyword(['fill', 'width'], 'width')).toBeNull();
  });

  it('handles float values', () => {
    expect(scanKeyword(['stroke', 'rotate', '45.5'], 'rotate')).toBe(45.5);
  });

  it('finds the first occurrence', () => {
    expect(scanKeyword(['width', '2', 'width', '5'], 'width')).toBe(2);
  });
});

// ── scaleFactor ────────────────────────────────────────────────────────────

describe('scaleFactor', () => {
  it('returns 1 when scale equals GRID_SCALE (20)', () => {
    expect(scaleFactor({ scale: 20 })).toBe(1);
  });

  it('returns 2 when scale is double GRID_SCALE', () => {
    expect(scaleFactor({ scale: 40 })).toBe(2);
  });

  it('returns 0.5 when scale is half GRID_SCALE', () => {
    expect(scaleFactor({ scale: 10 })).toBe(0.5);
  });
});

// ── isGradient ─────────────────────────────────────────────────────────────

describe('isGradient', () => {
  it('returns true for gradient-radial', () => {
    expect(isGradient({ style: 'gradient-radial' })).toBe(true);
  });

  it('returns true for gradient-linear', () => {
    expect(isGradient({ style: 'gradient-linear' })).toBe(true);
  });

  it('returns false for fill', () => {
    expect(isGradient({ style: 'fill' })).toBe(false);
  });

  it('returns false for stroke', () => {
    expect(isGradient({ style: 'stroke' })).toBe(false);
  });

  it('returns false for texfill', () => {
    expect(isGradient({ style: 'texfill' })).toBe(false);
  });
});

// ── parseStyleExtended ─────────────────────────────────────────────────────

describe('parseStyleExtended', () => {
  it('defaults to fill with null color/opacity when no tokens', () => {
    const result = parseStyleExtended([], 0);
    expect(result).toEqual({ style: 'fill', color: null, textureId: null, opacity: null });
  });

  it('parses gradient-radial with two colors', () => {
    const tokens = ['gradient-radial', '#FF0000', '#0000FF'];
    const result = parseStyleExtended(tokens, 0);
    expect(result.style).toBe('gradient-radial');
    expect(result.color).toBe('#FF0000');
    expect(result.gradientEnd).toBe('#0000FF');
  });

  it('parses gradient-linear with opacity', () => {
    const tokens = ['gradient-linear', '#FFF', '#000', '0.8'];
    const result = parseStyleExtended(tokens, 0);
    expect(result.style).toBe('gradient-linear');
    expect(result.opacity).toBe(0.8);
  });

  it('parses texfill with texture ID and opacity', () => {
    const tokens = ['texfill', 'stone_floor', '0.6'];
    const result = parseStyleExtended(tokens, 0);
    expect(result.style).toBe('texfill');
    expect(result.textureId).toBe('stone_floor');
    expect(result.opacity).toBe(0.6);
  });

  it('parses fill with hex color', () => {
    const tokens = ['fill', '#8B4513', '0.9'];
    const result = parseStyleExtended(tokens, 0);
    expect(result.style).toBe('fill');
    expect(result.color).toBe('#8B4513');
    expect(result.opacity).toBe(0.9);
  });

  it('parses stroke without color (theme color)', () => {
    const tokens = ['stroke', '0.5'];
    const result = parseStyleExtended(tokens, 0);
    expect(result.style).toBe('stroke');
    expect(result.color).toBeNull();
    expect(result.opacity).toBe(0.5);
  });

  it('parses fill without color or opacity', () => {
    const tokens = ['fill'];
    const result = parseStyleExtended(tokens, 0);
    expect(result.style).toBe('fill');
    expect(result.color).toBeNull();
    expect(result.opacity).toBeNull();
  });

  it('treats unknown style tokens as fill', () => {
    const tokens = ['unknown_style'];
    const result = parseStyleExtended(tokens, 0);
    expect(result.style).toBe('fill');
  });
});

// ── parseCommand ───────────────────────────────────────────────────────────

describe('parseCommand', () => {
  describe('rect', () => {
    it('parses basic rect', () => {
      const cmd = parseCommand('rect 0,0 1,1 fill');
      expect(cmd.type).toBe('rect');
      expect(cmd.x).toBe(0);
      expect(cmd.y).toBe(0);
      expect(cmd.w).toBe(1);
      expect(cmd.h).toBe(1);
      expect(cmd.style).toBe('fill');
    });

    it('parses rect with color and width', () => {
      const cmd = parseCommand('rect 0.1,0.2 0.8,0.6 fill #8B4513 width 2');
      expect(cmd.color).toBe('#8B4513');
      expect(cmd.width).toBe(2);
    });

    it('parses rect with rotate keyword', () => {
      const cmd = parseCommand('rect 0.25,0.25 0.5,0.5 fill rotate 45');
      expect(cmd.rotate).toBe(45);
    });
  });

  describe('circle', () => {
    it('parses basic circle', () => {
      const cmd = parseCommand('circle 0.5,0.5 0.35 fill');
      expect(cmd.type).toBe('circle');
      expect(cmd.cx).toBe(0.5);
      expect(cmd.cy).toBe(0.5);
      expect(cmd.r).toBe(0.35);
      expect(cmd.style).toBe('fill');
    });

    it('parses circle with stroke and color', () => {
      const cmd = parseCommand('circle 0.5,0.5 0.4 stroke #333333 0.8');
      expect(cmd.style).toBe('stroke');
      expect(cmd.color).toBe('#333333');
      expect(cmd.opacity).toBe(0.8);
    });
  });

  describe('ellipse', () => {
    it('parses ellipse', () => {
      const cmd = parseCommand('ellipse 0.5,0.5 0.4,0.3 fill');
      expect(cmd.type).toBe('ellipse');
      expect(cmd.cx).toBe(0.5);
      expect(cmd.cy).toBe(0.5);
      expect(cmd.rx).toBe(0.4);
      expect(cmd.ry).toBe(0.3);
    });
  });

  describe('line', () => {
    it('parses basic line with legacy lineWidth', () => {
      const cmd = parseCommand('line 0,0 1,1 0.05');
      expect(cmd.type).toBe('line');
      expect(cmd.x1).toBe(0);
      expect(cmd.y1).toBe(0);
      expect(cmd.x2).toBe(1);
      expect(cmd.y2).toBe(1);
      expect(cmd.lineWidth).toBe(0.05);
    });

    it('parses line with stroke style and color', () => {
      const cmd = parseCommand('line 0,0 1,1 stroke #FF0000 0.5');
      expect(cmd.color).toBe('#FF0000');
      expect(cmd.opacity).toBe(0.5);
      expect(cmd.lineWidth).toBeNull();
    });

    it('parses line without extra params', () => {
      const cmd = parseCommand('line 0.1,0.2 0.8,0.9');
      expect(cmd.lineWidth).toBeNull();
      expect(cmd.color).toBeNull();
    });
  });

  describe('poly', () => {
    it('parses polygon with three vertices', () => {
      const cmd = parseCommand('poly 0,0 1,0 0.5,1 fill');
      expect(cmd.type).toBe('poly');
      expect(cmd.points).toEqual([[0, 0], [1, 0], [0.5, 1]]);
      expect(cmd.style).toBe('fill');
    });

    it('parses polygon with stroke', () => {
      const cmd = parseCommand('poly 0,0 1,0 1,1 0,1 stroke #444 0.5');
      expect(cmd.style).toBe('stroke');
      expect(cmd.points).toHaveLength(4);
    });

    it('parses polygon with texfill', () => {
      const cmd = parseCommand('poly 0,0 1,0 0.5,1 texfill wood_plank');
      expect(cmd.style).toBe('texfill');
      expect(cmd.textureId).toBe('wood_plank');
    });
  });

  describe('arc', () => {
    it('parses arc command', () => {
      const cmd = parseCommand('arc 0.5,0.5 0.4 0 180 fill');
      expect(cmd.type).toBe('arc');
      expect(cmd.cx).toBe(0.5);
      expect(cmd.cy).toBe(0.5);
      expect(cmd.r).toBe(0.4);
      expect(cmd.startDeg).toBe(0);
      expect(cmd.endDeg).toBe(180);
      expect(cmd.style).toBe('fill');
    });
  });

  describe('ring', () => {
    it('parses ring command', () => {
      const cmd = parseCommand('ring 0.5,0.5 0.45 0.3 fill #666');
      expect(cmd.type).toBe('ring');
      expect(cmd.outerR).toBe(0.45);
      expect(cmd.innerR).toBe(0.3);
      expect(cmd.color).toBe('#666');
    });
  });

  describe('bezier', () => {
    it('parses cubic bezier', () => {
      const cmd = parseCommand('bezier 0,0 0.25,0.5 0.75,0.5 1,0 stroke');
      expect(cmd.type).toBe('bezier');
      expect(cmd.x1).toBe(0);
      expect(cmd.y1).toBe(0);
      expect(cmd.cp1x).toBe(0.25);
      expect(cmd.cp1y).toBe(0.5);
      expect(cmd.cp2x).toBe(0.75);
      expect(cmd.cp2y).toBe(0.5);
      expect(cmd.x2).toBe(1);
      expect(cmd.y2).toBe(0);
      expect(cmd.style).toBe('stroke');
    });
  });

  describe('qbezier', () => {
    it('parses quadratic bezier', () => {
      const cmd = parseCommand('qbezier 0,0 0.5,1 1,0 fill');
      expect(cmd.type).toBe('qbezier');
      expect(cmd.x1).toBe(0);
      expect(cmd.y1).toBe(0);
      expect(cmd.cpx).toBe(0.5);
      expect(cmd.cpy).toBe(1);
      expect(cmd.x2).toBe(1);
      expect(cmd.y2).toBe(0);
    });
  });

  describe('ering', () => {
    it('parses elliptical ring', () => {
      const cmd = parseCommand('ering 0.5,0.5 0.4,0.3 0.2,0.15 fill');
      expect(cmd.type).toBe('ering');
      expect(cmd.outerRx).toBe(0.4);
      expect(cmd.outerRy).toBe(0.3);
      expect(cmd.innerRx).toBe(0.2);
      expect(cmd.innerRy).toBe(0.15);
    });
  });

  describe('cutout', () => {
    it('parses cutout circle', () => {
      const cmd = parseCommand('cutout circle 0.5,0.5 0.2');
      expect(cmd.type).toBe('cutout');
      expect(cmd.subShape).toBe('circle');
      expect(cmd.cx).toBe(0.5);
      expect(cmd.cy).toBe(0.5);
      expect(cmd.r).toBe(0.2);
    });

    it('parses cutout rect', () => {
      const cmd = parseCommand('cutout rect 0.1,0.1 0.3,0.3');
      expect(cmd.type).toBe('cutout');
      expect(cmd.subShape).toBe('rect');
      expect(cmd.x).toBe(0.1);
      expect(cmd.w).toBe(0.3);
    });

    it('parses cutout ellipse', () => {
      const cmd = parseCommand('cutout ellipse 0.5,0.5 0.3,0.2');
      expect(cmd.type).toBe('cutout');
      expect(cmd.subShape).toBe('ellipse');
      expect(cmd.rx).toBe(0.3);
      expect(cmd.ry).toBe(0.2);
    });

    it('returns null for unknown cutout sub-shape', () => {
      expect(parseCommand('cutout triangle 0,0 1,1')).toBeNull();
    });
  });

  describe('clip-begin / clip-end', () => {
    it('parses clip-begin circle', () => {
      const cmd = parseCommand('clip-begin circle 0.5,0.5 0.4');
      expect(cmd.type).toBe('clip-begin');
      expect(cmd.subShape).toBe('circle');
      expect(cmd.r).toBe(0.4);
    });

    it('parses clip-begin rect', () => {
      const cmd = parseCommand('clip-begin rect 0,0 1,1');
      expect(cmd.type).toBe('clip-begin');
      expect(cmd.subShape).toBe('rect');
      expect(cmd.w).toBe(1);
    });

    it('parses clip-begin ellipse', () => {
      const cmd = parseCommand('clip-begin ellipse 0.5,0.5 0.4,0.3');
      expect(cmd.type).toBe('clip-begin');
      expect(cmd.subShape).toBe('ellipse');
    });

    it('parses clip-end', () => {
      const cmd = parseCommand('clip-end');
      expect(cmd.type).toBe('clip-end');
    });

    it('returns null for unknown clip-begin sub-shape', () => {
      expect(parseCommand('clip-begin polygon 0,0 1,1')).toBeNull();
    });
  });

  describe('hitbox / selection', () => {
    it('parses hitbox rect', () => {
      const cmd = parseCommand('hitbox rect 0,0 1,1');
      expect(cmd.type).toBe('hitbox');
      expect(cmd.subShape).toBe('rect');
      expect(cmd.x).toBe(0);
      expect(cmd.w).toBe(1);
    });

    it('parses hitbox rect with z-range', () => {
      const cmd = parseCommand('hitbox rect 0,0 1,1 z 0-6');
      expect(cmd.type).toBe('hitbox');
      expect(cmd.zBottom).toBe(0);
      expect(cmd.zTop).toBe(6);
    });

    it('parses selection circle', () => {
      const cmd = parseCommand('selection circle 0.5,0.5 0.4');
      expect(cmd.type).toBe('selection');
      expect(cmd.subShape).toBe('circle');
      expect(cmd.cx).toBe(0.5);
      expect(cmd.r).toBe(0.4);
    });

    it('parses hitbox poly', () => {
      const cmd = parseCommand('hitbox poly 0,0 1,0 1,1 0,1');
      expect(cmd.type).toBe('hitbox');
      expect(cmd.subShape).toBe('poly');
      expect(cmd.points).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    });

    it('parses hitbox poly with z-range (stops before z)', () => {
      const cmd = parseCommand('hitbox poly 0,0 1,0 1,1 z 0-4');
      expect(cmd.subShape).toBe('poly');
      expect(cmd.points).toEqual([[0, 0], [1, 0], [1, 1]]);
      expect(cmd.zBottom).toBe(0);
      expect(cmd.zTop).toBe(4);
    });

    it('returns null for unknown hitbox sub-shape', () => {
      expect(parseCommand('hitbox triangle 0,0 1,1')).toBeNull();
    });
  });

  describe('unknown commands', () => {
    it('returns null for unrecognized command type', () => {
      expect(parseCommand('splat 0,0 1')).toBeNull();
    });
  });
});

// ── parsePropFile ──────────────────────────────────────────────────────────

describe('parsePropFile', () => {
  it('parses a complete prop file with all header fields', () => {
    const text = `
name: Pillar
category: Structure
footprint: 1x1
facing: no
shadow: yes
blocks_light: yes
height: 8
padding: 0.1
lights: [{"preset":"torch","x":0.5,"y":0.5}]
placement: center
room_types: throne, temple
typical_count: single
clusters_with: banner, rug
notes: A tall stone pillar
---
circle 0.5,0.5 0.35 fill
    `.trim();

    const def = parsePropFile(text);
    expect(def.name).toBe('Pillar');
    expect(def.category).toBe('Structure');
    expect(def.footprint).toEqual([1, 1]);
    expect(def.facing).toBe(false);
    expect(def.shadow).toBe(true);
    expect(def.blocksLight).toBe(true);
    expect(def.height).toBe(8);
    expect(def.padding).toBe(0.1);
    expect(def.lights).toEqual([{ preset: 'torch', x: 0.5, y: 0.5 }]);
    expect(def.placement).toBe('center');
    expect(def.roomTypes).toEqual(['throne', 'temple']);
    expect(def.typicalCount).toBe('single');
    expect(def.clustersWith).toEqual(['banner', 'rug']);
    expect(def.notes).toBe('A tall stone pillar');
    expect(def.commands).toHaveLength(1);
    expect(def.commands[0].type).toBe('circle');
  });

  it('applies defaults for missing optional headers', () => {
    const text = `
name: Box
---
rect 0,0 1,1 fill
    `.trim();

    const def = parsePropFile(text);
    expect(def.name).toBe('Box');
    expect(def.category).toBe('Misc');
    expect(def.footprint).toEqual([1, 1]);
    expect(def.facing).toBe(false);
    expect(def.shadow).toBe(false);
    expect(def.blocksLight).toBe(false);
    expect(def.height).toBeNull();
    expect(def.padding).toBe(0);
    expect(def.lights).toBeNull();
    expect(def.placement).toBeNull();
    expect(def.roomTypes).toEqual([]);
    expect(def.typicalCount).toBeNull();
    expect(def.clustersWith).toEqual([]);
    expect(def.notes).toBeNull();
  });

  it('defaults name to Unnamed when missing', () => {
    const text = `
category: Furniture
---
rect 0,0 1,1 fill
    `.trim();
    expect(parsePropFile(text).name).toBe('Unnamed');
  });

  it('throws when separator is missing', () => {
    expect(() => parsePropFile('name: Pillar\ncircle 0.5,0.5 0.35 fill'))
      .toThrow('missing --- separator');
  });

  it('parses footprint correctly', () => {
    const text = `
footprint: 2x3
---
rect 0,0 2,3 fill
    `.trim();
    expect(parsePropFile(text).footprint).toEqual([2, 3]);
  });

  it('parses facing: yes', () => {
    const text = `
facing: yes
---
rect 0,0 1,1 fill
    `.trim();
    expect(parsePropFile(text).facing).toBe(true);
  });

  it('skips comments and blank lines in body', () => {
    const text = `
name: Test
---
# This is a comment
rect 0,0 1,1 fill

circle 0.5,0.5 0.3 fill
# another comment
    `.trim();

    const def = parsePropFile(text);
    expect(def.commands).toHaveLength(2);
  });

  it('collects textures from texfill commands', () => {
    const text = `
name: Floor
---
rect 0,0 1,1 texfill stone_tile
rect 0,0 0.5,0.5 texfill wood_plank
rect 0.5,0.5 0.5,0.5 texfill stone_tile
    `.trim();

    const def = parsePropFile(text);
    expect(def.textures).toEqual(['stone_tile', 'wood_plank']);
  });

  it('separates hitbox and selection commands from draw commands', () => {
    const text = `
name: Table
---
rect 0,0 1,1 fill
hitbox rect 0,0 1,1
selection rect 0.1,0.1 0.8,0.8
    `.trim();

    const def = parsePropFile(text);
    expect(def.commands).toHaveLength(1);
    expect(def.manualHitbox).toHaveLength(1);
    expect(def.manualHitbox[0].subShape).toBe('rect');
    expect(def.manualSelection).toHaveLength(1);
    expect(def.manualSelection[0].subShape).toBe('rect');
  });

  it('returns null for manualHitbox/manualSelection when none present', () => {
    const text = `
name: Simple
---
rect 0,0 1,1 fill
    `.trim();

    const def = parsePropFile(text);
    expect(def.manualHitbox).toBeNull();
    expect(def.manualSelection).toBeNull();
  });

  it('handles multiple draw command types in body', () => {
    const text = `
name: Fancy
---
rect 0,0 1,1 fill
circle 0.5,0.5 0.3 stroke
line 0,0 1,1 0.02
poly 0,0 1,0 0.5,1 fill
    `.trim();

    const def = parsePropFile(text);
    expect(def.commands).toHaveLength(4);
    expect(def.commands.map(c => c.type)).toEqual(['rect', 'circle', 'line', 'poly']);
  });
});

// ── rotatePoint ────────────────────────────────────────────────────────────

describe('rotatePoint', () => {
  describe('square footprint [1,1]', () => {
    const fp = [1, 1];

    it('0° returns identity', () => {
      expect(rotatePoint(0.2, 0.3, 0, fp)).toEqual([0.2, 0.3]);
    });

    it('90° rotation', () => {
      const [rx, ry] = rotatePoint(0, 0, 90, fp);
      // Center is (0.5, 0.5). After 90° CW: (0.5 + (0 - 0.5), 0.5 - (0 - 0.5)) = (0, 1)
      expect(rx).toBeCloseTo(0);
      expect(ry).toBeCloseTo(1);
    });

    it('180° rotation', () => {
      const [rx, ry] = rotatePoint(0, 0, 180, fp);
      expect(rx).toBeCloseTo(1);
      expect(ry).toBeCloseTo(1);
    });

    it('270° rotation', () => {
      const [rx, ry] = rotatePoint(0, 0, 270, fp);
      expect(rx).toBeCloseTo(1);
      expect(ry).toBeCloseTo(0);
    });

    it('center stays at center for all rotations', () => {
      for (const rot of [0, 90, 180, 270]) {
        const [rx, ry] = rotatePoint(0.5, 0.5, rot, fp);
        expect(rx).toBeCloseTo(0.5);
        expect(ry).toBeCloseTo(0.5);
      }
    });
  });

  describe('square footprint [2,2]', () => {
    const fp = [2, 2];

    it('center (1,1) stays at center for 90°', () => {
      const [rx, ry] = rotatePoint(1, 1, 90, fp);
      expect(rx).toBeCloseTo(1);
      expect(ry).toBeCloseTo(1);
    });

    it('origin (0,0) rotates to (0,2) at 90°', () => {
      const [rx, ry] = rotatePoint(0, 0, 90, fp);
      expect(rx).toBeCloseTo(0);
      expect(ry).toBeCloseTo(2);
    });
  });

  describe('non-square footprint [1,2]', () => {
    const fp = [1, 2]; // rows=1, cols=2

    it('0° returns identity', () => {
      expect(rotatePoint(0, 0, 0, fp)).toEqual([0, 0]);
    });

    it('90° rotation re-anchors correctly', () => {
      // Center is (1, 0.5). dx = (1-2)/2 = -0.5, dy = (2-1)/2 = 0.5
      const [rx, ry] = rotatePoint(0, 0, 90, fp);
      // cx + (0 - cy) + dx = 1 + (0 - 0.5) + (-0.5) = 0
      // cy - (0 - cx) + dy = 0.5 - (0 - 1) + 0.5 = 2
      expect(rx).toBeCloseTo(0);
      expect(ry).toBeCloseTo(2);
    });

    it('180° rotation', () => {
      const [rx, ry] = rotatePoint(0, 0, 180, fp);
      // 2*cx - 0 = 2, 2*cy - 0 = 1
      expect(rx).toBeCloseTo(2);
      expect(ry).toBeCloseTo(1);
    });
  });

  describe('non-square footprint [2,3]', () => {
    const fp = [2, 3];

    it('center stays at center for 180°', () => {
      const [rx, ry] = rotatePoint(1.5, 1, 180, fp);
      expect(rx).toBeCloseTo(1.5);
      expect(ry).toBeCloseTo(1);
    });
  });
});

// ── flipCommand ────────────────────────────────────────────────────────────

describe('flipCommand', () => {
  const fp1x1 = [1, 1];
  const fp1x2 = [1, 2];

  it('flips rect horizontally (1x1)', () => {
    const cmd = { type: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4, style: 'fill', color: null, textureId: null, opacity: null, rotate: null, angle: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.x).toBeCloseTo(0.6); // 1 - 0.1 - 0.3
    expect(flipped.y).toBe(0.2);
  });

  it('flips rect with rotate (negates rotate)', () => {
    const cmd = { type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, rotate: 30, style: 'fill', angle: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.rotate).toBe(-30);
  });

  it('flips circle (1x2 footprint)', () => {
    const cmd = { type: 'circle', cx: 0.5, cy: 0.5, r: 0.3, style: 'fill', angle: null };
    const flipped = flipCommand(cmd, fp1x2);
    expect(flipped.cx).toBeCloseTo(1.5); // 2 - 0.5
    expect(flipped.cy).toBe(0.5);
  });

  it('flips ellipse', () => {
    const cmd = { type: 'ellipse', cx: 0.3, cy: 0.5, rx: 0.2, ry: 0.1, style: 'fill', angle: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.cx).toBeCloseTo(0.7);
  });

  it('flips line', () => {
    const cmd = { type: 'line', x1: 0, y1: 0, x2: 0.5, y2: 1 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.x1).toBeCloseTo(1);
    expect(flipped.x2).toBeCloseTo(0.5);
    expect(flipped.y1).toBe(0);
    expect(flipped.y2).toBe(1);
  });

  it('flips poly points', () => {
    const cmd = { type: 'poly', points: [[0, 0], [1, 0], [0.5, 1]], style: 'fill', angle: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.points).toEqual([[1, 0], [0, 0], [0.5, 1]]);
  });

  it('flips arc (reflects angles)', () => {
    const cmd = { type: 'arc', cx: 0.3, cy: 0.5, r: 0.2, startDeg: 0, endDeg: 90, style: 'fill', angle: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.cx).toBeCloseTo(0.7);
    expect(flipped.startDeg).toBe(90);   // 180 - 90
    expect(flipped.endDeg).toBe(180);    // 180 - 0
  });

  it('flips cutout circle', () => {
    const cmd = { type: 'cutout', subShape: 'circle', cx: 0.3, cy: 0.5, r: 0.1 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.cx).toBeCloseTo(0.7);
  });

  it('flips cutout rect', () => {
    const cmd = { type: 'cutout', subShape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.x).toBeCloseTo(0.6); // 1 - 0.1 - 0.3
  });

  it('flips ring', () => {
    const cmd = { type: 'ring', cx: 0.3, cy: 0.5, outerR: 0.4, innerR: 0.2, style: 'fill', angle: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.cx).toBeCloseTo(0.7);
  });

  it('flips bezier (all x coords)', () => {
    const cmd = { type: 'bezier', x1: 0.1, y1: 0, cp1x: 0.3, cp1y: 0.5, cp2x: 0.7, cp2y: 0.5, x2: 0.9, y2: 1 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.x1).toBeCloseTo(0.9);
    expect(flipped.cp1x).toBeCloseTo(0.7);
    expect(flipped.cp2x).toBeCloseTo(0.3);
    expect(flipped.x2).toBeCloseTo(0.1);
  });

  it('flips qbezier', () => {
    const cmd = { type: 'qbezier', x1: 0, y1: 0, cpx: 0.5, cpy: 1, x2: 1, y2: 0 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.x1).toBeCloseTo(1);
    expect(flipped.cpx).toBeCloseTo(0.5);
    expect(flipped.x2).toBeCloseTo(0);
  });

  it('flips ering', () => {
    const cmd = { type: 'ering', cx: 0.3, cy: 0.5, outerRx: 0.4, outerRy: 0.3, innerRx: 0.2, innerRy: 0.15 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.cx).toBeCloseTo(0.7);
  });

  it('flips clip-begin circle', () => {
    const cmd = { type: 'clip-begin', subShape: 'circle', cx: 0.2, cy: 0.5, r: 0.1 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.cx).toBeCloseTo(0.8);
  });

  it('flips clip-begin rect', () => {
    const cmd = { type: 'clip-begin', subShape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.x).toBeCloseTo(0.6);
  });

  it('returns clip-end unchanged', () => {
    const cmd = { type: 'clip-end' };
    expect(flipCommand(cmd, fp1x1)).toEqual(cmd);
  });

  it('negates gradient-linear angle', () => {
    const cmd = { type: 'rect', x: 0, y: 0, w: 1, h: 1, style: 'gradient-linear', angle: 45, rotate: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.angle).toBe(-45);
  });

  it('does not negate angle for non-gradient styles', () => {
    const cmd = { type: 'rect', x: 0, y: 0, w: 1, h: 1, style: 'fill', angle: 45, rotate: null };
    const flipped = flipCommand(cmd, fp1x1);
    expect(flipped.angle).toBe(45);
  });
});

// ── transformCommand ───────────────────────────────────────────────────────

describe('transformCommand', () => {
  const fp1x1 = [1, 1];
  const fp1x2 = [1, 2];

  it('returns identity for rotation=0', () => {
    const cmd = { type: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4, style: 'fill', angle: null };
    expect(transformCommand(cmd, 0, fp1x1)).toBe(cmd); // same ref
  });

  describe('rect', () => {
    it('rotates non-rotated rect 90° (1x1)', () => {
      const cmd = { type: 'rect', x: 0, y: 0, w: 0.5, h: 1, style: 'fill', rotate: null, angle: null };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.type).toBe('rect');
      // Corners (0,0), (0.5,0), (0.5,1), (0,1) rotated 90° around center (0.5,0.5)
      // Should produce a rect starting at some point with swapped-ish dimensions
      expect(result.w).toBeCloseTo(1);
      expect(result.h).toBeCloseTo(0.5);
    });

    it('rotates rect with rotate field (accumulates angle)', () => {
      const cmd = { type: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, style: 'fill', rotate: 10, angle: null };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.rotate).toBe(100); // 10 + 90
    });
  });

  describe('circle', () => {
    it('rotates circle center 90° (1x1)', () => {
      const cmd = { type: 'circle', cx: 0, cy: 0, r: 0.2, style: 'fill', angle: null };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.cx).toBeCloseTo(0);
      expect(result.cy).toBeCloseTo(1);
      expect(result.r).toBe(0.2);
    });

    it('rotates circle center 180°', () => {
      const cmd = { type: 'circle', cx: 0, cy: 0, r: 0.3, style: 'fill', angle: null };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.cx).toBeCloseTo(1);
      expect(result.cy).toBeCloseTo(1);
    });
  });

  describe('ellipse', () => {
    it('swaps rx/ry for 90° rotation', () => {
      const cmd = { type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.2, style: 'fill', angle: null };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.rx).toBe(0.2);
      expect(result.ry).toBe(0.4);
    });

    it('does not swap rx/ry for 180° rotation', () => {
      const cmd = { type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.2, style: 'fill', angle: null };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.rx).toBe(0.4);
      expect(result.ry).toBe(0.2);
    });
  });

  describe('line', () => {
    it('rotates line endpoints 90°', () => {
      const cmd = { type: 'line', x1: 0, y1: 0, x2: 1, y2: 0, lineWidth: 0.02 };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.x1).toBeCloseTo(0);
      expect(result.y1).toBeCloseTo(1);
      expect(result.x2).toBeCloseTo(0);
      expect(result.y2).toBeCloseTo(0);
    });
  });

  describe('poly', () => {
    it('rotates all polygon points 180°', () => {
      const cmd = { type: 'poly', points: [[0, 0], [1, 0], [0.5, 1]], style: 'fill', angle: null };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.points[0][0]).toBeCloseTo(1);
      expect(result.points[0][1]).toBeCloseTo(1);
      expect(result.points[1][0]).toBeCloseTo(0);
      expect(result.points[1][1]).toBeCloseTo(1);
      expect(result.points[2][0]).toBeCloseTo(0.5);
      expect(result.points[2][1]).toBeCloseTo(0);
    });
  });

  describe('arc', () => {
    it('adds rotation to start/end degrees', () => {
      const cmd = { type: 'arc', cx: 0.5, cy: 0.5, r: 0.3, startDeg: 0, endDeg: 90, style: 'fill', angle: null };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.startDeg).toBe(90);
      expect(result.endDeg).toBe(180);
    });
  });

  describe('cutout', () => {
    it('rotates cutout circle center', () => {
      const cmd = { type: 'cutout', subShape: 'circle', cx: 0.2, cy: 0.3, r: 0.1 };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.cx).toBeCloseTo(0.8);
      expect(result.cy).toBeCloseTo(0.7);
    });

    it('rotates cutout rect (AABB approach)', () => {
      const cmd = { type: 'cutout', subShape: 'rect', x: 0, y: 0, w: 0.5, h: 1 };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.w).toBeCloseTo(1);
      expect(result.h).toBeCloseTo(0.5);
    });

    it('rotates cutout ellipse with rx/ry swap at 270°', () => {
      const cmd = { type: 'cutout', subShape: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.2 };
      const result = transformCommand(cmd, 270, fp1x1);
      expect(result.rx).toBe(0.2);
      expect(result.ry).toBe(0.4);
    });
  });

  describe('ring', () => {
    it('rotates ring center', () => {
      const cmd = { type: 'ring', cx: 0.3, cy: 0.5, outerR: 0.4, innerR: 0.2, style: 'fill', angle: null };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.cx).toBeCloseTo(0.7);
      expect(result.cy).toBeCloseTo(0.5);
    });
  });

  describe('bezier', () => {
    it('rotates all 4 bezier points', () => {
      const cmd = { type: 'bezier', x1: 0, y1: 0, cp1x: 0.25, cp1y: 0.5, cp2x: 0.75, cp2y: 0.5, x2: 1, y2: 1, style: 'stroke' };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.x1).toBeCloseTo(1);
      expect(result.y1).toBeCloseTo(1);
      expect(result.x2).toBeCloseTo(0);
      expect(result.y2).toBeCloseTo(0);
    });
  });

  describe('qbezier', () => {
    it('rotates all 3 qbezier points', () => {
      const cmd = { type: 'qbezier', x1: 0, y1: 0, cpx: 0.5, cpy: 1, x2: 1, y2: 0, style: 'fill' };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.x1).toBeCloseTo(1);
      expect(result.y1).toBeCloseTo(1);
      expect(result.cpx).toBeCloseTo(0.5);
      expect(result.cpy).toBeCloseTo(0);
      expect(result.x2).toBeCloseTo(0);
      expect(result.y2).toBeCloseTo(1);
    });
  });

  describe('ering', () => {
    it('swaps radii for 90° rotation', () => {
      const cmd = { type: 'ering', cx: 0.5, cy: 0.5, outerRx: 0.4, outerRy: 0.3, innerRx: 0.2, innerRy: 0.15, style: 'fill' };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.outerRx).toBe(0.3);
      expect(result.outerRy).toBe(0.4);
      expect(result.innerRx).toBe(0.15);
      expect(result.innerRy).toBe(0.2);
    });

    it('does not swap radii for 180°', () => {
      const cmd = { type: 'ering', cx: 0.5, cy: 0.5, outerRx: 0.4, outerRy: 0.3, innerRx: 0.2, innerRy: 0.15, style: 'fill' };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.outerRx).toBe(0.4);
      expect(result.outerRy).toBe(0.3);
    });
  });

  describe('clip-begin', () => {
    it('rotates clip-begin circle', () => {
      const cmd = { type: 'clip-begin', subShape: 'circle', cx: 0.2, cy: 0.3, r: 0.1 };
      const result = transformCommand(cmd, 180, fp1x1);
      expect(result.cx).toBeCloseTo(0.8);
      expect(result.cy).toBeCloseTo(0.7);
    });

    it('rotates clip-begin rect', () => {
      const cmd = { type: 'clip-begin', subShape: 'rect', x: 0, y: 0, w: 0.5, h: 1 };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.w).toBeCloseTo(1);
      expect(result.h).toBeCloseTo(0.5);
    });

    it('rotates clip-begin ellipse with rx/ry swap', () => {
      const cmd = { type: 'clip-begin', subShape: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.2 };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.rx).toBe(0.2);
      expect(result.ry).toBe(0.4);
    });
  });

  describe('clip-end', () => {
    it('returns clip-end unchanged', () => {
      const cmd = { type: 'clip-end' };
      expect(transformCommand(cmd, 90, fp1x1)).toEqual(cmd);
    });
  });

  describe('gradient angle rotation', () => {
    it('rotates gradient-linear angle by rotation amount', () => {
      const cmd = { type: 'rect', x: 0, y: 0, w: 1, h: 1, style: 'gradient-linear', angle: 45, rotate: null };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.angle).toBe(135); // 45 + 90
    });

    it('does not rotate angle for non-gradient styles', () => {
      const cmd = { type: 'circle', cx: 0.5, cy: 0.5, r: 0.3, style: 'fill', angle: 30 };
      const result = transformCommand(cmd, 90, fp1x1);
      expect(result.angle).toBe(30);
    });
  });

  describe('non-square footprint transforms', () => {
    it('transforms circle on [1,2] footprint at 90°', () => {
      const cmd = { type: 'circle', cx: 0, cy: 0, r: 0.2, style: 'fill', angle: null };
      const result = transformCommand(cmd, 90, fp1x2);
      expect(result.cx).toBeCloseTo(0);
      expect(result.cy).toBeCloseTo(2);
    });
  });

  describe('unknown types', () => {
    it('returns unknown command types unchanged', () => {
      const cmd = { type: 'sparkle', x: 1, y: 2 };
      expect(transformCommand(cmd, 90, fp1x1)).toEqual(cmd);
    });
  });
});
