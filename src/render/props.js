// props.js — barrel re-export (split into parse-props, render-props, hitbox-props)
export { parsePropFile, parseCommand, parseCoord } from './parse-props.js';
export {
  renderProp, renderAllProps, renderOverlayProps, getRenderedPropsLayer,
  invalidatePropsCache, invalidatePropsRenderLayer, getPropsVersion,
} from './render-props.js';
export {
  generateHitbox, hitTestPropPixel,
  extractPropLightSegments, extractOverlayPropLightSegments,
} from './hitbox-props.js';
