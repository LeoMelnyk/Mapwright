import { getClaudeSettings } from '../claude-settings.js';
import { TOOL_DEFINITIONS, executeTool } from '../claude-tools.js';

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a dungeon-building tool for Mapwright. Complete every request by calling tools immediately.

## FORBIDDEN — never do these things

- Ask "what would you like to do?" or "what should I…?"
- Present a numbered or bulleted menu of options for the user to choose from
- Say "I can help you with…", "Would you like me to…", "Shall I…", "Let me know if…"
- Describe or summarize the current map state back to the user unless they explicitly asked for it
- Stop after a read-only tool call and ask for direction — inspection results feed into your next write tool call, not into a question
- Tell the user what you are about to do instead of doing it

## Decision rules

**For creation requests** ("make me a dungeon", "add a room", "place some lights"): choose a specific design yourself — pick room sizes, shapes, theme, props — then call the appropriate tool. State your design choice in one sentence AFTER the tool calls.

**For ambiguous requests**: make a reasonable creative interpretation, act on it, then briefly explain what you chose and why.

**For inspection requests** ("what rooms exist?", "what's at row 3, col 4?"): call the appropriate read tool and report the result concisely.

**Inspection → write chain**: if you call suggestPlacement, getRoomBounds, listRooms, getMapInfo, or any read tool to plan a change, you MUST follow it immediately with write tool calls — never with a question.

## Tool strategy

**Building or rebuilding a dungeon** → use planBrief to lay out rooms and connections, then furnish with placeProp, setTexture, placeLight tools. Design the entire layout yourself in one shot. Do NOT ask the user to design it.

**Modifying an existing map** → call listRooms/getMapInfo first to understand the layout, then use individual tools for changes.

**Targeted single changes** → use individual tools: setTheme, setName, placeProp, removeProp, placeLight, placeLightInRoom, removeLight, setFill, setTexture, setDoor, addStairs, removeStairs, addBridge, addLevel, setHazard, setHazardRect, etc.

## Available themes
stone-dungeon, crypt, earth-cave, ice-cave, water-temple, underdark, volcanic, swamp, desert, dirt, grasslands, snow-tundra, arcane, alien, blue-parchment, sepia-parchment

