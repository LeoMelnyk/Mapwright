/**
 * prop-catalog-node.js
 * Node.js-only prop catalog loader for the CLI render pipeline.
 * NOT imported by the browser bundle — uses fs.readFileSync and Node.js path utilities.
 */

// @ts-expect-error — strict-mode migration
import fs from 'fs';
// @ts-expect-error — strict-mode migration
import { fileURLToPath } from 'url';
// @ts-expect-error — strict-mode migration
import { dirname, join } from 'path';
import { parsePropFile, generateHitbox } from './props.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Convert manual hitbox commands (rect/circle/poly) into a single polygon. */
function manualHitboxToPolygon(cmds: any[]): number[][] | null {
  const points = [];
  for (const cmd of cmds) {
    switch (cmd.subShape) {
      case 'rect':
        points.push(
          [cmd.x, cmd.y], [cmd.x + cmd.w, cmd.y],
          [cmd.x + cmd.w, cmd.y + cmd.h], [cmd.x, cmd.y + cmd.h],
        );
        break;
      case 'circle': {
        const N = 16;
        for (let i = 0; i < N; i++) {
          const angle = (i / N) * Math.PI * 2;
          points.push([cmd.cx + cmd.r * Math.cos(angle), cmd.cy + cmd.r * Math.sin(angle)]);
        }
        break;
      }
      case 'poly':
        if (cmd.points?.length) points.push(...cmd.points);
        break;
    }
  }
  return points.length >= 3 ? points : null;
}

/** Build hitbox zones for z-height shadow projection. */
function buildHitboxZones(def: any): any[] | null {
  const hasZRanges = def.manualHitbox?.some((cmd: any) => cmd.zBottom != null);
  if (hasZRanges) {
    const groups = new Map();
    for (const cmd of def.manualHitbox) {
      const key = cmd.zBottom != null ? `${cmd.zBottom}-${cmd.zTop}` : 'default';
      if (!groups.has(key)) groups.set(key, { cmds: [], zBottom: cmd.zBottom ?? 0, zTop: cmd.zTop ?? Infinity });
      groups.get(key).cmds.push(cmd);
    }
    const zones = [];
    for (const { cmds, zBottom, zTop } of groups.values()) {
      const polygon = manualHitboxToPolygon(cmds);
      if (polygon) zones.push({ polygon, zBottom, zTop });
    }
    return zones.length > 0 ? zones : null;
  }
  const polygon = def.hitbox;
  if (!polygon) return null;
  const zTop = (def.height != null && isFinite(def.height)) ? def.height : Infinity;
  return [{ polygon, zBottom: 0, zTop }];
}

/**
 * Synchronously load the full prop catalog from .prop files on disk.
 * Returns { props: { [name]: PropDefinition }, categories: string[] }.
 */
export function loadPropCatalogSync(): { props: Record<string, any>; categories: string[] } {
  const manifestPath = join(__dirname, '../props/manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    console.warn('[props] Could not load prop manifest — props will not render in CLI build');
    return { props: {}, categories: [] };
  }

  const props = {};
  for (const name of manifest) {
    const propPath = join(__dirname, `../props/${name}.prop`);
    try {
      const text = fs.readFileSync(propPath, 'utf-8');
      const def = parsePropFile(text);
      // Generate hitboxes (same as browser prop-catalog.js buildCatalog)
      if (!def.autoHitbox && def.commands?.length) {
        // @ts-expect-error — strict-mode migration
        def.autoHitbox = generateHitbox(def.commands, def.footprint);
      }
      if (!def.hitbox) {
        // @ts-expect-error — strict-mode migration
        def.hitbox = def.manualHitbox?.length
          ? manualHitboxToPolygon(def.manualHitbox)
          : def.autoHitbox;
      }
      if (def.blocksLight && !def.hitboxZones) {
        // @ts-expect-error — strict-mode migration
        def.hitboxZones = buildHitboxZones(def);
      }
      (props as any)[name] = def;
    } catch (e) {
      console.warn(`[props] Failed to load ${name}.prop: ${(e as any).message}`);
    }
  }

  const categories = [...new Set(Object.values(props).map(p => (p as any).category))];
  return { props, categories };
}
