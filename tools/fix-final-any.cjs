// Final sweep: fix ALL remaining `: any` with specific targeted replacements.
const fs = require('fs');

const replacements = [
  // API return types
  ['src/editor/js/api/convenience.ts', 'const newLevelStartRows: any = []', 'const newLevelStartRows: number[] = []'],
  ['src/editor/js/api/levels.ts', "levels: any[]", "levels: { index: number; name: string | null; startRow: number; numRows: number }[]"],
  ['src/editor/js/api/map-management.ts', "loadMap(json: any)", "loadMap(json: Record<string, unknown>)"],
  ['src/editor/js/api/map-management.ts', "dungeon: any", "dungeon: Record<string, unknown>"],
  ['src/editor/js/api/plan-brief.ts', "brief: Record<string, any>", "brief: Record<string, string | number | boolean | Record<string, unknown>[] | Record<string, unknown>>"],
  ['src/editor/js/api/plan-brief.ts', "commands: any[][]", "commands: (string | number | boolean)[][]"],
  ['src/editor/js/api/stairs-bridges.ts', "bridges: any[]", "bridges: { id: number; type: string; points: [number, number][] }[]"],
  ['src/editor/js/api/trims.ts', "trimSize: number | Record<string, any>", "trimSize: number | Record<string, number | boolean>"],
  ['src/editor/js/api/trims.ts', "options: Record<string, any>", "options: Record<string, number | boolean | string>"],
  ['src/editor/js/api/trims.ts', "bounds: any", "bounds: { r1: number; c1: number; r2: number; c2: number }"],
  ['src/editor/js/api/validation.ts', "issues: any[]", "issues: { row: number; col: number; direction: string; doorType: string; problem: string }[]"],

  // App init
  ['src/editor/js/app-init.ts', "loaded: any, total: any) {", "loaded: number, total: number) {"],
  ['src/editor/js/app-init.ts', "(loaded: any, total: any) =>", "(loaded: number, total: number) =>"],

  // Canvas view
  ['src/editor/js/canvas-view.ts', "setSessionOverlay(renderFn: ((...args: any[]) => void) | null, clickFn: ((...args: any[]) => boolean) | null)", "setSessionOverlay(renderFn: ((...args: unknown[]) => void) | null, clickFn: ((...args: unknown[]) => boolean) | null)"],
  ['src/editor/js/canvas-view.ts', "setSessionTool(tool: any)", "setSessionTool(tool: { onMouseDown?: Function; onMouseMove?: Function; onMouseUp?: Function; renderOverlay?: Function } | null)"],
  ['src/editor/js/canvas-view.ts', "setSessionRangeTool(tool: any)", "setSessionRangeTool(tool: { renderOverlay?: Function } | null)"],
  ['src/editor/js/canvas-view.ts', "setActiveTool(tool: any)", "setActiveTool(tool: { onActivate?: Function; onDeactivate?: Function; onMouseDown?: Function } | null)"],

  // Imports
  ['src/editor/js/import-donjon.ts', "convertDonjonDungeon(data: any)", "convertDonjonDungeon(data: Record<string, unknown>)"],
  ['src/editor/js/import-opd.ts', "convertOnePageDungeon(opd: any)", "convertOnePageDungeon(opd: Record<string, unknown>)"],
  ['src/editor/js/import-opd.ts', "const props: any = []", "const props: Record<string, unknown>[] = []"],
  ['src/editor/js/import-opd.ts', "const insideArc: any = []", "const insideArc: { row: number; col: number }[] = []"],

  // Light catalog
  ['src/editor/js/light-catalog.ts', "buildFromMetadata(entries: any)", "buildFromMetadata(entries: Record<string, Record<string, unknown>>)"],

  // Onboarding
  ['src/editor/js/onboarding.ts', "markHintSeen(tool: any)", "markHintSeen(tool: string)"],
  ['src/editor/js/onboarding.ts', "showToolHint(tool: any)", "showToolHint(tool: string)"],
  ['src/editor/js/onboarding.ts', "showWelcome(onTutorial: any, onExample: any, onFresh: any)", "showWelcome(onTutorial: () => void, onExample: () => void, onFresh: () => void)"],
  ['src/editor/js/onboarding.ts', "_positionPanel(panel: any, targetRect: any, position: any)", "_positionPanel(panel: HTMLElement, targetRect: DOMRect, position: string)"],

  // Panels
  ['src/editor/js/panels/metadata.ts', "(cb: any) => window.requestIdleCallback(cb)", "(cb: IdleRequestCallback) => window.requestIdleCallback(cb)"],
  ['src/editor/js/panels/metadata.ts', ": (cb: any) => setTimeout(cb, 0)", ": (cb: () => void) => setTimeout(cb, 0)"],
  ['src/editor/js/panels/metadata.ts', "(ev: any) => { if (ev.target === modal) onCancel(); }", "(ev: MouseEvent) => { if (ev.target === modal) onCancel(); }"],
  ['src/editor/js/panels/textures.ts', "buildCategoryGrid(cat: any, parent: any, filter: any)", "buildCategoryGrid(cat: string, parent: HTMLElement, filter: string)"],
  ['src/editor/js/panels/textures.ts', "filterTextures(cat: any)", "filterTextures(cat: string)"],

  // Prop overlay / spatial
  ['src/editor/js/prop-overlay.ts', "getOverlayPropAABB(prop: any,", "getOverlayPropAABB(prop: OverlayProp,"],
  ['src/editor/js/prop-spatial.ts', "(a: any, b: any) => (b.zIndex ?? 10) - (a.zIndex ?? 10)", "(a: { zIndex?: number }, b: { zIndex?: number }) => (b.zIndex ?? 10) - (a.zIndex ?? 10)"],

  // Texture
  ['src/editor/js/texture-alerts.ts', "downloadSnapshot }: any)", "downloadSnapshot }: { count: number; requiredCount: number; catalogCount: number; downloadInProgress: boolean; downloadSnapshot: number })"],
  ['src/editor/js/texture-catalog.ts', "buildFromMetadata(entries: any)", "buildFromMetadata(entries: Record<string, Record<string, unknown>>[])"],
  ['src/editor/js/texture-catalog.ts', "awaitImage(image: any)", "awaitImage(image: HTMLImageElement)"],

  // Tools
  ['src/editor/js/tools/tool-erase.ts', "(s: any) => s.id === id", "(s: { id: number }) => s.id === id"],
  ['src/editor/js/tools/tool-erase.ts', "(s: any) => s.link === stairDef.link && s.id !== id", "(s: { link: string | null; id: number }) => s.link === stairDef.link && s.id !== id"],
  ['src/editor/js/tools/tool-fill.ts', "_applyBox(mode: any)", "_applyBox(mode: string)"],
  ['src/editor/js/tools/tool-label.ts', "cleanupLabelPos(center: any)", "cleanupLabelPos(center: Record<string, unknown>)"],
  ['src/editor/js/tools/tool-label.ts', "_event: any,", "_event: MouseEvent | null,"],
  ['src/editor/js/tools/tool-label.ts', "worldX: any, worldY: any)", "worldX: number, worldY: number)"],
  ['src/editor/js/tools/tool-light.ts', "px: any, py: any, light: Light, isSelected: any, isHovered: any)", "px: number, py: number, light: Light, isSelected: boolean, isHovered: boolean)"],
  ['src/editor/js/tools/tool-light.ts', "px: any, py: any, light: Light, transform:", "px: number, py: number, light: Light, transform:"],
  ['src/editor/js/tools/tool-stairs.ts', "_handlePlaceClick(corner: any)", "_handlePlaceClick(corner: { row: number; col: number })"],
  ['src/editor/js/tools/tool-stairs.ts', "occupiedCells: any)", "occupiedCells: { row: number; col: number }[])"],
  ['src/editor/js/tools/tool-trim.ts', "declare previewCells: any;", "declare previewCells: { row: number; col: number }[] | null;"],
  ['src/editor/js/tools/tool-trim.ts', "const insideArc: any = []", "const insideArc: { row: number; col: number }[] = []"],
  ['src/editor/js/tools/tool-trim.ts', "syncTrimButtons = (prop: any, val: any)", "syncTrimButtons = (prop: string, val: boolean)"],
  ['src/editor/js/tools/tool-trim.ts', "corner: any)", "corner: string)"],
  ['src/editor/js/tools/tool-wall.ts', "_fillLine(endRow: any, endCol: any)", "_fillLine(endRow: number, endCol: number)"],
  ['src/editor/js/ui-components.ts', "applySnap(snapId: any)", "applySnap(snapId: string)"],
  ['src/editor/js/ui-components.ts', "updatePullCmd(modelValue: any)", "updatePullCmd(modelValue: string)"],

  // Render
  ['src/render/borders.ts', "_getDoorRole(cells: CellGrid, row: number, col: number, direction: any, resolution: any, mode: any)", "_getDoorRole(cells: CellGrid, row: number, col: number, direction: string, resolution: number, mode: string)"],
  ['src/render/compile.ts', "resolveTheme(themeConfig: any, themeOverrides: any,", "resolveTheme(themeConfig: string | Record<string, unknown>, themeOverrides: Record<string, unknown> | null,"],
  ['src/render/compile.ts', "bgImageEl: any = null): void {", "bgImageEl: HTMLImageElement | null = null): void {"],
  ['src/render/compile.ts', "revealedCells: any, fogOptions: any,", "revealedCells: Set<string> | boolean[][], fogOptions: { openedDoors?: string[]; openedStairs?: string[] } | null,"],
  ['src/render/effects.ts', "hexToRgba(hex: any, alpha: any)", "hexToRgba(hex: string, alpha: number)"],
  ['src/render/effects.ts', "roomCells: any, maxDist: any)", "roomCells: boolean[][], maxDist: number)"],
  ['src/render/export-dd2vtt.ts', "cellToPixelSegment(edge: any,", "cellToPixelSegment(edge: { x1: number; y1: number; x2: number; y2: number; dir: string },"],
  ['src/render/export-dd2vtt.ts', "(cellVal: any, offset: any)", "(cellVal: number, offset: number)"],
  ['src/render/lighting-hq.ts', "options: any, metadata:", "options: Record<string, unknown> | null, metadata:"],
  ['src/render/lighting-hq.ts', "_pointInPolygon(px: any, py: any, polygon: any)", "_pointInPolygon(px: number, py: number, polygon: Array<{x: number; y: number}>)"],
  ['src/render/patterns.ts', "WATER_PATTERNS: any[]", "WATER_PATTERNS: Record<string, unknown>[]"],
  ['src/render/patterns.ts', "WATER_SPATIAL: any", "WATER_SPATIAL: Record<string, number[]>"],
  ['src/render/prop-catalog-node.ts', "manualHitboxToPolygon(cmds: any[])", "manualHitboxToPolygon(cmds: PropCommand[])"],
  ['src/render/prop-catalog-node.ts', "buildHitboxZones(def: any): any[]", "buildHitboxZones(def: PropDefinition): Record<string, unknown>[]"],
  ['src/render/prop-validate.ts', "validatePropFile(text: any)", "validatePropFile(text: string)"],
  ['src/render/render-cells.ts', "propCatalog?: any;", "propCatalog?: PropCatalog | null;"],
  ['src/render/render-cells.ts', "textureOptions?: any;", "textureOptions?: { catalog: TextureCatalog; blendWidth: number } | null;"],
  ['src/render/render-cells.ts', "bgImgConfig?: any;", "bgImgConfig?: Record<string, number | string> | null;"],
  ['src/render/render-phases.ts', "textureOptions: any, metadata:", "textureOptions: { catalog: TextureCatalog; blendWidth: number } | null, metadata:"],
  ['src/render/texture-catalog-node.ts', "ensureTexturesForConfig(catalog: any,", "ensureTexturesForConfig(catalog: TextureCatalog | null,"],
];

let total = 0;
const fileCache = {};

for (const [file, search, replace] of replacements) {
  if (!fileCache[file]) {
    fileCache[file] = { content: fs.readFileSync(file, 'utf8'), modified: false };
  }
  const entry = fileCache[file];
  if (entry.content.includes(search)) {
    entry.content = entry.content.replace(search, replace);
    entry.modified = true;
    total++;
  } else {
    // Try replacing just the first occurrence
    console.warn(`  MISS: ${file} — "${search.substring(0, 60)}..."`);
  }
}

for (const [file, entry] of Object.entries(fileCache)) {
  if (entry.modified) {
    fs.writeFileSync(file, entry.content);
  }
}

console.log(`\nTotal replaced: ${total}`);
