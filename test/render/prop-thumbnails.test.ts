// Render-tier tests for the prop thumbnail cache.
//
// Uses @napi-rs/canvas (via setup-render.js) to provide a real OffscreenCanvas,
// plus extra polyfills for convertToBlob/FileReader needed by renderPropPreview.

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Extra polyfills for renderPropPreview's data-URL path ───────────────────
// The shared render setup provides OffscreenCanvas via @napi-rs/canvas, but
// renderPropPreview also calls .convertToBlob() and FileReader.readAsDataURL()
// (both browser APIs). Polyfill them to wrap the napi-rs canvas's toBuffer.

beforeAll(async () => {
  // The render setup polyfills document.createElement but not getElementById,
  // which the editor api/index.ts waitForReady() loop needs.
  const doc = (globalThis as { document?: Record<string, unknown> }).document;
  if (doc && typeof doc.getElementById !== 'function') {
    doc.getElementById = (id: string) => (id === 'editor-canvas' ? { toDataURL: () => '' } : null);
  }
  if (doc && typeof doc.addEventListener !== 'function') {
    doc.addEventListener = () => {};
  }
  if (doc && doc.readyState === undefined) {
    doc.readyState = 'complete';
  }
  if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === 'undefined') {
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  }

  const OC = (globalThis as { OffscreenCanvas?: { prototype: Record<string, unknown> } }).OffscreenCanvas;
  if (OC && !OC.prototype.convertToBlob) {
    OC.prototype.convertToBlob = function (
      this: { _canvas: { toBuffer: (mime: string) => Buffer } },
      opts?: { type?: string },
    ) {
      const mime = opts?.type ?? 'image/png';
      const buf = this._canvas.toBuffer(mime);
      const arr = new Uint8Array(buf);
      // Minimal Blob-like — just enough for FileReader below
      return Promise.resolve({
        type: mime,
        size: arr.byteLength,
        arrayBuffer: () => Promise.resolve(arr.buffer),
        _bytes: arr,
      });
    };
  }
  if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
    class StubFileReader {
      onloadend: ((this: StubFileReader) => void) | null = null;
      result: string | null = null;
      readAsDataURL(blob: { type?: string; _bytes: Uint8Array }) {
        const mime = blob.type ?? 'application/octet-stream';
        const b64 = Buffer.from(blob._bytes).toString('base64');
        this.result = `data:${mime};base64,${b64}`;
        if (this.onloadend) this.onloadend.call(this);
      }
    }
    (globalThis as { FileReader?: unknown }).FileReader = StubFileReader;
  }
});

// Imports must come AFTER the polyfills are queued (beforeAll runs before tests,
// and these top-level imports run at module-load time, but the tests use the
// polyfilled functions which are read at call-time — so order is fine).
const importApi = async () => {
  const state = (await import('../../src/editor/js/state.js')).default;
  const { createEmptyDungeon } = await import('../../src/editor/js/utils.js');
  await import('../../src/editor/js/api/index.js');
  const preview = await import('../../src/editor/js/api/preview.js');
  const { parsePropFile } = await import('../../src/render/parse-props.js');
  return { state, createEmptyDungeon, preview, parsePropFile };
};

let api: Awaited<ReturnType<typeof importApi>>;

beforeAll(async () => {
  api = await importApi();
});

function loadProp(name: string): Record<string, unknown> {
  const propPath = path.join(__dirname, '../../src/props', `${name}.prop`);
  const text = fs.readFileSync(propPath, 'utf-8');
  return api.parsePropFile(text) as Record<string, unknown>;
}

beforeEach(() => {
  api.state.dungeon = api.createEmptyDungeon('Test', 20, 20, 5, 'stone-dungeon', 1);
  api.state.undoStack = [];
  api.state.redoStack = [];
  // Build a small catalog from real .prop files so renderPropPreview has
  // genuine draw commands to render.
  api.state.propCatalog = {
    categories: ['features', 'structure'],
    props: {
      brazier: loadProp('brazier'),
      pillar: loadProp('pillar'),
    },
  };
  // Reset the cache between tests
  api.preview.clearPropThumbnailCache();
});

