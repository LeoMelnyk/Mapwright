// discovery.ts — apiSearch / apiDetails for runtime API discovery.
//
// The Editor API has 250+ methods. Loading the full reference doc costs
// ~15k tokens. apiSearch lets callers find relevant methods by category +
// keyword without paging the whole doc. apiDetails returns the signature
// of a single method.
//
// The category map is hand-maintained — when adding a new API method,
// also add its name to the category it belongs to below.

import { ApiValidationError, getApi } from './_shared.js';

type Category =
  | 'map'
  | 'rooms'
  | 'cells'
  | 'walls-doors'
  | 'labels'
  | 'stairs-bridges'
  | 'trims'
  | 'fills'
  | 'textures'
  | 'lighting'
  | 'props'
  | 'bulk-props'
  | 'spatial'
  | 'relational'
  | 'inspection'
  | 'validation'
  | 'transforms'
  | 'levels'
  | 'plan'
  | 'undo-checkpoints'
  | 'preview'
  | 'session'
  | 'catalog'
  | 'discovery'
  | 'operational';

interface MethodInfo {
  name: string;
  category: Category;
  intent: string;
}

// Curated registry. New API methods should be added here under the right
// category to remain discoverable via apiSearch.
const REGISTRY: MethodInfo[] = [
  // ── map ─────────────────────────────────────────────
  { name: 'newMap', category: 'map', intent: 'Create an empty dungeon with given dimensions' },
  { name: 'loadMap', category: 'map', intent: 'Load a dungeon from JSON' },
  { name: 'getMap', category: 'map', intent: 'Export current dungeon as JSON' },
  { name: 'getMapInfo', category: 'map', intent: 'Get map metadata (dimensions, theme, counts)' },
  {
    name: 'getFullMapInfo',
    category: 'map',
    intent: 'Comprehensive state snapshot — rooms, props, doors, lights, stairs, bridges',
  },
  { name: 'setName', category: 'map', intent: 'Set the dungeon name' },
  { name: 'setTheme', category: 'map', intent: 'Set the rendering theme' },
  { name: 'setLabelStyle', category: 'map', intent: 'Set label style (circled/plain/bold)' },
  { name: 'setFeature', category: 'map', intent: 'Toggle a feature flag (grid, compass, scale, border)' },

  // ── rooms / cells ───────────────────────────────────
  { name: 'createRoom', category: 'rooms', intent: 'Create a walled rectangular room' },
  { name: 'createPolygonRoom', category: 'rooms', intent: 'Create a room from arbitrary cell list (L/U/+ shapes)' },
  { name: 'paintCell', category: 'cells', intent: 'Paint a single floor cell' },
  { name: 'paintRect', category: 'cells', intent: 'Paint a rectangle of floor cells' },
  { name: 'eraseCell', category: 'cells', intent: 'Erase a single cell to void' },
  { name: 'eraseRect', category: 'cells', intent: 'Erase a rectangle to void' },
  { name: 'getCellInfo', category: 'cells', intent: 'Inspect a single cell' },

  // ── walls & doors ───────────────────────────────────
  { name: 'setWall', category: 'walls-doors', intent: 'Place a wall on a cell edge' },
  { name: 'removeWall', category: 'walls-doors', intent: 'Remove a wall from a cell edge' },
  { name: 'setDoor', category: 'walls-doors', intent: 'Place a door on a wall' },
  { name: 'removeDoor', category: 'walls-doors', intent: 'Remove a door (reverts to wall)' },
  { name: 'setDoorBetween', category: 'walls-doors', intent: 'Place a door at the midpoint of two adjacent rooms' },
  { name: 'findWallBetween', category: 'walls-doors', intent: 'Find all shared walls between two rooms' },
  { name: 'partitionRoom', category: 'walls-doors', intent: 'Add an internal wall partition across a room' },

  // ── labels ──────────────────────────────────────────
  { name: 'setLabel', category: 'labels', intent: 'Set a room label' },
  { name: 'removeLabel', category: 'labels', intent: 'Remove a room label' },

  // ── stairs & bridges ────────────────────────────────
  { name: 'addStairs', category: 'stairs-bridges', intent: 'Place stairs from 3 corner points' },
  { name: 'setStairs', category: 'stairs-bridges', intent: 'Legacy 1×1 rectangle stair placement' },
  { name: 'removeStairs', category: 'stairs-bridges', intent: 'Remove stair object at cell' },
  { name: 'linkStairs', category: 'stairs-bridges', intent: 'Link two stair objects across levels' },
  { name: 'addBridge', category: 'stairs-bridges', intent: 'Place a bridge from 3 corner points' },
  { name: 'removeBridge', category: 'stairs-bridges', intent: 'Remove a bridge' },
  { name: 'getBridges', category: 'stairs-bridges', intent: 'List all bridges' },

  // ── trims ──────────────────────────────────────────
  { name: 'createTrim', category: 'trims', intent: 'Cut a diagonal corner from a room' },
  { name: 'roundRoomCorners', category: 'trims', intent: 'Round all 4 corners of a labeled room' },

  // ── fills ──────────────────────────────────────────
  { name: 'setFill', category: 'fills', intent: 'Set fill on a cell (pit/water/lava)' },
  { name: 'removeFill', category: 'fills', intent: 'Remove fill from a cell' },
  { name: 'setFillRect', category: 'fills', intent: 'Set fill on a rectangle of cells' },
  { name: 'removeFillRect', category: 'fills', intent: 'Remove fill from a rectangle' },
  { name: 'setHazard', category: 'fills', intent: 'Mark a cell as hazard (difficult terrain)' },
  { name: 'setHazardRect', category: 'fills', intent: 'Mark a rectangle as hazard' },

  // ── textures ───────────────────────────────────────
  { name: 'setTexture', category: 'textures', intent: 'Apply texture to a cell' },
  { name: 'removeTexture', category: 'textures', intent: 'Remove texture from a cell' },
  { name: 'setTextureRect', category: 'textures', intent: 'Apply texture to a rectangle' },
  { name: 'removeTextureRect', category: 'textures', intent: 'Remove texture from a rectangle' },
  { name: 'floodFillTexture', category: 'textures', intent: 'Flood-fill texture across connected cells' },
  { name: 'waitForTextures', category: 'textures', intent: 'Wait for texture images to finish loading' },
  { name: 'listTextures', category: 'catalog', intent: 'List all available texture IDs' },

  // ── lighting ───────────────────────────────────────
  { name: 'placeLight', category: 'lighting', intent: 'Place a light at world-feet coordinates' },
  { name: 'placeLightInRoom', category: 'lighting', intent: 'Place a light at the center of a labeled room' },
  { name: 'removeLight', category: 'lighting', intent: 'Remove a light by ID' },
  { name: 'setLightName', category: 'lighting', intent: 'Set a label/name on a light' },
  { name: 'getLights', category: 'lighting', intent: 'Return all lights' },
  { name: 'setAmbientLight', category: 'lighting', intent: 'Set ambient light level (0–1)' },
  { name: 'setLightingEnabled', category: 'lighting', intent: 'Toggle the lighting system' },
  { name: 'listLightPresets', category: 'catalog', intent: 'List all light presets' },

  // ── props ──────────────────────────────────────────
  { name: 'placeProp', category: 'props', intent: 'Place a single prop at an anchor cell' },
  { name: 'removeProp', category: 'props', intent: 'Remove the prop covering a cell' },
  { name: 'removePropAt', category: 'props', intent: 'Remove the prop whose anchor is exactly at this cell' },
  { name: 'rotateProp', category: 'props', intent: 'Rotate a prop 90° clockwise' },
  { name: 'removePropsInRect', category: 'props', intent: 'Remove all props in a rectangle' },
  { name: 'setPropZIndex', category: 'props', intent: 'Set z-index of a prop (rendering order)' },
  { name: 'bringForward', category: 'props', intent: 'Bring a prop forward by one z-step' },
  { name: 'sendBackward', category: 'props', intent: 'Send a prop backward by one z-step' },
  { name: 'suggestPropPosition', category: 'spatial', intent: 'Suggest a free position for a prop in a room' },
  { name: 'listProps', category: 'catalog', intent: 'List all available props with metadata' },
  { name: 'getPropsForRoomType', category: 'catalog', intent: 'Get props tagged for a room type' },
  { name: 'searchProps', category: 'catalog', intent: 'Filter the prop catalog by metadata' },
  { name: 'listLightEmittingProps', category: 'catalog', intent: 'Props that auto-emit a light when placed' },
  { name: 'getPropFootprint', category: 'props', intent: 'Cells a prop occupies at given rotation' },

  // ── bulk-props ─────────────────────────────────────
  { name: 'fillWallWithProps', category: 'bulk-props', intent: 'Line a wall with copies of a prop' },
  { name: 'lineProps', category: 'bulk-props', intent: 'Place props in a straight line' },
  { name: 'scatterProps', category: 'bulk-props', intent: 'Scatter props at random valid positions' },
  { name: 'clusterProps', category: 'bulk-props', intent: 'Place a group of props at offsets from an anchor' },
  {
    name: 'autofurnish',
    category: 'bulk-props',
    intent: 'Catalog-driven prop placement for a labeled room (back-compat: propose+commit)',
  },
  {
    name: 'proposeFurnishing',
    category: 'bulk-props',
    intent: 'Compute a furnishing plan without touching the map — inspectable before commit',
  },
  {
    name: 'commitFurnishing',
    category: 'bulk-props',
    intent: 'Execute a plan from proposeFurnishing — entries can be mutated first',
  },
  { name: 'furnishBrief', category: 'bulk-props', intent: 'Run autofurnish across many rooms in one call' },

  // ── relational placement ───────────────────────────
  { name: 'placeRelative', category: 'relational', intent: 'Place a prop offset from an anchor cell in a direction' },
  { name: 'placeSymmetric', category: 'relational', intent: 'Place a pair of props mirrored across a room centerline' },
  {
    name: 'placeFlanking',
    category: 'relational',
    intent: 'Place flanking props on either side of an existing anchor prop',
  },

  // ── spatial ────────────────────────────────────────
  { name: 'findCellByLabel', category: 'spatial', intent: 'Find the cell holding a room label' },
  { name: 'getRoomBounds', category: 'spatial', intent: 'BFS from a label cell to find room extent' },
  { name: 'listRooms', category: 'spatial', intent: 'List all labeled rooms with bounds and centers' },
  { name: 'listRoomCells', category: 'spatial', intent: 'List all floor cells of a labeled room' },
  { name: 'getRoomContents', category: 'spatial', intent: 'Props/fills/doors/textures inside a room bbox' },
  { name: 'getValidPropPositions', category: 'spatial', intent: 'Valid anchor cells for a prop in a room' },
  { name: 'suggestPlacement', category: 'spatial', intent: 'Find free rectangular space of given size' },
  { name: 'mergeRooms', category: 'rooms', intent: 'Remove walls on shared boundary between two rooms' },
  { name: 'shiftCells', category: 'rooms', intent: 'Shift all cells by (dr, dc), grow grid as needed' },
  { name: 'normalizeMargin', category: 'rooms', intent: 'Normalize grid margin around all structural content' },
  { name: 'createCorridor', category: 'rooms', intent: 'Auto-create a corridor between two rooms (caves only)' },

  // ── inspection ─────────────────────────────────────
  { name: 'renderAscii', category: 'inspection', intent: 'ASCII-render a region of the map' },
  { name: 'inspectRegion', category: 'inspection', intent: 'Structured per-cell dump of a region' },
  { name: 'getRoomSummary', category: 'inspection', intent: 'One-call survey of a labeled room' },
  { name: 'queryCells', category: 'inspection', intent: 'Find cells matching a structured predicate' },
  { name: 'getLightingCoverage', category: 'inspection', intent: 'Per-cell lighting estimate (ignores walls)' },
  { name: 'findConflicts', category: 'inspection', intent: 'Single-call structural design audit' },
  {
    name: 'getPropPlacementOptions',
    category: 'inspection',
    intent: 'Enumerate prop anchors with valid/invalid + reasons',
  },
  {
    name: 'describeMap',
    category: 'inspection',
    intent: 'Compact semantic snapshot — ASCII + keyed prop sidecar per room',
  },
  { name: 'listDoors', category: 'inspection', intent: 'List every door, deduplicated' },
  { name: 'listWalls', category: 'inspection', intent: 'List every wall edge, deduplicated' },
  { name: 'listFills', category: 'inspection', intent: 'List every filled cell with depth' },
  { name: 'unlabelledRooms', category: 'inspection', intent: 'Find BFS regions with no center label' },
  { name: 'getThemeColors', category: 'catalog', intent: 'Resolved theme color map for current map' },
  { name: 'waitForRender', category: 'operational', intent: 'Wait until lighting version stops advancing' },

  // ── validation ─────────────────────────────────────
  { name: 'validateDoorClearance', category: 'validation', intent: 'Check for props blocking doors' },
  { name: 'validateConnectivity', category: 'validation', intent: 'BFS from entrance through open edges and doors' },
  { name: 'explainCommand', category: 'validation', intent: 'Dry-run a single command, return ok/error' },
  { name: 'validateCommands', category: 'validation', intent: 'Dry-run a batch sequentially' },
  {
    name: 'critiqueMap',
    category: 'validation',
    intent: 'Run design heuristics — completeness, lighting, spatial, composition',
  },

  // ── transforms ─────────────────────────────────────
  { name: 'cloneRoom', category: 'transforms', intent: 'Copy a labeled room to an offset' },
  { name: 'mirrorRegion', category: 'transforms', intent: 'Flip cells in a rectangle across an axis' },
  { name: 'rotateRegion', category: 'transforms', intent: 'Rotate a square region 90/180/270' },
  { name: 'replaceProp', category: 'transforms', intent: 'Bulk swap one prop type for another' },
  { name: 'replaceTexture', category: 'transforms', intent: 'Bulk swap one texture ID for another' },

  // ── levels ─────────────────────────────────────────
  { name: 'getLevels', category: 'levels', intent: 'List levels with name/startRow/numRows' },
  { name: 'renameLevel', category: 'levels', intent: 'Rename a level' },
  { name: 'resizeLevel', category: 'levels', intent: 'Add or remove rows in a level' },
  { name: 'addLevel', category: 'levels', intent: 'Append a new level' },
  { name: 'defineLevels', category: 'levels', intent: 'Set level boundaries on existing rows' },

  // ── plan brief ─────────────────────────────────────
  { name: 'planBrief', category: 'plan', intent: 'Compute a full layout from a room+connection brief' },

  // ── undo / checkpoints ─────────────────────────────
  { name: 'undo', category: 'undo-checkpoints', intent: 'Undo last action' },
  { name: 'redo', category: 'undo-checkpoints', intent: 'Redo last undone action' },
  { name: 'getUndoDepth', category: 'undo-checkpoints', intent: 'Return current undo stack depth' },
  { name: 'undoToDepth', category: 'undo-checkpoints', intent: 'Undo back to a numeric depth' },
  { name: 'checkpoint', category: 'undo-checkpoints', intent: 'Record a named checkpoint at current depth' },
  { name: 'rollback', category: 'undo-checkpoints', intent: 'Undo back to a named checkpoint' },
  { name: 'listCheckpoints', category: 'undo-checkpoints', intent: 'List all named checkpoints with stepsAhead' },
  { name: 'clearCheckpoint', category: 'undo-checkpoints', intent: 'Delete a named checkpoint' },
  { name: 'diffFromCheckpoint', category: 'undo-checkpoints', intent: 'Summarize what would be undone if rolled back' },
  { name: 'transaction', category: 'undo-checkpoints', intent: 'All-or-nothing batch with auto-rollback on failure' },
  {
    name: 'pauseForReview',
    category: 'operational',
    intent: 'Block batch execution for human inspection (works best with --visible)',
  },

  // ── preview / session ──────────────────────────────
  { name: 'getScreenshot', category: 'preview', intent: 'Return current canvas as data URL' },
  { name: 'getScreenshotAnnotated', category: 'preview', intent: 'Annotated screenshot with highlights overlay' },
  { name: 'renderPropPreview', category: 'preview', intent: 'Render a single prop to a data-URL image' },
  { name: 'getPropThumbnail', category: 'preview', intent: 'Cached small thumbnail for a prop (visual picking)' },
  { name: 'getPropThumbnails', category: 'preview', intent: 'Batch-fetch thumbnails for many props' },
  {
    name: 'prewarmPropThumbnails',
    category: 'preview',
    intent: 'Pre-render the entire prop catalog into the thumbnail cache',
  },
  {
    name: 'searchPropsWithThumbnails',
    category: 'preview',
    intent: 'searchProps + inline thumbnail per result (async)',
  },
  { name: 'clearPropThumbnailCache', category: 'preview', intent: 'Clear in-memory prop thumbnail cache' },
  {
    name: 'getSessionInfo',
    category: 'session',
    intent: 'Rich snapshot of editor state — catalogs, counts, dirty flags',
  },

  // ── operational ────────────────────────────────────
  { name: 'eval', category: 'operational', intent: 'Evaluate arbitrary JS — escape hatch' },
  { name: 'clearCaches', category: 'operational', intent: 'Reload all asset caches' },
  { name: 'render', category: 'operational', intent: 'Force an immediate re-render' },
  { name: 'waitForEditor', category: 'operational', intent: 'Wait for editor initialization' },
  { name: 'exportPng', category: 'preview', intent: 'Render a high-quality PNG via the full export pipeline' },
  { name: 'getRenderDiagnostics', category: 'operational', intent: 'Render performance/timing diagnostics' },
  { name: 'getStateDigest', category: 'operational', intent: 'Hash digest of map state — useful for change detection' },
  { name: 'listThemes', category: 'catalog', intent: 'List all available themes' },

  // ── discovery (this module) ────────────────────────
  { name: 'apiSearch', category: 'discovery', intent: 'Search API methods by keyword and category' },
  { name: 'apiDetails', category: 'discovery', intent: 'Get full signature + intent for a method' },
  { name: 'apiCategories', category: 'discovery', intent: 'List all API categories with method counts' },
];

