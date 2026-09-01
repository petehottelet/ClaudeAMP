"use strict";

/* One menu spec drives the in-app hamburger and the native macOS menu
   bar. These tests keep the two from drifting: every spec id must have
   a renderer handler, ids and accelerators must be unique, and the
   macOS Services menu (which this app has nothing for) must never
   reappear via the stock appMenu role. */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const spec = require("../js/menu-spec.js");
const appSource = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const items = spec.flatMap(section => section.items).filter(item => !item.type);

test("spec ids are unique and every one has a MENU_COMMANDS handler", () => {
  const ids = items.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate menu id");
  const commands = appSource.slice(appSource.indexOf("const MENU_COMMANDS"),
    appSource.indexOf("function runMenuCommand"));
  for (const id of ids)
    assert.ok(commands.includes(`"${id}":`), `no MENU_COMMANDS handler for "${id}"`);
});

test("accelerators are unique and labels carry no Services item", () => {
  const accelerators = items.map(item => item.accelerator).filter(Boolean);
  assert.equal(new Set(accelerators).size, accelerators.length, "duplicate accelerator");
  for (const item of items)
    assert.doesNotMatch(item.label, /services/i);
});

test("the native bar builds from the spec, not the stock appMenu role", () => {
  assert.doesNotMatch(mainSource, /role:\s*"appMenu"/);
  assert.match(mainSource, /require\("\.\.\/js\/menu-spec\.js"\)/);
  assert.match(mainSource, /claudeamp:menu-command/);
  assert.match(mainSource, /claudeamp:menu-state/);
  assert.match(mainSource, /app\.dock\?\.setMenu/);
  assert.match(mainSource, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: false \}\)/);
  assert.match(mainSource, /setAboutPanelOptions/);
});

test("expected menus and shortcuts exist", () => {
  const menus = spec.map(section => section.menu);
  for (const name of ["app", "File", "View", "Account", "Help", "dock"])
    assert.ok(menus.includes(name), `missing menu ${name}`);
  const byId = Object.fromEntries(items.map(item => [item.id, item]));
  assert.equal(byId["settings"].accelerator, "CmdOrCtrl+,");
  assert.equal(byId["toggle-win-main"].accelerator, "CmdOrCtrl+1");
  assert.equal(byId["toggle-win-term"].accelerator, "CmdOrCtrl+7");
  assert.equal(byId["zoom-1"].accelerator, "CmdOrCtrl+0");
});
