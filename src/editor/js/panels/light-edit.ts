// light-edit.ts — Floating, draggable dialog for editing a selected light.
//
// Mirrors panels/prop-edit.ts: opens on double-click (or Enter on a selected
// light), snapshots the light's fields, pushes one undo entry, and lets edits
// mutate the light in place. Enter / × / click-outside applies; Esc reverts to
// the snapshot and pops the undo entry.
import type { FalloffType, Light, LightAnimationConfig, LightPreset } from '../../../types.js';
import state, { invalidateLightmap, markDirty, notify, pushUndo, subscribe } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { getLightCatalog } from '../light-catalog.js';
import { kelvinToRgb, falloffMultiplier } from '../../../render/index.js';

// ─── Module state ────────────────────────────────────────────────────────────

let panel: HTMLDivElement | null = null;
let header: HTMLDivElement | null = null;
let body: HTMLDivElement | null = null;
let currentLightId: number | null = null;
let snapshot: Light | null = null;
let undoDepthOnOpen = -1;
let isOpen = false;
// True while a dialog-initiated mutation is firing its notify. Prevents the
// subscribe callback from rebuilding the body (which would unfocus the input
// the user is typing into).
let selfMutating = false;

// Draggable-header state
const drag = { active: false, offsetX: 0, offsetY: 0 };

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e;
}

function getLight(): Light | null {
  if (currentLightId == null) return null;
  return state.dungeon.metadata.lights.find((l) => l.id === currentLightId) ?? null;
}

