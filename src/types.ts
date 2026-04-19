/**
 * Core type definitions for the Mapwright dungeon editor.
 *
 * These types describe the dungeon data model, rendering pipeline inputs,
 * and editor state. They are the source of truth for the TypeScript migration.
 */

// ── Cell & Edge Types ──────────────────────────────────────────────────────

/** Wall/door edge values stored on each cell face. */
export type EdgeValue = 'w' | 'd' | 's' | 'iw' | 'id' | null | undefined;

/** Cardinal direction names for cell edges. */
export type CardinalDirection = 'north' | 'south' | 'east' | 'west';

/** Diagonal direction names for cell edges. */
export type DiagonalDirection = 'nw-se' | 'ne-sw';

/** All direction names (cardinal + diagonal). */
export type Direction = CardinalDirection | DiagonalDirection;

/** Fill types for cells. */
export type FillType = 'water' | 'lava' | 'pit';

/** A texture applied to a cell floor. */
export interface CellTexture {
  id: string;
  opacity: number;
}

/** A prop placed on a cell. */
export interface CellProp {
  type: string;
  span: [number, number];
  facing: number;
  flipped?: boolean;
}

/** Center content of a cell (labels, stair IDs, etc.). */
export interface CellCenter {
  label?: string;
  dmLabel?: string;
  labelX?: number;
  labelY?: number;
  'stair-id'?: number;
  [key: string]: unknown;
}

/** A single cell in the dungeon grid. null = void (no floor). */
export interface Cell {
  north?: EdgeValue;
  south?: EdgeValue;
  east?: EdgeValue;
  west?: EdgeValue;
  'nw-se'?: EdgeValue;
  'ne-sw'?: EdgeValue;
  fill?: FillType;
  fillDepth?: number;
  hazard?: boolean;
  texture?: string;
  textureOpacity?: number;
  textureSecondary?: string;
  textureSecondaryOpacity?: number;
  textureNE?: string;
  textureNEOpacity?: number;
  textureSW?: string;
  textureSWOpacity?: number;
  textureNW?: string;
  textureNWOpacity?: number;
  textureSE?: string;
  textureSEOpacity?: number;
  trimmed?: boolean;
  trimWall?: CardinalDirection | number[][];
  trimCorner?: string;
  trimRound?: boolean;
  trimInverted?: boolean;
  trimOpen?: boolean;
  trimPassable?: boolean;
  trimClip?: number[][];
  trimCrossing?: boolean | Record<string, string>;
  trimHideExterior?: boolean;
  trimShowExteriorOnly?: boolean;
  trimInsideArc?: boolean;
  trimArcRadius?: number;
  trimArcCenterRow?: number;
  trimArcCenterCol?: number;
  trimArcInverted?: boolean;
  waterDepth?: number;
  lavaDepth?: number;
  center?: CellCenter;
  prop?: CellProp;
}

/** The 2D cell grid. null entries are void (no floor). */
export type CellGrid = (Cell | null)[][];

/** A multi-level dungeon: one CellGrid per level. */
export type MultiLevelCellGrid = CellGrid[];

/**
 * Dungeon cells — either a single flat grid or an array of grids (one per level).
 * At runtime, multi-level dungeons store cells as CellGrid[] even though the
 * static type is CellGrid.  Use `asMultiLevel()` after an `isMultiLevel` guard.
 */
export type CellGridOrMultiLevel = CellGrid | MultiLevelCellGrid;

/** Narrow a CellGrid to MultiLevelCellGrid after a runtime multi-level check. */
export function asMultiLevel(cells: CellGrid): MultiLevelCellGrid {
  return cells as unknown as MultiLevelCellGrid;
}

// ── Lights ─────────────────────────────────────────────────────────────────

/** Light falloff curve types. */
export type FalloffType = 'smooth' | 'linear' | 'sharp' | 'step' | 'quadratic' | 'inverse-square';

