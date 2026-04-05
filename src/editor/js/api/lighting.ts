import {
  state, pushUndo, markDirty, notify,
  invalidateLightmap, requestRender,
  getLightCatalog,
} from './_shared.js';

/**
 * Place a light source at world-feet coordinates.
 * @param {number} x - World-feet X position
 * @param {number} y - World-feet Y position
 * @param {Object} [config] - Light configuration (preset, radius, color, intensity, etc.)
 * @returns {{ success: boolean, id: number }}
 */
export function placeLight(x: number, y: number, config: Record<string, any> = {}): { success: true; id: number } {
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

/**
 * Remove a light source by ID.
 * @param {number} id - Light ID
 * @returns {{ success: boolean }}
 */
export function removeLight(id: number): { success: true } {
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

/**
 * Get a deep copy of all placed lights.
 * @returns {{ success: boolean, lights: Array<Object> }}
 */
export function getLights(): { success: true; lights: any[] } {
  const lights = state.dungeon.metadata?.lights || [];
  return { success: true, lights: JSON.parse(JSON.stringify(lights)) };
}

/**
 * Set the global ambient light level.
 * @param {number} level - Ambient light between 0 (dark) and 1 (full bright)
 * @returns {{ success: boolean }}
 */
export function setAmbientLight(level: number): { success: true } {
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

/**
 * Enable or disable the lighting system.
 * @param {boolean} enabled - Whether lighting is enabled
 * @returns {{ success: boolean }}
 */
export function setLightingEnabled(enabled: boolean): { success: true } {
  pushUndo();
  state.dungeon.metadata.lightingEnabled = !!enabled;
  invalidateLightmap(false);
  markDirty();
  notify();
  requestRender();
  return { success: true };
}

/**
 * List all available light presets grouped by category.
 * @returns {{ success: boolean, categories: Array<string>, presets: Object }}
 */
export function listLightPresets(): { success: true; categories: string[]; presets: Record<string, any> } {
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
