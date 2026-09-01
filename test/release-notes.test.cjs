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
  // Structure, not prose: the current version's section must exist and
  // contain no other version's heading. The extractor's slicing is pinned
  // against a FROZEN historical section, so this test survives releases.
  const section = extractVersionSection(changelog, version);
  assert.ok(section.length > 40, "current version section looks empty");
  assert.doesNotMatch(section, /^## \[/m);
  const frozen = extractVersionSection(changelog, "1.7.1");
  assert.match(frozen, /welcome screen runs again/i);
  assert.doesNotMatch(frozen, /First release from the re-founded repository/i);
});

test("release notes name every supported installer and checksum file", () => {
  const notes = buildReleaseNotes(changelog, version);
  assert.match(notes, new RegExp(`ClaudeAmp-Setup-${version}\\.exe`));
  assert.match(notes, new RegExp(`ClaudeAmp-${version}-arm64\\.dmg`));
  assert.match(notes, new RegExp(`ClaudeAmp-${version}-x64\\.dmg`));
  assert.match(notes, new RegExp(`ClaudeAmp-${version}-x86_64\\.AppImage`));
  assert.match(notes, /SHA256SUMS\.txt/);
});