/** A light source placed in the dungeon. */
export interface Light {
  id: number;
  x: number;
  y: number;
  type: 'point' | 'directional';
  radius: number;
  color: string;
  intensity: number;
  falloff: FalloffType;
  z?: number;
  angle?: number;
  spread?: number;
  animation?: LightAnimationConfig | null;
  name?: string;
  range?: number;
  dimRadius?: number;
  presetId?: string;
  propRef?: { row: number; col: number };
  /**
   * Optional group name. Lights sharing a group can be toggled together via
   * setLightGroupEnabled(). `undefined` or `''` puts the light in the
   * default (always-on) bucket.
   */
  group?: string;
  _propShadows?: {
    shadowPoly: number[][];
    nearCenter: number[];
    farCenter: number[];
    opacity: number;
    hard: boolean;
  }[];
}

/** A light preset from the catalog. */
export interface LightPreset {
  id?: string;
  displayName: string;
  category: string;
  type: 'point' | 'directional';
  color: string;
  radius: number;
  intensity: number;
  falloff: FalloffType;
  dimRadius?: number;
  z?: number | null;
  spread?: number;
  animation?: LightAnimationConfig | null;
  description?: string;
  [key: string]: unknown;
}

/** Light catalog loaded from manifest. */
export interface LightCatalog {
  names: string[];
  lights: Record<string, LightPreset | undefined>;
  categoryOrder: string[];
  byCategory: Record<string, string[]>;
}

// ── Stairs & Bridges ───────────────────────────────────────────────────────

/** A stair object defined by 3 corner points. */
export interface Stairs {
  id: number;
  points: [[number, number], [number, number], [number, number]];
  link?: string | null;
}

/** Bridge type names. */
export type BridgeType = 'wood' | 'stone' | 'rope' | 'dock';

/** A bridge object defined by 3 corner points. */
export interface Bridge {
  id: number;
  type: BridgeType;
  points: [[number, number], [number, number], [number, number]];
}

// ── Levels ─────────────────────────────────────────────────────────────────

/** A dungeon level (floor) definition. */
export interface Level {
  name: string | null;
  startRow: number;
  numRows: number;
}

// ── Metadata ───────────────────────────────────────────────────────────────

/** Map feature toggle flags. */
export interface MapFeatures {
  showGrid: boolean;
  showSubGrid?: boolean;
  compassRose: boolean;
  scale: boolean;
  border: boolean;
}

/** Label display style. */
export type LabelStyle = 'circled' | 'plain' | 'bold';

/** Background image overlay. */
export interface BackgroundImage {
  dataUrl: string;
  opacity: number;
  cellWidth?: number;
  cellHeight?: number;
  pixelsPerCell?: number;
  offsetX?: number;
  offsetY?: number;
  filename?: string;
  _wheelTimer?: ReturnType<typeof setTimeout> | null;
}

/** Dungeon metadata (map-level settings). */
export interface Metadata {
  dungeonName: string;
  dungeonLetter?: string;
  gridSize: number;
  resolution: number;
  theme: string | Theme;
  labelStyle: LabelStyle;
  features: MapFeatures;
  levels: Level[];
  lightingEnabled: boolean;
  ambientLight: number;
  lights: Light[];
  /**
   * Disabled light groups. A group whose name appears here is culled from
   * the renderer output; un-grouped lights (group=undefined or '') are
   * always rendered. Kept separate from Light.group so the set of groups
   * on the map can grow without each light carrying redundant state.
   */
  disabledLightGroups?: string[];
  stairs: Stairs[];
  bridges: Bridge[];
  nextLightId: number;
  nextBridgeId: number;
  nextStairId: number;
  backgroundImage?: BackgroundImage;
  savedThemeData?: { name?: string; theme: Record<string, unknown> };
  props?: OverlayProp[];
  nextPropId?: number;
  pixelsPerCell?: number;
  titleFontSize?: number;
  themeOverrides?: Record<string, unknown> | null;
  texturesVersion?: number;
  ambientColor?: string;
  backgroundMusic?: string;
  [key: string]: unknown;
}