/** Apply a mutation to renderer/caches with subscribe-rebuild suppression. */
function commitRenderChange(): void {
  invalidateLightmap(false);
  markDirty();
  selfMutating = true;
  try {
    notify('lighting');
  } finally {
    selfMutating = false;
  }
  requestRender();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderBody(light: Light): void {
  if (!body) return;
  body.innerHTML = '';

  const titleEl = document.getElementById('le-header-title');
  if (titleEl) titleEl.textContent = light.name ? `Edit: ${light.name}` : `Edit Light #${light.id}`;

  // Preview thumbnail — rebuilt cheap on every refresh.
  const previewRow = row();
  previewRow.appendChild(labelEl('Preview'));
  const previewImg = document.createElement('img');
  previewImg.src = buildLightPreview(light.color, light.falloff, !!light.darkness);
  previewImg.width = PREVIEW_SIZE;
  previewImg.height = PREVIEW_SIZE;
  previewImg.style.border = '1px solid var(--border)';
  previewImg.style.borderRadius = '4px';
  previewRow.appendChild(previewImg);
  previewRow.appendChild(document.createElement('span'));
  body.appendChild(previewRow);

  // Name
  addTextRow(body, 'Name', 'name', light.name ?? '', 'Optional label…', (v) => {
    if (v) light.name = v;
    else delete light.name;
    markDirty();
    selfMutating = true;
    try {
      notify('lighting');
    } finally {
      selfMutating = false;
    }
    // Update the header title without a full rebuild.
    if (titleEl) titleEl.textContent = light.name ? `Edit: ${light.name}` : `Edit Light #${light.id}`;
  });

  // Group
  addTextRow(body, 'Group', 'group', light.group ?? '', 'e.g. torches, traps…', (v) => {
    if (v) light.group = v;
    else delete light.group;
    commitRenderChange();
  });

  // Darkness
  addCheckRow(body, 'Darkness', 'darkness', !!light.darkness, (v) => {
    if (v) light.darkness = true;
    else delete light.darkness;
    // Preview reflects darkness.
    previewImg.src = buildLightPreview(light.color, light.falloff, !!light.darkness);
    commitRenderChange();
  });

  // Preset dropdown — full re-render after apply so new values reflect in UI.
  addPresetRow(body, light.presetId ?? null, (preset: LightPreset) => {
    light.type = preset.type;
    light.color = preset.color;
    if (preset.type === 'directional') {
      light.range = preset.radius;
      light.spread = preset.spread ?? 45;
      delete (light as unknown as Record<string, unknown>).radius;
    } else {
      light.radius = preset.radius;
      delete (light as unknown as Record<string, unknown>).range;
      delete (light as unknown as Record<string, unknown>).spread;
    }
    light.intensity = preset.intensity;
    light.falloff = preset.falloff;
    if (preset.dimRadius) light.dimRadius = preset.dimRadius;
    else delete light.dimRadius;
    if (preset.animation) light.animation = { ...preset.animation };
    else delete light.animation;
    if (preset.z != null) light.z = preset.z;
    else delete light.z;
    light.presetId = preset.id;
    commitRenderChange();
    refreshFromState();
  });

  // ── Appearance section ────────────────────────────────────────────────
  addSection(body, 'Appearance');

  addColorRow(body, 'Color', 'color', light.color, (v) => {
    light.color = v;
    delete light.presetId;
    previewImg.src = buildLightPreview(light.color, light.falloff, !!light.darkness);
    commitRenderChange();
  });

  addSliderRow(
    body,
    'Temp (K)',
    'temp',
    2700,
    1500,
    10000,
    100,
    (v) => {
      const hex = kelvinToRgb(v);
      light.color = hex;
      delete light.presetId;
      // Sync the color picker so the two controls don't disagree.
      const colorInput = document.getElementById('le-color') as HTMLInputElement | null;
      if (colorInput) colorInput.value = hex;
      previewImg.src = buildLightPreview(hex, light.falloff, !!light.darkness);
      commitRenderChange();
    },
    (v) => `${v}K`,
  );

  const radiusLabel = light.type === 'directional' ? 'Range' : 'Radius';
  const radiusField = light.type === 'directional' ? 'range' : 'radius';
  const radiusValue = light.type === 'directional' ? (light.range ?? light.radius) || 30 : light.radius || 30;
  addSliderRow(
    body,
    radiusLabel,
    'radius',
    radiusValue,
    5,
    100,
    5,
    (v) => {
      if (radiusField === 'range') light.range = v;
      else light.radius = v;
      delete light.presetId;
      commitRenderChange();
    },
    (v) => `${v} ft`,
  );

  addSliderRow(
    body,
    'Intensity',
    'intensity',
    light.intensity,
    0.1,
    2.0,
    0.1,
    (v) => {
      light.intensity = v;
      delete light.presetId;
      commitRenderChange();
    },
    (v) => `${v.toFixed(1)}×`,
  );

  addSelectRow(
    body,
    'Falloff',
    'falloff',
    light.falloff,
    [
      ['smooth', 'Smooth'],
      ['linear', 'Linear'],
      ['quadratic', 'Quadratic'],
      ['inverse-square', 'Inverse Square'],
    ],
    (v) => {
      light.falloff = v as FalloffType;
      delete light.presetId;
      previewImg.src = buildLightPreview(light.color, light.falloff, !!light.darkness);
      commitRenderChange();
    },
  );

  if (light.type === 'point') {
    addSliderRow(
      body,
      'Dim Radius',
      'dimRadius',
      light.dimRadius ?? 0,
      0,
      120,
      5,
      (v) => {
        if (v > 0) light.dimRadius = v;
        else delete light.dimRadius;
        delete light.presetId;
        commitRenderChange();
      },
      (v) => (v === 0 ? 'Off' : `${v} ft`),
    );
  }

  if (light.type === 'directional') {
    addSliderRow(
      body,
      'Angle',
      'angle',
      light.angle ?? 0,
      0,
      359,
      1,
      (v) => {
        light.angle = v;
        delete light.presetId;
        commitRenderChange();
      },
      (v) => `${v}°`,
    );
    addSliderRow(
      body,
      'Spread',
      'spread',
      light.spread ?? 45,
      5,
      90,
      5,
      (v) => {
        light.spread = v;
        delete light.presetId;
        commitRenderChange();
      },
      (v) => `${v}°`,
    );
  }

  addSliderRow(
    body,
    'Height (ft)',
    'z',
    light.z ?? 8,
    0.5,
    20,
    0.5,
    (v) => {
      light.z = v;
      delete light.presetId;
      commitRenderChange();
    },
    (v) => `${v}ft`,
  );

  addSliderRow(
    body,
    'Soft Shadow',
    'softShadow',
    light.softShadowRadius ?? 0,
    0,
    4,
    0.25,
    (v) => {
      if (v > 0) light.softShadowRadius = v;
      else delete light.softShadowRadius;
      commitRenderChange();
    },
    (v) => (v === 0 ? 'Off' : `${v.toFixed(2)} ft`),
  );

  // ── Animation section ─────────────────────────────────────────────────
  addSection(body, 'Animation');
  renderAnimationSection(body, light);

  // ── Cookie / Gobo section ─────────────────────────────────────────────
  addSection(body, 'Cookie (Gobo)');
  renderCookieSection(body, light);

  // ── Delete ────────────────────────────────────────────────────────────
  const actionRow = document.createElement('div');
  actionRow.className = 'pe-row';
  actionRow.appendChild(document.createElement('span'));
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'pe-btn';
  deleteBtn.type = 'button';
  deleteBtn.textContent = 'Delete Light';
  deleteBtn.addEventListener('click', () => {
    // The deletion itself should commit (not be reverted by Esc). Close the
    // dialog first so the pushed "Edit light" undo entry stays intact only if
    // something actually changed before delete; then perform a separate
    // mutation-free delete (the overall undo depth will absorb it).
    const meta = state.dungeon.metadata;
    const idx = meta.lights.findIndex((l) => l.id === light.id);
    if (idx < 0) return;
    meta.lights.splice(idx, 1);
    if (state.selectedLightId === light.id) state.selectedLightId = null;
    closeLightEditDialog(false);
    invalidateLightmap(false);
    markDirty();
    notify('lighting');
    requestRender();
  });
  actionRow.appendChild(deleteBtn);
  actionRow.appendChild(document.createElement('span'));
  body.appendChild(actionRow);
}

// ─── Animation sub-panel ─────────────────────────────────────────────────────

function renderAnimationSection(parent: HTMLElement, light: Light): void {
  const existing = light.animation ?? ({} as Partial<LightAnimationConfig>);

  // Type selector — changing this rebuilds the section.
  const typeRow = row();
  typeRow.appendChild(labelEl('Type'));
  const typeSelect = document.createElement('select');
  for (const [val, lbl] of [
    ['none', 'None'],
    ['flicker', 'Flicker'],
    ['pulse', 'Pulse'],
    ['strobe', 'Strobe'],
    ['strike', 'Strike (lightning)'],
    ['sweep', 'Sweep (lighthouse)'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    opt.selected = (existing.type ?? 'none') === val;
    typeSelect.appendChild(opt);
  }
  typeRow.appendChild(typeSelect);
  typeRow.appendChild(document.createElement('span'));
  parent.appendChild(typeRow);

  const currentType = existing.type ?? 'none';
  if (currentType === 'none') {
    typeSelect.addEventListener('change', () => {
      const t = typeSelect.value;
      if (t === 'none') return;
      // Seed a sensible default config for the chosen type.
      light.animation = { type: t, speed: 1.0, amplitude: 0.3 } as LightAnimationConfig;
      delete light.presetId;
      commitRenderChange();
      refreshFromState();
    });
    return;
  }

  // Build controls reflecting current animation config. Any field change calls
  // applyAnim(), which reads all inputs and rebuilds the animation object.
  const speedRow = buildSlider('Speed', existing.speed ?? 1.0, 0.1, 5.0, 0.1, (v) => v.toFixed(1) + '×');
  const ampRow =
    currentType === 'sweep'
      ? null
      : buildSlider('Amplitude', existing.amplitude ?? 0.3, 0, 1, 0.05, (v) => v.toFixed(2));
  const radVarRow =
    currentType === 'flicker' || currentType === 'pulse' || currentType === 'strobe'
      ? buildSlider('Radius Var', existing.radiusVariation ?? 0, 0, 0.5, 0.05, (v) => v.toFixed(2))
      : null;

  let flickerPatternSelect: HTMLSelectElement | null = null;
  let guttRow: { row: HTMLDivElement; input: HTMLInputElement; display: HTMLSpanElement } | null = null;
  if (currentType === 'flicker') {
    const r = row();
    r.appendChild(labelEl('Pattern'));
    flickerPatternSelect = document.createElement('select');
    for (const [val, lbl] of [
      ['sine', 'Sine (default)'],
      ['noise', 'Noise (windblown)'],
    ] as const) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = lbl;
      o.selected = (existing.pattern ?? 'sine') === val;
      flickerPatternSelect.appendChild(o);
    }
    r.appendChild(flickerPatternSelect);
    r.appendChild(document.createElement('span'));
    parent.appendChild(r);
    guttRow = buildSlider('Guttering', existing.guttering ?? 0, 0, 1, 0.05, (v) => (v === 0 ? 'Off' : v.toFixed(2)));
  }

  let freqRow: ReturnType<typeof buildSlider> | null = null;
  let durRow: ReturnType<typeof buildSlider> | null = null;
  let probRow: ReturnType<typeof buildSlider> | null = null;
  let baseRow: ReturnType<typeof buildSlider> | null = null;
  if (currentType === 'strike') {
    freqRow = buildSlider('Frequency', existing.frequency ?? 0.2, 0.05, 2, 0.05, (v) => `${v.toFixed(2)}/s`);
    durRow = buildSlider('Flash Length', existing.duration ?? 0.12, 0.02, 1, 0.02, (v) => v.toFixed(2));
    probRow = buildSlider('Probability', existing.probability ?? 0.4, 0, 1, 0.05, (v) => v.toFixed(2));
    baseRow = buildSlider('Baseline', existing.baseline ?? 0.05, 0, 1, 0.05, (v) => v.toFixed(2));
  }

  let sweepSpeedRow: ReturnType<typeof buildSlider> | null = null;
  let sweepArcRow: ReturnType<typeof buildSlider> | null = null;
  if (currentType === 'sweep') {
    sweepSpeedRow = buildSlider('Angular Speed', existing.angularSpeed ?? 60, -360, 360, 5, (v) => `${v}°/s`);
    sweepArcRow = buildSlider('Arc Range', existing.arcRange ?? 0, 0, 360, 5, (v) =>
      v === 0 ? 'Full 360°' : `±${v / 2}°`,
    );
  }

  // Sync toggle (forces phase=0)
  const syncRow = document.createElement('label');
  syncRow.className = 'pe-row';
  const syncLbl = document.createElement('span');
  syncLbl.textContent = 'Sync group';
  syncLbl.style.fontSize = '11px';
  syncLbl.style.color = 'var(--text-dim)';
  const syncCb = document.createElement('input');
  syncCb.type = 'checkbox';
  syncCb.checked = existing.phase === 0;
  const syncSpacer = document.createElement('span');
  syncRow.appendChild(syncLbl);
  syncRow.appendChild(syncCb);
  syncRow.appendChild(syncSpacer);

  // Color modulation
  const colorModeRow = row();
  colorModeRow.appendChild(labelEl('Color Mode'));
  const colorModeSelect = document.createElement('select');
  for (const [val, lbl] of [
    ['none', 'None'],
    ['auto', 'Auto (red-shift)'],
    ['secondary', 'Two-color blend'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = lbl;
    o.selected = (existing.colorMode ?? 'none') === val;
    colorModeSelect.appendChild(o);
  }
  colorModeRow.appendChild(colorModeSelect);
  colorModeRow.appendChild(document.createElement('span'));

  const colorVarRow = buildSlider('Color Variation', existing.colorVariation ?? 0.5, 0, 1, 0.05, (v) => v.toFixed(2));
  const colorSecRow = row();
  colorSecRow.appendChild(labelEl('Secondary'));
  const colorSecInput = document.createElement('input');
  colorSecInput.type = 'color';
  // Default to the complement of the light's primary color — picking a
  // secondary that's similar to (or white against) the primary produces no
  // visible blend. The complement is always a contrasting fallback.
  colorSecInput.value = existing.colorSecondary ?? complementHex(light.color);
  colorSecRow.appendChild(colorSecInput);
  colorSecRow.appendChild(document.createElement('span'));

  // Add rows to DOM.
  parent.appendChild(speedRow.row);
  if (ampRow) parent.appendChild(ampRow.row);
  if (radVarRow) parent.appendChild(radVarRow.row);
  if (guttRow) parent.appendChild(guttRow.row);
  if (freqRow) parent.appendChild(freqRow.row);
  if (durRow) parent.appendChild(durRow.row);
  if (probRow) parent.appendChild(probRow.row);
  if (baseRow) parent.appendChild(baseRow.row);
  if (sweepSpeedRow) parent.appendChild(sweepSpeedRow.row);
  if (sweepArcRow) parent.appendChild(sweepArcRow.row);
  parent.appendChild(syncRow);
  parent.appendChild(colorModeRow);
  parent.appendChild(colorVarRow.row);
  parent.appendChild(colorSecRow);

  const applyAnim = () => {
    const t = typeSelect.value;
    if (t === 'none') {
      delete light.animation;
    } else {
      const animObj: LightAnimationConfig = {
        type: t,
        speed: parseFloat(speedRow.input.value),
        amplitude: ampRow ? parseFloat(ampRow.input.value) : 0,
      };
      if (radVarRow) animObj.radiusVariation = parseFloat(radVarRow.input.value);
      if (t === 'flicker' && flickerPatternSelect) {
        animObj.pattern = flickerPatternSelect.value as 'sine' | 'noise';
        if (guttRow) {
          const g = parseFloat(guttRow.input.value);
          if (g > 0) animObj.guttering = g;
        }
      }
      if (t === 'strike') {
        if (freqRow) animObj.frequency = parseFloat(freqRow.input.value);
        if (durRow) animObj.duration = parseFloat(durRow.input.value);
        if (probRow) animObj.probability = parseFloat(probRow.input.value);
        if (baseRow) animObj.baseline = parseFloat(baseRow.input.value);
      }
      if (t === 'sweep') {
        if (sweepSpeedRow) animObj.angularSpeed = parseFloat(sweepSpeedRow.input.value);
        if (sweepArcRow) {
          const arc = parseFloat(sweepArcRow.input.value);
          if (arc > 0) animObj.arcRange = arc;
        }
      }
      const cm = colorModeSelect.value as 'none' | 'auto' | 'secondary';
      if (cm !== 'none') {
        animObj.colorMode = cm;
        animObj.colorVariation = parseFloat(colorVarRow.input.value);
        if (cm === 'secondary') animObj.colorSecondary = colorSecInput.value;
      }
      if (syncCb.checked) animObj.phase = 0;
      light.animation = animObj;
    }
    delete light.presetId;
    commitRenderChange();
  };

  // Wire change listeners — type change rebuilds; others apply live.
  typeSelect.addEventListener('change', () => {
    applyAnim();
    refreshFromState();
  });
  speedRow.input.addEventListener('input', applyAnim);
  if (ampRow) ampRow.input.addEventListener('input', applyAnim);
  if (radVarRow) radVarRow.input.addEventListener('input', applyAnim);
  if (flickerPatternSelect) flickerPatternSelect.addEventListener('change', applyAnim);
  if (guttRow) guttRow.input.addEventListener('input', applyAnim);
  if (freqRow) freqRow.input.addEventListener('input', applyAnim);
  if (durRow) durRow.input.addEventListener('input', applyAnim);
  if (probRow) probRow.input.addEventListener('input', applyAnim);
  if (baseRow) baseRow.input.addEventListener('input', applyAnim);
  if (sweepSpeedRow) sweepSpeedRow.input.addEventListener('input', applyAnim);
  if (sweepArcRow) sweepArcRow.input.addEventListener('input', applyAnim);
  syncCb.addEventListener('change', applyAnim);
  colorModeSelect.addEventListener('change', () => {
    applyAnim();
    refreshFromState();
  });
  colorVarRow.input.addEventListener('input', applyAnim);
  colorSecInput.addEventListener('input', applyAnim);

  // Hide color variation/secondary when mode is 'none'
  const cmShow = colorModeSelect.value !== 'none';
  colorVarRow.row.style.display = cmShow ? '' : 'none';
  colorSecRow.style.display = cmShow && colorModeSelect.value === 'secondary' ? '' : 'none';
}

// ─── Cookie / Gobo sub-panel ─────────────────────────────────────────────────

function renderCookieSection(parent: HTMLElement, light: Light): void {
  const existing = light.cookie ?? null;

  const typeRow = row();
  typeRow.appendChild(labelEl('Pattern'));
  const typeSelect = document.createElement('select');
  for (const [val, lbl] of [
    ['none', 'None'],
    ['slats', 'Slats (prison bars)'],
    ['dapple', 'Canopy Dapple'],
    ['caustics', 'Water Caustics'],
    ['sigil', 'Magical Sigil'],
    ['grid', 'Grid (window)'],
    ['stained-glass', 'Stained Glass'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = lbl;
    o.selected = (existing?.type ?? 'none') === val;
    typeSelect.appendChild(o);
  }
  typeRow.appendChild(typeSelect);
  typeRow.appendChild(document.createElement('span'));
  parent.appendChild(typeRow);

  if (!existing || typeSelect.value === 'none') {
    typeSelect.addEventListener('change', () => {
      const t = typeSelect.value;
      if (t === 'none') return;
      light.cookie = { type: t as NonNullable<Light['cookie']>['type'], scale: 1, strength: 1 };
      delete light.presetId;
      commitRenderChange();
      refreshFromState();
    });
    return;
  }

  const focusRow = buildSlider('Focus Radius', existing.focusRadius ?? 0, 0, 10, 0.1, (v) =>
    v === 0 ? 'Full' : `${v.toFixed(1)} ft`,
  );
  const scaleRow = buildSlider('Scale', existing.scale ?? 1, 0.25, 4, 0.05, (v) => `${v.toFixed(2)}×`);
  const strengthRow = buildSlider('Strength', existing.strength ?? 1, 0, 1, 0.05, (v) => v.toFixed(2));
  const rotSpeedRow = buildSlider('Rotation Speed', existing.rotationSpeed ?? 0, -90, 90, 1, (v) =>
    v === 0 ? 'Static' : `${v}°/s`,
  );
  const scrollXRow = buildSlider('Scroll X', existing.scrollSpeedX ?? 0, -0.5, 0.5, 0.01, (v) => v.toFixed(2));
  const scrollYRow = buildSlider('Scroll Y', existing.scrollSpeedY ?? 0, -0.5, 0.5, 0.01, (v) => v.toFixed(2));

  parent.appendChild(focusRow.row);
  parent.appendChild(scaleRow.row);
  parent.appendChild(strengthRow.row);
  parent.appendChild(rotSpeedRow.row);
  parent.appendChild(scrollXRow.row);
  parent.appendChild(scrollYRow.row);

  const apply = () => {
    const t = typeSelect.value;
    if (t === 'none') {
      delete light.cookie;
    } else {
      const c: NonNullable<Light['cookie']> = {
        type: t as NonNullable<Light['cookie']>['type'],
        scale: parseFloat(scaleRow.input.value),
        strength: parseFloat(strengthRow.input.value),
      };
      const fr = parseFloat(focusRow.input.value);
      if (fr > 0) c.focusRadius = fr;
      const rs = parseFloat(rotSpeedRow.input.value);
      if (rs !== 0) c.rotationSpeed = rs;
      const sx = parseFloat(scrollXRow.input.value);
      if (sx !== 0) c.scrollSpeedX = sx;
      const sy = parseFloat(scrollYRow.input.value);
      if (sy !== 0) c.scrollSpeedY = sy;
      light.cookie = c;
    }
    delete light.presetId;
    commitRenderChange();
  };
  typeSelect.addEventListener('change', () => {
    apply();
    refreshFromState();
  });
  focusRow.input.addEventListener('input', apply);
  scaleRow.input.addEventListener('input', apply);
  strengthRow.input.addEventListener('input', apply);
  rotSpeedRow.input.addEventListener('input', apply);
  scrollXRow.input.addEventListener('input', apply);
  scrollYRow.input.addEventListener('input', apply);
}

// ─── Generic row builders ────────────────────────────────────────────────────

function row(): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'pe-row';
  return r;
}

function labelEl(text: string): HTMLLabelElement {
  const l = document.createElement('label');
  l.textContent = text;
  return l;
}

function addSection(parent: HTMLElement, title: string): void {
  const h = document.createElement('div');
  h.className = 'pe-section-title';
  h.textContent = title;
  parent.appendChild(h);
}

function addTextRow(
  parent: HTMLElement,
  label: string,
  id: string,
  value: string,
  placeholder: string,
  onChange: (v: string) => void,
): void {
  const r = row();
  const lbl = labelEl(label);
  lbl.htmlFor = `le-${id}`;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `le-${id}`;
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value.trim()));
  r.appendChild(lbl);
  r.appendChild(input);
  r.appendChild(document.createElement('span'));
  parent.appendChild(r);
}

function addCheckRow(
  parent: HTMLElement,
  label: string,
  id: string,
  value: boolean,
  onChange: (v: boolean) => void,
): void {
  const r = row();
  const lbl = labelEl(label);
  lbl.htmlFor = `le-${id}`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `le-${id}`;
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  r.appendChild(lbl);
  r.appendChild(input);
  r.appendChild(document.createElement('span'));
  parent.appendChild(r);
}

function addColorRow(
  parent: HTMLElement,
  label: string,
  id: string,
  value: string,
  onChange: (v: string) => void,
): void {
  const r = row();
  const lbl = labelEl(label);
  lbl.htmlFor = `le-${id}`;
  const input = document.createElement('input');
  input.type = 'color';
  input.id = `le-${id}`;
  input.value = normalizeHexColor(value);
  input.addEventListener('input', () => onChange(input.value));
  r.appendChild(lbl);
  r.appendChild(input);
  r.appendChild(document.createElement('span'));
  parent.appendChild(r);
}

function addSelectRow(
  parent: HTMLElement,
  label: string,
  id: string,
  currentValue: string,
  options: Array<readonly [string, string]>,
  onChange: (v: string) => void,
): void {
  const r = row();
  const lbl = labelEl(label);
  lbl.htmlFor = `le-${id}`;
  const sel = document.createElement('select');
  sel.id = `le-${id}`;
  for (const [v, t] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    o.selected = v === currentValue;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  r.appendChild(lbl);
  r.appendChild(sel);
  r.appendChild(document.createElement('span'));
  parent.appendChild(r);
}

function addSliderRow(
  parent: HTMLElement,
  label: string,
  id: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  formatValue: (v: number) => string,
): void {
  const b = buildSlider(label, value, min, max, step, formatValue);
  b.input.id = `le-${id}`;
  b.input.addEventListener('input', () => {
    const v = parseFloat(b.input.value);
    if (!Number.isFinite(v)) return;
    b.display.textContent = formatValue(v);
    onChange(v);
  });
  parent.appendChild(b.row);
}

function buildSlider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  formatValue: (v: number) => string,
): { row: HTMLDivElement; input: HTMLInputElement; display: HTMLSpanElement } {
  const r = row();
  const lbl = labelEl(label);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const display = document.createElement('span');
  display.className = 'pe-value';
  display.textContent = formatValue(value);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) display.textContent = formatValue(v);
  });
  r.appendChild(lbl);
  r.appendChild(input);
  r.appendChild(display);
  return { row: r, input, display };
}

