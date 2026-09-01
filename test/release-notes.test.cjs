"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildReleaseNotes, extractVersionSection } = require("../scripts/release-notes.cjs");

const root = path.resolve(__dirname, "..");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const version = require("../package.json").version;

test("release notes use the current changelog section only", () => {
  const section = extractVersionSection(changelog, version);
  assert.match(section, /welcome screen runs again/i);
  assert.doesNotMatch(section, /First release from the re-founded repository/i);
});

test("release notes name every supported installer and checksum file", () => {
  const notes = buildReleaseNotes(changelog, version);
  assert.match(notes, new RegExp(`ClaudeAmp-Setup-${version}\\.exe`));
  assert.match(notes, new RegExp(`ClaudeAmp-${version}-arm64\\.dmg`));
  assert.match(notes, new RegExp(`ClaudeAmp-${version}-x64\\.dmg`));
  assert.match(notes, new RegExp(`ClaudeAmp-${version}-x86_64\\.AppImage`));
  assert.match(notes, /SHA256SUMS\.txt/);
});