/** The full dungeon data structure. */
export interface Dungeon {
  metadata: Metadata;
  cells: CellGrid;
}

// ── Theme ──────────────────────────────────────────────────────────────────

/** Grid overlay style. */
export type GridStyle = 'lines' | 'dotted' | 'corner-crosses' | 'corner-dots' | 'corners-x' | 'corners-dot';

/** Theme grid configuration. */
export interface ThemeGrid {
  style: GridStyle;
  color: string;
  width: number;
  opacity: number;
  cornerLength?: number;
  noise?: number;
}

/** A dungeon rendering theme. */
export interface Theme {
  background: string;
  floor: string;
  wall: string;
  wallStroke: string;
  wallFill?: string;
  wallShadow?: { color: string; blur: number; offsetX: number; offsetY: number } | null;
  wallRoughness?: number;
  door: string;
  doorFill?: string;
  doorStroke?: string;
  secretDoor: string;
  secretDoorColor?: string;
  label: string;
  labelBg: string;
  textColor?: string;
  borderColor?: string;
  floorFill?: string;
  grid?: ThemeGrid;
  gridLine?: string;
  gridLineWidth?: number;
  gridStyle?: GridStyle;
  gridOpacity?: number;
  gridNoise?: number;
  gridCornerLength?: number;
  hatchColor?: string;
  hatchOpacity?: number;
  hatchSize?: number;
  hatchDistance?: number;
  hatchStyle?: string;
  outerShading?: { color: string; size: number; roughness?: number } | null;
  bufferShadingColor?: string;
  bufferShadingOpacity?: number;
  textureBlendWidth?: number;
  compassRoseFill?: string;
  compassRoseStroke?: string;
  pitBaseColor?: string;
  pitCrackColor?: string;
  pitVignetteColor?: string;
  [key: string]: unknown;
}

/** Registry of all themes by key. */
export type ThemeRegistry = Record<string, Theme>;

// ── Props ──────────────────────────────────────────────────────────────────

/** Prop placement type. */
export type PropPlacement = 'wall' | 'corner' | 'center' | 'floor' | 'any' | null;

/** A parsed .prop file definition. */
export interface PropDefinition {
  name: string;
  category: string;
  footprint: [number, number];
  facing: boolean;
  shadow: boolean;
  blocksLight: boolean;
  padding: number;
  height: number | null;
  commands: PropCommand[];
  textures: string[];
  lights: PropLight[] | null;
  manualHitbox: PropCommand[] | null;
  manualSelection: PropCommand[] | null;
  hitbox?: number[][];
  hitboxZones?: { polygon: number[][]; zBottom: number; zTop: number }[];
  selectionHitbox?: number[][];
  autoHitbox?: number[][];
  placement: PropPlacement;
  roomTypes: string[];
  typicalCount: string | null;
  clustersWith: string[];
  notes: string | null;
}

/** A draw command parsed from a .prop file. */
export interface PropCommand {
  type: string;
  style?: string;
  color?: string | null;
  textureId?: string | null;
  opacity?: number | null;
  gradientEnd?: string;
  width?: number | null;
  rotate?: number | null;
  angle?: number | null;
  // Geometry fields (used by hitbox, render, validate)
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  r?: number;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  innerR?: number;
  outerR?: number;
  startDeg?: number;
  endDeg?: number;
  cpx?: number;
  cpy?: number;
  cp1x?: number;
  cp1y?: number;
  cp2x?: number;
  cp2y?: number;
  innerRx?: number;
  innerRy?: number;
  outerRx?: number;
  outerRy?: number;
  lineWidth?: number | null;
  subShape?: string;
  points?: number[][];
  trim?: boolean;
  src?: string;
  [key: string]: unknown;
}

