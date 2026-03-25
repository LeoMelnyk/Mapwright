#!/usr/bin/env node
// Puppeteer bridge for programmatic dungeon editor control.
//
// Two execution modes:
//
//   HEADLESS (default): launches a new headless browser per invocation, closes on exit.
//
//   VISIBLE (--visible): opens a persistent headed browser that stays alive between calls.
//     - First call: tries to connect to an existing Chrome on port 9222. If none found,
//       launches a new headed Chrome with --remote-debugging-port=9222.
//     - Subsequent calls: connect to the already-running Chrome, find the open editor tab,
//       apply commands without reloading — the browser stays open throughout.
//     - If the user closes the browser between calls: connection fails, execution
//       continues in headless mode for that invocation (no new window is opened).
//
// Usage:
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
//
// Command format: [["methodName", arg1, arg2, ...], ...]
// Example: [["createRoom", 2, 2, 8, 12], ["setDoor", 5, 12, "east"]]

import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
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
        if (Date.now() >= deadline) return reject(new Error(`Chrome debug port ${port} not ready after ${timeoutMs}ms`));
        setTimeout(attempt, 200);
      });
      req.setTimeout(500, () => { req.destroy(); });
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
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--load': args.load = argv[++i]; break;
      case '--commands': args.commands = argv[++i]; break;
      case '--commands-file': args.commandsFile = argv[++i]; break;
      case '--screenshot': args.screenshot = argv[++i]; break;
      case '--save': args.save = argv[++i]; break;
      case '--export-png': args.exportPng = argv[++i]; break;
      case '--info': args.info = true; break;
      case '--continue-on-error': args.continueOnError = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--port': args.port = parseInt(argv[++i], 10); break;
      case '--visible': args.visible = true; break;
      case '--slow-mo': args.slowMo = parseInt(argv[++i], 10); break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const editorUrl = `http://localhost:${args.port}/editor/?api`;
  let browser = null;
  let page = null;
  let usingPersistentBrowser = false; // true = leave browser open on exit

  // ---- Browser acquisition ------------------------------------------------

  if (args.visible) {
    // Step 1: try to connect to an already-running Chrome (user-visible window)
    try {
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${DEBUG_PORT}`,
        defaultViewport: null,
      });
      usingPersistentBrowser = true;
    } catch {
      // Step 2: no existing Chrome — launch a NEW detached Chrome process so it
      // survives after this Node process exits (avoids Windows Job Object kill).
      try {
        const chromePath = puppeteer.executablePath();
        const chromeProc = spawn(chromePath, [
          `--remote-debugging-port=${DEBUG_PORT}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--start-maximized',
        ], { detached: true, stdio: 'ignore' });
        chromeProc.unref(); // detach from this Node process

        // Wait up to 8 s for the remote debugging endpoint to become reachable
        await waitForDebugPort(DEBUG_PORT, 8000);

        browser = await puppeteer.connect({
          browserURL: `http://localhost:${DEBUG_PORT}`,
          defaultViewport: null,
        });
        usingPersistentBrowser = true;
      } catch {
        // Step 3: couldn't open a window at all — fall back silently to headless
        console.error('[visible] Could not open or connect to browser — running headless.');
        args.visible = false;
      }
    }
  }

  if (!args.visible) {
    // Standard headless session
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    usingPersistentBrowser = false;
  }

  let exitCode = 0;

  try {
    // ---- Page acquisition -------------------------------------------------

    if (usingPersistentBrowser) {
      // Find an already-open editor tab, or open a new one
      const pages = await browser.pages();
      page = pages.find(p => p.url().includes('/editor')) || null;

      if (page) {
        // Editor tab exists — verify API is ready (it should be)
        try {
          await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 5000 });
        } catch {
          // Tab might have been refreshed mid-session; navigate again
          await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 15000 });
          await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 10000 });
        }
      } else {
        // No editor tab open yet — create one
        page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 10000 });
      }
    } else {
      // Headless: fresh page every time
      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 10000 });
    }

    // ---- Load map from file -----------------------------------------------

    if (args.load) {
      const mapPath = path.resolve(args.load);
      const json = await fs.readFile(mapPath, 'utf-8');
      const result = await page.evaluate((jsonStr) => {
        try {
          return window.editorAPI.loadMap(jsonStr);
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, json);
      if (!result.success) throw new Error(`Failed to load map: ${result.error}`);
      console.log(`Loaded: ${args.load}`);
    }

    // ---- Execute commands -------------------------------------------------

    let commands = [];
    if (args.commands) {
      commands = JSON.parse(args.commands);
    } else if (args.commandsFile) {
      const content = await fs.readFile(path.resolve(args.commandsFile), 'utf-8');
      commands = JSON.parse(content);
    }

    let anyFailed = false;
    for (let i = 0; i < commands.length; i++) {
      const [method, ...methodArgs] = commands[i];
      const result = await page.evaluate(async (m, a) => {
        try {
          const fn = window.editorAPI[m];
          if (typeof fn !== 'function') {
            return { success: false, error: `unknown method: ${m}` };
          }
          const res = await fn.apply(window.editorAPI, a);
          return res || { success: true };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, method, methodArgs);

      if (!result.success) {
        console.error(`FAILED [${i}] [${method}]: ${result.error}`);
        anyFailed = true;
        if (!args.continueOnError) break;
      } else {
        const returnVal = (result && Object.keys(result).some(k => k !== 'success'))
          ? ` => ${JSON.stringify(result)}`
          : '';
        console.log(`OK [${i}]: ${method}(${methodArgs.map(a => JSON.stringify(a)).join(', ')})${returnVal}`);
      }

      // Manual slow-mo delay (works for both launched and connected browsers)
      if (args.slowMo > 0) {
        await new Promise(r => setTimeout(r, args.slowMo));
      }
    }
    if (anyFailed) exitCode = 1;

    // ---- Print map info ---------------------------------------------------

    if (args.info) {
      const info = await page.evaluate(() => window.editorAPI.getMapInfo());
      console.log(JSON.stringify(info, null, 2));
    }

    // ---- File I/O ---------------------------------------------------------

    if (args.dryRun) {
      console.log('[dry-run] Skipping all file I/O (screenshot, save, export)');
    } else {
      if (args.screenshot) {
        const dataURL = await page.evaluate(async () => {
          return await window.editorAPI.getScreenshot();
        });
        const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
        const outPath = path.resolve(args.screenshot);
        await fs.writeFile(outPath, Buffer.from(base64, 'base64'));
        console.log(`Screenshot: ${outPath}`);
      }

      if (args.save) {
        const result = await page.evaluate(() => window.editorAPI.getMap());
        const map = result.dungeon || result; // unwrap { success, dungeon } envelope
        const outPath = path.resolve(args.save);
        await fs.writeFile(outPath, JSON.stringify(map));
        console.log(`Saved: ${outPath}`);
      }

      if (args.exportPng) {
        const dataURL = await page.evaluate(async () => {
          return await window.editorAPI.exportPng();
        });
        const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
        const outPath = path.resolve(args.exportPng);
        await fs.writeFile(outPath, Buffer.from(base64, 'base64'));
        console.log(`Export PNG: ${outPath}`);
      }
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    exitCode = 1;
  } finally {
    if (usingPersistentBrowser) {
      // Leave the browser window open — just detach Puppeteer's connection
      try { browser.disconnect(); } catch {}
    } else {
      // Headless: clean up
      try { await browser.close(); } catch {}
    }
  }

  process.exit(exitCode);
}

main();