describe('getPropThumbnail', () => {
  it('renders a prop and returns a data URL', async () => {
    const r = await api.preview.getPropThumbnail('pillar');
    expect(r.success).toBe(true);
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(r.cached).toBe(false);
  });

  it('returns cached=true on second call for the same prop', async () => {
    await api.preview.getPropThumbnail('pillar');
    const second = await api.preview.getPropThumbnail('pillar');
    expect(second.cached).toBe(true);
    // Same dataUrl
  });

  it('renders different sizes as separate cache entries', async () => {
    const small = await api.preview.getPropThumbnail('pillar', 16);
    const large = await api.preview.getPropThumbnail('pillar', 64);
    expect(small.cached).toBe(false);
    expect(large.cached).toBe(false);
    // Both entries should be cached now
    const small2 = await api.preview.getPropThumbnail('pillar', 16);
    expect(small2.cached).toBe(true);
  });

  it('rejects unknown props', async () => {
    await expect(api.preview.getPropThumbnail('nonexistent')).rejects.toThrow(/Unknown prop/);
  });

  it('invalidates when prop definition changes (hash key)', async () => {
    await api.preview.getPropThumbnail('pillar');
    // Mutate the prop definition — hash should differ now
    const def = api.state.propCatalog!.props.pillar as { footprint: number[] };
    def.footprint = [2, 2]; // change footprint
    const second = await api.preview.getPropThumbnail('pillar');
    expect(second.cached).toBe(false);
  });
});

describe('getPropThumbnails (batch)', () => {
  it('returns one entry per requested name', async () => {
    const r = await api.preview.getPropThumbnails(['pillar', 'brazier']);
    expect(r.success).toBe(true);
    expect(r.thumbnails).toHaveLength(2);
    expect(r.thumbnails.map((t) => t.name)).toEqual(['pillar', 'brazier']);
    for (const t of r.thumbnails) {
      expect(t.dataUrl).toMatch(/^data:image\/png/);
    }
  });

  it('records errors per-entry without halting the batch', async () => {
    const r = await api.preview.getPropThumbnails(['pillar', 'nonexistent', 'brazier']);
    expect(r.thumbnails).toHaveLength(3);
    expect(r.thumbnails[0].dataUrl).toBeTruthy();
    expect(r.thumbnails[1].dataUrl).toBeNull();
    expect(r.thumbnails[1].error).toBeTruthy();
    expect(r.thumbnails[2].dataUrl).toBeTruthy();
  });
});

describe('prewarmPropThumbnails', () => {
  it('renders every prop in the catalog and reports counts', async () => {
    const r = await api.preview.prewarmPropThumbnails();
    expect(r.success).toBe(true);
    expect(r.total).toBe(2);
    expect(r.rendered).toBe(2);
    expect(r.cached).toBe(0);
    expect(r.failed).toHaveLength(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('skips already-cached entries when onlyMissing=true (default)', async () => {
    await api.preview.getPropThumbnail('pillar');
    const r = await api.preview.prewarmPropThumbnails();
    expect(r.cached).toBe(1);
    expect(r.rendered).toBe(1);
  });

  it('re-renders all when onlyMissing=false', async () => {
    await api.preview.getPropThumbnail('pillar');
    const r = await api.preview.prewarmPropThumbnails({ onlyMissing: false });
    expect(r.rendered).toBe(2);
    expect(r.cached).toBe(0);
  });

  it('returns total=0 with no catalog', async () => {
    api.state.propCatalog = null;
    const r = await api.preview.prewarmPropThumbnails();
    expect(r.total).toBe(0);
    expect(r.rendered).toBe(0);
  });
});

describe('clearPropThumbnailCache', () => {
  it('clears all cached entries and reports the count', async () => {
    await api.preview.getPropThumbnail('pillar');
    await api.preview.getPropThumbnail('brazier');
    const r = api.preview.clearPropThumbnailCache();
    expect(r.cleared).toBe(2);
    // Next fetch should be uncached
    const after = await api.preview.getPropThumbnail('pillar');
    expect(after.cached).toBe(false);
  });
});

describe('searchPropsWithThumbnails', () => {
  it('returns search hits with inline data URLs', async () => {
    const r = await api.preview.searchPropsWithThumbnails({});
    expect(r.success).toBe(true);
    expect(r.count).toBe(2);
    for (const p of r.props) {
      expect(p.dataUrl).toMatch(/^data:image\/png/);
      expect(p.name).toBeTruthy();
    }
  });

  it('honors the underlying searchProps filter', async () => {
    const r = await api.preview.searchPropsWithThumbnails({ namePattern: 'pillar' });
    expect(r.count).toBe(1);
    expect((r.props[0] as { name: string }).name).toBe('pillar');
  });
});