/** A light bundled with a prop definition. */
export interface PropLight {
  preset: string;
  x: number;
  y: number;
  // Optional per-prop overrides on top of the named preset. Parsed from the
  // prop file's `lights:` JSON, so any field the preset defines may be
  // overridden inline.
  radius?: number;
  color?: string;
  intensity?: number;
  falloff?: FalloffType;
  dimRadius?: number;
  angle?: number;
  spread?: number;
}

/** Prop catalog structure. */
export interface PropCatalog {
  categories: string[];
  props: Record<string, PropDefinition>;
  byCategory?: Record<string, string[]>;
  [key: string]: unknown;
}

// ── Overlay Props ──────────────────────────────────────────────────────────

/** An overlay prop (free-positioned, not grid-snapped). */
export interface OverlayProp {
  id: number | string;
  type: string;
  x: number;
  y: number;
  rotation: number;
  facing?: number;
  scale: number;
  flipped: boolean;
  zIndex: number;
  lights?: OverlayPropLight[];
  [key: string]: unknown;
}

/** Light reference on an overlay prop. */
export interface OverlayPropLight {
  preset: string;
  x: number;
  y: number;
  _offsetX?: number;
  _offsetY?: number;
  type?: string;
  radius?: number;
  color?: string;
  intensity?: number;
  falloff?: string;
  [key: string]: unknown;
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** Canvas transform for world-feet → canvas-pixel conversion. */
export interface RenderTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
  lineWidth?: number;
}

/** Visible bounds for viewport culling. */
export interface VisibleBounds {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

/** Dungeon spatial bounds in world feet. */
export interface DungeonBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Cached fluid render data for a single fill type (water/lava/pit Voronoi patterns). */
export interface FluidCellData {
  clipPath: Path2D;
  fills: Map<string, Path2D>;
  cracksPath?: Path2D | null;
  crackColor?: string;
  causticPath?: Path2D | null;
  causticColor?: string;
  vignetteGroups?: { gcx: number; gcy: number; maxDistWorld: number; cells: unknown[] }[];
  vignetteColor?: string;
  [key: string]: unknown;
}

/** Geometry data returned by buildFluidGeometry / getFluidPathCache. */
export interface FluidGeometryData {
  pit?: FluidCellData | null;
  water?: FluidCellData | null;
  lava?: FluidCellData | null;
  [key: string]: unknown;
}

/** Texture options passed to render functions. */
export interface TextureOptions {
  catalog: TextureCatalog;
  blendWidth: number;
  texturesVersion?: number;
}

/** Render cache size descriptor. */
export interface RenderCacheSize {
  w: number;
  h: number;
  scale: number;
  gridSize?: number;
  theme?: Theme;
  texturesVersion?: number;
}

// ── Editor State ───────────────────────────────────────────────────────────

/** Stair placement in-progress state. */
export interface StairPlacement {
  p1: [number, number] | null;
  p2: [number, number] | null;
}

/** Cell clipboard for copy/paste. */
export interface CellClipboard {
  cells: { dRow: number; dCol: number; data: Cell | null }[];
  anchorRow: number;
  anchorCol: number;
}

/** Prop clipboard for copy/paste. */
export interface PropClipboardData {
  anchorRow: number;
  anchorCol: number;
  props: { dRow: number; dCol: number; prop: OverlayProp; lights?: OverlayPropLight[] }[];
}

/** Light animation config. */
export interface LightAnimationConfig {
  type: string;
  speed: number;
  amplitude: number;
  radiusVariation?: number;
}

/** The full editor state object. */
export interface EditorState {
  // Dungeon data (serialized, undo-tracked)
  dungeon: Dungeon;
  currentLevel: number;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  dirty: boolean;
  unsavedChanges: boolean;

  // Viewport
  zoom: number;
  panX: number;
  panY: number;

