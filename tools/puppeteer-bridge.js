#!/usr/bin/env node
// Puppeteer bridge for programmatic dungeon editor control.
//
// Three execution modes:
//
//   ONE-SHOT (default): launches/reuses browser, runs commands, exits.
//
//   VISIBLE (--visible): persistent headed browser shared across calls via
//     Chrome remote debugging port 9222.
//
//   DAEMON (--daemon): long-running stdin/stdout NDJSON server. Browser
//     stays alive between requests. Each NDJSON request on stdin produces
//     one NDJSON response on stdout. Used by the MCP server.
//
//     Request:  {"id":1,"op":"execute","commands":[...],"load":"...",...}
//                {"id":2,"op":"shutdown"}
//     Response: {"id":1,"ok":true,"output":"...","exitCode":0}
//                {"id":1,"ok":false,"error":"..."}
//
// Usage (one-shot):
//   node puppeteer-bridge.js [options]
//
// Options:
//   --load <file.mapwright>    Load map from file before executing commands
//   --commands '<json>'       JSON array of commands (inline)
//   --commands-file <file>    JSON array of commands (from file)
//   --screenshot <out.png>    Save screenshot after commands
//   --save <file.mapwright>    Save map after commands
//   --info                    Print map info and exit
//   --dry-run                 Execute commands but skip all file I/O (screenshot, save, export)
//   --port <number>           Editor port (default: 3000)
//   --visible                 Persistent headed browser (see above)
//   --slow-mo <ms>            Delay between commands in ms (default: 0)
//   --daemon                  Long-running NDJSON request server on stdin/stdout
//
// Command format: [["methodName", arg1, arg2, ...], ...]
// Example: [["createRoom", 2, 2, 8, 12], ["setDoor", 5, 12, "east"]]

import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { get as httpGet } from 'http';

const DEBUG_PORT = 9222;

/** Poll until Chrome's remote debugging HTTP endpoint responds, or timeout. */
function waitForDebugPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = httpGet(`http://localhost:${port}/json/version`, (res) => {
        res.destroy();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() >= deadline)
          return reject(new Error(`Chrome debug port ${port} not ready after ${timeoutMs}ms`));
        setTimeout(attempt, 200);
      });
      req.setTimeout(500, () => {
        req.destroy();
      });
    }
    attempt();
  });
}

function parseArgs(argv) {
  const args = {
    load: null,
    commands: null,
    commandsFile: null,
    screenshot: null,
    save: null,
    exportPng: null,
    info: false,
    continueOnError: false,
    dryRun: false,
    port: 3000,
    visible: false,
    slowMo: 0,
    highlight: null,
    daemon: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--load':
        args.load = argv[++i];
        break;
      case '--commands':
        args.commands = argv[++i];
        break;
      case '--commands-file':
        args.commandsFile = argv[++i];
        break;
      case '--screenshot':
        args.screenshot = argv[++i];
        break;
      case '--save':
        args.save = argv[++i];
        break;
      case '--export-png':
        args.exportPng = argv[++i];
        break;
      case '--info':
        args.info = true;
        break;
      case '--continue-on-error':
        args.continueOnError = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--port':
        args.port = parseInt(argv[++i], 10);
        break;
      case '--visible':
        args.visible = true;
        break;
      case '--slow-mo':
        args.slowMo = parseInt(argv[++i], 10);
        break;
      case '--highlight':
        args.highlight = argv[++i];
        break;
      case '--daemon':
        args.daemon = true;
        break;
    }
  }
  return args;
}

// ─── Browser/page setup (shared by one-shot and daemon) ─────────────────────

