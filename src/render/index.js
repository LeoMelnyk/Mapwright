// Core rendering
export { renderCells, renderLabels, invalidateGeometryCache, captureBeforeState, smartInvalidate, invalidateBlendLayerCache, renderTimings, bumpTimingFrame, getTimingFrame, getContentVersion, getGeometryVersion, bumpContentVersion, getDirtyRegion, consumeDirtyRegion, accumulateDirtyRect, patchBlendForDirtyRegion, patchFluidForDirtyRegion, traceArcWedge, collectRoundedCorners, getBroadcastDirtyRegion, consumeBroadcastDirtyRegion } from './render.js';
export { invalidateFluidCache } from './fluid.js';
// Decorations & lighting
export { drawBorderOnMap, drawScaleIndicatorOnMap, findCompassRosePositionOnMap, drawCompassRoseScaled } from './decorations.js';
export { renderLightmap, renderCoverageHeatmap, invalidateVisibilityCache, invalidateLightmapCaches, extractFillLights, getLightingVersion } from './lighting.js';
// Bounds
export { toCanvas } from './bounds.js';
// Props & features
export { renderProp, parsePropFile, generateHitbox, invalidatePropsCache, invalidatePropsRenderLayer, getPropsVersion, renderOverlayProps, extractOverlayPropLightSegments, hitTestPropPixel } from './props.js';
export { drawDmLabel } from './features.js';
// Themes
export { THEMES } from './themes.js';
// Compile-to-canvas
export { calculateCanvasSize, renderDungeonToCanvas } from './compile.js';
// Render warnings
export { warn as renderWarn, flush as flushRenderWarnings } from './warnings.js';
// Effects (shading / hatching) — used by player fog overlay
export { drawHatching, drawRockShading, drawOuterShading, drawBufferShading, invalidateEffectsCache } from './effects.js';
// Room cell detection — used by player fog overlay for hatching
export { determineRoomCells } from './floors.js';

// Shared map cache
export { MapCache } from './map-cache.js';

// Aggregate invalidation — call after any structural change to cells (add/duplicate/resize/delete level)
import { invalidateGeometryCache, invalidateBlendLayerCache, bumpContentVersion } from './render.js';
import { invalidateFluidCache } from './fluid.js';
import { invalidateVisibilityCache } from './lighting.js';
import { invalidatePropsCache } from './props.js';
export function invalidateAllCaches() {
  invalidateGeometryCache();
  invalidateFluidCache();
  invalidateBlendLayerCache();
  invalidateVisibilityCache();
  invalidatePropsCache();
  bumpContentVersion();
}
