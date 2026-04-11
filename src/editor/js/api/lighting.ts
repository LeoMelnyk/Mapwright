import type { FalloffType, LightPreset, Light, PlaceLightConfig } from '../../../types.js';
import {
  state, mutate,
  requestRender,
  getLightCatalog,
  ApiValidationError,
} from './_shared.js';

/**
 * Place a light source at world-feet coordinates.
 * @param {number} x - World-feet X position
 * @param {number} y - World-feet Y position
 * @param {Object} [config] - Light configuration (preset, radius, color, intensity, etc.)
 * @returns {{ success: boolean, id: number }}
 */
export function placeLight(x: number, y: number, config: PlaceLightConfig = {}): { success: true; id: number } {
  if (config.preset) {
    const catalog = getLightCatalog();
    const p = catalog?.lights[config.preset];
    if (!p) throw new ApiValidationError('UNKNOWN_LIGHT_PRESET', `Unknown light preset: ${config.preset}. Call listLightPresets() for valid names.`, { preset: config.preset });
    config = { ...p, ...config };
    delete config.preset;
    delete config.displayName;
    delete config.description;
    delete config.category;
    delete config.id;
  }

  const meta = state.dungeon.metadata;
  if (!meta.nextLightId) meta.nextLightId = 1;

  const type = config.type ?? 'point';
  if (type !== 'point' && type !== 'directional') {
    throw new Error(`Invalid light type: ${type}. Use 'point' or 'directional'.`);
  }

  let lightId: number;
  mutate('Place light', [], () => {
    const light: Light = {
      id: meta.nextLightId++,
      x, y, type,
      radius: config.radius ?? 30,
      color: config.color ?? '#ff9944',
      intensity: config.intensity ?? 1.0,
      falloff: (config.falloff ?? 'smooth') as FalloffType,
    };

    // Z-height (height above floor in feet) — from preset or explicit config
    if (config.z != null) light.z = config.z;

    if (type === 'directional') {
      light.angle = config.angle ?? 0;
      light.spread = config.spread ?? 45;
    }

    meta.lights.push(light);
    if (!meta.lightingEnabled) meta.lightingEnabled = true;
    lightId = light.id;
  }, { metaOnly: true, invalidate: ['lighting'] });

  requestRender();
  return { success: true, id: lightId! };
}

/**
 * Remove a light source by ID.
 * @param {number} id - Light ID
 * @returns {{ success: boolean }}
 */
export function removeLight(id: number): { success: true } {
  const meta = state.dungeon.metadata;
  if (meta.lights.length === 0) return { success: true };
  const idx = meta.lights.findIndex(l => l.id === id);
  if (idx === -1) throw new ApiValidationError('LIGHT_NOT_FOUND', `Light with id ${id} not found`, { id });

  mutate('Remove light', [], () => {
    meta.lights.splice(idx, 1);
  }, { metaOnly: true, invalidate: ['lighting'] });
  requestRender();
  return { success: true };
}

/**
 * Get a deep copy of all placed lights.
 * @returns {{ success: boolean, lights: Array<Object> }}
 */
export function getLights(): { success: true; lights: Light[] } {
  const lights = state.dungeon.metadata.lights;
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
  mutate('Set ambient light', [], () => {
    state.dungeon.metadata.ambientLight = level;
  }, { metaOnly: true, invalidate: ['lighting'] });
  requestRender();
  return { success: true };
}

/**
 * Enable or disable the lighting system.
 * @param {boolean} enabled - Whether lighting is enabled
 * @returns {{ success: boolean }}
 */
export function setLightingEnabled(enabled: unknown): { success: true } {
  mutate('Set lighting enabled', [], () => {
    state.dungeon.metadata.lightingEnabled = !!enabled;
  }, { metaOnly: true, invalidate: ['lighting'] });
  requestRender();
  return { success: true };
}

/**
 * List all available light presets grouped by category.
 * @returns {{ success: boolean, categories: Array<string>, presets: Object }}
 */
export function listLightPresets(): { success: true; categories: string[]; presets: Record<string, LightPreset> } {
  const catalog = getLightCatalog();
  if (!catalog) return { success: true, categories: [], presets: {} };
  return {
    success: true,
    categories: catalog.categoryOrder,
    presets: Object.fromEntries(
      Object.entries(catalog.lights).filter((e): e is [string, LightPreset] => e[1] != null).map(([k, v]) => [k, {
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
