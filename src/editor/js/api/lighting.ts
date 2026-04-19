import type { FalloffType, LightPreset, Light, PlaceLightConfig } from '../../../types.js';
import { clampSpread } from '../../../render/index.js';
import { state, mutate, requestRender, getLightCatalog, ApiValidationError } from './_shared.js';

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
    if (!p)
      throw new ApiValidationError(
        'UNKNOWN_LIGHT_PRESET',
        `Unknown light preset: ${config.preset}. Call listLightPresets() for valid names.`,
        { preset: config.preset },
      );
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
    throw new ApiValidationError('INVALID_LIGHT_TYPE', `Invalid light type: ${type}. Use 'point' or 'directional'.`, {
      type,
      validTypes: ['point', 'directional'],
    });
  }

  let lightId: number;
  mutate(
    'Place light',
    [],
    () => {
      const light: Light = {
        id: meta.nextLightId++,
        x,
        y,
        type,
        radius: config.radius ?? 30,
        color: config.color ?? '#ff9944',
        intensity: config.intensity ?? 1.0,
        falloff: (config.falloff ?? 'smooth') as FalloffType,
      };

      // Z-height (height above floor in feet) — from preset or explicit config
      if (config.z != null) light.z = config.z;

      if (type === 'directional') {
        light.angle = config.angle ?? 0;
        light.spread = clampSpread(config.spread);
      }

      meta.lights.push(light);
      if (!meta.lightingEnabled) meta.lightingEnabled = true;
      lightId = light.id;
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );

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
  const idx = meta.lights.findIndex((l) => l.id === id);
  if (idx === -1) throw new ApiValidationError('LIGHT_NOT_FOUND', `Light with id ${id} not found`, { id });

  mutate(
    'Remove light',
    [],
    () => {
      meta.lights.splice(idx, 1);
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );
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
    throw new ApiValidationError(
      'INVALID_AMBIENT_LEVEL',
      `Ambient light must be a number between 0 and 1, got: ${level}`,
      { received: level, type: typeof level, range: [0, 1] },
    );
  }
  mutate(
    'Set ambient light',
    [],
    () => {
      state.dungeon.metadata.ambientLight = level;
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );
  requestRender();
  return { success: true };
}

/**
 * Enable or disable the lighting system.
 * @param {boolean} enabled - Whether lighting is enabled
 * @returns {{ success: boolean }}
 */
export function setLightingEnabled(enabled: unknown): { success: true } {
  mutate(
    'Set lighting enabled',
    [],
    () => {
      state.dungeon.metadata.lightingEnabled = !!enabled;
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );
  requestRender();
  return { success: true };
}

// ─── Light groups ──────────────────────────────────────────────────────────

/**
 * Assign a light to a group (or clear its group with `''` / `null`). Lights
 * in the same group can be toggled together via setLightGroupEnabled.
 */
export function setLightGroup(id: number, group: string | null): { success: true } {
  const meta = state.dungeon.metadata;
  const light = meta.lights.find((l) => l.id === id);
  if (!light) throw new ApiValidationError('LIGHT_NOT_FOUND', `Light with id ${id} not found`, { id });
  mutate(
    'Set light group',
    [],
    () => {
      if (group && group.length > 0) light.group = group;
      else delete light.group;
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );
  requestRender();
  return { success: true };
}

/**
 * Enable or disable every light in `group`. When disabled, the renderer
 * filters these lights out entirely (no visibility compute, no composite),
 * so toggling is cheap enough for real-time DM use.
 */
export function setLightGroupEnabled(group: string, enabled: boolean): { success: true } {
  if (!group || typeof group !== 'string') {
    throw new ApiValidationError('INVALID_LIGHT_GROUP', `Group name must be a non-empty string`, { group });
  }
  const meta = state.dungeon.metadata;
  mutate(
    'Toggle light group',
    [],
    () => {
      const disabled = new Set(meta.disabledLightGroups ?? []);
      if (enabled) disabled.delete(group);
      else disabled.add(group);
      meta.disabledLightGroups = disabled.size > 0 ? [...disabled] : undefined;
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );
  requestRender();
  return { success: true };
}

/**
 * Summarize the groups present on the map: group name → {lightCount, enabled}.
 * Un-grouped lights appear under the reserved "" key and are always enabled.
 */
export function listLightGroups(): {
  success: true;
  groups: { name: string; lightCount: number; enabled: boolean }[];
} {
  const meta = state.dungeon.metadata;
  const disabled = new Set(meta.disabledLightGroups ?? []);
  const counts = new Map<string, number>();
  for (const l of meta.lights) {
    const g = l.group ?? '';
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const groups = [...counts.entries()].map(([name, lightCount]) => ({
    name,
    lightCount,
    enabled: name === '' || !disabled.has(name),
  }));
  // Sort: ungrouped first, then alphabetical.
  groups.sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : a.name.localeCompare(b.name)));
  return { success: true, groups };
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
      Object.entries(catalog.lights)
        .filter((e): e is [string, LightPreset] => e[1] != null)
        .map(([k, v]) => [
          k,
          {
            displayName: v.displayName,
            category: v.category,
            type: v.type,
            color: v.color,
            radius: v.radius,
            intensity: v.intensity,
            falloff: v.falloff,
          },
        ]),
    ),
  };
}
