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
  texture?: CellTexture;
  textureOpacity?: number;
  textureSecondary?: CellTexture;
  textureSecondaryOpacity?: number;
  textureNE?: CellTexture;
  textureNEOpacity?: number;
  textureSW?: CellTexture;
  textureSWOpacity?: number;
  textureNW?: CellTexture;
  textureNWOpacity?: number;
  textureSE?: CellTexture;
  textureSEOpacity?: number;
  trimmed?: boolean;
  trimWall?: CardinalDirection;
  trimCorner?: string;
  trimRound?: boolean;
  trimInverted?: boolean;
  trimOpen?: boolean;
  trimPassable?: boolean;
  trimClip?: number[][];
  trimCrossing?: boolean;
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

// ── Lights ─────────────────────────────────────────────────────────────────

/** Light falloff curve types. */
export type FalloffType = 'smooth' | 'linear' | 'sharp' | 'step';

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
  animation?: string;
  name?: string;
  range?: number;
  dimRadius?: number;
  presetId?: string;
  propRef?: { row: number; col: number };
}

/** A light preset from the catalog. */
export interface LightPreset {
  displayName: string;
  category: string;
  type: 'point' | 'directional';
  color: string;
  radius: number;
  intensity: number;
  falloff: FalloffType;
  dimRadius?: number;
  description?: string;
  [key: string]: unknown;
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
}

/** Dungeon metadata (map-level settings). */
export interface Metadata {
  dungeonName: string;
  gridSize: number;
  resolution: number;
  theme: string;
  labelStyle: LabelStyle;
  features: MapFeatures;
  levels: Level[];
  lightingEnabled: boolean;
  ambientLight: number;
  lights: Light[];
  stairs: Stairs[];
  bridges: Bridge[];
  nextLightId: number;
  nextBridgeId: number;
  nextStairId: number;
  backgroundImage?: BackgroundImage;
  savedThemeData?: { theme: Record<string, unknown> };
  [key: string]: unknown;
}

/** The full dungeon data structure. */
export interface Dungeon {
  metadata: Metadata;
  cells: CellGrid;
}

// ── Theme ──────────────────────────────────────────────────────────────────

/** Grid overlay style. */
export type GridStyle = 'lines' | 'dotted' | 'corner-crosses' | 'corner-dots';

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
  door: string;
  secretDoor: string;
  label: string;
  labelBg: string;
  grid?: ThemeGrid;
  hatchColor?: string;
  hatchOpacity?: number;
  bufferShadingColor?: string;
  bufferShadingOpacity?: number;
  textureBlendWidth?: number;
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
  hitboxZones?: Record<string, number[][]>;
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
  [key: string]: unknown;
}

/** A light bundled with a prop definition. */
export interface PropLight {
  preset: string;
  x: number;
  y: number;
}

/** Prop catalog structure. */
export interface PropCatalog {
  categories: string[];
  props: Record<string, PropDefinition>;
}

// ── Overlay Props ──────────────────────────────────────────────────────────

/** An overlay prop (free-positioned, not grid-snapped). */
export interface OverlayProp {
  id: number;
  type: string;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  flipped: boolean;
  zIndex: number;
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** Canvas transform for world-feet → canvas-pixel conversion. */
export interface RenderTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
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

// ── Editor State ───────────────────────────────────────────────────────────

/** An entry in the undo stack. */
export interface UndoEntry {
  json: string;
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

/** Texture catalog structure. */
export interface TextureCatalog {
  entries: TextureEntry[];
  byId: Record<string, TextureEntry>;
  images: Record<string, HTMLImageElement | unknown>;
}
