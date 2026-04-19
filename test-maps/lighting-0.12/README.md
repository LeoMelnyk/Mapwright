# v0.12 Lighting Test Maps

Four focused dungeons for exercising the new lighting features. PNGs next to each `.mapwright` are HQ exports at the shipped defaults — open the `.mapwright` in the editor to flip the new toggles.

---

## 01 — Shadow Theater

Long stone hall with four pillars down the middle and three light sources (flicker torch, pulsing brazier, flicker torch). The pillars cast long shadows across the floor, so this is the map to drag the **Soft Shadow** slider on.

**Try:**
- Click the center brazier light → Soft Shadow slider from 0 → 2 ft. Pillar shadow edges should fade through a visible penumbra.
- Toggle **Contact shadows** in the Ambient section. Every wall gets a subtle darker halo on the adjacent floor pixels.
- Add a **Group** value of `torches` to the two outer lights, leave the brazier ungrouped. Bottom of panel shows a "torches (2)" toggle — flip it off and the hall darkens while the center brazier stays lit.

## 02 — Stained Glass Chapel

Square arcane chamber with one saturated light in each corner (red / blue / green / yellow) plus a crystal-ball eldritch glow. Designed to stress **color stacking** — the overlap zones show magenta, cyan, etc.

**Try:**
- Select the red corner light → drag **Temp (K)** from 1500 to 10000. The color picker tracks and the preview tile updates live.
- Turn **Bloom** up to ~60% in the Ambient section. Each light bleeds into its neighbours — obvious hot colored halos form at the overlaps.
- Set all four corner lights to `group = "walls"` and the crystal-ball light to `group = "magic"`. Use the Groups section to blink each one on and off.

## 03 — The Dark Sanctum

Crypt with a bright ambient (0.7), four brazier lights in the corners, and a powerful **darkness** light at the center overlapping a sarcophagus. The darkness carves a black pocket out of the bright floor even while the braziers push light inward from the corners — magical darkness vs emissive lights.

**Try:**
- Disable the darkness light (uncheck its "Darkness" toggle) to see the room fully lit, then re-enable it.
- Drop ambient to 0 and notice the darkness halo gets subtle but still measurably subtracts where light from the braziers overlaps.
- Move the darkness light around the sanctum — it carves a travelling black pocket through whatever's lit.

## 04 — Torchlit Hall (perf stress)

16-column hall with 14 pillars and **14 animated lights** (10 flickering torches along the walls, 4 candles down the middle). The whole hall is animating every frame.

**Try:**
- Pan + zoom with all 14 lights flickering. The animation path uses the new intensity-only bake cache and the pooled `getEffectiveLight` buffer — should stay smooth.
- Add walls or prop rotations in real time — the scoped cache invalidation only rebuilds what's needed.
- Enable **Soft Shadow** 1.5 ft on every torch. Costs 4× ray-casts per invalidation, but caches thereafter — should stay interactive during pan/zoom.
- Open the devtools console and inspect `window.renderTimings` to see each lighting phase: `lighting:segments`, `lighting:propZones`, `lighting:staticBuild`, `lighting:animated`, `lighting:normalMap`, `lighting:contactShadows`.

---

## Regenerating the PNGs

All four use HQ export, which runs the same rendering pipeline the panel previews use. Regenerate after a code change with:

```bash
for n in 01-shadow-theater 02-stained-glass-chapel 03-dark-sanctum 04-torchlit-hall; do
  node tools/puppeteer-bridge.js --load test-maps/lighting-0.12/$n.mapwright --export-png test-maps/lighting-0.12/$n.png
done
```
