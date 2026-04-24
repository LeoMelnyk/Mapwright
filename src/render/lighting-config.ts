/**
 * Tunable constants for the 2D lighting engine.
 *
 * Centralized so the lighting module has a single "what can I tune?" surface
 * and parity tests can hold these values constant across the real-time and
 * HQ-export paths. Don't inline new magic numbers into lighting.ts or
 * lighting-geometry.ts — add them here and document intent.
 */

// ─── Falloff math ──────────────────────────────────────────────────────────

/**
 * Denominator constant for the 'inverse-square' falloff curve.
 *
 *   f(d) = 1 / (1 + k·(d/R)²)
 *
 * Larger k makes the falloff steeper (more pronounced dark edges). 25 was
 * tuned to roughly match artistic "torch glow" expectations at radius 30 ft.
 */
export const INVERSE_SQUARE_K = 25;

/**
 * Number of color stops in the real-time radial gradient fill. More stops
 * track the mathematical falloff curve more accurately but incur a per-light
 * overhead when the gradient is rebuilt. 16 is the visual sweet spot —
 * humans cannot distinguish 16 vs 32 stops on a typical torch glow.
 */
export const GRADIENT_STOPS = 16;

// ─── Ray casting ───────────────────────────────────────────────────────────

/**
 * Epsilon used throughout visibility polygon computation to nudge rays off
 * wall-segment endpoints. Avoids divide-by-zero on grazing rays and keeps
 * the visibility polygon closed when two walls share an endpoint exactly.
 */
export const RAY_EPSILON = 0.00001;

// ─── Animation ─────────────────────────────────────────────────────────────

/**
 * Global time scaling for light animations. `t_anim = t * speed * SCALE`.
 * Bigger values speed up every animation; don't touch without updating
 * presets that were tuned against the current value.
 */
export const ANIM_TIME_SCALE = 0.4;

/**
 * Flicker frequencies — three incommensurate sine waves blended together
 * (weights 0.5, 0.3, 0.2) to give a chaotic, non-repeating flame look.
 * Prime-like ratios avoid the beating that would appear with round numbers.
 */
export const FLICKER_FREQS = [17.3, 31.7, 7.1] as const;
export const FLICKER_WEIGHTS = [0.5, 0.3, 0.2] as const;

/** Secondary frequency used for the optional radius-variation flicker. */
export const FLICKER_RADIUS_FREQ = 11.3;

/**
 * Maximum hue shift (degrees) applied by `colorMode: 'auto'` as flicker
 * intensity dips toward zero. 25° shifts orange (~30°) toward red (~5°),
 * which mirrors how real combustion looks dimmer + redder when starved
 * of fuel for a fraction of a second.
 */
export const COLOR_SHIFT_MAX_DEG = 25;

/**
 * Strike (lightning) defaults. Each window of `1 / frequency` seconds
 * deterministically rolls whether a flash occurs, then shows it for a
 * fraction `duration` of the window length. Baseline keeps the light
 * faintly visible between flashes (set to 0 for total darkness).
 */
export const STRIKE_DEFAULT_FREQUENCY = 0.2;
export const STRIKE_DEFAULT_DURATION = 0.12;
export const STRIKE_DEFAULT_PROBABILITY = 0.4;
export const STRIKE_DEFAULT_BASELINE = 0.05;

/**
 * Sweep lights bypass the per-light geometry cache (angle changes every
 * frame). To keep the perf cliff visible, render warns once when more than
 * this many sweep lights are in view simultaneously.
 */
export const SWEEP_LIGHT_SOFT_LIMIT = 4;

// ─── Prop shadow projection ────────────────────────────────────────────────

/**
 * Maximum multiplier applied when projecting a prop's silhouette outward from
 * the light. Prevents shadows from becoming effectively infinite when a
 * light's z-height nearly matches the prop top (height difference → 0 =
 * shadow length → ∞).
 */
export const PROP_SHADOW_MAX_RATIO = 20;

/** Height difference (feet) below which we treat the light as "at prop top". */
export const PROP_SHADOW_EPSILON_FT = 0.1;

/**
 * Opacity curve when the light sits within a prop's z-range [zBottom, zTop]:
 *   opacity = WITHIN_BASE + WITHIN_SPAN * ((zTop - lz) / (zTop - zBottom))
 *
 * At lz == zTop the light just skims over the prop → 0.7 shadow.
 * At lz == zBottom the prop fully occludes → 1.0 shadow.
 */
export const PROP_SHADOW_WITHIN_BASE = 0.7;
export const PROP_SHADOW_WITHIN_SPAN = 0.3;

/**
 * Opacity curve when the light sits above the prop (lz > zTop). The prop
 * only occludes the narrow slice between the two, so the shadow is always
 * softer: capped at 0.85 with a floor around 0.4.
 */
export const PROP_SHADOW_ABOVE_BASE = 0.4;
export const PROP_SHADOW_ABOVE_SPAN = 0.45;
export const PROP_SHADOW_ABOVE_MAX = 0.85;

// ─── Normal-map bump ───────────────────────────────────────────────────────

/**
 * Size of the tiny offscreen sampler used to aggregate normal-map bytes
 * per cell in the real-time path. 4×4 means 16 samples per cell; larger
 * values smooth out noise but cost O(N²) per cell per frame.
 */
export const BUMP_SAMPLE_SIZE = 4;

/**
 * Real-time bump output range: `bumpFactor = BASE + avgDot * SPAN`.
 * Steep surfaces (`avgDot ≈ 0`) get BASE (dim); surfaces normal to the
 * light direction (`avgDot ≈ 1`) get BASE + SPAN (slight highlight).
 */
export const BUMP_RT_BASE = 0.85;
export const BUMP_RT_SPAN = 0.25;

/** Light-height (feet) bias used by both normal-map bump paths. */
export const BUMP_LIGHT_HEIGHT_FRAC = 0.7;

// ─── Cone lights ───────────────────────────────────────────────────────────

/**
 * Default spread (cone half-angle, degrees) applied when a directional light
 * is placed without one. Matches the legacy default used throughout the
 * editor and API.
 */
export const DEFAULT_CONE_SPREAD_DEG = 45;

/** Clamp range for directional light spread (see clampSpread in lighting.ts). */
export const CONE_SPREAD_MIN_DEG = 0;
export const CONE_SPREAD_MAX_DEG = 180;

// ─── Soft shadows (multi-ray PCF) ──────────────────────────────────────────

/**
 * Number of jittered sample points used when a light has softShadowRadius > 0.
 * 4 samples is the classic PCF "good enough" count — gives convincing
 * penumbra at wall corners without costing 4× the ray-cast time for every
 * light in the map. Raise for hero lights; don't go above 8 without a reason
 * (returns diminish fast and visibility recompute is the dominant cost).
 */
export const SOFT_SHADOW_SAMPLES = 4;

/**
 * Golden-angle stride (radians) used to place the jittered samples around the
 * light's center. Irrational rotation avoids grid artefacts that a round
 * (π/2 between samples) arrangement would produce.
 */
export const SOFT_SHADOW_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