If you made changes to the map: write one short paragraph saying what was built or changed, then give 1 DM tip. No questions, no "let me know", no offers to do more.
If you only answered a question (no writes): respond concisely and stop.`;



// ── Context builder ──────────────────────────────────────────────────────────

/**
 * Build a rich map context for the AI.
 * Uses getFullMapInfo() to provide room layout, props, doors, and lights,
 * then appends scale info, next label, and available props/textures.
 */
function buildMapContext() {
  if (!window.editorAPI) return null;
  try {
    const info = window.editorAPI.getMapInfo();
    if (!info) return null;

    const gs = info.gridSize || 5;
    const c = (ft) => Math.max(1, Math.round(ft / gs));

    const lines = [
      `## Current map: "${info.name}"`,
      `Grid: ${info.rows} rows × ${info.cols} cols | ${gs} ft/cell | Theme: ${info.theme}`,
      '',
      `## Grid scale (cells at ${gs} ft/cell)`,
      `  Small room (guard post): ${c(20)}×${c(20)} cells`,
      `  Medium room (encounter): ${c(30)}×${c(30)} cells`,
      `  Large room / great hall: ${c(50)}×${c(50)} cells`,
      `  Boss chamber:            ${c(60)}×${c(60)} cells`,
      `  Corridor width: 2 cells`,
      '',
    ];

    // ── Room layout summary from getFullMapInfo ───────────────────────────
    try {
      const full = window.editorAPI.getFullMapInfo();
      if (full?.rooms?.length) {
        lines.push('## Rooms');
        for (const room of full.rooms) {
          const b = room.bounds;
          const dims = b ? `rows ${b.r1}-${b.r2}, cols ${b.c1}-${b.c2}` : 'unknown bounds';
          lines.push(`  ${room.label}: ${dims}`);
        }
        if (full.doors?.length) {
          lines.push('');
          lines.push(`## Doors: ${full.doors.length}`);
        }
        if (full.props?.length) {
          lines.push(`## Props: ${full.props.length}`);
        }
      } else {
        lines.push('The map is currently empty — no rooms placed yet.');
      }
    } catch { /* info unavailable */ }

    // ── Next room label ───────────────────────────────────────────────────
    try {
      const map = window.editorAPI.getMap();
      const dungeonLetter = map?.metadata?.dungeonLetter || 'A';
      const labelPat = new RegExp(`^${dungeonLetter}(\\d+)$`);
      const usedNums = new Set();
      for (const row of map?.cells ?? []) {
        if (!row) continue;
        for (const cell of row) {
          const m = cell?.center?.label?.match(labelPat);
          if (m) usedNums.add(parseInt(m[1]));
        }
      }
      let nextN = 1;
      while (usedNums.has(nextN)) nextN++;
      lines.push(`\nNext room label: ${dungeonLetter}${nextN}`);
    } catch { /* label unavailable */ }

    // ── Levels (multi-level maps) ─────────────────────────────────────────
    try {
      const levels = window.editorAPI.getLevels();
      if (levels?.length > 1) {
        const summary = levels.map((l, i) => `  Level ${i + 1}: "${l.name}" (rows ${l.startRow}–${l.startRow + l.numRows - 1})`).join('\n');
        lines.push(`\n## Levels (${levels.length} total — use getLevels for full info)`);
        lines.push(summary);
      }
    } catch { /* levels unavailable */ }

    // ── Lights ────────────────────────────────────────────────────────────
    try {
      const lightsResult = window.editorAPI.getLights();
      const lights = lightsResult?.lights ?? [];
      if (lights.length > 0) {
        const enabled = lightsResult?.lightingEnabled ? 'enabled' : 'disabled';
        const ambient = lightsResult?.ambientLight != null ? `, ambient: ${lightsResult.ambientLight}` : '';
        lines.push(`\n## Lights: ${lights.length} light(s) on map (lighting ${enabled}${ambient}) — call getLights for full list`);
      }
    } catch { /* lights unavailable */ }

    // ── Available props (compact list for .map props: section) ──────────────
    try {
      const propInfo = window.editorAPI.listProps();
      if (propInfo?.props && Object.keys(propInfo.props).length > 0) {
        const names = Object.keys(propInfo.props).sort().join(', ');
        lines.push(`\n## Valid prop names for props: section`);
        lines.push(names);
      }
    } catch { /* prop catalog unavailable */ }

    return lines.join('\n');
  } catch {
    return null;
  }
}

// ── AI session logger ────────────────────────────────────────────────────────
// Mirrors [AI] console logs to ai-session.log on disk so they can be read
// externally. Each new user message resets the file via resetAILog().

function aiLog(...args) {
  console.log(...args);
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  fetch('/api/ai-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line }),
  }).catch(() => {});
}

function resetAILog() {
  fetch('/api/ai-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true, line: `=== Session ${new Date().toISOString()} ===` }),
  }).catch(() => {});
}

// ── Panel state ──────────────────────────────────────────────────────────────

let _container = null;
const _messages = []; // Anthropic message history
let _abortController = null; // non-null while a request is in flight
const _sessionTokens = { input: 0, output: 0 }; // cumulative for current chat session
let _ollamaStatus = null; // { running, models } — set on init
let _streamingEl = null; // <span> inside live streaming bubble, null when not streaming
let _planMode = false;       // true when plan-before-act mode is on
let _pendingPlanIdx = -1;    // _messages index of the awaiting-execute plan (-1 = none)
const _hiddenMsgIdxs = new Set(); // indices of injected system messages to hide from UI

export function initClaudePanel(containerEl) {
  _container = containerEl;
  render();
  checkOllamaStatus();
}

