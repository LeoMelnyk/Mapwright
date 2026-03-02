import { getClaudeSettings } from '../claude-settings.js';
import { TOOL_DEFINITIONS, executeTool } from '../claude-tools.js';

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are an expert dungeon designer embedded in Mapwright, a D&D 5e map editor. \
You create tactically interesting, atmospheric dungeons that are fun to run at the table.

## Your capabilities
You have tools to read and modify the current dungeon map directly. \
When asked to build or modify a dungeon, use your tools — don't just describe what to do.

## Coordinate system
- Grid origin is top-left: row 0 = top edge, col 0 = left edge
- createRoom(r1, c1, r2, c2): r1,c1 = top-left corner, r2,c2 = bottom-right corner (inclusive)
- Always leave at least 1 cell of margin from all grid edges
- Rooms must not overlap each other — use suggestPlacement to find safe coordinates

## Room labels — CRITICAL RULE
- setLabel ONLY accepts {Letter}{Number} format: A1, B3, C12, etc. Any other text is rejected.
- The map context always shows "Next room label" — use that value. Never invent a label.
- Descriptive room names (Guard Room, Boss Chamber) go in your summary text, NOT on the map.
- Corridors also get room labels — createCorridor assigns one automatically.

## Dungeon design principles
**Layout:** Plan the full layout before placing anything. Sketch connections mentally first.
- Entrance (A1) near the top-left area of the grid
- Number rooms in exploration order along the main path
- Boss room furthest from entrance, requiring passage through other rooms
- Include branching paths and optional areas — avoid pure linearity
- Dead ends should contain rewards (treasure, lore) to justify exploration

**Room variety:** Every dungeon needs a mix:
- Guard room / barracks (near entrance)
- Corridor/antechamber (connects areas, adds tension)
- Puzzle or trap room (non-combat challenge)
- Feature room (shrine, chasm, flooded area — use fills)
- Boss chamber (largest room, dramatic geometry)

**Room sizing:** Always refer to the "Grid scale" section in the current map context below. \
Room sizes are given in grid cells — the context tells you exactly how many cells to use \
for each room type at this map's scale. Corridors are always 2 cells wide.

**Connecting rooms:**
- Use createCorridor(label1, label2) to connect two rooms — it handles geometry and doors automatically.
- Only use findWallBetween + setDoor directly when rooms are already touching (no gap).
- Secret doors (type "s") for hidden passages and optional areas.

**Props:** Use props to make rooms feel inhabited and purposeful.
- Guard rooms: table, chairs, weapon rack, torch
- Boss rooms: throne, altar, or a dramatic centerpiece prop
- Storage/utility rooms: barrels, crates, shelves
- Always call listProps first if unsure of available names
- Call getRoomContents before adding props to avoid duplicating existing ones

**Textures:** Apply floor/surface textures to cells for visual variety.
- Use setTextureRect to paint a whole room's floor in one step
- Always call listTextures first to find valid texture IDs
- Good uses: stone floor, wood planks, water surface, sand, grass, lava rock

**Labels:** Place at the cell closest to the room's center, clear of walls.

## Workflow
1. Call getMapInfo to understand the grid dimensions and existing content
2. Note existing rooms from the context; check "Next room label" to know what label to use next
3. Plan full layout: for each room, call suggestPlacement(rows, cols, adjacentTo?) to get safe coordinates
4. Create rooms in exploration order (entrance first) using the coordinates from suggestPlacement
5. Add room labels immediately after each room — use the "Next room label" value
6. Connect rooms with createCorridor(label1, label2) — it places doors automatically
7. Add fills (water, pit, difficult terrain) for environmental variety
8. Apply textures with setTextureRect for floor variety (call listTextures first)
9. Place props for atmosphere (call listProps first; call getRoomContents to avoid duplicates)
10. Summarize what you built — room names (from labels), key features, any DM tips

## Response style
- Be concise after building. One short paragraph describing what was made.
- Add 1-2 sentence DM tip only when genuinely useful (encounter hook, trap idea).
- Don't narrate every tool call. Just do the work, then summarize.
- For questions that don't require map changes, answer conversationally without tools.

