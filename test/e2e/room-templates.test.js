import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, stopServer } from './helpers/server.js';
import { runBridge } from './helpers/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '../../room-templates');

let port;

beforeAll(async () => {
  port = await startServer();
});

afterAll(async () => {
  await stopServer();
});

describe('Room Templates', () => {
  const templates = fs.existsSync(TEMPLATES_DIR)
    ? fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'))
    : [];

  if (templates.length === 0) {
    it.skip('no room templates found', () => {});
    return;
  }

  for (const file of templates) {
    it(`runs ${file} without crashing`, async () => {
      // Run with --continue-on-error and --dry-run.
      // Some templates have known prop overlap issues — we only verify
      // the bridge doesn't crash (produces output) and processes commands.
      const result = await runBridge([
        '--commands-file', path.join(TEMPLATES_DIR, file),
        '--dry-run',
        '--continue-on-error',
      ], port);

      // Bridge should produce stdout output showing command execution
      const allOutput = result.stdout + result.stderr;
      expect(allOutput.length).toBeGreaterThan(0);

      // Should have processed at least some commands (OK lines in stdout)
      const okCount = (result.stdout.match(/^OK /gm) || []).length;
      expect(okCount).toBeGreaterThan(0);
    });
  }
});