  // Tool config
  activeTool: string;
  roomMode: string;
  paintMode: string;
  fillMode: string;
  waterDepth: number;
  lavaDepth: number;
  doorType: string;
  trimCorner: string;
  trimRound: boolean;
  trimInverted: boolean;
  trimOpen: boolean;
  labelMode: string;
  stairsMode: string;
  stairPlacement: StairPlacement;
  bridgeType: string;
  selectedBridgeId: number | null;
  linkSource: number | { row: number; col: number; level: number } | null;
  selectMode: string;

  // Prop tool
  selectedProp: string | null;
  propRotation: number;
  propFlipped: boolean;
  propScale: number;
  propRandomRotation: boolean;
  propRandomScale: boolean;
  selectedPropAnchors: { row: number; col: number; propId?: number | string }[];
  selectedPropIds: number[];

  // Paint tool
  activeTexture: string | null;
  textureOpacity: number;
  paintSecondary: boolean;

  // Light tool
  selectedLightId: number | null;
  lightClipboard: Light | null;
  lightPasteMode: boolean;
  lightPreset: string | null;
  lightType: string;
  lightRadius: number;
  lightColor: string;
  lightIntensity: number;
  lightFalloff: string;
  lightAngle: number;
  lightSpread: number;
  lightDimRadius: number;
  lightAnimation: LightAnimationConfig | null;
  lightCoverageMode: boolean;
  lightZ: number;
  animClock: number;

  // Clipboard
  clipboard: CellClipboard | null;
  pasteMode: boolean;
  propClipboard: PropClipboardData | null;
  propPasteMode: boolean;

  // Hover/selection
  hoveredCell: { row: number; col: number } | null;
  hoveredEdge: { row: number; col: number; direction: string } | null;
  hoveredCorner: { row: number; col: number } | null;
  selectedCells: { row: number; col: number }[];

  // Runtime catalogs
  propCatalog: PropCatalog | null;
  textureCatalog: TextureCatalog | null;
  lightCatalog: LightCatalog | null;
  texturesVersion: number;

  // File I/O
  fileHandle: FileSystemFileHandle | null;
  fileName: string | null;

  // Session
  session: { active: boolean; playerCount: number };
  sessionToolsActive: boolean;
  statusInstruction: string | null;

  // Debug
  debugShowHitboxes: boolean;

  // App metadata
  appVersion?: string;

  // Wall tool
  wallType: string;

  // Infrastructure
  listeners: {
    fn: (s: EditorState) => void;
    label: string;
    topics?: ('cells' | 'metadata' | 'lighting' | 'props' | 'viewport' | 'ui')[];
  }[];
  _lastPushUndoMs: { stringify: number; total: number } | null;