async function setupBrowser(args) {
  const editorUrl = `http://localhost:${args.port}/editor/?api`;
  let browser = null;
  let page = null;
  let usingPersistentBrowser = false;

  if (args.visible) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${DEBUG_PORT}`,
        defaultViewport: null,
      });
      usingPersistentBrowser = true;
    } catch {
      try {
        const chromePath = puppeteer.executablePath();
        const chromeProc = spawn(
          chromePath,
          [
            `--remote-debugging-port=${DEBUG_PORT}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--start-maximized',
          ],
          { detached: true, stdio: 'ignore' },
        );
        chromeProc.unref();
        await waitForDebugPort(DEBUG_PORT, 8000);
        browser = await puppeteer.connect({
          browserURL: `http://localhost:${DEBUG_PORT}`,
          defaultViewport: null,
        });
        usingPersistentBrowser = true;
      } catch {
        console.error('[visible] Could not open or connect to browser — running headless.');
        args.visible = false;
      }
    }
  }

  if (!args.visible) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    usingPersistentBrowser = false;
  }

  if (usingPersistentBrowser) {
    const pages = await browser.pages();
    page = pages.find((p) => p.url().includes('/editor')) || null;
    if (page) {
      try {
        await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 5000 });
      } catch {
        await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 10000 });
      }
    } else {
      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 10000 });
    }
  } else {
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 10000 });
  }

  return { browser, page, usingPersistentBrowser };
}

// ─── Per-request execution (used by both one-shot and daemon) ────────────────

/**
 * Run one batch of commands against an existing page.
 * @param {Page} page
 * @param {object} req — { load, commands, commandsFile, screenshot, save, exportPng,
 *                         dryRun, continueOnError, highlight, info, slowMo }
 * @param {(line: string) => void} emit — receives every log line (replaces console)
 * @returns {{ exitCode: number, anyFailed: boolean }}
 */
