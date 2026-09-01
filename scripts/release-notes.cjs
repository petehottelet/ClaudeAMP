"use strict";

const fs = require("node:fs");
const path = require("node:path");

function extractVersionSection(markdown, version) {
  const headings = [...markdown.matchAll(/^## \[([^\]]+)\](?:\s+-[^\n]*)?\s*$/gm)];
  const index = headings.findIndex(match => match[1] === version);
  if (index < 0) throw new Error(`CHANGELOG.md has no [${version}] section`);

  const start = headings[index].index + headings[index][0].length;
  const end = headings[index + 1]?.index ?? markdown.length;
  const section = markdown.slice(start, end).trim();
  if (!section) throw new Error(`CHANGELOG.md [${version}] section is empty`);
  return section;
}

function buildReleaseNotes(markdown, version) {
  const changes = extractVersionSection(markdown, version);
  return [
    "## Changes",
    "",
    changes,
    "",
    "## Downloads",
    "",
    `- **Windows:** \`ClaudeAmp-Setup-${version}.exe\``,
    `- **macOS Apple Silicon:** \`ClaudeAmp-${version}-arm64.dmg\``,
    `- **macOS Intel:** \`ClaudeAmp-${version}-x64.dmg\``,
    `- **Linux:** \`ClaudeAmp-${version}-x86_64.AppImage\``,
    "",
    "Every artifact is built and smoke-tested by GitHub Actions. Use",
    "`SHA256SUMS.txt` to verify a downloaded file before installing.",
    "",
  ].join("\n");
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const version = process.argv[2] || require(path.join(root, "package.json")).version;
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  process.stdout.write(buildReleaseNotes(changelog, version));
}

module.exports = { buildReleaseNotes, extractVersionSection };
