"use strict";
/* electron-builder afterSign hook. We ship unsigned (no Apple Developer
   account), so CSC_IDENTITY_AUTO_DISCOVERY=false stops electron-builder
   from even attempting to sign - but a completely unsigned .app fails
   Gatekeeper on Apple Silicon with "ClaudeAmp is damaged and can't be
   opened", a strictly worse (and untrue) message than the normal
   unidentified-developer prompt. An ad-hoc signature (no certificate,
   just a valid local signing identity) is enough to get the ordinary
   "unidentified developer - right-click Open to override" behavior
   instead, on both Intel and Apple Silicon. This runs after
   electron-builder finishes its own (skipped) signing step and before
   the .app is packaged into the dmg/zip. */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterSign] ad-hoc signing ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
