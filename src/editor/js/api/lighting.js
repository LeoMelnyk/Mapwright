import {
  state, pushUndo, markDirty, notify,
  invalidateLightmap, requestRender,
  getLightCatalog,
} from './_shared.js';

export function placeLight(x, y, config = {}) {
  if (config.preset) {
    const catalog = getLightCatalog();
    const p = catalog?.lights[config.preset];
    if (!p) throw new Error(`Unknown light preset: ${config.preset}. Call listLightPresets() for valid names.`);
    config = { ...p, ...config };
    delete config.preset;
    delete config.displayName;
    delete config.description;
    delete config.category;
    delete config.id;
  }

  const meta = state.dungeon.metadata;
  if (!meta.lights) meta.lights = [];
  if (!meta.nextLightId) meta.nextLightId = 1;

  const type = config.type || 'point';
  if (type !== 'point' && type !== 'directional') {
    throw new Error(`Invalid light type: ${type}. Use 'point' or 'directional'.`);
  }

  pushUndo();

  const light = {
    id: meta.nextLightId++,
    x, y, type,
    radius: config.radius ?? 30,
    color: config.color || '#ff9944',
    intensity: config.intensity ?? 1.0,
    falloff: config.falloff || 'smooth',
  };

  // Z-height (height above floor in feet) — from preset or explicit config
  if (config.z != null) light.z = config.z;

  if (type === 'directional') {
    light.angle = config.angle ?? 0;
    light.spread = config.spread ?? 45;
  }

  meta.lights.push(light);
  if (!meta.lightingEnabled) meta.lightingEnabled = true;
  invalidateLightmap(false);
  markDirty();
  notify();
  requestRender();
  return { success: true, id: light.id };
}

export function removeLight(id) {
  const meta = state.dungeon.metadata;
  if (!meta.lights) return { success: true };
  const idx = meta.lights.findIndex(l => l.id === id);
  if (idx === -1) throw new Error(`Light with id ${id} not found`);

  pushUndo();
  meta.lights.splice(idx, 1);
  invalidateLightmap(false);
  markDirty();
  notify();
  requestRender();
  return { success: true };
}

export function getLights() {
  const lights = state.dungeon.metadata?.lights || [];
  return { success: true, lights: JSON.parse(JSON.stringify(lights)) };
}

export function setAmbientLight(level) {
  if (typeof level !== 'number' || level < 0 || level > 1) {
    throw new Error(`Ambient light must be a number between 0 and 1, got: ${level}`);
  }
  pushUndo();
  state.dungeon.metadata.ambientLight = level;
  invalidateLightmap(false);
  markDirty();
  notify();
  requestRender();
  return { success: true };
}

export function setLightingEnabled(enabled) {
  pushUndo();
  state.dungeon.metadata.lightingEnabled = !!enabled;
  invalidateLightmap(false);
  markDirty();
  notify();
  requestRender();
  return { success: true };
}

export function listLightPresets() {
  const catalog = getLightCatalog();
  if (!catalog) return { success: true, categories: [], presets: {} };
  return {
    success: true,
    categories: catalog.categoryOrder,
    presets: Object.fromEntries(
      Object.entries(catalog.lights).map(([k, v]) => [k, {
        displayName: v.displayName,
        category: v.category,
        type: v.type,
        color: v.color,
        radius: v.radius,
        intensity: v.intensity,
        falloff: v.falloff,
      }])
    ),
  };
}
