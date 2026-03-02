'use strict';
// afterPack hook — ad-hoc sign the .app on macOS before DMG packaging.
//
// Without signing, macOS Gatekeeper marks downloaded apps as "damaged" and
// refuses to open them. Ad-hoc signing (-) satisfies the quarantine check;
// users see the standard "unidentified developer" prompt instead, which they
// can bypass via System Settings > Privacy & Security > Open Anyway.
//
// This only runs on darwin; on other platforms it exits immediately.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`afterPack: ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--sign', '-', '--force', '--deep', '--no-strict', appPath], {
    stdio: 'inherit',
  });
};
