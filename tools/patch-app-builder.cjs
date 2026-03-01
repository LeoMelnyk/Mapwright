'use strict';
// Patches app-builder-bin's Windows binary after npm install.
//
// electron-builder passes -snld to 7za when extracting its own tool archives.
// On Windows without Developer Mode, 7za exits with code 2 when it can't create
// macOS-style symlinks inside those archives (libcrypto.dylib, libssl.dylib).
// Those files are macOS-only and unused on Windows — but the non-zero exit code
// causes the entire build to fail.
//
// Fix: replace -snld with -snl- in the app-builder binary. This tells 7za to
// dereference symlinks (copy file contents) instead of creating symlink entries,
// so it exits 0 even on Windows without Developer Mode.
const fs = require('fs');
const path = require('path');

const binary = path.join(__dirname, '../node_modules/app-builder-bin/win/x64/app-builder.exe');

if (!fs.existsSync(binary)) {
  // Non-Windows or wrong arch — nothing to patch.
  process.exit(0);
}

const data = fs.readFileSync(binary);
const NEEDLE    = Buffer.from('-snld');
const PATCHED   = Buffer.from('-snl-');

if (data.indexOf(PATCHED) !== -1) {
  // Already patched from a previous install.
  process.exit(0);
}

const idx = data.indexOf(NEEDLE);
if (idx === -1) {
  // Pattern not found — binary may have changed; skip silently.
  process.exit(0);
}

const out = Buffer.allocUnsafe(data.length);
data.copy(out);
PATCHED.copy(out, idx);
fs.writeFileSync(binary, out);
console.log('patched app-builder.exe (-snld → -snl-)');

// Patch 2: windowsSignAzureManager.js — quote all PowerShell param values so that
// paths containing special characters (e.g. '&' in "D&D") don't break the command.
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
