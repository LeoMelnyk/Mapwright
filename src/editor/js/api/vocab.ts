// vocab.ts — Room vocabulary library API.
//
// Surfaces the room semantic library (src/rooms/**/*.room.json) to Claude
// as queryable data rather than preloaded prose. The library is a PALETTE:
// each spec lists option sets (primary/secondary/scatter/story_prompts) so
// two instances of the same room type look meaningfully different even
// though they share vocabulary.
//
// Flow:
//   listRoomTypes()                       → all types (name, category, tags, summary)
//   searchRoomVocab({ tags, ... })        → filtered discovery
//   getRoomVocab("throne-room")           → full palette for one type
//   suggestRoomType({ description })      → fuzzy reverse-lookup from prose

import { ApiValidationError } from './_shared.js';
import { loadRoomManifest, loadRoomSpec, type RoomManifestEntry, type RoomVocabSpec } from '../room-vocab.js';

interface ListRoomTypesOptions {
  category?: string;
}

interface SearchVocabFilter {
  tags?: string | string[]; // any-of
  allTags?: string | string[]; // all-of
  category?: string;
  namePattern?: string; // case-insensitive substring
  minSize?: [number, number]; // filter to rooms whose min footprint >= this
  maxSize?: [number, number]; // filter to rooms whose typical footprint fits within
}

interface SuggestOptions {
  description: string;
  size?: [number, number];
  limit?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function entryMatchesFilter(entry: RoomManifestEntry, filter: SearchVocabFilter): boolean {
  if (filter.category && entry.category !== filter.category) return false;

  const anyTags = asArray(filter.tags);
  if (anyTags.length && !anyTags.some((t) => entry.tags.includes(t))) return false;

  const allTags = asArray(filter.allTags);
  if (allTags.length && !allTags.every((t) => entry.tags.includes(t))) return false;

  if (filter.namePattern) {
    const p = filter.namePattern.toLowerCase();
    const hay = `${entry.name} ${entry.summary}`.toLowerCase();
    if (!hay.includes(p)) return false;
  }
  return true;
}

// Tokenize a description into lowercase word tokens, stripping punctuation
// and dropping common English stopwords. Used by suggestRoomType.
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'with',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'from',
  'room',
  'that',
  'this',
  'these',
  'those',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ── API methods ──────────────────────────────────────────────────────────

/**
 * List every room type available in the vocabulary library.
 *
 * @param options.category  Restrict to one category (e.g. "dungeon")
 * @returns  `{ success, count, rooms: [{ name, category, tags, summary }] }`
 */
export async function listRoomTypes(options: ListRoomTypesOptions = {}): Promise<{
  success: true;
  count: number;
  rooms: Array<{ name: string; category: string; tags: string[]; summary: string }>;
}> {
  const manifest = await loadRoomManifest();
  let rooms = manifest;
  if (options.category) {
    rooms = rooms.filter((r) => r.category === options.category);
  }
  return {
    success: true,
    count: rooms.length,
    rooms: rooms.map(({ name, category, tags, summary }) => ({ name, category, tags, summary })),
  };
}

/**
 * Filter the room vocab library by tags, category, or name.
 * All filter fields are AND-combined. Array tags use any-of semantics;
 * use `allTags` for all-of.
 *
 * @param filter  `{ tags, allTags, category, namePattern, minSize, maxSize }`
 */
export async function searchRoomVocab(filter: SearchVocabFilter = {}): Promise<{
  success: true;
  count: number;
  rooms: Array<{ name: string; category: string; tags: string[]; summary: string }>;
}> {
  const manifest = await loadRoomManifest();
  const filtered = manifest.filter((e) => entryMatchesFilter(e, filter));
  return {
    success: true,
    count: filtered.length,
    rooms: filtered.map(({ name, category, tags, summary }) => ({ name, category, tags, summary })),
  };
}

/**
 * Fetch the full palette/spec for a single room type.
 *
 * @param name  Room type name as listed in the manifest (e.g. "throne-room")
 * @returns  The full `RoomVocabSpec` with primary/secondary/scatter palettes,
 *          story prompts, shape guidance, lighting notes, anti-patterns.
 * @throws  ApiValidationError if the type is unknown.
 */
export async function getRoomVocab(name: string): Promise<{ success: true; spec: RoomVocabSpec }> {
  const spec = await loadRoomSpec(name);
  if (!spec) {
    const manifest = await loadRoomManifest();
    throw new ApiValidationError('UNKNOWN_ROOM_TYPE', `Room type "${name}" not found in vocabulary library.`, {
      name,
      available: manifest.map((r) => r.name),
    });
  }
  return { success: true, spec };
}

/**
 * Reverse-lookup: "smoky room full of pipes" → [hookah-lounge, opium-den, …].
 *
 * Tokenizes the description, scores each room entry by how many description
 * tokens appear in its `name`, `summary`, or `tags`, and returns the top-N
 * matches. Optionally filters by a [rows, cols] size envelope.
 *
 * This is intentionally simple (no embeddings) — good enough to narrow 150
 * options to 3-5 candidates worth full vocab lookup.
 *
 * @param options.description  Prose describing the desired room
 * @param options.size         Optional [rows, cols] envelope for filtering
 * @param options.limit        Max suggestions to return (default 5)
 */
export async function suggestRoomType(options: SuggestOptions): Promise<{
  success: true;
  query: string;
  suggestions: Array<{ name: string; category: string; score: number; reason: string[] }>;
}> {
  if (!options.description || typeof options.description !== 'string') {
    throw new ApiValidationError('INVALID_ARGS', 'suggestRoomType requires { description: string }.', { got: options });
  }
  const tokens = tokenize(options.description);
  const limit = Math.max(1, Math.min(25, options.limit ?? 5));
  const manifest = await loadRoomManifest();

  const scored = manifest.map((entry) => {
    const reasons: string[] = [];
    let score = 0;
    const nameHay = entry.name.replace(/-/g, ' ').toLowerCase();
    const summaryHay = entry.summary.toLowerCase();
    for (const tok of tokens) {
      if (nameHay.includes(tok)) {
        score += 3;
        reasons.push(`name:${tok}`);
      } else if (entry.tags.some((tag) => tag.toLowerCase() === tok)) {
        score += 2;
        reasons.push(`tag:${tok}`);
      } else if (summaryHay.includes(tok)) {
        score += 1;
        reasons.push(`summary:${tok}`);
      }
    }
    return { entry, score, reasons };
  });

  const filtered = scored.filter((s) => s.score > 0);
  filtered.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  return {
    success: true,
    query: options.description,
    suggestions: filtered.slice(0, limit).map((s) => ({
      name: s.entry.name,
      category: s.entry.category,
      score: s.score,
      reason: s.reasons,
    })),
  };
}