## Few-shot examples

<example>
User: Add a small guard room connected to A1
Assistant: [calls findWallBetween("A1", ...) — but first checks getMapInfo to see what exists, then creates the guard room adjacent to A1 using mode "merge", sets label "A2", calls findWallBetween("A1","A2") to get the shared wall, places a door at the middle position, then places a table and two chairs]
Summary: Added A2 — Guard Room (5×5) south of the entrance, connected by a door. Two guards are mid-meal at a table. DC 14 Perception to hear them from A1.
</example>

<example>
User: Create a 5-room dungeon — abandoned dwarven mine
Assistant: [calls getMapInfo, plans layout for the grid, creates rooms in this order:
  A1 Mine Entrance (5×5, top-left area)
  A2 Collapsed Tunnel/Corridor (3×8, connects east)
  A3 Ore Processing Chamber (8×7, central, difficult-terrain fill for rubble)
  A4 Foreman's Office (5×5, branch north from A3, secret door)
  A5 Collapsed Shaft / Boss Chamber (10×9, south end, pit fill for the shaft)
Then doors between each, props: mine cart prop in A3, desk in A4, torch sconces throughout]
Summary: Five-room dwarven mine — entrance leads through a collapsed tunnel into the ore chamber (rough terrain from rubble). A hidden foreman's office branches north. The boss chamber features a collapsed mine shaft (pit) where a cave troll has made its lair. A4 is accessible only via secret door — good loot location.
</example>`;

// ── Context builder ──────────────────────────────────────────────────────────

/**
 * Build a rich map context string: basic info + room directory + prop catalog summary.
 * Passed as part of the system prompt each turn so Claude always has current state.
 */
function buildMapContext() {
  if (!window.editorAPI) return null;
  try {
    const info = window.editorAPI.getMapInfo();
    if (!info) return null;

    const gs = info.gridSize || 5;

    // Compute calibrated room sizes (in cells) so every room hits real D&D dimensions
    // regardless of grid scale. Target real-world sizes: tiny=10ft, small=20ft,
    // medium=30ft, large=50ft, huge=70ft. Corridors always 2 cells wide.
    const cells = (ft) => Math.max(1, Math.round(ft / gs));
    const scaleNote = [
      `## Grid scale`,
      `1 cell = ${gs} ft. Design rooms to hit these real-world sizes:`,
      `  Tight quarters (closet, alcove): ${cells(10)}×${cells(10)} – ${cells(15)}×${cells(15)} cells (${cells(10)*gs}–${cells(15)*gs} ft)`,
      `  Guard post / small chamber:      ${cells(20)}×${cells(20)} – ${cells(25)}×${cells(25)} cells (${cells(20)*gs}–${cells(25)*gs} ft)`,
      `  Standard encounter room:         ${cells(30)}×${cells(30)} – ${cells(40)}×${cells(40)} cells (${cells(30)*gs}–${cells(40)*gs} ft)`,
      `  Great hall / throne room:        ${cells(50)}×${cells(50)} – ${cells(60)}×${cells(60)} cells (${cells(50)*gs}–${cells(60)*gs} ft)`,
      `  Boss chamber:                    ${cells(60)}×${cells(60)} – ${cells(70)}×${cells(70)} cells (${cells(60)*gs}–${cells(70)*gs} ft)`,
      `  Corridor width: 2 cells (${2*gs} ft)`,
    ].join('\n');

    const lines = [
      `## Current map: "${info.name}"`,
      `Grid: ${info.rows} rows × ${info.cols} cols | ${gs} ft/square`,
      `Theme: ${info.theme} | Labels: ${info.labelCount} | Props: ${info.propCount}`,
      ``,
      scaleNote,
    ];

    // Extract room directory from cells
    const map = window.editorAPI.getMap();
    if (map?.cells) {
      const labels = new Map(); // label text → first cell found
      for (const [key, cell] of Object.entries(map.cells)) {
        const label = cell?.center?.label;
        if (label && !labels.has(label)) {
          const [r, c] = key.split(',').map(Number);
          labels.set(label, { r, c });
        }
      }

      // Compute next available room label (mirrors tool-label.js _getNextRoomNumber logic)
      const dungeonLetter = map?.metadata?.dungeonLetter || 'A';
      const labelPat = new RegExp(`^${dungeonLetter}(\\d+)$`);
      const usedNums = new Set();
      for (const cell of Object.values(map?.cells ?? {})) {
        const m = cell?.center?.label?.match(labelPat);
        if (m) usedNums.add(parseInt(m[1]));
      }
      let nextN = 1;
      while (usedNums.has(nextN)) nextN++;
      lines.push(`\nNext room label: ${dungeonLetter}${nextN}`);

      if (labels.size > 0) {
        lines.push('\n## Existing rooms (label → bounds)');
        for (const [label, { r, c }] of labels) {
          try {
            const bounds = window.editorAPI.getRoomBounds(label);
            if (bounds) {
              lines.push(
                `  ${label}: rows ${bounds.r1}–${bounds.r2}, cols ${bounds.c1}–${bounds.c2}` +
                ` (center ${bounds.centerRow},${bounds.centerCol})`
              );
            } else {
              lines.push(`  ${label}: label at (${r},${c})`);
            }
          } catch {
            lines.push(`  ${label}: label at (${r},${c})`);
          }
        }
      } else {
        lines.push('The map is currently empty — no rooms placed yet.');
      }
    }

    // Available prop categories (names omitted to save tokens — call listProps tool to see them)
    try {
      const propInfo = window.editorAPI.listProps();
      if (propInfo?.categories?.length) {
        lines.push(`\n## Available prop categories: ${propInfo.categories.join(', ')}`);
        lines.push(`(Use the listProps tool to see individual prop names within each category.)`);
      }
    } catch { /* prop catalog unavailable */ }

    return lines.join('\n');
  } catch {
    return null;
  }
}

