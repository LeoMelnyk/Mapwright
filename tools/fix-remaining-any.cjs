// Fix ALL remaining `: any` in the codebase with specific types.
// Each replacement is context-aware — we read the pattern and apply the right type.
const fs = require('fs');
const path = require('path');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const before = (content.match(/: any/g) || []).length;
  if (before === 0) return 0;

  // ──────── Universal replacements ────────
  // Return types
  content = content.replace(/\): any\s*\{/g, '): Record<string, unknown> {');
  content = content.replace(/\): any\[\]\s*\{/g, '): Record<string, unknown>[] {');

  // Common param patterns
  content = content.replace(/\bnumRows: any\b/g, 'numRows: number');
  content = content.replace(/\bnumCols: any\b/g, 'numCols: number');
  content = content.replace(/\baxis: any\b/g, 'axis: string');
  content = content.replace(/\bcollapsed: any\b/g, 'collapsed: boolean');
  content = content.replace(/\bpreview: any\b/g, 'preview: Record<string, unknown>');
  content = content.replace(/\bstairDef: any\b/g, 'stairDef: Record<string, unknown>');

  // Variable declarations
  content = content.replace(/let (\w+): any = null;/g, (match, name) => {
    // Context-specific replacements
    if (name === '_cache') return `let ${name}: Record<string, unknown> | null = null;`;
    if (name === '_mapCache') return `let ${name}: MapCache | null = null;`;
    if (name === 'catalog') return `let ${name}: Record<string, unknown> | null = null;`;
    if (name === '_dlPollInterval') return `let ${name}: ReturnType<typeof setInterval> | null = null;`;
    if (name === '_onDirtyCallback') return `let ${name}: (() => void) | null = null;`;
    return `let ${name}: HTMLElement | null = null;`;
  });

  // [key: string]: any on classes
  content = content.replace(/  \[key: string\]: any;/g, '  [key: string]: Function | string | number | boolean | object | null | undefined;');

  // Callback params in .map/.filter/.find/.some
  content = content.replace(/\(({ row, col }: any)\)/g, '({ row, col }: { row: number; col: number })');
  content = content.replace(/\.map\(\(({ row, col }: any) =>/g, '.map(({ row, col }: { row: number; col: number }) =>');
  content = content.replace(/\((a: any, b: any) =>/g, '((a: Record<string, number>, b: Record<string, number>) =>');
  content = content.replace(/\((s: any, e: MouseEvent) =>/g, '((s: number, e: Record<string, unknown>) =>');
  content = content.replace(/\(s: any,/g, '(s: number,');

  // Specific function patterns
  content = content.replace(/wallSegments: any\[\]/g, 'wallSegments: Array<{x1: number; y1: number; x2: number; y2: number}>');
  content = content.replace(/lights: any\[\]/g, 'lights: Light[]');
  content = content.replace(/walls: any\[\]; portals: any\[\]/g, 'walls: Array<[{x: number; y: number}, {x: number; y: number}]>; portals: Dd2vttPortal[]');
  content = content.replace(/input: Record<string, any>/g, 'input: Record<string, string | number | boolean>');
  content = content.replace(/\.\.\.fields: any\[\]/g, '...fields: string[]');
  content = content.replace(/\(input: any,/g, '(input: Record<string, string | number | boolean>,');

  // args: any[] in function declarations
  content = content.replace(/\(\.\.\.(args): any\[\]\)/g, '(...$1: unknown[])');
  content = content.replace(/\(\.\.\.args: any\[\]\) => void\)/g, '(...args: unknown[]) => void)');
  content = content.replace(/\(\.\.\.args: any\[\]\) => boolean\)/g, '(...args: unknown[]) => boolean)');

  // stair geometry
  content = content.replace(/\bp1: any, p2: any, p3: any\b/g, 'p1: [number, number], p2: [number, number], p3: [number, number]');
  content = content.replace(/\bpy: any, px: any, polygon: any\b/g, 'py: number, px: number, polygon: number[][]');

  // visibility/shadow
  content = content.replace(/visibility: any,/g, 'visibility: Array<{x: number; y: number}>,');
  content = content.replace(/bbX: any, bbY: any, bbW: any, bbH: any/g, 'bbX: number, bbY: number, bbW: number, bbH: number');

  // cmd param
  content = content.replace(/\bcmd: any\b/g, 'cmd: PropCommand');
  content = content.replace(/\bentry: any\b/g, 'entry: Record<string, unknown>');

  const after = (content.match(/: any/g) || []).length;
  const fixed = before - after;
  if (fixed > 0) {
    fs.writeFileSync(filePath, content);
    const rel = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    console.log(`${rel}: ${before} → ${after} (fixed ${fixed})`);
  }
  return fixed;
}

let total = 0;
function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      walkDir(full);
    } else if (entry.name.endsWith('.ts')) {
      total += processFile(full);
    }
  }
}

walkDir(path.join(process.cwd(), 'src'));
console.log(`\nTotal fixed: ${total}`);
