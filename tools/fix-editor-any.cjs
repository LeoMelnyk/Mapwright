// Batch-replace common `: any` patterns in editor/ files with proper types
const fs = require('fs');
const path = require('path');

function processDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let totalFixed = 0;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      totalFixed += processDir(fullPath);
    } else if (entry.name.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      const beforeCount = (content.match(/: any/g) || []).length;
      if (beforeCount === 0) continue;

      // Common editor replacements
      const replacements = [
        // State and core types
        [/\bstate: any\b/g, 'state: EditorState'],
        [/\bcells: any\b/g, 'cells: CellGrid'],
        [/\bcell: any\b/g, 'cell: Cell | null'],
        [/\btheme: any\b/g, 'theme: Theme'],
        [/\btransform: any\b/g, 'transform: RenderTransform'],
        [/\bmetadata: any\b/g, 'metadata: Metadata'],
        [/\bmeta: any\b/g, 'meta: Metadata'],
        [/\bpropCatalog: any\b/g, 'propCatalog: PropCatalog | null'],
        [/\bpropDef: any\b/g, 'propDef: PropDefinition'],
        [/\blight: any\b/g, 'light: Light'],
        // DOM events
        [/\bevent: any\b/g, 'event: MouseEvent'],
        [/\be: any\b(?!\.\w)/g, 'e: MouseEvent'], // bare e: any (not e: any.something)
        // Numeric params
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
        [/\bindex: any\b/g, 'index: number'],
        [/\blevel: any\b/g, 'level: number'],
        [/\bdepth: any\b/g, 'depth: number'],
        // Canvas
        [/\bctx: any\b/g, 'ctx: CanvasRenderingContext2D'],
        // String params
        [/\bname: any\b/g, 'name: string'],
        [/\blabel: any\b/g, 'label: string'],
        [/\btype: any\b/g, 'type: string'],
        [/\bdir: any\b/g, 'dir: string'],
        [/\bdirection: any\b/g, 'direction: string'],
        [/\bkey: any\b/g, 'key: string'],
        [/\bvalue: any\b/g, 'value: string'],
        [/\bid: any\b/g, 'id: string'],
        [/\bpath: any\b/g, 'path: string'],
        [/\btext: any\b/g, 'text: string'],
        [/\bmsg: any\b/g, 'msg: string'],
        [/\burl: any\b/g, 'url: string'],
      ];

      for (const [pattern, replacement] of replacements) {
        content = content.replace(pattern, replacement);
      }

      const afterCount = (content.match(/: any/g) || []).length;
      const fixed = beforeCount - afterCount;

      if (fixed > 0) {
        fs.writeFileSync(fullPath, content);
        const relPath = path.relative(path.join(__dirname, '..'), fullPath).replace(/\\/g, '/');
        console.log(`${relPath}: ${beforeCount} → ${afterCount} (fixed ${fixed})`);
        totalFixed += fixed;
      }
    }
  }
  return totalFixed;
}

const editorDir = path.join(__dirname, '..', 'src', 'editor');
const playerDir = path.join(__dirname, '..', 'src', 'player');
const utilDir = path.join(__dirname, '..', 'src', 'util');

let total = 0;
total += processDir(editorDir);
total += processDir(playerDir);
total += processDir(utilDir);

console.log(`\nTotal fixed: ${total}`);