// ── Panel state ──────────────────────────────────────────────────────────────

let _container = null;
let _messages = []; // Anthropic message history
let _abortController = null; // non-null while a request is in flight
let _sessionTokens = { input: 0, output: 0 }; // cumulative for current chat session

// Cost per million tokens (USD) — update if Anthropic changes pricing
const MODEL_COSTS = {
  'claude-opus-4-6':          { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':        { input:  3.00, output: 15.00 },
  'claude-haiku-4-5-20251001':{ input:  0.80, output:  4.00 },
};

export function initClaudePanel(containerEl) {
  _container = containerEl;
  render();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!_container) return;
  _container.innerHTML = `<div class="claude-chat">
    <div class="claude-message-list" id="claude-message-list"></div>
    <div class="claude-token-bar" id="claude-token-bar" style="display:none"></div>
    <div class="claude-input-row">
      <textarea class="claude-input" id="claude-input" placeholder="Ask Claude to build or modify your dungeon…" rows="2"></textarea>
      <button class="claude-send-btn" id="claude-send-btn" title="Send">
        <svg class="icon-send" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 8L14 2L8 14L7 9L2 8Z" fill="currentColor"/>
        </svg>
        <svg class="icon-stop" width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:none">
          <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/>
        </svg>
      </button>
    </div>
  </div>`;

  renderMessages();
  wireEvents();
}

function renderMessages() {
  const list = document.getElementById('claude-message-list');
  if (!list) return;

  if (_messages.length === 0) {
    list.innerHTML = `<div class="claude-empty-state">
      <div class="claude-empty-icon">✦</div>
      <div class="claude-empty-title">Claude AI Assistant</div>
      <div class="claude-empty-hint">Ask me to create rooms, add doors, place props, change themes — anything about your dungeon.</div>
      <div class="claude-empty-hint">Make sure your API key is set in <strong>Help → Claude Settings</strong>.</div>
    </div>`;
    return;
  }

  list.innerHTML = _messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      if (m.role === 'user') {
        const text = Array.isArray(m.content)
          ? m.content.filter(b => b.type === 'text').map(b => b.text).join('')
          : m.content;
        // Skip tool result messages (they look like user messages but are [{type:'tool_result'}])
        if (Array.isArray(m.content) && m.content.every(b => b.type === 'tool_result')) return '';
        return `<div class="claude-message claude-message-user"><div class="claude-bubble">${escHtml(text)}</div></div>`;
      } else {
        const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
        const textBlocks = blocks.filter(b => b.type === 'text');
        if (textBlocks.length === 0) return '';
        const text = textBlocks.map(b => b.text).join('');
        return `<div class="claude-message claude-message-assistant"><div class="claude-bubble">${formatMarkdown(text)}</div></div>`;
      }
    })
    .join('');

  list.scrollTop = list.scrollHeight;
}