const BY_NAME = new Map<string, MethodInfo>(REGISTRY.map((m) => [m.name, m]));

/**
 * Search API methods by keyword and/or category. Returns lightweight method
 * metadata (name + category + 1-line intent) — call `apiDetails(name)` for
 * the full signature and JSDoc.
 *
 * @param query Keyword substring (case-insensitive). Empty string matches all.
 * @param options.category Restrict to a single category
 * @param options.limit Max results (default 30)
 */
export function apiSearch(
  query: string,
  options: { category?: string; limit?: number } = {},
): { success: true; count: number; results: Array<{ name: string; category: string; intent: string }> } {
  const q = (typeof query === 'string' ? query : '').toLowerCase();
  const limit = Math.max(1, Math.min(200, options.limit ?? 30));
  const cat = options.category;

  let results = REGISTRY.filter((m) => {
    if (cat && m.category !== cat) return false;
    if (!q) return true;
    return m.name.toLowerCase().includes(q) || m.intent.toLowerCase().includes(q);
  });

  // Rank: name match before intent match
  results.sort((a, b) => {
    const aName = a.name.toLowerCase().includes(q) ? 0 : 1;
    const bName = b.name.toLowerCase().includes(q) ? 0 : 1;
    if (aName !== bName) return aName - bName;
    return a.name.localeCompare(b.name);
  });

  results = results.slice(0, limit);
  return { success: true, count: results.length, results };
}

