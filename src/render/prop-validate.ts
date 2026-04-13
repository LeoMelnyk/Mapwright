import type { PropCommand, PropDefinition } from '../types.js';
/**
 * prop-validate.js - Validate that prop draw commands stay within footprint bounds.
 *
 * For a prop with footprint [rows, cols] and padding p:
 *   Valid x range: [-p, cols + p]
 *   Valid y range: [-p, rows + p]
 *
 * A tolerance of 0.02 is applied for floating-point imprecision.
 */

import { parsePropFile } from './props.js';

const TOLERANCE = 0.02;

/**
 * Validate that all draw commands in a prop definition stay within
 * the footprint + padding bounds.
 *
 * @param {object} propDef - Parsed prop definition with footprint, padding, commands
 * @returns {{ valid: boolean, warnings: Array<{ line: number, command: string, message: string }> }}
 */
export function validatePropBounds(propDef: PropDefinition) {
  const { footprint, padding = 0, commands } = propDef;
  const [rows, cols] = footprint;
  const p = padding;

  const xMin = -p;
  const xMax = cols + p;
  const yMin = -p;
  const yMax = rows + p;

  const warnings = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    const checks = getCommandBounds(cmd);
    if (!checks) continue;

    for (const { label, value, bound, side } of checks) {
      if (side === 'min' && value < bound - TOLERANCE) {
        warnings.push({
          line: i,
          command: cmd.type === 'cutout' ? `cutout-${cmd.subShape as string}` : cmd.type,
          message: `${label}=${value.toFixed(2)} below ${bound === xMin || bound === yMin ? (bound === xMin ? 'x' : 'y') : ''}${label.startsWith('x') || label.startsWith('cx') ? 'x' : 'y'} min=${bound.toFixed(2)}`,
        });
      } else if (side === 'max' && value > bound + TOLERANCE) {
        warnings.push({
          line: i,
          command: cmd.type === 'cutout' ? `cutout-${cmd.subShape as string}` : cmd.type,
          message: `${label}=${value.toFixed(2)} exceeds ${label.startsWith('x') || label.startsWith('cx') ? 'x' : 'y'} max=${bound.toFixed(2)}`,
        });
      }
    }
  }

  return { valid: warnings.length === 0, warnings };

  /**
   * Extract coordinate checks for a given command.
   * Returns an array of { label, value, bound, side } objects.
   */
  function getCommandBounds(cmd: PropCommand) {
    switch (cmd.type) {
      case 'rect':
        return [
          { label: 'x', value: cmd.x ?? 0, bound: xMin, side: 'min' },
          { label: 'y', value: cmd.y ?? 0, bound: yMin, side: 'min' },
          { label: 'x+w', value: (cmd.x ?? 0) + (cmd.w ?? 0), bound: xMax, side: 'max' },
          { label: 'y+h', value: (cmd.y ?? 0) + (cmd.h ?? 0), bound: yMax, side: 'max' },
        ];

      case 'circle':
        return [
          { label: 'cx-r', value: (cmd.cx ?? 0) - (cmd.r ?? 0), bound: xMin, side: 'min' },
          { label: 'cy-r', value: (cmd.cy ?? 0) - (cmd.r ?? 0), bound: yMin, side: 'min' },
          { label: 'cx+r', value: (cmd.cx ?? 0) + (cmd.r ?? 0), bound: xMax, side: 'max' },
          { label: 'cy+r', value: (cmd.cy ?? 0) + (cmd.r ?? 0), bound: yMax, side: 'max' },
        ];

      case 'ellipse':
        return [
          { label: 'cx-rx', value: (cmd.cx ?? 0) - (cmd.rx ?? 0), bound: xMin, side: 'min' },
          { label: 'cy-ry', value: (cmd.cy ?? 0) - (cmd.ry ?? 0), bound: yMin, side: 'min' },
          { label: 'cx+rx', value: (cmd.cx ?? 0) + (cmd.rx ?? 0), bound: xMax, side: 'max' },
          { label: 'cy+ry', value: (cmd.cy ?? 0) + (cmd.ry ?? 0), bound: yMax, side: 'max' },
        ];

      case 'line':
        return [
          { label: 'x1', value: cmd.x1 ?? 0, bound: xMin, side: 'min' },
          { label: 'y1', value: cmd.y1 ?? 0, bound: yMin, side: 'min' },
          { label: 'x1', value: cmd.x1 ?? 0, bound: xMax, side: 'max' },
          { label: 'y1', value: cmd.y1 ?? 0, bound: yMax, side: 'max' },
          { label: 'x2', value: cmd.x2 ?? 0, bound: xMin, side: 'min' },
          { label: 'y2', value: cmd.y2 ?? 0, bound: yMin, side: 'min' },
          { label: 'x2', value: cmd.x2 ?? 0, bound: xMax, side: 'max' },
          { label: 'y2', value: cmd.y2 ?? 0, bound: yMax, side: 'max' },
        ];

      case 'poly':
        if (!cmd.points) return null;
        const polyChecks = [];
        for (let pi = 0; pi < cmd.points.length; pi++) {
          const [px = 0, py = 0] = cmd.points[pi]!;
          polyChecks.push(
            { label: `x[${pi}]`, value: px, bound: xMin, side: 'min' },
            { label: `y[${pi}]`, value: py, bound: yMin, side: 'min' },
            { label: `x[${pi}]`, value: px, bound: xMax, side: 'max' },
            { label: `y[${pi}]`, value: py, bound: yMax, side: 'max' },
          );
        }
        return polyChecks;

      case 'arc':
        return [
          { label: 'cx-r', value: (cmd.cx ?? 0) - (cmd.r ?? 0), bound: xMin, side: 'min' },
          { label: 'cy-r', value: (cmd.cy ?? 0) - (cmd.r ?? 0), bound: yMin, side: 'min' },
          { label: 'cx+r', value: (cmd.cx ?? 0) + (cmd.r ?? 0), bound: xMax, side: 'max' },
          { label: 'cy+r', value: (cmd.cy ?? 0) + (cmd.r ?? 0), bound: yMax, side: 'max' },
        ];

      case 'ring':
        return [
          { label: 'cx-outerR', value: (cmd.cx ?? 0) - (cmd.outerR ?? 0), bound: xMin, side: 'min' },
          { label: 'cy-outerR', value: (cmd.cy ?? 0) - (cmd.outerR ?? 0), bound: yMin, side: 'min' },
          { label: 'cx+outerR', value: (cmd.cx ?? 0) + (cmd.outerR ?? 0), bound: xMax, side: 'max' },
          { label: 'cy+outerR', value: (cmd.cy ?? 0) + (cmd.outerR ?? 0), bound: yMax, side: 'max' },
        ];

      case 'cutout':
        return getCutoutBounds(cmd);

      default:
        return null;
    }
  }

  function getCutoutBounds(cmd: PropCommand) {
    switch (cmd.subShape as string) {
      case 'circle':
        return [
          { label: 'cx-r', value: (cmd.cx ?? 0) - (cmd.r ?? 0), bound: xMin, side: 'min' },
          { label: 'cy-r', value: (cmd.cy ?? 0) - (cmd.r ?? 0), bound: yMin, side: 'min' },
          { label: 'cx+r', value: (cmd.cx ?? 0) + (cmd.r ?? 0), bound: xMax, side: 'max' },
          { label: 'cy+r', value: (cmd.cy ?? 0) + (cmd.r ?? 0), bound: yMax, side: 'max' },
        ];
      case 'rect':
        return [
          { label: 'x', value: cmd.x ?? 0, bound: xMin, side: 'min' },
          { label: 'y', value: cmd.y ?? 0, bound: yMin, side: 'min' },
          { label: 'x+w', value: (cmd.x ?? 0) + (cmd.w ?? 0), bound: xMax, side: 'max' },
          { label: 'y+h', value: (cmd.y ?? 0) + (cmd.h ?? 0), bound: yMax, side: 'max' },
        ];
      case 'ellipse':
        return [
          { label: 'cx-rx', value: (cmd.cx ?? 0) - (cmd.rx ?? 0), bound: xMin, side: 'min' },
          { label: 'cy-ry', value: (cmd.cy ?? 0) - (cmd.ry ?? 0), bound: yMin, side: 'min' },
          { label: 'cx+rx', value: (cmd.cx ?? 0) + (cmd.rx ?? 0), bound: xMax, side: 'max' },
          { label: 'cy+ry', value: (cmd.cy ?? 0) + (cmd.ry ?? 0), bound: yMax, side: 'max' },
        ];
      default:
        return null;
    }
  }
}

/**
 * Parse a .prop file's text and validate its bounds.
 *
 * @param {string} text - Raw .prop file contents
 * @returns {{ name: string, footprint: number[], valid: boolean, warnings: Array }}
 */
export function validatePropFile(text: string) {
  const propDef = parsePropFile(text);
  const { valid, warnings } = validatePropBounds(propDef);
  return {
    name: propDef.name,
    footprint: propDef.footprint,
    valid,
    warnings,
  };
}
