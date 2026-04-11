# Room Templates

Reference designs for common room types. These exist to show what props, textures, and lighting work well together for a given room concept — **not** to be copy-pasted into maps.

## How to Use

Study the prop choices, density, and spatial arrangement for a room type. Then design a fresh room that fits the actual dungeon — different size, different layout, different prop mix. Every room in a dungeon should feel unique.

**Do NOT** run these templates directly into a dungeon or offset-stamp them into a larger map. That produces repetitive, lifeless rooms.

To preview a template standalone:
```bash
node tools/puppeteer-bridge.js --commands-file room-templates/throne-room.json --screenshot out.png
```

## Templates

| Template | File | Concept | Key Props |
|----------|------|---------|-----------|
| Throne Room | `throne-room.json` | Grand audience chamber | throne-dais, brazier, banner, pillar |
| Alchemist's Lab | `alchemist-lab.json` | Brewing and experimentation | alchemy-bench, alembic, ingredient-rack, bookshelf |
| Forge / Smithy | `forge.json` | Metalworking workshop | forge, anvil, bellows, trough, weapon-rack |
| Crypt / Ossuary | `crypt.json` | Burial chamber | sarcophagus, bone-pile, coffin, candelabra |
| Temple / Shrine | `temple.json` | Religious worship space | altar, pew, holy-font, candelabra, kneeling-bench |
| Wizard's Sanctum | `wizard-sanctum.json` | Arcane study | crystal-ball, magic-circle, bookshelf, arcane-pedestal |
| Prison Block | `prison-block.json` | Jail and interrogation | shackles, torture-rack, iron-maiden, pillory |

## What to Take From Each

- **Prop palette**: Which props belong together for the room's theme
- **Density**: How many props per room before it feels cluttered
- **Wall vs center placement**: Which props hug walls, which anchor the center
- **Lighting mood**: What light presets and ambient levels sell the atmosphere
- **Texture pairings**: Which floor textures complement the room type
