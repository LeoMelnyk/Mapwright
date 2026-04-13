// room-vocab.ts — Room vocabulary library loader.
//
// Loads the room semantic library from the server's /api/rooms/manifest endpoint
// and individual spec files from /rooms/<category>/<name>.room.json.
//
// The library is a palette, not a template: each spec describes *options* for
// a room type (multiple primary choices, multiple secondary options, story
// prompts for variation) rather than prescribing a fixed layout. The caller
// composes a specific room from the palette.
//
// Discovery is cheap: listRoomTypes() hits the manifest only. Full specs are
// loaded lazily and cached in-memory after first fetch.

export interface RoomManifestEntry {
  name: string;
  category: string;
  tags: string[];
  summary: string;
  path: string;
}

export interface PaletteEntry {
  props: string[];
  note?: string;
  surrounded_by?: string[];
  [k: string]: unknown;
}

export interface RoomVocabSpec {
  name: string;
  category: string;
  tags: string[];
  summary: string;
  size_guidance?: {
    min?: [number, number];
    typical?: [number, number];
    aspect_ratio?: string;
  };
  texture_options?: {
    floor?: string[];
    accent?: { purpose?: string; options?: string[] };
  };
  primary_palette?: Array<PaletteEntry | string>;
  secondary_palette?: string[];
  scatter_palette?: string[];
  shape_guidance?: {
    preferred?: string[];
    discouraged?: string[];
  };
  story_prompts?: string[];
  lighting_notes?: {
    ambient_intent?: string;
    ambient_is?: 'required' | 'optional' | 'discouraged';
    common_sources?: string[];
  };
  anti_patterns?: string[];
  [k: string]: unknown;
}

let _manifest: RoomManifestEntry[] | null = null;
const _specCache = new Map<string, RoomVocabSpec>();

/** Fetch + cache the manifest of all available room types. */
export async function loadRoomManifest(): Promise<RoomManifestEntry[]> {
  if (_manifest) return _manifest;
  try {
    const resp = await fetch('/api/rooms/manifest');
    if (!resp.ok) {
      _manifest = [];
      return _manifest;
    }
    const data = (await resp.json()) as { rooms?: RoomManifestEntry[] };
    _manifest = Array.isArray(data.rooms) ? data.rooms : [];
  } catch {
    _manifest = [];
  }
  return _manifest;
}

/** Fetch + cache a full spec by room type name. Returns null if not found. */
export async function loadRoomSpec(name: string): Promise<RoomVocabSpec | null> {
  const cached = _specCache.get(name);
  if (cached) return cached;

  const manifest = await loadRoomManifest();
  const entry = manifest.find((r) => r.name === name);
  if (!entry) return null;

  try {
    const resp = await fetch(`/rooms/${entry.path}`);
    if (!resp.ok) return null;
    const spec = (await resp.json()) as RoomVocabSpec;
    _specCache.set(name, spec);
    return spec;
  } catch {
    return null;
  }
}

/**
 * Clear the in-memory caches — call if the library changes on disk while
 * the editor is running. Rare.
 */
export function clearRoomVocabCache(): void {
  _manifest = null;
  _specCache.clear();
}

/**
 * Synchronous getters for code paths that have already awaited the async
 * loaders. Return null when uncached — callers should fall back to the
 * async versions.
 */
export function getCachedManifest(): RoomManifestEntry[] | null {
  return _manifest;
}

export function getCachedSpec(name: string): RoomVocabSpec | null {
  return _specCache.get(name) ?? null;
}