/**
 * Return registered metadata for a single API method: name, category,
 * intent, and runtime signature (parameter count). For the full JSDoc /
 * code, read the source module corresponding to the category.
 */
export function apiDetails(methodName: string): {
  success: true;
  name: string;
  category: string;
  intent: string;
  paramCount: number;
  sourceModule: string;
} {
  const info = BY_NAME.get(methodName);
  if (!info) {
    throw new ApiValidationError('UNKNOWN_API_METHOD', `No API method named "${methodName}"`, {
      methodName,
      hint: 'Call apiSearch with a keyword to discover the right name.',
    });
  }
  const api = getApi() as unknown as Record<string, unknown>;
  const fn = api[methodName] as ((...args: unknown[]) => unknown) | undefined;
  return {
    success: true,
    name: info.name,
    category: info.category,
    intent: info.intent,
    paramCount: typeof fn === 'function' ? fn.length : 0,
    sourceModule: `editor/js/api/${categoryToModule(info.category)}.ts`,
  };
}

/** List every category and how many registered methods are in it. */
export function apiCategories(): {
  success: true;
  categories: Array<{ category: string; methodCount: number }>;
} {
  const counts = new Map<string, number>();
  for (const m of REGISTRY) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  const categories = [...counts.entries()]
    .map(([category, methodCount]) => ({ category, methodCount }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return { success: true, categories };
}

function categoryToModule(cat: string): string {
  const map: Record<string, string> = {
    map: 'map-management',
    rooms: 'cells',
    cells: 'cells',
    'walls-doors': 'walls-doors',
    labels: 'labels',
    'stairs-bridges': 'stairs-bridges',
    trims: 'trims',
    fills: 'fills',
    textures: 'textures',
    lighting: 'lighting',
    props: 'props',
    'bulk-props': 'props',
    spatial: 'spatial',
    relational: 'spatial',
    inspection: 'inspect',
    validation: 'validation',
    transforms: 'transforms',
    levels: 'levels',
    plan: 'plan-brief',
    'undo-checkpoints': 'operational',
    preview: 'preview',
    session: 'operational',
    catalog: 'operational',
    discovery: 'discovery',
    operational: 'operational',
  };
  return map[cat] ?? 'unknown';
}
