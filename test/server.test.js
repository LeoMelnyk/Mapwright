/**
 * Integration tests for the Express server API endpoints.
 *
 * Spawns the real server as a subprocess (same pattern as E2E tests)
 * and makes HTTP requests against it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer } from './e2e/helpers/server.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPWRIGHT_DIR = path.resolve(__dirname, '..');

let port;
let baseUrl;

beforeAll(async () => {
  port = await startServer();
  baseUrl = `http://localhost:${port}`;
}, 20000);

afterAll(async () => {
  await stopServer();
});

// ── Helper ──────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  return res;
}

async function apiJson(path, options = {}) {
  const res = await api(path, options);
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

async function apiPost(path, body) {
  return apiJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiPut(path, body) {
  return apiJson(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiDelete(path) {
  return apiJson(path, { method: 'DELETE' });
}

// ── Security Headers ────────────────────────────────────────────────────────

describe('Security headers', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await api('/api/version');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY', async () => {
    const res = await api('/api/version');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('sets Content-Security-Policy', async () => {
    const res = await api('/api/version');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('connect-src');
  });
});

// ── GET /api/version ────────────────────────────────────────────────────────

describe('GET /api/version', () => {
  it('returns a version string from package.json', async () => {
    const { status, body } = await apiJson('/api/version');
    expect(status).toBe(200);
    expect(body).toHaveProperty('version');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('version matches package.json', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(MAPWRIGHT_DIR, 'package.json'), 'utf-8'));
    const { body } = await apiJson('/api/version');
    expect(body.version).toBe(pkg.version);
  });
});

// ── GET /api/open-file ──────────────────────────────────────────────────────

describe('GET /api/open-file', () => {
  it('returns 400 when path is missing', async () => {
    const { status, body } = await apiJson('/api/open-file');
    expect(status).toBe(400);
    expect(body.error).toMatch(/path required/i);
  });

  it('returns 403 for non-.mapwright/.json extension', async () => {
    const { status, body } = await apiJson('/api/open-file?path=test.txt');
    expect(status).toBe(403);
    expect(body.error).toMatch(/only.*allowed/i);
  });

  it('returns 403 for .exe extension', async () => {
    const { status } = await apiJson('/api/open-file?path=malware.exe');
    expect(status).toBe(403);
  });

  it('blocks path traversal attempts', async () => {
    const traversal = encodeURIComponent('../../etc/passwd.json');
    const { status, body } = await apiJson(`/api/open-file?path=${traversal}`);
    // Should be 403 (outside allowed dirs) or 400
    expect(status).toBeGreaterThanOrEqual(403);
    expect(body.error).toBeTruthy();
  });

  it('returns valid dungeon JSON for an example .mapwright file', async () => {
    const examplePath = path.join(MAPWRIGHT_DIR, 'examples', 'mines.mapwright');
    if (!fs.existsSync(examplePath)) return; // skip if no examples

    const encoded = encodeURIComponent(examplePath);
    const { status, body } = await apiJson(`/api/open-file?path=${encoded}`);
    expect(status).toBe(200);
    expect(body).toHaveProperty('metadata');
    expect(body).toHaveProperty('cells');
  });
});

// ── GET /api/examples ───────────────────────────────────────────────────────

describe('GET /api/examples', () => {
  it('returns an array', async () => {
    const { status, body } = await apiJson('/api/examples');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('each example has name, file, and url', async () => {
    const { body } = await apiJson('/api/examples');
    if (body.length === 0) return; // skip if no examples
    for (const ex of body) {
      expect(ex).toHaveProperty('name');
      expect(ex).toHaveProperty('file');
      expect(ex).toHaveProperty('url');
      expect(ex.url).toMatch(/^\/examples\//);
    }
  });

  it('includes .mapwright files from examples directory', async () => {
    const { body } = await apiJson('/api/examples');
    const files = body.map(e => e.file);
    // We know mines.mapwright exists
    expect(files).toContain('mines.mapwright');
  });
});

// ── User Themes CRUD ────────────────────────────────────────────────────────

describe('User Themes CRUD', () => {
  const uniqueName = `test-theme-${Date.now()}`;
  let createdKey;

  afterAll(async () => {
    // Clean up any created test theme
    if (createdKey) {
      await apiDelete(`/api/user-themes/${createdKey}`);
    }
  });

  it('GET /api/user-themes returns an array', async () => {
    const { status, body } = await apiJson('/api/user-themes');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /api/user-themes returns 400 without name', async () => {
    const { status, body } = await apiPost('/api/user-themes', { theme: { floorColor: '#333' } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name.*required/i);
  });

  it('POST /api/user-themes returns 400 without theme', async () => {
    const { status, body } = await apiPost('/api/user-themes', { name: 'test' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/theme.*required/i);
  });

  it('POST /api/user-themes creates a new theme', async () => {
    const { status, body } = await apiPost('/api/user-themes', {
      name: uniqueName,
      theme: { floorColor: '#112233', wallColor: '#445566' },
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty('key');
    createdKey = body.key;
  });

  it('POST /api/user-themes returns 409 for duplicate name', async () => {
    const { status, body } = await apiPost('/api/user-themes', {
      name: uniqueName,
      theme: { floorColor: '#000' },
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already exists/i);
  });

  it('GET /api/user-themes includes the created theme', async () => {
    const { body } = await apiJson('/api/user-themes');
    const found = body.find(t => t.key === createdKey);
    expect(found).toBeTruthy();
    expect(found.displayName).toBe(uniqueName);
  });

  it('PUT /api/user-themes/:key updates theme properties', async () => {
    const { status, body } = await apiPut(`/api/user-themes/${createdKey}`, {
      name: uniqueName,
      theme: { floorColor: '#aabbcc', wallColor: '#ddeeff' },
    });
    expect(status).toBe(200);
    expect(body.key).toBe(createdKey);
  });

  it('PUT /api/user-themes/:key returns 404 for nonexistent key', async () => {
    const { status, body } = await apiPut('/api/user-themes/nonexistent-theme-xyz', {
      name: 'whatever',
      theme: { floorColor: '#000' },
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  it('PUT /api/user-themes/:key returns 400 without name or theme', async () => {
    const { status } = await apiPut(`/api/user-themes/${createdKey}`, {});
    expect(status).toBe(400);
  });

  it('DELETE /api/user-themes/:key removes the theme', async () => {
    const { status, body } = await apiDelete(`/api/user-themes/${createdKey}`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify it is gone
    const list = await apiJson('/api/user-themes');
    const found = list.body.find(t => t.key === createdKey);
    expect(found).toBeFalsy();
    createdKey = null; // prevent afterAll cleanup
  });

  it('DELETE /api/user-themes/:key with path traversal uses basename only', async () => {
    // path.basename strips traversal, so ../../foo becomes just foo
    const { status } = await apiDelete('/api/user-themes/..%2F..%2Fimportant');
    expect(status).toBe(200); // returns success even if file doesnt exist
  });
});

// ── GET /api/ollama-status (SSRF protection) ────────────────────────────────

describe('GET /api/ollama-status', () => {
  it('returns 400 for non-localhost base URL (SSRF protection)', async () => {
    const { status, body } = await apiJson('/api/ollama-status?base=http://evil.com:11434');
    expect(status).toBe(400);
    expect(body.error).toMatch(/must be localhost/i);
  });

  it('returns 400 for IP-based SSRF bypass attempt', async () => {
    const { status } = await apiJson('/api/ollama-status?base=http://192.168.1.1:11434');
    expect(status).toBe(400);
  });

  it('allows localhost base URL', async () => {
    // Will likely fail to connect to Ollama, but should not return 400
    const { status } = await apiJson('/api/ollama-status?base=http://localhost:11434');
    expect(status).toBe(200);
    // running may be true or false depending on whether Ollama is up
  });

  it('allows 127.0.0.1 base URL', async () => {
    const { status } = await apiJson('/api/ollama-status?base=http://127.0.0.1:11434');
    expect(status).toBe(200);
  });

  it('defaults to localhost when no base provided', async () => {
    const { status } = await apiJson('/api/ollama-status');
    expect(status).toBe(200);
  });
});

// ── POST /api/claude (SSRF protection) ──────────────────────────────────────

describe('POST /api/claude', () => {
  it('returns 400 for non-localhost ollamaBase (SSRF protection)', async () => {
    const { status, body } = await apiPost('/api/claude', {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'test',
      ollamaBase: 'http://evil.com:11434',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/must be localhost/i);
  });

  it('returns 400 for external IP in ollamaBase', async () => {
    const { status } = await apiPost('/api/claude', {
      messages: [],
      ollamaBase: 'http://10.0.0.1:11434',
    });
    expect(status).toBe(400);
  });
});

// ── GET /api/local-ip ───────────────────────────────────────────────────────

describe('GET /api/local-ip', () => {
  it('returns an ip field', async () => {
    const { status, body } = await apiJson('/api/local-ip');
    expect(status).toBe(200);
    expect(body).toHaveProperty('ip');
    expect(typeof body.ip).toBe('string');
  });

  it('returns a valid IPv4 address or localhost', async () => {
    const { body } = await apiJson('/api/local-ip');
    const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(body.ip);
    const isLocalhost = body.ip === 'localhost';
    expect(isIPv4 || isLocalhost).toBe(true);
  });
});

// ── GET /api/textures/status ────────────────────────────────────────────────

describe('GET /api/textures/status', () => {
  it('returns texture count information', async () => {
    const { status, body } = await apiJson('/api/textures/status');
    expect(status).toBe(200);
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('requiredCount');
    expect(body).toHaveProperty('downloadInProgress');
    expect(typeof body.count).toBe('number');
    expect(typeof body.requiredCount).toBe('number');
    expect(body.downloadInProgress).toBe(false);
  });
});

// ── GET /api/changelog ──────────────────────────────────────────────────────

describe('GET /api/changelog', () => {
  it('returns version and notes', async () => {
    const { status, body } = await apiJson('/api/changelog');
    expect(status).toBe(200);
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('notes');
    expect(typeof body.version).toBe('string');
    expect(typeof body.notes).toBe('string');
  });

  it('version starts with v', async () => {
    const { body } = await apiJson('/api/changelog');
    expect(body.version).toMatch(/^v/);
  });
});

// ── POST /api/export-png ────────────────────────────────────────────────────

describe('POST /api/export-png', () => {
  it('returns 400 for empty body', async () => {
    const { status, body } = await apiPost('/api/export-png', {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid dungeon config/i);
  });

  it('returns 400 for missing cells', async () => {
    const { status } = await apiPost('/api/export-png', { metadata: {} });
    expect(status).toBe(400);
  });

  it('returns 400 for missing metadata', async () => {
    const { status } = await apiPost('/api/export-png', { cells: {} });
    expect(status).toBe(400);
  });
});

// ── POST /api/export-dd2vtt ─────────────────────────────────────────────────

describe('POST /api/export-dd2vtt', () => {
  it('returns 400 for empty body', async () => {
    const { status, body } = await apiPost('/api/export-dd2vtt', {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid dungeon config/i);
  });

  it('returns 400 for missing cells', async () => {
    const { status } = await apiPost('/api/export-dd2vtt', { metadata: {} });
    expect(status).toBe(400);
  });

  it('returns 400 for missing metadata', async () => {
    const { status } = await apiPost('/api/export-dd2vtt', { cells: {} });
    expect(status).toBe(400);
  });
});

// ── POST /api/ai-log ────────────────────────────────────────────────────────

describe('POST /api/ai-log', () => {
  it('accepts a log line', async () => {
    const { status, body } = await apiPost('/api/ai-log', { line: 'test log line' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('accepts reset flag', async () => {
    const { status, body } = await apiPost('/api/ai-log', { line: 'fresh start', reset: true });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ── GET /api/check-update ───────────────────────────────────────────────────

describe('GET /api/check-update', () => {
  it('returns hasUpdate field', async () => {
    const { status, body } = await apiJson('/api/check-update');
    expect(status).toBe(200);
    expect(body).toHaveProperty('hasUpdate');
    expect(typeof body.hasUpdate).toBe('boolean');
  });
});

// ── POST /api/textures/cancel ───────────────────────────────────────────────

describe('POST /api/textures/cancel', () => {
  it('returns ok even when no download is running', async () => {
    const res = await api('/api/textures/cancel', { method: 'POST' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ── Redirect / → /editor/ ───────────────────────────────────────────────────

describe('GET /', () => {
  it('redirects to /editor/', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/editor/');
  });
});
