#!/usr/bin/env node
// Puppeteer bridge for programmatic dungeon editor control.
// Stateless per invocation: launches headless browser, executes commands, exits.
//
// Usage:
//   node puppeteer-bridge.js [options]
//
// Options:
//   --load <file.json>        Load map from file before executing commands
//   --commands '<json>'       JSON array of commands (inline)
//   --commands-file <file>    JSON array of commands (from file)
//   --screenshot <out.png>    Save screenshot after commands
//   --save <file.json>        Save map after commands
//   --info                    Print map info and exit
//   --dry-run                 Execute commands but skip all file I/O (screenshot, save, export)
//   --port <number>           Editor port (default: 3000)
//
// Command format: [["methodName", arg1, arg2, ...], ...]
// Example: [["createRoom", 2, 2, 8, 12], ["setDoor", 5, 12, "east"]]

import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

function parseArgs(argv) {
  const args = {
    load: null,
    commands: null,
    commandsFile: null,
    screenshot: null,
    save: null,
    exportMap: null,
    exportPng: null,
    info: false,
    continueOnError: false,
    dryRun: false,
    port: 3000,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--load': args.load = argv[++i]; break;
      case '--commands': args.commands = argv[++i]; break;
      case '--commands-file': args.commandsFile = argv[++i]; break;
      case '--screenshot': args.screenshot = argv[++i]; break;
      case '--save': args.save = argv[++i]; break;
      case '--export-map': args.exportMap = argv[++i]; break;
      case '--export-png': args.exportPng = argv[++i]; break;
      case '--info': args.info = true; break;
      case '--continue-on-error': args.continueOnError = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--port': args.port = parseInt(argv[++i], 10); break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let exitCode = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to editor with API enabled
    const url = `http://localhost:${args.port}/editor/?api`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

    // Wait for API to be ready
    await page.waitForFunction(() => window.editorAPI !== undefined, { timeout: 10000 });

    // Load map from file
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

    // Execute commands
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
            return { success: false, error: `Unknown method: ${m}` };
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
    }
    if (anyFailed) exitCode = 1;

    // Print map info
    if (args.info) {
      const info = await page.evaluate(() => window.editorAPI.getMapInfo());
      console.log(JSON.stringify(info, null, 2));
    }

    if (args.dryRun) {
      console.log('[dry-run] Skipping all file I/O (screenshot, save, export)');
    } else {
      // Take screenshot
      if (args.screenshot) {
        const dataURL = await page.evaluate(async () => {
          return await window.editorAPI.getScreenshot();
        });
        const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
        const outPath = path.resolve(args.screenshot);
        await fs.writeFile(outPath, Buffer.from(base64, 'base64'));
        console.log(`Screenshot: ${outPath}`);
      }

      // Save map
      if (args.save) {
        const map = await page.evaluate(() => window.editorAPI.getMap());
        const outPath = path.resolve(args.save);
        await fs.writeFile(outPath, JSON.stringify(map, null, 2));
        console.log(`Saved: ${outPath}`);
      }

      // Export PNG via compile pipeline (HQ lighting)
      if (args.exportPng) {
        const dataURL = await page.evaluate(async () => {
          return await window.editorAPI.exportPng();
        });
        const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
        const outPath = path.resolve(args.exportPng);
        await fs.writeFile(outPath, Buffer.from(base64, 'base64'));
        console.log(`Export PNG: ${outPath}`);
      }

      // Export .map text
      if (args.exportMap) {
        const result = await page.evaluate(() => window.editorAPI.exportToMapFormat());
        const outPath = path.resolve(args.exportMap);
        await fs.writeFile(outPath, result.mapText, 'utf-8');
        console.log(`Exported .map: ${outPath}`);
      }
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    exitCode = 1;
  } finally {
    await browser.close();
  }

  process.exit(exitCode);
}

main();
