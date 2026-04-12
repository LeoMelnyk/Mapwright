// Daemon-mode test: spawn puppeteer-bridge --daemon and exercise
// the NDJSON request/response protocol over stdin/stdout.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, stopServer } from './helpers/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.resolve(__dirname, '../../tools/puppeteer-bridge.js');
const MAPWRIGHT_DIR = path.resolve(__dirname, '../..');

class DaemonClient {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.readyPromise = null;
  }

  async start(port) {
    this.proc = spawn('node', [BRIDGE_PATH, '--daemon', '--port', String(port)], {
      cwd: MAPWRIGHT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: this.proc.stdout });
    this.readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('daemon ready timeout')), 30000);
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (msg.ready) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          if (msg.type === 'progress') {
            if (entry.onProgress) entry.onProgress(msg);
            return;
          }
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      });
      this.proc.on('exit', () => {
        for (const { reject: rj } of this.pending.values()) rj(new Error('daemon exited'));
        this.pending.clear();
      });
    });
    return this.readyPromise;
  }

  request(req, onProgress) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.proc.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  async stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ id: 0, op: 'shutdown' }) + '\n');
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try {
      this.proc.kill();
    } catch {}
  }
}

let port;
let daemon;

beforeAll(async () => {
  port = await startServer();
  daemon = new DaemonClient();
  await daemon.start(port);
}, 60000);

afterAll(async () => {
  if (daemon) await daemon.stop();
  await stopServer();
});

describe('daemon mode', () => {
  it('responds to ping', async () => {
    const r = await daemon.request({ op: 'ping' });
    expect(r.ok).toBe(true);
    expect(r.pong).toBe(true);
  });

  it('executes a single command batch', async () => {
    const r = await daemon.request({
      op: 'execute',
      commands: [
        ['newMap', 'DaemonTest1', 20, 30],
        ['createRoom', 2, 2, 8, 12],
        ['setLabel', 5, 7, 'A1'],
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('OK [0]');
  });

  it('persists browser state across requests (subsequent map info reflects prior commands)', async () => {
    await daemon.request({
      op: 'execute',
      commands: [
        ['newMap', 'PersistTest', 20, 30],
        ['createRoom', 2, 2, 6, 6],
      ],
    });
    const r = await daemon.request({
      op: 'execute',
      commands: [['getMapInfo']],
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('PersistTest');
  });

  it('reports failures via ok=false but keeps daemon alive', async () => {
    const fail = await daemon.request({
      op: 'execute',
      commands: [['nonexistentMethod', 'arg']],
    });
    expect(fail.ok).toBe(false);
    expect(fail.output).toContain('FAILED');
    // Daemon still responsive
    const ping = await daemon.request({ op: 'ping' });
    expect(ping.ok).toBe(true);
  });

  it('continues batch when continueOnError=true', async () => {
    const r = await daemon.request({
      op: 'execute',
      continueOnError: true,
      commands: [['newMap', 'ContinueTest', 20, 30], ['nonexistentMethod'], ['createRoom', 2, 2, 5, 5]],
    });
    expect(r.output).toContain('FAILED');
    expect(r.output).toContain('OK [2]');
  });

  it('rejects unknown ops gracefully', async () => {
    const r = await daemon.request({ op: 'frobnicate' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Unknown op');
  });

  it('streams per-command progress when stream:true is set', async () => {
    const progressEvents = [];
    const r = await daemon.request(
      {
        op: 'execute',
        stream: true,
        commands: [
          ['newMap', 'StreamTest', 20, 30],
          ['createRoom', 2, 2, 6, 6],
          ['setLabel', 4, 4, 'A1'],
          ['createRoom', 2, 10, 6, 14],
        ],
      },
      (msg) => progressEvents.push(msg),
    );
    expect(r.ok).toBe(true);
    // Should have received at least one progress event per command (4 commands)
    const cmdProgressEvents = progressEvents.filter((e) => e.index != null);
    expect(cmdProgressEvents.length).toBe(4);
    // Indices should be monotonic 1..4
    expect(cmdProgressEvents.map((e) => e.index)).toEqual([1, 2, 3, 4]);
    // Each should report total
    for (const e of cmdProgressEvents) expect(e.total).toBe(4);
    // Each should include the OK line
    expect(cmdProgressEvents[0].line).toContain('OK [0]');
  });

  it('does NOT stream progress when stream is omitted', async () => {
    const progressEvents = [];
    const r = await daemon.request(
      {
        op: 'execute',
        commands: [
          ['newMap', 'NoStreamTest', 15, 15],
          ['createRoom', 2, 2, 5, 5],
        ],
      },
      (msg) => progressEvents.push(msg),
    );
    expect(r.ok).toBe(true);
    expect(progressEvents).toHaveLength(0);
  });
});