async function checkOllamaStatus() {
  const settings = getClaudeSettings();
  const base = settings.ollamaBase || 'http://localhost:11434';
  try {
    const r = await fetch(`/api/ollama-status?base=${encodeURIComponent(base)}`);
    _ollamaStatus = await r.json();
  } catch {
    _ollamaStatus = { running: false, models: [] };
  }
  updateStatusDot();
  if (_messages.length === 0) renderMessages();
}

function updateStatusDot() {
  const dot = document.getElementById('claude-status-dot');
  if (!dot) return;
  dot.classList.toggle('offline', !_ollamaStatus?.running);
  dot.title = _ollamaStatus?.running ? 'Ollama running' : 'Ollama not detected';
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!_container) return;
  _container.innerHTML = `<div class="claude-chat">
    <div class="claude-chat-header">
      <span class="claude-chat-title">AI Assistant</span>
      <button id="claude-plan-toggle" class="claude-plan-toggle" title="Plan mode — AI writes a plan before building">Plan</button>
      <span id="claude-status-dot" class="claude-status-dot offline" title="Checking Ollama…"></span>
    </div>
    <div class="claude-message-list" id="claude-message-list"></div>
    <div class="claude-token-bar" id="claude-token-bar" style="display:none"></div>
    <div class="claude-input-row">
      <textarea class="claude-input" id="claude-input" placeholder="Ask me to build or modify your dungeon…" rows="2"></textarea>
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
    const settings = getClaudeSettings();
    const model = settings.model || 'qwen3.5:9b';
    let setupHtml = '';
    if (_ollamaStatus && !_ollamaStatus.running) {
      setupHtml = `<div class="claude-setup-card">
        <div class="claude-setup-title">Ollama not detected</div>
        <p>Install Ollama to use AI dungeon generation:</p>
        <ol>
          <li>Download from <strong>ollama.com</strong></li>
          <li>Run: <code>ollama pull ${escHtml(model)}</code></li>
          <li>Restart Mapwright</li>
        </ol>
        <p class="claude-setup-hint">Configure the URL in <strong>Help → AI Settings</strong>.</p>
      </div>`;
    } else if (_ollamaStatus?.running && _ollamaStatus.models.length > 0) {
      const baseName = model.split(':')[0];
      if (!_ollamaStatus.models.some(m => m.startsWith(baseName))) {
        setupHtml = `<div class="claude-setup-card">
          <div class="claude-setup-title">Model not pulled</div>
          <p>Run this command, then refresh:</p>
          <code>ollama pull ${escHtml(model)}</code>
        </div>`;
      }
    }
    list.innerHTML = `<div class="claude-empty-state">
      <div class="claude-empty-icon">✦</div>
      <div class="claude-empty-title">AI Dungeon Assistant</div>
      ${setupHtml || '<div class="claude-empty-hint">Ask me to create rooms, add doors, place props, change themes — anything about your dungeon.</div>'}
    </div>`;
    return;
  }

  list.innerHTML = _messages
    .map((m, idx) => {
      if (_hiddenMsgIdxs.has(idx)) return '';
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
        const bubble = `<div class="claude-message claude-message-assistant"><div class="claude-bubble">${formatMarkdown(text)}</div></div>`;
        if (idx === _pendingPlanIdx) {
          return bubble + `<div class="claude-plan-actions"><button class="claude-execute-btn">Execute Plan</button></div>`;
        }
        return bubble;
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

  document.getElementById('claude-plan-toggle')
    ?.addEventListener('click', togglePlanMode);

  // Execute button — event delegation so it survives renderMessages() re-renders
  document.getElementById('claude-message-list')
    ?.addEventListener('click', e => {
      if (e.target.classList.contains('claude-execute-btn')) executePlan();
    });
}

// ── Plan mode ─────────────────────────────────────────────────────────────────

function togglePlanMode() {
  _planMode = !_planMode;
  _pendingPlanIdx = -1;
  const btn = document.getElementById('claude-plan-toggle');
  if (btn) btn.classList.toggle('claude-plan-active', _planMode);
}

async function executePlan() {
  _pendingPlanIdx = -1;
  const wasInPlanMode = _planMode;
  _planMode = false;   // run execution in normal mode (tools allowed)

  const settings = getClaudeSettings();
  _abortController = new AbortController();
  setProcessing(true);

  _messages.push({ role: 'user', content: 'Execute the plan.' });
  renderMessages();
  showThinking();

  try {
    await runConversationLoop(settings, _abortController.signal);
  } catch (err) {
    aiLog('[AI] executePlan error:', err.name, err.message);
    hideThinking();
    if (err.name !== 'AbortError') appendErrorMessage(`Error: ${err.message}`);
  } finally {
    _planMode = wasInPlanMode;
    _abortController = null;
    setProcessing(false);
    document.getElementById('claude-input')?.focus();
  }
}

// ── Message handling ─────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('claude-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const settings = getClaudeSettings();

  input.value = '';
  resetAILog();
  _abortController = new AbortController();
  setProcessing(true);

  _messages.push({ role: 'user', content: text });
  renderMessages();
  showThinking();

  try {
    await runConversationLoop(settings, _abortController.signal);
    // In plan mode, detect if the AI wrote a plan (no tool calls) and show Execute button
    if (_planMode && _pendingPlanIdx === -1) {
      const last = _messages[_messages.length - 1];
      if (last?.role === 'assistant') {
        const blocks = Array.isArray(last.content)
          ? last.content : [{ type: 'text', text: last.content }];
        if (!blocks.some(b => b.type === 'tool_use')) {
          _pendingPlanIdx = _messages.length - 1;
          renderMessages();
        }
      }
    }
  } catch (err) {
    aiLog('[AI] caught error:', err.name, err.message, err);
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

// ── Streaming bubble helpers ──────────────────────────────────────────────────

function showStreamingBubble() {
  hideThinking();
  const list = document.getElementById('claude-message-list');
  if (!list) return;
  const el = document.createElement('div');
  el.className = 'claude-message claude-message-assistant';
  el.innerHTML = '<div class="claude-bubble claude-streaming"><span class="claude-streaming-text"></span><span class="claude-cursor"></span></div>';
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
  _streamingEl = el.querySelector('.claude-streaming-text');
}

function updateStreamingBubble(text) {
  if (!_streamingEl) return;
  _streamingEl.textContent += text;
  const list = document.getElementById('claude-message-list');
  if (list) list.scrollTop = list.scrollHeight;
}

function finalizeStreamingBubble() {
  if (!_streamingEl) return;
  const bubble = _streamingEl.closest('.claude-bubble');
  if (bubble) {
    const text = _streamingEl.textContent;
    bubble.innerHTML = formatMarkdown(text);
    bubble.classList.remove('claude-streaming');
  }
  _streamingEl = null;
}

// ── Streaming fetch ───────────────────────────────────────────────────────────

async function fetchStreamingResponse(body, signal) {
  aiLog('[AI] fetch start — model:', body.model, '| tools:', body.tools?.length, '| messages:', body.messages?.length);

  const response = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  aiLog('[AI] response status:', response.status);

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    aiLog('[AI] response error:', data);
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let accText = '';
  let toolUseBlocks = [];
  let eventCount = 0;

   
  while (true) {
    const { done, value } = await reader.read();
    if (done) { aiLog('[AI] stream done (reader exhausted)'); break; }

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') { aiLog('[AI] [DONE] received'); break; }

      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }

      eventCount++;
      if (eventCount <= 5 || parsed.type !== 'text_delta') {
        aiLog('[AI] event:', JSON.stringify(parsed).slice(0, 120));
      }

      if (parsed.type === 'text_delta') {
        if (!_streamingEl) showStreamingBubble();
        updateStreamingBubble(parsed.text);
        accText += parsed.text;
      } else if (parsed.type === 'tool_use') {
        aiLog('[AI] tool_use blocks:', parsed.blocks?.map(b => b.name));
        toolUseBlocks = parsed.blocks;
      }
    }
  }

  finalizeStreamingBubble();

  aiLog('[AI] stream complete — accText length:', accText.length, '| tool blocks:', toolUseBlocks.length, '| total events:', eventCount);

  const content = [];
  if (accText) content.push({ type: 'text', text: accText });
  for (const b of toolUseBlocks) content.push(b);
  return {
    content,
    stop_reason: toolUseBlocks.length > 0 ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 }, // Ollama streaming doesn't report usage
  };
}

async function runConversationLoop(settings, signal) {
  let toolsUsed = 0;

  // Build context once per user message, not once per tool iteration.
  // Re-building every loop turn multiplies token usage by the number of tool calls.
  const mapContext = buildMapContext();
  const planInstruction = _planMode
    ? `\n\nPLAN MODE: You may call read-only tools (getMapInfo, listRooms, getFullMapInfo, etc.) to understand the current map, but do NOT call any write tools. Do NOT ask clarifying questions. Make all creative decisions yourself — choose room sizes, positions, connections, theme, props, and doors. After any tool calls, write a concise numbered plan listing every element you will create. End your plan text with a line containing only "---". The user will click Execute to build it.`
    : '';
  const system = SYSTEM_PROMPT + planInstruction + (mapContext ? `\n\n${mapContext}` : '');

  // Capture undo depth before any changes so we can offer "Undo all" after.
  const startUndoDepth = window.editorAPI?.getUndoDepth?.() ?? null;

  const readOnlyTools = new Set(['getMapInfo', 'getFullMapInfo', 'getCellInfo', 'getRoomBounds',
    'findWallBetween', 'listProps', 'listTextures', 'getBridges', 'getRoomContents', 'suggestPlacement', 'listRooms']);

  const model = settings.model || 'qwen3.5:9b';

  const MAX_ITERATIONS = 15;
  const MAX_PLAN_ITERATIONS = 5; // plan phase should inspect briefly then write
  let iteration = 0;
  let planNudgeSent = false;
  while (true) {
    iteration++;
    aiLog(`[AI] loop iteration ${iteration}`);

    if (iteration > MAX_ITERATIONS) {
      hideThinking();
      appendErrorMessage(`Stopped after ${MAX_ITERATIONS} tool calls — the map may be incomplete. Try a simpler request or use "Undo all".`);
      renderMessages();
      return;
    }

    // In plan mode: after MAX_PLAN_ITERATIONS read-only calls, nudge the AI to write the plan
    if (_planMode && !planNudgeSent && iteration > MAX_PLAN_ITERATIONS) {
      planNudgeSent = true;
      _messages.push({ role: 'user', content: "You've gathered enough information. Write your complete plan now — do not call any more tools." });
      _hiddenMsgIdxs.add(_messages.length - 1);
    }

    const data = await fetchStreamingResponse({
      messages: _messages,
      ollamaBase: settings.ollamaBase,
      model,
      tools: _planMode ? TOOL_DEFINITIONS.filter(t => readOnlyTools.has(t.name)) : TOOL_DEFINITIONS,
      system,
    }, signal);

    aiLog('[AI] stop_reason:', data.stop_reason, '| content blocks:', data.content.length);
    _messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn') {
      hideThinking();
      renderMessages();
      updateTokenDisplay();
      if (toolsUsed > 0 && startUndoDepth !== null) {
        showUndoToast(startUndoDepth);
      }
      return;
    }

    if (data.stop_reason === 'tool_use') {
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      hideThinking(); // clear any existing before re-showing
      showThinking();
      for (const block of toolUseBlocks) {
        aiLog('[AI] executing tool:', block.name, JSON.stringify(block.input).slice(0, 80));
        updateThinkingText(block.name);
        let result;
        try {
          result = await Promise.resolve(executeTool(block.name, block.input));
        } catch (toolErr) {
          result = { error: `${block.name} failed: ${toolErr.message}` };
        }
        aiLog('[AI] tool result:', JSON.stringify(result).slice(0, 120));
        // Truncate large tool results to prevent context bloat.
        // Catalog and export tools are never truncated (bounded or needed in full).
        // For other tools: try smart array-level truncation before falling back to char-slice.
        const NO_TRUNCATE = new Set([
          'listProps', 'listTextures', 'listLightPresets', 'listRooms', 'listThemes',
        ]);
        const MAX_RESULT = 3000;
        let resultStr = JSON.stringify(result);
        if (!NO_TRUNCATE.has(block.name) && resultStr.length > MAX_RESULT) {
          // Try trimming arrays at item boundaries before doing a raw char-slice
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const trimmed = { ...result };
            for (const [k, v] of Object.entries(trimmed)) {
              if (Array.isArray(v) && JSON.stringify(v).length > 400) {
                const kept = Math.max(1, Math.ceil(v.length / 2));
                if (kept < v.length) {
                  trimmed[k] = v.slice(0, kept);
                  trimmed[`${k}_note`] = `showing ${kept}/${v.length} items`;
                }
              }
            }
            const trimmedStr = JSON.stringify(trimmed);
            if (trimmedStr.length < resultStr.length) resultStr = trimmedStr;
          }
          if (resultStr.length > MAX_RESULT) {
            resultStr = resultStr.slice(0, MAX_RESULT) + '… [truncated]';
          }
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultStr,
        });
        if (!readOnlyTools.has(block.name)) toolsUsed++;
      }

      _messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason
    aiLog('[AI] unexpected stop_reason:', data.stop_reason);
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
  finalizeStreamingBubble();
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

function updateTokenDisplay() {
  const bar = document.getElementById('claude-token-bar');
  if (!bar) return;
  const { input, output } = _sessionTokens;
  const total = input + output;
  if (total === 0) { bar.style.display = 'none'; return; }

  const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  bar.style.display = '';
  bar.textContent = `Session: ↑${fmt(input)} ↓${fmt(output)} (FREE)`;
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
    planBrief: 'Planning layout', getMapInfo: 'Reading map', getCellInfo: 'Inspecting cell', getRoomBounds: 'Checking room',
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
    removeProp: 'Removing prop', removePropsInRect: 'Clearing props',
    placeLight: 'Placing light', addStairs: 'Adding stairs', linkStairs: 'Linking stairs',
    removeStairs: 'Removing stairs',
    getLights: 'Checking lights', removeLight: 'Removing light',
    setAmbientLight: 'Setting ambient light', setLightingEnabled: 'Toggling lighting',
    listLightPresets: 'Checking light presets',
    addBridge: 'Adding bridge', removeBridge: 'Removing bridge',
    paintCell: 'Painting cell', paintRect: 'Painting area', eraseCell: 'Erasing cell', eraseRect: 'Erasing area',
    setHazard: 'Marking hazard', setHazardRect: 'Marking hazard', mergeRooms: 'Merging rooms',
    newMap: 'Creating new map',
    setLabelStyle: 'Setting label style', listThemes: 'Checking themes',
    getLevels: 'Checking levels', addLevel: 'Adding level',
    renameLevel: 'Renaming level', resizeLevel: 'Resizing level',
    findCellByLabel: 'Finding room', shiftCells: 'Repositioning map',
    listRooms: 'Listing rooms', placeLightInRoom: 'Placing light',
  };
  label.textContent = (LABELS[toolName] ?? toolName) + '…';
}

function showUndoToast(startDepth) {
  const list = document.getElementById('claude-message-list');
  if (!list) return;
  const toast = document.createElement('div');
  toast.className = 'claude-undo-toast';
  toast.innerHTML = `<span>AI made changes.</span><button class="claude-undo-all-btn">Undo all</button>`;
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
