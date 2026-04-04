// render.js — barrel re-export (split into render-state, render-cache, render-phases, render-cells)
export { renderTimings, bumpTimingFrame, getTimingFrame, getContentVersion, getGeometryVersion, bumpContentVersion, getDirtyRegion, consumeDirtyRegion, accumulateDirtyRect, getBroadcastDirtyRegion, consumeBroadcastDirtyRegion } from './render-state.js';
export { invalidateGeometryCache, captureBeforeState, smartInvalidate, invalidateBlendLayerCache, invalidateFluidCache, patchBlendForDirtyRegion, patchFluidForDirtyRegion, collectRoundedCorners, traceArcWedge } from './render-cache.js';
export { renderLabels } from './render-phases.js';
export { renderCells } from './render-cells.js';
