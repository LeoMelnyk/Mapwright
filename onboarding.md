# Onboarding — Making Mapwright Usable for Other DMs

## Problem

Mapwright was built for a power-user workflow (Claude AI generates maps via API). The manual editor works but lacks discoverability — a new DM opening it for the first time won't know what to do.

## Goals

1. A new user can create their first dungeon room within 2 minutes of opening the app
2. All tools are discoverable without reading documentation
3. The learning curve is gradual — basic features first, advanced features revealed as needed

## Ideas to Explore

### In-App Tutorial (First Launch)

An interactive overlay that walks the user through creating a simple 2-room dungeon:

1. **"Click and drag to create a room"** — Highlight the Room tool, show a ghost rectangle
2. **"Create a second room next to it"** — Arrow pointing to adjacent space
3. **"Click the Door tool and place a door between them"** — Highlight Door tool, show valid door positions
4. **"Add some furniture"** — Open prop panel, show drag-to-place
5. **"Export your map!"** — Point to export button

Implementation: Overlay div with spotlight cutouts (CSS `clip-path` or canvas mask) + step counter + skip button.

Store completion state in localStorage so it doesn't show again.

### Tooltips on Tools

Every toolbar button should have a tooltip that:
- Shows the tool name
- Shows the keyboard shortcut
- Shows a 1-sentence description of what it does
- Appears on hover after 500ms delay

Current state: Need to audit what tooltips exist vs. what's missing.

### First-Launch Example Map

Instead of a blank canvas, load a small pre-built example map on first launch:
- 3-4 rooms with doors, a corridor, some props, and lighting
- Labels explaining each feature ("This is a door", "This is a brazier light")
- User can explore, modify, or start fresh with File > New

### Contextual Hints

Show small, dismissible hints when the user first uses a tool:
- First time selecting Wall tool: "Click between two cells to place a wall"
- First time opening Props panel: "Drag props onto the map, or click to place"
- First time enabling Lighting: "Click on the map to place a light source"

### Progressive Disclosure

Don't show everything at once:
- **Level 1 (always visible):** Room, Paint, Door, Erase, Props, Export
- **Level 2 (visible after first save):** Walls, Fills, Stairs, Labels, Lighting
- **Level 3 (visible in settings or on demand):** Trims, Bridges, Textures, Multi-level, Themes

Or: just use a "Simple / Advanced" toggle in the toolbar.

### Video / GIF Tutorials

Embedded in a Help panel or linked from tooltips:
- 30-second GIFs showing common workflows
- "How to connect rooms", "How to add lighting", "How to use themes"

### Keyboard Shortcut Overlay

Press `?` to show a full-screen overlay of all keyboard shortcuts, grouped by category.

## Anti-Patterns to Avoid

- Don't block the user from doing anything — hints should always be dismissible
- Don't assume the user will read text — prefer visual demonstrations
- Don't show everything at once — progressive disclosure is key
- Don't make the tutorial mandatory — power users should be able to skip immediately

## Implementation Priority

1. **Tooltips on all tools** — Lowest effort, highest immediate impact
2. **Keyboard shortcut overlay** — Standard UX pattern, easy to implement
3. **First-launch example map** — Medium effort, great first impression
4. **Interactive tutorial** — Highest effort, best onboarding experience
5. **Contextual hints** — Medium effort, ongoing value
6. **Progressive disclosure** — Requires UI restructuring, do last

## Open Questions

- Should the tutorial be skippable per-step or only as a whole?
- Should we track which features the user has discovered (analytics-free, localStorage only)?
- Is there a way to surface the AI generation workflow to non-technical DMs?
- Should the example map be theme-specific (stone dungeon vs cave vs outdoor)?
