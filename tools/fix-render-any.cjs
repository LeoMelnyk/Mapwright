// Batch-replace common `: any` patterns in render/ files with proper types
const fs = require('fs');
const path = require('path');

const renderDir = path.join(__dirname, '..', 'src', 'render');

// Common replacement patterns (order matters — more specific first)
const replacements = [
  // Function param patterns
  [/\bcells: any\b/g, 'cells: CellGrid'],
  [/\bcell: any\b/g, 'cell: Cell | null'],
  [/\btheme: any\b/g, 'theme: Theme'],
  [/\btransform: any\b/g, 'transform: RenderTransform'],
  [/\bmetadata: any\b/g, 'metadata: Metadata | null'],
  [/\bpropCatalog: any\b/g, 'propCatalog: PropCatalog | null'],
  [/\btextureCatalog: any\b/g, 'textureCatalog: TextureCatalog | null'],
  [/\bpropDef: any\b/g, 'propDef: PropDefinition'],
  [/\blight: any\b/g, 'light: Light'],
  [/\blights: any\[\]/g, 'lights: Light[]'],
  [/\bconfig: any\b/g, 'config: { metadata: Metadata; cells: CellGrid }'],
  [/\bctx: any\b/g, 'ctx: CanvasRenderingContext2D'],
  [/\bgridSize: any\b/g, 'gridSize: number'],
  [/\brow: any\b/g, 'row: number'],
  [/\bcol: any\b/g, 'col: number'],
  [/\bw: any\b/g, 'w: number'],
  [/\bh: any\b/g, 'h: number'],
  [/\br: any\b/g, 'r: number'],
  [/\bc: any\b/g, 'c: number'],
  [/\bx: any\b/g, 'x: number'],
  [/\by: any\b/g, 'y: number'],
  [/\brotation: any\b/g, 'rotation: number'],
  [/\bflipped: any\b/g, 'flipped: boolean'],
  [/\bscale: any\b/g, 'scale: number'],
  [/\bopacity: any\b/g, 'opacity: number'],
  // Return types
  [/\): any\s*\{/g, '): Record<string, unknown> {'],
  [/\): any\[\]\s*\{/g, '): Record<string, unknown>[] {'],
  // Variable declarations
  [/let (\w+): any = null/g, 'let $1: OffscreenCanvas | HTMLCanvasElement | null = null'],
  // Array callback params
  [/\((\w+): any\) =>/g, '($1: Record<string, unknown>) =>'],
];

// Ensure needed imports exist
const neededImports = new Set();
const importMap = {
  'CellGrid': '../types.js',
  'Cell': '../types.js',
  'Theme': '../types.js',
  'RenderTransform': '../types.js',
  'Metadata': '../types.js',
  'PropCatalog': '../types.js',
  'PropDefinition': '../types.js',
  'TextureCatalog': '../types.js',
  'Light': '../types.js',
};

let totalFixed = 0;

const files = fs.readdirSync(renderDir).filter(f => f.endsWith('.ts'));
for (const file of files) {
  const filePath = path.join(renderDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  const beforeCount = (content.match(/: any/g) || []).length;
  if (beforeCount === 0) continue;

  for (const [pattern, replacement] of replacements) {
    content = content.replace(pattern, replacement);
  }

  const afterCount = (content.match(/: any/g) || []).length;
  const fixed = beforeCount - afterCount;

  if (fixed > 0) {
    fs.writeFileSync(filePath, content);
    console.log(`${file}: ${beforeCount} → ${afterCount} (fixed ${fixed})`);
    totalFixed += fixed;
  }
}

console.log(`\nTotal fixed: ${totalFixed}`);