  /** Allow dynamic string-key access for toolbar/keybindings state binding. */
  [key: string]: unknown;
}

/** A cell-level diff for compact undo storage. */
export interface UndoCellPatch {
  row: number;
  col: number;
  before: Cell | null;
  after: Cell | null;
}

/** Metadata diff for compact undo storage (JSON-serialized sub-objects). */
export interface UndoMetaPatch {
  before: string;
  after: string;
}

/** An entry in the undo stack. Either a full JSON snapshot or a compact patch. */
export interface UndoEntry {
  json?: string;
  patch?: { cells: UndoCellPatch[]; meta: UndoMetaPatch | null };
  label: string;
  timestamp: number;
}

/** Editor API result (success case). */
export interface ApiSuccess {
  success: true;
  [key: string]: unknown;
}

/** Editor API result (error case). */
export interface ApiError {
  success: false;
  error: string;
}

/** Editor API result (union). */
export type ApiResult = ApiSuccess | ApiError;

// ── Editor API Option Interfaces ──────────────────────────────────────────

/** Options for placeProp API method. */
export interface PlacePropOptions {
  scale?: number;
  allowOverlap?: boolean;
  zIndex?: number | string;
  x?: number;
  y?: number;
}

/** Options for fillWallWithProps API method. */
export interface FillWallOptions {
  facing?: number;
  gap?: number;
  inset?: number;
  skipDoors?: boolean;
}

/** Options for lineProps API method. */
export interface LinePropsOptions {
  facing?: number;
  gap?: number;
}

/** Options for scatterProps API method. */
export interface ScatterPropsOptions {
  facing?: number;
  avoidWalls?: number | boolean;
  avoidDoors?: boolean;
}

/** Options for placeLight API method (merged with LightPreset fields when preset is used). */
export interface PlaceLightConfig {
  preset?: string;
  type?: string;
  radius?: number;
  color?: string;
  intensity?: number;
  falloff?: string;
  z?: number | null;
  angle?: number;
  spread?: number;
  dimRadius?: number;
  // Preset fields that get merged in but then deleted
  displayName?: string;
  description?: string;
  category?: string;
  id?: string;
  animation?: LightAnimationConfig | null;
}

/** Options for createTrim API method. */
export interface CreateTrimOptions {
  corner?: string;
  round?: boolean;
  inverted?: boolean;
  open?: boolean;
}

/** Options for partitionRoom API method. */
export interface PartitionRoomOptions {
  doorAt?: number;
}

/** Options for renderPropPreview API method. */
export interface RenderPropPreviewOptions {
  rotation?: number;
  flipped?: boolean;
  scale?: number;
  background?: string | null;
}

/** Options for suggestPropPosition API method. */
export interface SuggestPropPositionOptions {
  preferredFacing?: number;
  preferWall?: string;
}

// ── dd2vtt Export ──────────────────────────────────────────────────────────

/** Universal VTT format (dd2vtt). */
export interface Dd2vttFormat {
  format: number;
  resolution: {
    map_origin: { x: number; y: number };
    map_size: { x: number; y: number };
    pixels_per_grid: number;
  };
  image: string;
  line_of_sight: Array<[{ x: number; y: number }, { x: number; y: number }]>;
  portals: Dd2vttPortal[];
  lights: Dd2vttLight[];
  environment: {
    brt: number;
    exp: number;
  };
}

/** A door portal in dd2vtt format. */
export interface Dd2vttPortal {
  position: { x: number; y: number };
  bounds: [{ x: number; y: number }, { x: number; y: number }];
  rotation: number;
  closed: boolean;
  freestanding: boolean;
}

/** A light in dd2vtt format. */
export interface Dd2vttLight {
  position: { x: number; y: number };
  range: number;
  intensity: number;
  color: string;
  shadows: boolean;
}

// ── Texture Catalog ────────────────────────────────────────────────────────

/** A texture entry from the catalog. */
export interface TextureEntry {
  id: string;
  displayName: string;
  category: string;
  file: string;
  maps?: {
    disp?: string;
    nor?: string;
    arm?: string;
  };
  scale: number;
  credit: string;
}

/** Runtime texture entry stored in TextureCatalog.textures. */
export interface TextureRuntime {
  displayName?: string;
  img?: HTMLImageElement & { complete?: boolean };
  file?: string;
  dispImg?: HTMLImageElement | null;
  dispFile?: string;
  norImg?: HTMLImageElement | null;
  norFile?: string;
  _loadPromise?: Promise<unknown> | null;
  _pattern?: CanvasPattern | null;
  _patternCtx?: CanvasRenderingContext2D | null;
  // GPU-ready bitmap for Canvas2D pattern creation. Populated after diffuse
  // decode; `createPattern(bitmap)` skips the lazy re-decode that Canvas2D
  // does with an HTMLImageElement on first fill, killing the paint-time stall.
  _patternBitmap?: ImageBitmap | null;
  [key: string]: unknown;
}

/** Texture catalog structure. */
export interface TextureCatalog {
  entries: TextureEntry[];
  byId: Record<string, TextureEntry>;
  images: Record<string, HTMLImageElement | unknown>;
  textures: Record<string, TextureRuntime | undefined>;
  byCategory: Record<string, string[]>;
  categoryOrder: string[];
  names: string[];
  getTextureImage?: (id: string) => HTMLImageElement | null;
  [key: string]: unknown;
}