function wireEvents() {
  const sendBtn = document.getElementById('claude-send-btn');
  const input = document.getElementById('claude-input');
  if (!sendBtn || !input) return;

  sendBtn.addEventListener('click', () => {
    if (_abortController) stopGeneration();
    else sendMessage();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (_abortController) stopGeneration();
      else sendMessage();
    }
  });
}

// ── Message handling ─────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('claude-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const settings = getClaudeSettings();
  if (!settings.apiKey) {
    appendErrorMessage('No API key configured. Go to Help → Claude Settings to add your Anthropic API key.');
    return;
  }

  input.value = '';
  _abortController = new AbortController();
  setProcessing(true);

  _messages.push({ role: 'user', content: text });
  renderMessages();
  showThinking();

  try {
    await runConversationLoop(settings, _abortController.signal);
  } catch (err) {
    hideThinking();
    if (err.name !== 'AbortError') {
      appendErrorMessage(`Error: ${err.message}`);
    }
  } finally {
    _abortController = null;
    setProcessing(false);
    input.focus();
  }
}

async function runConversationLoop(settings, signal) {
  let toolsUsed = 0;

  // Build context once per user message, not once per tool iteration.
  // Re-building every loop turn multiplies token usage by the number of tool calls.
  const mapContext = buildMapContext();
  const system = SYSTEM_PROMPT + (mapContext ? `\n\n${mapContext}` : '');

  // Capture undo depth before any changes so we can offer "Undo all" after.
  const startUndoDepth = window.editorAPI?.getUndoDepth?.() ?? null;

  const readOnlyTools = new Set(['getMapInfo', 'getCellInfo', 'getRoomBounds', 'findWallBetween',
    'listProps', 'listTextures', 'getBridges', 'getRoomContents', 'suggestPlacement']);

  const model = settings.model || 'claude-opus-4-6';

  while (true) {
    const response = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: _messages,
        apiKey: settings.apiKey,
        model,
        tools: TOOL_DEFINITIONS,
        system,
      }),
      signal,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }

    // Accumulate token usage from every API response
    if (data.usage) {
      _sessionTokens.input  += data.usage.input_tokens  ?? 0;
      _sessionTokens.output += data.usage.output_tokens ?? 0;
      updateTokenDisplay(model);
    }

    _messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn') {
      hideThinking();
      renderMessages();
      if (toolsUsed > 0 && startUndoDepth !== null) {
        showUndoToast(startUndoDepth);
      }
      return;
    }

    if (data.stop_reason === 'tool_use') {
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolUseBlocks) {
        updateThinkingText(block.name);
        const result = executeTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
        if (!readOnlyTools.has(block.name)) toolsUsed++;
      }

      _messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason
    hideThinking();
    renderMessages();
    return;
  }
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function setProcessing(active) {
  const btn   = document.getElementById('claude-send-btn');
  const input = document.getElementById('claude-input');
  if (!btn || !input) return;
  input.disabled = active;
  btn.classList.toggle('claude-btn-stop', active);
  btn.title = active ? 'Stop' : 'Send';
  btn.querySelector('.icon-send').style.display = active ? 'none' : '';
  btn.querySelector('.icon-stop').style.display = active ? ''     : 'none';
}

function stopGeneration() {
  _abortController?.abort();
  hideThinking();
  // Add a soft visual indicator that the user stopped the response
  const list = document.getElementById('claude-message-list');
  if (list) {
    const el = document.createElement('div');
    el.className = 'claude-message claude-message-assistant';
    el.innerHTML = '<div class="claude-bubble claude-stopped">Stopped.</div>';
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  }
}

