import type {
  FalloffType,
  LightPreset,
  Light,
  LightAnimationConfig,
  LightCookie,
  PlaceLightConfig,
} from '../../../types.js';
import { clampSpread, beginGroupTransition, listCookieTypes } from '../../../render/index.js';
import { state, mutate, requestRender, getLightCatalog, ApiValidationError } from './_shared.js';

/**
 * Place a light source at world-feet coordinates.
 * @param {number} x - World-feet X position
 * @param {number} y - World-feet Y position
 * @param {Object} [config] - Light configuration (preset, radius, color, intensity, etc.)
 * @returns {{ success: boolean, id: number }}
 */
export function placeLight(x: number, y: number, config: PlaceLightConfig = {}): { success: true; id: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ApiValidationError(
      'INVALID_LIGHT_COORDINATES',
      `placeLight requires finite numeric x and y in world feet; got x=${x}, y=${y}.`,
      { x, y },
    );
  }

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

      // Darkness / anti-light — subtracts illumination instead of adding.
      if (config.darkness) light.darkness = true;

      // Forward optional preset/explicit fields the renderer understands.
      if (config.dimRadius != null) light.dimRadius = config.dimRadius;
      if (config.range != null) light.range = config.range;
      if (config.softShadowRadius != null) light.softShadowRadius = config.softShadowRadius;
      if (config.animation) light.animation = config.animation;
      if (config.cookie) light.cookie = config.cookie;
      if (config.group) light.group = config.group;
      if (config.name) light.name = config.name;

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
 *
 * Optionally animate the transition with `transition`:
 *   - `'instant'` (default) — hard cut, matches legacy behavior
 *   - `'simple-fade'` — smoothstep ramp over `durationMs`
 *   - `'ignite'` — ramp from 0 with mid-ramp flicker (use when enabling)
 *   - `'extinguish'` — ramp toward 0 with a brief gutter (use when disabling)
 */
export function setLightGroupEnabled(
  group: string,
  enabled: boolean,
  options: {
    transition?: 'instant' | 'simple-fade' | 'ignite' | 'extinguish';
    durationMs?: number;
  } = {},
): { success: true } {
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
  const transition = options.transition ?? 'instant';
  if (transition !== 'instant') {
    beginGroupTransition(group, enabled, transition, options.durationMs ?? 600);
  }
  requestRender();
  return { success: true };
}

/**
 * Set or replace a light's animation config. Pass `null` to clear.
 */
export function setLightAnimation(id: number, animation: LightAnimationConfig | null): { success: true } {
  const meta = state.dungeon.metadata;
  const light = meta.lights.find((l) => l.id === id);
  if (!light) throw new ApiValidationError('LIGHT_NOT_FOUND', `Light with id ${id} not found`, { id });
  mutate(
    'Set light animation',
    [],
    () => {
      if (animation?.type) {
        light.animation = animation;
      } else {
        delete light.animation;
      }
      delete light.presetId;
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );
  requestRender();
  return { success: true };
}

/**
 * Attach a procedural cookie (gobo) to a light. Pass `null` to clear.
 * Use `listCookies()` for valid type names.
 */
export function setLightCookie(id: number, cookie: LightCookie | null): { success: true } {
  const meta = state.dungeon.metadata;
  const light = meta.lights.find((l) => l.id === id);
  if (!light) throw new ApiValidationError('LIGHT_NOT_FOUND', `Light with id ${id} not found`, { id });
  if (cookie && !listCookieTypes().includes(cookie.type)) {
    throw new ApiValidationError(
      'UNKNOWN_COOKIE_TYPE',
      `Unknown cookie type: ${cookie.type}. Valid: ${listCookieTypes().join(', ')}`,
      { received: cookie.type, valid: listCookieTypes() },
    );
  }
  mutate(
    'Set light cookie',
    [],
    () => {
      if (cookie) light.cookie = cookie;
      else delete light.cookie;
      delete light.presetId;
    },
    { metaOnly: true, invalidate: ['lighting'] },
  );
  requestRender();
  return { success: true };
}

/**
 * List every available procedural cookie type. No external assets — these are
 * drawn programmatically on first use and cached.
 */
export function listCookies(): { success: true; cookies: string[] } {
  return { success: true, cookies: listCookieTypes() };
}

/**
 * Set or clear the map-wide ambient animation. Currently `strike` (lightning
 * storm flashes) is the only meaningful type — flashes are full-canvas
 * additive bursts whose color follows `metadata.ambientColor`.
 */
export function setAmbientAnimation(animation: LightAnimationConfig | null): { success: true } {
  mutate(
    'Set ambient animation',
    [],
    () => {
      if (animation?.type) {
        state.dungeon.metadata.ambientAnimation = animation;
      } else {
        delete state.dungeon.metadata.ambientAnimation;
      }
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
