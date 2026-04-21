// Core rendering
export {
  renderCells,
  renderLabels,
  invalidateGeometryCache,
  captureBeforeState,
  smartInvalidate,
  invalidateBlendLayerCache,
  renderTimings,
  bumpTimingFrame,
  getTimingFrame,
  getContentVersion,
  getTopContentVersion,
  getGeometryVersion,
  bumpContentVersion,
  getDirtyRegion,
  consumeDirtyRegion,
  accumulateDirtyRect,
  markDirtyFullRebuild,
  patchBlendForDirtyRegion,
  patchFluidForDirtyRegion,
  traceArcWedge,
  collectRoundedCorners,
  getBroadcastDirtyRegion,
  consumeBroadcastDirtyRegion,
} from './render.js';
export {
  invalidateFluidCache,
  invalidateFluidTileCache,
  getFluidCacheParams,
  getFluidDataVersion,
  getFluidVariantTile,
  getFluidVariantClip,
  buildFluidComposite,
  fluidThemeSig,
  patchFluidRegion,
  FLUID_VARIANTS,
  FLUID_BASE_SKIP,
  FLUID_TOP_SKIP,
  type FluidVariant,
} from './fluid.js';
// Decorations & lighting
export {
  drawBorderOnMap,
  drawScaleIndicatorOnMap,
  findCompassRosePositionOnMap,
  drawCompassRoseScaled,
} from './decorations.js';
export {
  renderLightmap,
  renderCoverageHeatmap,
  invalidateVisibilityCache,
  invalidateLightmapCaches,
  extractFillLights,
  getLightingVersion,
  falloffMultiplier,
  clampSpread,
  kelvinToRgb,
  beginGroupTransition,
  hasActiveGroupTransitions,
  clearGroupTransitions,
  listCookieTypes,
} from './lighting.js';
export { WINDOW_Z_BOTTOM, WINDOW_Z_TOP } from './lighting-geometry.js';
// Bounds
export { toCanvas } from './bounds.js';
// Props & features
export {
  renderProp,
  parsePropFile,
  generateHitbox,
  materializePropHitbox,
  invalidatePropsCache,
  invalidatePropsRenderLayer,
  getPropsVersion,
  renderOverlayProps,
  extractOverlayPropLightSegments,
  hitTestPropPixel,
} from './props.js';
export { drawDmLabel } from './features.js';
// Themes
export { THEMES } from './themes.js';
// Theme change diffing — property → cache-bucket routing
export {
  type ThemeBucket,
  THEME_BUCKETS,
  CELLS_LAYER_KEYS,
  diffThemeBuckets,
  cloneTheme,
  cellsLayerThemeSig,
} from './theme-diff.js';
// Bridges
export { BRIDGE_TEXTURE_IDS } from './bridges.js';
// Compile-to-canvas
export { calculateCanvasSize, renderDungeonToCanvas, normalizeTheme } from './compile.js';
// Render warnings
export { warn as renderWarn, flush as flushRenderWarnings } from './warnings.js';
// Effects (shading / hatching) — used by player fog overlay
export {
  drawHatching,
  drawRockShading,
  drawOuterShading,
  drawBufferShading,
  invalidateEffectsCache,
} from './effects.js';
// Room cell detection — used by player fog overlay for hatching
export { determineRoomCells } from './floors.js';

// Shared map cache
export { MapCache } from './map-cache.js';

// Aggregate invalidation — call after any structural change to cells (add/duplicate/resize/delete level)
import { invalidateGeometryCache, invalidateBlendLayerCache, bumpContentVersion } from './render.js';
import { invalidateFluidCache } from './fluid.js';
import { invalidateVisibilityCache } from './lighting.js';
import { invalidatePropsCache } from './props.js';
import { log } from '../util/index.js';
export function invalidateAllCaches(): void {
  log.devTrace(`invalidateAllCaches() — full cache teardown`);
  invalidateGeometryCache();
  invalidateFluidCache();
  invalidateBlendLayerCache();
  invalidateVisibilityCache();
  invalidatePropsCache();
  bumpContentVersion();
}