function updateTokenDisplay(model) {
  const bar = document.getElementById('claude-token-bar');
  if (!bar) return;
  const { input, output } = _sessionTokens;
  const total = input + output;
  if (total === 0) { bar.style.display = 'none'; return; }

  const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const costs = MODEL_COSTS[model] ?? MODEL_COSTS['claude-sonnet-4-6'];
  const cost = (input / 1e6) * costs.input + (output / 1e6) * costs.output;
  const costStr = cost < 0.01 ? `<$0.01` : `$${cost.toFixed(2)}`;

  bar.style.display = '';
  bar.textContent = `Session: ↑${fmt(input)} ↓${fmt(output)} ≈ ${costStr}`;
}

function showThinking() {
  const list = document.getElementById('claude-message-list');
  if (!list) return;
  const el = document.createElement('div');
  el.className = 'claude-message claude-message-assistant claude-thinking-row';
  el.id = 'claude-thinking';
  el.innerHTML = '<div class="claude-bubble claude-thinking"><span class="claude-thinking-label"></span><span></span><span></span><span></span></div>';
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

function hideThinking() {
  document.getElementById('claude-thinking')?.remove();
}

function updateThinkingText(toolName) {
  const label = document.querySelector('#claude-thinking .claude-thinking-label');
  if (!label) return;
  const LABELS = {
    getMapInfo: 'Reading map', getCellInfo: 'Inspecting cell', getRoomBounds: 'Checking room',
    getRoomContents: 'Reading room contents', findWallBetween: 'Finding wall',
    listProps: 'Checking props', listTextures: 'Checking textures', getBridges: 'Checking bridges',
    suggestPlacement: 'Finding space',
    createRoom: 'Creating room', createCorridor: 'Creating corridor', createTrim: 'Trimming corner',
    setLabel: 'Labelling room', setDoor: 'Placing door', removeDoor: 'Removing door',
    setWall: 'Setting wall', removeWall: 'Removing wall', removeLabel: 'Removing label',
    setFill: 'Adding fill', setFillRect: 'Adding fill', removeFill: 'Clearing fill', removeFillRect: 'Clearing fill',
    setTheme: 'Changing theme', setName: 'Setting name', setFeature: 'Toggling feature',
    setTexture: 'Applying texture', setTextureRect: 'Applying texture',
    floodFillTexture: 'Painting texture', removeTexture: 'Clearing texture', removeTextureRect: 'Clearing texture',
    placeProp: 'Placing prop', rotateProp: 'Rotating prop',
    placeLight: 'Placing light', addStairs: 'Adding stairs', linkStairs: 'Linking stairs',
    addBridge: 'Adding bridge', removeBridge: 'Removing bridge',
    paintCell: 'Painting cell', paintRect: 'Painting area', eraseCell: 'Erasing cell', eraseRect: 'Erasing area',
    setHazard: 'Marking hazard', setHazardRect: 'Marking hazard', mergeRooms: 'Merging rooms',
    newMap: 'Creating new map',
  };
  label.textContent = (LABELS[toolName] ?? toolName) + '…';
}

function showUndoToast(startDepth) {
  const list = document.getElementById('claude-message-list');
  if (!list) return;
  const toast = document.createElement('div');
  toast.className = 'claude-undo-toast';
  toast.innerHTML = `<span>Claude made changes.</span><button class="claude-undo-all-btn">Undo all</button>`;
  toast.querySelector('.claude-undo-all-btn').addEventListener('click', () => {
    window.editorAPI?.undoToDepth(startDepth);
    toast.remove();
    window.showToast?.('All Claude changes undone.');
  });
  list.appendChild(toast);
  list.scrollTop = list.scrollHeight;
  setTimeout(() => toast.remove(), 15000);
}

function appendErrorMessage(text) {
  _messages.push({ role: 'assistant', content: [{ type: 'text', text: `⚠ ${text}` }] });
  renderMessages();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMarkdown(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
