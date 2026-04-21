/**
 * Core type definitions for the Mapwright dungeon editor.
 *
 * These types describe the dungeon data model, rendering pipeline inputs,
 * and editor state. They are the source of truth for the TypeScript migration.
 */

// ── Cell & Edge Types ──────────────────────────────────────────────────────

/** Wall/door edge values stored on each cell face. */
export type EdgeValue = 'w' | 'd' | 's' | 'iw' | 'id' | 'win' | null | undefined;

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
  /**
   * When true, this light SUBTRACTS illumination instead of adding it.
   * Used for the D&D Darkness spell, cursed zones, and shadow auras.
   * The gradient shape and radius behave identically to a normal light,
   * but the renderer composites with destination-out so the area ends up
   * darker than the ambient level. Intensity controls how fully opaque
   * the darkness gets at the center.
   */
  darkness?: boolean;
  /**
   * Per-light soft-shadow radius (world-feet). When > 0, the visibility
   * mask is rasterized from several jittered sample points on a disc of
   * this radius around the light center and averaged together, yielding
   * penumbra wedges at wall corners. 0 (the default) keeps the classic
   * single-ray hard shadow. Typical values: 0.5–2 ft.
   */
  softShadowRadius?: number;
  /** Optional procedural cookie (gobo) — see {@link LightCookie}. */
  cookie?: LightCookie | null;
  _propShadows?: {
    shadowPoly: number[][];
    nearCenter: number[];
    farCenter: number[];
    opacity: number;
    hard: boolean;
  }[];
  /**
   * Per-light projected gobo patterns. Populated per-frame alongside
   * `_propShadows` — a pattern-multiplied floor footprint cast from each
   * prop-declared gobo that this light clears. See
   * {@link computeGoboProjectionPolygon}.
   */
  _gobos?: {
    /** Quadrilateral footprint in world-feet: [nearP1, nearP2, farP2, farP1]. */
    quad: number[][];
    /** Gobo segment z-range (feet), copied from the source zone. Used by the
     *  procedural line-based renderer to project each mullion/bar individually. */
    zBottom: number;
    zTop: number;
    /** Gobo id (for debugging/inspection). */
    goboId: string;
    /** Resolved pattern key — see {@link GoboPattern}. */
    pattern: GoboPattern;
    /** Effective density (pattern divisions / band count). */
    density: number;
    /** Slat orientation (only meaningful for the `slats` pattern). */
    orientation: 'vertical' | 'horizontal';
    /** Projection mode — see {@link GoboMode}. */
    mode: GoboMode;
    /** Strength in 0..1 multiplied onto the pattern (1 = full mask). */
    strength: number;
    /** Optional stained-glass/mosaic tint — hex color multiplied into the
     *  aperture re-admit gradient so the sunpool picks up the window's hue. */
    tintColor?: string;
    /** Optional palette of hex colors for patterns that colorize per pane
     *  (`mosaic`). Cycled through the cells of the pattern. */
    colors?: string[];
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

// ── Gobos ──────────────────────────────────────────────────────────────────

/** Procedural gobo pattern built into the renderer. */
export type GoboPattern =
  | 'plain'
  | 'grid'
  | 'slats'
  | 'slot'
  | 'mosaic'
  | 'sigil'
  | 'caustics'
  | 'dapple'
  | 'stained-glass'
  | 'diamond'
  | 'cross';

/** A parsed .gobo asset. Procedural only; image-backed gobos are TODO. */
export interface GoboDefinition {
  id: string;
  name: string;
  description: string;
  pattern: GoboPattern;
  /** Divisions / bands count for procedural patterns. Meaning depends on pattern. */
  density: number;
  /** For `slats` pattern: orientation of the slats. Default vertical. */
  orientation?: 'vertical' | 'horizontal';
  /**
   * Optional palette of hex colors for patterns that support colored regions
   * (e.g. `mosaic` — stained-glass / church-window panes). Cycled per pane so
   * a palette of 4 colors across a density=3 (9-pane) grid gives 9 panes with
   * colors [0,1,2,3,0,1,2,3,0]. Ignored by patterns that don't use it.
   */
  colors?: string[];
}

/** Gobo catalog loaded from manifest/bundle. */
export interface GoboCatalog {
  names: string[];
  gobos: Record<string, GoboDefinition | undefined>;
}

/**
 * Projection mode for a gobo.
 *
 * `occluder` — default. Gobo is a silhouette in open air; light reaches the
 * whole scene normally, the gobo just carves dark bars out of the lit region.
 * Use for prison bars, lattices, anything where the light source and the
 * shadow-receiving surface are in the same open space.
 *
 * `aperture` — gobo is a hole in an otherwise-opaque surface. The light is
 * clipped to the projection quad on the floor, producing a defined "sunpool"
 * with the mullion bars cast inside it. Outside the pool, this light
 * contributes nothing. Use for windows in walls, grates above shafts, any
 * scenario where the gobo acts like a cookie-cutter over a blocked light.
 */
export type GoboMode = 'occluder' | 'aperture';

/**
 * A gobo footprint declared on a prop. The pattern lives on the prop (upright
 * patterned occluder — window mullions, prison bars, lattice). Any nearby
 * light that clears the gobo's `zBottom` projects the pattern onto the floor
 * on the far side, mirroring the z-height prop shadow system.
 */
export interface PropGobo {
  /** Segment endpoints in prop-local cell coordinates (0..cols, 0..rows). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Gobo base height above the floor, in feet. */
  zBottom: number;
  /** Gobo top height in feet. */
  zTop: number;
  /** Gobo catalog id. */
  gobo: string;
  /** Projection mode — see {@link GoboMode}. Defaults to `occluder`. */
  mode?: GoboMode;
  /** Optional density override (otherwise taken from the .gobo definition). */
  density?: number;
  /** Optional strength in 0..1 — 1 full pattern, 0 no effect. Default 1. */
  strength?: number;
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

// ── Windows ────────────────────────────────────────────────────────────────

/**
 * A window placed on a cell edge. Stored canonically on the `north` or `west`
 * edge of the owning cell (for cardinals), or `nw-se` / `ne-sw` on the
 * owning cell (for diagonals). Every physical edge maps to exactly one
 * entry, regardless of which side the user clicked when placing.
 *
 * The edge itself is marked with `cell[direction] = 'win'` (reciprocally on
 * the neighbor for cardinals — diagonals have no reciprocal) so the lighting
 * system treats it as a wall; light is blocked on the floor. The gobo
 * referenced here is projected through the window's aperture (4–6 ft above
 * floor by default), producing a patterned sunpool on the far side.
 */
export interface Window {
  row: number;
  col: number;
  direction: 'north' | 'west' | 'nw-se' | 'ne-sw';
  /** Gobo catalog id (e.g. "window-mullions", "arrow-slit"). */
  goboId: string;
  /**
   * Optional hex color (e.g. "#ff6633") that tints light passing through the
   * window — stained glass / mosaic effect. Absent or null means untinted.
   */
  tintColor?: string;
  /** Window sill height in feet. Defaults to WINDOW_Z_BOTTOM (4 ft) when absent. */
  floorHeight?: number;
  /** Window head (top) height in feet. Defaults to WINDOW_Z_TOP (6 ft) when absent. */
  ceilingHeight?: number;
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
  /**
   * Bloom intensity in [0, 1]. When > 0, the renderer applies a screen-
   * blended Gaussian-blurred copy of the lightmap on top of the composited
   * scene — bright torches and magical auras bleed into their surroundings.
   * 0 (default) disables the pass entirely.
   */
  bloomIntensity?: number;
  stairs: Stairs[];
  bridges: Bridge[];
  /**
   * Windows placed on cell edges. Each entry is keyed by the canonical
   * (row, col, direction) — direction is always `'north'` or `'west'`.
   * See {@link Window}.
   */
  windows?: Window[];
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
  /**
   * Optional ambient-light animation. Currently only `strike` is meaningful
   * (lightning storm flashes). Lives on metadata so the whole map shares one
   * synchronized rhythm.
   */
  ambientAnimation?: LightAnimationConfig | null;
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
  /** Upright patterned occluders — see {@link PropGobo}. */
  gobos?: PropGobo[] | null;
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
  /** Z-range for manual hitbox commands (used by light shadow projection).
   *  `zTop: null` means "unbounded" (no upper limit). */
  zBottom?: number;
  zTop?: number | null;
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
  /**
   * Optional procedural cookie/gobo declaration. Lets a prop (e.g. a stained-
   * glass window) project a patterned mask through any light it auto-emits.
   * The placed light inherits this verbatim unless explicit `cookie` set on
   * the lightEntry overrides it. See {@link LightCookie}.
   */
  cookie?: LightCookie | null;
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
  /**
   * Animation kind:
   *   - `flicker` — chaotic flame (sine sum or 1D noise via `pattern`)
   *   - `pulse`   — smooth sin-wave breathing
   *   - `strobe`  — binary on/off
   *   - `strike`  — long-quiet → brief bright flash (lightning)
   *   - `sweep`   — rotate `angle` over time (directional lights only)
   */
  type: string;
  /** Time-scale multiplier. Defaults to 1.0 if omitted. */
  speed?: number;
  /** Intensity swing magnitude. Defaults to 0.3 if omitted. */
  amplitude?: number;
  /** Oscillate light radius. Now honored by flicker, pulse, and strobe. */
  radiusVariation?: number;
  /**
   * Per-light phase offset (seconds). When unset, a deterministic offset is
   * derived from the light's id so co-located identical-speed lights desync
   * naturally. Set to 0 explicitly to force lock-step sync (alarm bells,
   * ritual circles).
   */
  phase?: number;
  /**
   * Color modulation as intensity dips:
   *   - `auto` — physically motivated red-shift toward dimmer warm color
   *   - `secondary` — blend `color` ↔ `colorSecondary` driven by waveform
   *   - `none` (default) — leave color alone
   */
  colorMode?: 'none' | 'auto' | 'secondary';
  /** Strength of color modulation, 0–1. */
  colorVariation?: number;
  /** Second color pole for `colorMode: 'secondary'`. */
  colorSecondary?: string;
  /**
   * For `flicker`:
   *   - `sine` (default) — three-incommensurate-sine sum
   *   - `noise` — 1D simplex-style noise, gusty/wind feel
   */
  pattern?: 'sine' | 'noise';
  /**
   * Optional guttering envelope applied on top of any flicker pattern.
   * 0 = no guttering, 1 = strong dropouts (light occasionally dies near zero).
   */
  guttering?: number;
  /** ── strike (lightning) only ── */
  /** Average strikes per second. Defaults to 0.2 (one every 5s). */
  frequency?: number;
  /** Fraction of each window during which the flash is visible (0–1). */
  duration?: number;
  /** Probability of any given window producing a strike (0–1). */
  probability?: number;
  /** Floor intensity multiplier between strikes. Defaults to 0.05. */
  baseline?: number;
  /** ── sweep (lighthouse) only ── */
  /** Degrees per second. Positive = clockwise. */
  angularSpeed?: number;
  /** When set, sweep oscillates within ±arcRange/2 instead of full 360°. */
  arcRange?: number;
  /** Center of sweep arc in degrees (only meaningful with arcRange). */
  arcCenter?: number;
}

/**
 * Procedural cookie (gobo) — a grayscale mask multiplied into a light's
 * gradient. No external assets; cookies are drawn procedurally on first use
 * and cached. Animatable via scrollX/scrollY/rotationSpeed.
 */
export interface LightCookie {
  /** Cookie pattern id. */
  type: 'slats' | 'dapple' | 'caustics' | 'sigil' | 'grid' | 'stained-glass';
  /**
   * Hard cap on cookie projection size, in feet. Outside this radius the
   * cookie has no effect — the light continues as plain gradient. Models the
   * physical reality that a window/grate only projects its pattern onto the
   * floor area immediately downstream of the prop, while the rest of the
   * light radius is diffuse ambient glow. When unset, the cookie spans the
   * full light bounding box (legacy behavior — useful for cookies placed
   * directly on a light, not via a prop).
   */
  focusRadius?: number;
  /** Mask scale multiplier — pattern density within the focus area. Default 1. */
  scale?: number;
  /** Static rotation in degrees. Default 0. */
  rotation?: number;
  /** Static scroll in mask space (0–1 wraps). */
  scrollX?: number;
  scrollY?: number;
  /** Animate rotation (degrees per second). */
  rotationSpeed?: number;
  /** Animate scroll (units per second). */
  scrollSpeedX?: number;
  scrollSpeedY?: number;
  /** Strength of the cookie effect, 0 = no cookie, 1 = full mask. Default 1. */
  strength?: number;
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

  // Window tool
  windowGobo: string;

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
  /** If true, the light subtracts illumination (D&D Darkness spell). */
  darkness?: boolean;
  // Preset fields that get merged in but then deleted
  displayName?: string;
  description?: string;
  category?: string;
  id?: string;
  animation?: LightAnimationConfig | null;
  cookie?: LightCookie | null;
  group?: string;
  name?: string;
  range?: number;
  softShadowRadius?: number;
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
