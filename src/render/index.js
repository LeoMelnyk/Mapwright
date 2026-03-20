// Core rendering
export { renderCells, renderLabels, invalidateGeometryCache, captureBeforeState, smartInvalidate, invalidateBlendLayerCache } from './render.js';
export { invalidateFluidCache } from './fluid.js';
// Decorations & lighting
export { drawBorderOnMap, drawScaleIndicatorOnMap, findCompassRosePositionOnMap, drawCompassRoseScaled } from './decorations.js';
export { renderLightmap, renderCoverageHeatmap, invalidateVisibilityCache, extractFillLights } from './lighting.js';
// Bounds
export { toCanvas } from './bounds.js';
// Props & features
export { renderProp, parsePropFile, invalidatePropsCache, renderOverlayProps, extractOverlayPropLightSegments, hitTestPropPixel } from './props.js';
export { drawDmLabel } from './features.js';
// Themes
export { THEMES } from './themes.js';
// Compile-to-canvas
export { calculateCanvasSize, renderDungeonToCanvas } from './compile.js';
// Render warnings
export { warn as renderWarn, flush as flushRenderWarnings } from './warnings.js';

// Aggregate invalidation — call after any structural change to cells (add/duplicate/resize/delete level)
import { invalidateGeometryCache, invalidateBlendLayerCache } from './render.js';
import { invalidateFluidCache } from './fluid.js';
import { invalidateVisibilityCache } from './lighting.js';
import { invalidatePropsCache } from './props.js';
export function invalidateAllCaches() {
  invalidateGeometryCache();
  invalidateFluidCache();
  invalidateBlendLayerCache();
  invalidateVisibilityCache();
  invalidatePropsCache();
}
