'use strict';
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Patch 1 (Windows only): app-builder.exe — replace -snld with -snl-
//
// electron-builder passes -snld to 7za when extracting its own tool archives.
// On Windows without Developer Mode, 7za exits with code 2 when it can't
// create macOS-style symlinks inside those archives. Those files are unused on
// Windows, but the non-zero exit code fails the entire build.
// Fix: replace -snld with -snl- so 7za dereferences symlinks instead.
// ---------------------------------------------------------------------------
const binary = path.join(__dirname, '../node_modules/app-builder-bin/win/x64/app-builder.exe');
if (fs.existsSync(binary)) {
  const data    = fs.readFileSync(binary);
  const NEEDLE  = Buffer.from('-snld');
  const PATCHED = Buffer.from('-snl-');
  if (data.indexOf(PATCHED) === -1) {
    const idx = data.indexOf(NEEDLE);
    if (idx !== -1) {
      const out = Buffer.allocUnsafe(data.length);
      data.copy(out);
      PATCHED.copy(out, idx);
      fs.writeFileSync(binary, out);
      console.log('patched app-builder.exe (-snld → -snl-)');
    }
  }
}

// ---------------------------------------------------------------------------
// Patch 2 (Windows only): windowsSignAzureManager.js — quote PowerShell
// param values so paths containing special characters (e.g. '&' in "D&D")
// don't break the signing command.
// ---------------------------------------------------------------------------
const azureManager = path.join(__dirname, '../node_modules/app-builder-lib/out/codeSign/windowsSignAzureManager.js');
if (fs.existsSync(azureManager)) {
  const AZURE_NEEDLE  = 'return [...res, `-${field}`, value];';
  const AZURE_PATCHED = 'const quoted = typeof value === "string" ? `"${value}"` : value;\n            return [...res, `-${field}`, quoted];';
  let src = fs.readFileSync(azureManager, 'utf8');
  if (!src.includes(AZURE_PATCHED)) {
    if (src.includes(AZURE_NEEDLE)) {
      fs.writeFileSync(azureManager, src.replace(AZURE_NEEDLE, AZURE_PATCHED), 'utf8');
      console.log('patched windowsSignAzureManager.js (quote PowerShell param values)');
    } else {
      console.log('windowsSignAzureManager.js: needle not found, skipping');
    }
  }
}

// ---------------------------------------------------------------------------
// Patch 3 (all platforms): macPackager.js — fall back to a safe x64ArchFiles
// glob when platformSpecificBuildOptions doesn't surface the value from config.
//
// @napi-rs/canvas installs pre-built binaries for every darwin arch as npm
// optional packages, so skia.darwin-arm64.node ends up identical in both the
// x64 and arm64 temp builds. @electron/universal errors when it sees identical
// Mach-O files not covered by the x64ArchFiles rule. electron-builder v25 reads
// x64ArchFiles from the mac config section but fails to pass it through on
// some CI environments, leaving opts.x64ArchFiles undefined. This patch adds a
// ?? fallback so the universal merge always gets the pattern it needs.
// ---------------------------------------------------------------------------
const macPackager = path.join(__dirname, '../node_modules/app-builder-lib/out/macPackager.js');
if (fs.existsSync(macPackager)) {
  const MAC_NEEDLE  = 'x64ArchFiles: platformSpecificBuildOptions.x64ArchFiles,';
  const MAC_PATCHED = 'x64ArchFiles: platformSpecificBuildOptions.x64ArchFiles ?? "**/@napi-rs/canvas-darwin-*/**",';
  let src = fs.readFileSync(macPackager, 'utf8');
  if (!src.includes(MAC_PATCHED)) {
    if (src.includes(MAC_NEEDLE)) {
      fs.writeFileSync(macPackager, src.replace(MAC_NEEDLE, MAC_PATCHED), 'utf8');
      console.log('patched macPackager.js (x64ArchFiles fallback for @napi-rs/canvas)');
    } else {
      console.log('macPackager.js: needle not found, skipping');
    }
  }
}