function addPresetRow(parent: HTMLElement, currentValue: string | null, onSelect: (p: LightPreset) => void): void {
  const catalog = getLightCatalog();
  const r = row();
  r.appendChild(labelEl('Preset'));
  const sel = document.createElement('select');
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— Select preset —';
  sel.appendChild(empty);
  if (catalog) {
    for (const category of catalog.categoryOrder) {
      const group = document.createElement('optgroup');
      group.label = category;
      for (const id of catalog.byCategory[category] ?? []) {
        const preset = catalog.lights[id];
        if (!preset) continue;
        const o = document.createElement('option');
        o.value = id;
        o.textContent = preset.displayName;
        if (id === currentValue) o.selected = true;
        group.appendChild(o);
      }
      sel.appendChild(group);
    }
  }
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    const preset = catalog?.lights[sel.value];
    if (preset) onSelect(preset);
  });
  r.appendChild(sel);
  r.appendChild(document.createElement('span'));
  parent.appendChild(r);
}

// ─── Preview thumbnail ───────────────────────────────────────────────────────

const PREVIEW_SIZE = 64;
const _previewCache = new Map<string, string>();
function buildLightPreview(color: string, falloff: FalloffType, darkness: boolean): string {
  const key = `${color}|${falloff}|${darkness ? '1' : '0'}`;
  const cached = _previewCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PREVIEW_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = darkness ? '#e8e8e8' : '#1a1a1a';
  ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  const cx = PREVIEW_SIZE / 2;
  const cy = PREVIEW_SIZE / 2;
  const r = PREVIEW_SIZE / 2 - 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  const hex = color.replace('#', '');
  const hi = darkness ? '000000' : hex.length === 6 ? hex : 'ffffff';
  const stops = 12;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    const a = Math.max(0, Math.min(1, falloffMultiplier(t * 20, 20, falloff)));
    grad.addColorStop(
      t,
      `#${hi}${Math.round(a * 255)
        .toString(16)
        .padStart(2, '0')}`,
    );
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  const url = canvas.toDataURL();
  _previewCache.set(key, url);
  return url;
}