async function executeRequest(page, req, emit) {
  let anyFailed = false;
  let exitCode = 0;

  try {
    // Load map
    if (req.load) {
      const mapPath = path.resolve(req.load);
      const json = await fs.readFile(mapPath, 'utf-8');
      const result = await page.evaluate((jsonStr) => {
        try {
          return window.editorAPI.loadMap(jsonStr);
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, json);
      if (!result.success) throw new Error(`Failed to load map: ${result.error}`);
      emit(`Loaded: ${req.load}`);
    }

    // Resolve commands
    let commands = [];
    if (req.commands && typeof req.commands === 'string') {
      commands = JSON.parse(req.commands);
    } else if (Array.isArray(req.commands)) {
      commands = req.commands;
    } else if (req.commandsFile) {
      const content = await fs.readFile(path.resolve(req.commandsFile), 'utf-8');
      commands = JSON.parse(content);
    }

    // Execute commands
    for (let i = 0; i < commands.length; i++) {
      const [method, ...methodArgs] = commands[i];
      const result = await page.evaluate(
        async (m, a) => {
          try {
            const fn = window.editorAPI[m];
            if (typeof fn !== 'function') {
              return { success: false, error: `unknown method: ${m}` };
            }
            const res = await fn.apply(window.editorAPI, a);
            return res || { success: true };
          } catch (e) {
            const out = { success: false, error: e.message };
            if (e.code) out.code = e.code;
            if (e.context) out.context = e.context;
            return out;
          }
        },
        method,
        methodArgs,
      );

      if (!result.success) {
        const codePart = result.code ? ` (${result.code})` : '';
        const ctxPart = result.context ? ` ${JSON.stringify(result.context)}` : '';
        emit(`FAILED [${i}] [${method}]${codePart}: ${result.error}${ctxPart}`);
        anyFailed = true;
        if (!req.continueOnError) break;
      } else {
        const returnVal =
          result && Object.keys(result).some((k) => k !== 'success') ? ` => ${JSON.stringify(result)}` : '';
        emit(`OK [${i}]: ${method}(${methodArgs.map((a) => JSON.stringify(a)).join(', ')})${returnVal}`);
      }

      if (req.slowMo > 0) {
        await new Promise((r) => setTimeout(r, req.slowMo));
      }
    }
    if (anyFailed) exitCode = 1;

    if (req.info) {
      const info = await page.evaluate(() => window.editorAPI.getMapInfo());
      emit(JSON.stringify(info, null, 2));
    }

    if (req.dryRun) {
      emit('[dry-run] Skipping all file I/O (screenshot, save, export)');
    } else {
      if (req.screenshot) {
        const highlights = req.highlight
          ? typeof req.highlight === 'string'
            ? JSON.parse(req.highlight)
            : req.highlight
          : null;
        const dataURL = await page.evaluate(async (h) => {
          if (h) return await window.editorAPI.getScreenshotAnnotated(h);
          return await window.editorAPI.getScreenshot();
        }, highlights);
        const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
        const outPath = path.resolve(req.screenshot);
        await fs.writeFile(outPath, Buffer.from(base64, 'base64'));
        emit(
          `Screenshot: ${outPath}${highlights ? ` (with ${highlights.length} highlight${highlights.length === 1 ? '' : 's'})` : ''}`,
        );
      }

      if (req.save) {
        const result = await page.evaluate(() => window.editorAPI.getMap());
        const map = result.dungeon || result;
        const outPath = path.resolve(req.save);
        await fs.writeFile(outPath, JSON.stringify(map));
        emit(`Saved: ${outPath}`);
      }

      if (req.exportPng) {
        const dataURL = await page.evaluate(async () => {
          return await window.editorAPI.exportPng();
        });
        const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
        const outPath = path.resolve(req.exportPng);
        await fs.writeFile(outPath, Buffer.from(base64, 'base64'));
        emit(`Export PNG: ${outPath}`);
      }
    }
  } catch (err) {
    emit(`Error: ${err.message}`);
    exitCode = 1;
  }

  return { exitCode, anyFailed };
}

// ─── Daemon mode ─────────────────────────────────────────────────────────────

async function runDaemon(args) {
  const { browser, page, usingPersistentBrowser } = await setupBrowser(args);

  // Signal readiness on stdout
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n');

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  let shuttingDown = false;
  const cleanup = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (usingPersistentBrowser) {
      try {
        browser.disconnect();
      } catch {}
    } else {
      try {
        await browser.close();
      } catch {}
    }
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void cleanup(0));
  process.on('SIGINT', () => void cleanup(0));

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ id: null, type: 'result', ok: false, error: `JSON parse: ${e.message}` }) + '\n',
      );
      continue;
    }
    const id = req.id ?? null;
    if (req.op === 'shutdown') {
      process.stdout.write(JSON.stringify({ id, type: 'result', ok: true, shutdown: true }) + '\n');
      await cleanup(0);
      return;
    }
    if (req.op === 'ping') {
      process.stdout.write(JSON.stringify({ id, type: 'result', ok: true, pong: true }) + '\n');
      continue;
    }
    if (req.op !== 'execute') {
      process.stdout.write(JSON.stringify({ id, type: 'result', ok: false, error: `Unknown op: ${req.op}` }) + '\n');
      continue;
    }
    // Execute — capture output. If stream:true, also emit per-line progress.
    const lines = [];
    const stream = !!req.stream;
    const totalCommands = Array.isArray(req.commands) ? req.commands.length : 0;
    let progressIndex = 0;
    const emit = (s) => {
      const str = String(s);
      lines.push(str);
      if (stream) {
        // Increment progress on OK/FAILED command lines (one per executed command)
        const isCmdLine = str.startsWith('OK [') || str.startsWith('FAILED [');
        if (isCmdLine) progressIndex++;
        process.stdout.write(
          JSON.stringify({
            id,
            type: 'progress',
            line: str,
            index: isCmdLine ? progressIndex : undefined,
            total: totalCommands || undefined,
          }) + '\n',
        );
      }
    };
    let result;
    try {
      result = await executeRequest(page, req, emit);
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ id, type: 'result', ok: false, error: e.message, output: lines.join('\n') }) + '\n',
      );
      continue;
    }
    process.stdout.write(
      JSON.stringify({
        id,
        type: 'result',
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        anyFailed: result.anyFailed,
        output: lines.join('\n'),
      }) + '\n',
    );
  }

  // stdin closed
  await cleanup(0);
}

// ─── Main entry ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.daemon) {
    await runDaemon(args);
    return;
  }

  // One-shot mode
  const { browser, page, usingPersistentBrowser } = await setupBrowser(args);

  const emit = (s) => {
    // Match prior behavior: FAILED / Error → stderr; everything else → stdout
    if (typeof s === 'string' && (s.startsWith('FAILED') || s.startsWith('Error:'))) {
      console.error(s);
    } else {
      console.log(s);
    }
  };

  let exitCode = 0;
  try {
    const result = await executeRequest(page, args, emit);
    exitCode = result.exitCode;
  } finally {
    if (usingPersistentBrowser) {
      try {
        browser.disconnect();
      } catch {}
    } else {
      try {
        await browser.close();
      } catch {}
    }
  }

  process.exit(exitCode);
}

main();