/** Channel-invert a hex color (#rrggbb → #RRGGBB where each byte = 255 - byte). */
function complementHex(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#4466ff';
  const n = parseInt(m[1]!, 16);
  const r = 255 - ((n >> 16) & 0xff);
  const g = 255 - ((n >> 8) & 0xff);
  const b = 255 - (n & 0xff);
  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
}

function normalizeHexColor(v: string): string {
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    const r = v[1]!;
    const g = v[2]!;
    const b = v[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return '#ffffff';
}

// ─── Open / Close ────────────────────────────────────────────────────────────

function refreshFromState(): void {
  if (!panel || !body) return;
  const light = getLight();
  if (!light) {
    closeLightEditDialog(false);
    return;
  }
  renderBody(light);
}

export function openLightEditDialog(lightId: number): void {
  if (!panel || !body) return;
  // Different light requested while already open — apply current, then reopen.
  if (isOpen && currentLightId != null && currentLightId !== lightId) {
    closeLightEditDialog(false);
  }
  if (isOpen) return;
  const light = state.dungeon.metadata.lights.find((l) => l.id === lightId);
  if (!light) return;

  currentLightId = lightId;
  snapshot = JSON.parse(JSON.stringify(light));
  undoDepthOnOpen = state.undoStack.length;
  pushUndo('Edit light');

  isOpen = true;
  panel.style.display = '';
  state.selectedLightId = lightId;
  refreshFromState();
}

export function closeLightEditDialog(revert: boolean): void {
  if (!isOpen || !panel) return;
  if (revert && snapshot) {
    const meta = state.dungeon.metadata;
    const idx = meta.lights.findIndex((l) => l.id === snapshot!.id);
    if (idx >= 0) {
      // Replace the whole object — simpler than field-by-field restore and
      // handles delete/add of optional keys (animation, cookie, etc.).
      meta.lights[idx] = JSON.parse(JSON.stringify(snapshot));
    }
    if (state.undoStack.length > undoDepthOnOpen) {
      state.undoStack.length = undoDepthOnOpen;
    }
    invalidateLightmap(false);
    markDirty();
    notify('lighting');
    requestRender();
  }
  panel.style.display = 'none';
  isOpen = false;
  currentLightId = null;
  snapshot = null;
  undoDepthOnOpen = -1;
}

export function isLightEditDialogOpen(): boolean {
  return isOpen;
}

// ─── Drag (header) ───────────────────────────────────────────────────────────

function onDragStart(e: MouseEvent): void {
  if (e.button !== 0 || !panel) return;
  const target = e.target as HTMLElement;
  if (target.classList.contains('pe-close')) return;
  const rect = panel.getBoundingClientRect();
  drag.active = true;
  drag.offsetX = e.clientX - rect.left;
  drag.offsetY = e.clientY - rect.top;
  panel.classList.add('pe-dragging');
  e.preventDefault();
}

function onDragMove(e: MouseEvent): void {
  if (!drag.active || !panel) return;
  const x = e.clientX - drag.offsetX;
  const y = e.clientY - drag.offsetY;
  const maxX = window.innerWidth - panel.offsetWidth;
  const maxY = window.innerHeight - panel.offsetHeight;
  panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
  panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function onDragEnd(): void {
  if (!drag.active || !panel) return;
  drag.active = false;
  panel.classList.remove('pe-dragging');
}

// ─── Global keydown (Esc / Enter while open) ──────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  if (!isOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeLightEditDialog(true);
  } else if (e.key === 'Enter') {
    const target = e.target as HTMLElement | null;
    if (target && panel?.contains(target)) {
      e.preventDefault();
      closeLightEditDialog(false);
    }
  }
}

// ─── Selection sync ──────────────────────────────────────────────────────────

function onStateChanged(): void {
  if (!isOpen || currentLightId == null) return;
  const light = getLight();
  if (!light) {
    closeLightEditDialog(false);
    return;
  }
  // If the user selected a different light via the panel/list or canvas,
  // swap the dialog onto the new light.
  if (state.selectedLightId != null && state.selectedLightId !== currentLightId) {
    const requested = state.selectedLightId;
    closeLightEditDialog(false);
    openLightEditDialog(requested);
    return;
  }
  if (selfMutating) return;
  refreshFromState();
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initLightEditDialog(): void {
  panel = el('light-edit-dialog') as HTMLDivElement;
  header = panel.querySelector('.pe-header');
  body = panel.querySelector('.pe-body');
  const titleSpan = panel.querySelector('.pe-header-title');
  if (titleSpan) titleSpan.id = 'le-header-title';
  const closeBtn = panel.querySelector('.pe-close');

  closeBtn!.addEventListener('click', () => closeLightEditDialog(false));
  header!.addEventListener('mousedown', onDragStart as EventListener);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  window.addEventListener('keydown', onKeyDown, true);

  subscribe(onStateChanged, { label: 'light-edit-dialog', topics: ['lighting'] });
}
