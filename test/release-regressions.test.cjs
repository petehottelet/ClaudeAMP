"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const html = read("index.html");
const app = read("js/app.js");
const css = read("css/skin.css");
const main = read("electron/main.cjs");
const proofs = read("electron/verify-proof.cjs");
const preload = read("electron/preload.cjs");
const versionSource = read("js/version.js");
const windows = read("js/windows.js");
const installer = read("build/installer.nsh");
const player = read("js/player.js");
const radio = read("js/radio.js");

test("release version agrees across package, lockfile, and UI", () => {
  const uiVersion = versionSource.match(/CLAUDEAMP_VERSION\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(pkg.version, "1.7.5");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(uiVersion, pkg.version);
});

test("setup menu uses the packaged official provider icon set", () => {
  const icons = [
    ["claude-cli", "claudecode-color.svg", "Claude Code"],
    ["codex-cli", "codex-color.svg", "Codex"],
    ["ollama", "ollama.svg", "Ollama"],
    ["claude", "claude-color.svg", "Claude"],
    ["openai", "openai.svg", "OpenAI"],
    ["gemini", "gemini-color.svg", "Gemini"],
  ];

  for (const [provider, file, title] of icons) {
    const asset = read(`assets/provider-icons/${file}`);
    assert.match(asset, new RegExp(`<title>${title}</title>`));
    assert.match(html, new RegExp(
      `name="sm-provider" value="${provider}"[\\s\\S]{0,240}` +
      `src="assets/provider-icons/${file.replace(".", "\\.")}"`,
    ));
  }

  const notice = read("assets/provider-icons/LICENSE.txt");
  assert.match(notice, /MIT License/);
  assert.match(notice, /Copyright \(c\) 2023 LobeHub/);
  assert.ok(pkg.build.files.includes("assets/**/*"));
  assert.match(proofs, /providerIconsPackaged/);
  assert.match(proofs, /icon\.naturalWidth > 0 && icon\.naturalHeight > 0/);
});

test("welcome music services remain three stacked radio choices", () => {
  assert.equal((html.match(/name="wm-music"/g) || []).length, 3);
  assert.equal((html.match(/type="radio" name="wm-music"/g) || []).length, 3);
  assert.match(css, /\.modern-ui \.provider-grid\.music-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(css, /\.modern-ui \.provider-grid\.music-grid\s*\{[^}]*repeat\(3/);
  assert.match(proofs, /welcomeMusicChoicesStacked/);
});

test("live verification bypasses the current onboarding screen before reload", () => {
  const setupKey = app.match(/const SETUP_KEY = "([^"]+)"/)?.[1];
  assert.ok(setupKey, "app must define an onboarding setup key");
  assert.ok(proofs.includes(`localStorage.setItem('${setupKey}', 'done')`));
  assert.doesNotMatch(proofs, /claudeamp\.onboarding\.setup\.v1/);
});

test("real terminal remains packaged, reachable, and covered by verification", () => {
  assert.match(html, /id="win-term"/);
  assert.match(app, /label:\s*"Terminal"/);
  assert.match(app, /function openTerminal\s*\(/);
  assert.match(preload, /claudeamp:term-open/);
  assert.match(main, /ipcMain\.handle\("claudeamp:term-open"/);
  assert.match(main, /utilityProcess\.fork/);
  assert.doesNotMatch(main, /fallback:\s*piped cmd\.exe/i);
  assert.match(main, /\["host", "conpty", winShell\], \["host", "winpty", winShell\]/);
  assert.match(main, /\["host", "pty", unixShell\], \["inproc", "pty", unixShell\]/);
  assert.match(main, /resolveLoginShell\(\)/);
  assert.match(proofs, /isRealTerminalBackend\(process\.platform, terminalBackend\)/);
  assert.ok(pkg.dependencies["@xterm/xterm"]);
  assert.ok(pkg.optionalDependencies["node-pty"]);
  assert.equal(pkg.build.npmRebuild, false);
  assert.ok(pkg.build.files.includes("node_modules/node-pty/**/*"));
  assert.ok(pkg.build.asarUnpack.includes("electron/pty-host.cjs"));
  assert.match(proofs, /terminalRendersOutput/);
  assert.match(proofs, /terminalAcceptsInput/);
  assert.match(proofs, /terminalUsesRealPty/);
  assert.match(proofs, /terminalHasConsoleDevice/);
  assert.match(proofs, /claudeCliRendersTui/);
  assert.match(proofs, /terminalOverlayHidden/);
  assert.match(proofs, /terminalSnapsToMainTop/);
  assert.match(main, /readiness round trip complete/);
  assert.match(app, /res\.initialData/);
  assert.match(app, /WM\.visible\("win-term"\)[\s\S]*openTerminal\(shellAutoCommand\(\)\)/);
  assert.match(app, /"Lucida Console", "Menlo", "Cascadia Mono", "Courier New"/);
  // Block art renders cell-exact regardless of font, at integer cell
  // heights, through the canvas renderer; truecolor TUIs get their real
  // colors. The WebGL addon must stay out: under the desktop's CSS zoom
  // it painted the grid into the bottom-left 1/zoom of its canvas,
  // leaving the top of every zoomed terminal black.
  assert.match(app, /customGlyphs:\s*true/);
  assert.match(app, /fontSize:\s*12\b/);
  assert.doesNotMatch(app, /WebglAddon/);
  assert.doesNotMatch(app, /addon-webgl/);
  assert.match(app, /CanvasAddon\.CanvasAddon\(\)/);
  assert.match(app, /Unicode11Addon\(\)/);
  assert.match(main, /COLORTERM\s*=\s*"truecolor"/);
  assert.match(html, /id="term-scroll"[\s\S]*class="amp-scroll-track"/);
  assert.match(app, /attachAmpScroll\(terminalViewport,\s*\$\("term-scroll"\)/);
  assert.match(app, /setChatMode\(WM\.visible\("win-term"\) \? "chat" : "shell"\)/);
  assert.match(app, /w\.id === "win-term" && S\.chatMode === "shell"/);
  assert.match(css, /#term-holder \.xterm-viewport\s*\{\s*scrollbar-width:\s*none/);
  assert.match(proofs, /terminalMenuShowsRealMode/);
  assert.match(proofs, /terminalUsesPlaylistScrollbar/);
  assert.doesNotMatch(app, /termTraceLines/);
  assert.doesNotMatch(app, /term\.write\("\\x1b\[90m\[claudeamp\]/);
  assert.doesNotMatch(app, /writeTerminalCliHint/);
  assert.match(css, /\.term-note\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.term-note\s*\{[^}]*pointer-events:\s*none/s);
});

test("near-aligned docked windows weld to the exact same top or left edge", () => {
  assert.match(windows, /const cross = Math\.abs\(edge\.cross\) <= DOCK_EPS \? 0 : edge\.cross/);
  assert.match(proofs, /\{x:289, y:13, w:480, h:220/);
  assert.match(proofs, /restored\.terminalTop === restored\.mainTop/);
});

test("onboarding tooltip uses the compact native-size pointer from the mockup", () => {
  // 16x10 with a uniform 2px outline: the 12x8 caret's 1px staircase read
  // as stray black squares once the desktop zoom scaled it up.
  assert.match(css, /\.onboarding-arrow\s*\{[^}]*left:\s*4\.5px/s);
  assert.match(css, /\.onboarding-arrow\s*\{[^}]*width:\s*16px;\s*height:\s*10px/s);
  assert.match(css, /\.onboarding-arrow\s*\{[^}]*background-size:\s*16px 10px/s);
  assert.doesNotMatch(css, /\.onboarding-arrow\s*\{[^}]*width:\s*24px/s);
  const arrowRule = css.match(/\.onboarding-arrow\s*\{[^}]*\}/s)[0];
  assert.doesNotMatch(arrowRule, /width%3D%271%27/,
    "no 1px-wide outline runs in the caret sprite - the stroke stays 2px thick");
  assert.match(proofs, /onboardingArrowCompact/);
  assert.match(proofs, /onboardingArrowPointsAtMenu/);
  assert.match(proofs, /onboardingArrowInNativeShape/);
  assert.match(read("js/native.js"), /SOLID\s*=\s*"[^"]*\.onboarding-arrow/);
  assert.match(app, /ONBOARDING_KEY\s*=\s*"claudeamp\.onboarding\.menu\.v2"/);
  assert.doesNotMatch(app, /ONBOARDING_KEY\s*=\s*"claudeamp\.onboarding\.menu\.v1"/);
});

test("Bosstones are removed, Mustard Plug is track 33, and radio charts use Bad Religion", () => {
  const readme = read("README.md");
  assert.doesNotMatch(player, /title:\s*"[^"]*Mighty Mighty Bosstones/i);
  assert.doesNotMatch(radio, /a:\s*"The Mighty Mighty Bosstones"/i);
  assert.doesNotMatch(readme, /the Mighty Mighty Bosstones/i);
  assert.match(player, /Mustard Plug - Mr\. Smiley/);
  assert.doesNotMatch(radio, /a:\s*"Mustard Plug"/);
  assert.match(radio, /a:\s*"Bad Religion",\s*t:\s*"21st Century \(Digital Boy\)"/);
  const defaults = [...player.matchAll(/^\s+applePreview\(\d+,\s*"([^"]+)"\),?$/gm)].map(match => match[1]);
  assert.equal(defaults.length, 50);
  assert.equal(defaults[32], "Mustard Plug - Mr. Smiley");
  // Owner's reorder: tracks 22 and 24 swapped. Stored playlists that are
  // still exactly the bundled catalog follow the current order on load.
  assert.equal(defaults[21], "The Lemonheads - It's A Shame About Ray");
  assert.equal(defaults[23], "Katrina & The Waves - Walking On Sunshine");
  assert.match(player, /const storedTracks = followDefaultOrder\(migrated\)/);
  assert.match(player, /followDefaultOrder\(replaceBosstones\(playlist\.tracks\)\)/);
  assert.match(player, /replaceBosstones\(cloneTracks\(data\.tracks\)\)/);
});

test("first-run playlist is backed by live iTunes previews", () => {
  const defaults = [...player.matchAll(/^\s+applePreview\((\d+),\s*"([^"]+)"\),?$/gm)];
  assert.equal(defaults.length, 50);
  assert.equal(new Set(defaults.map(match => match[1])).size, defaults.length);
  assert.match(player, /type:\s*"apple"[\s\S]*dur:\s*30/);
  assert.match(player, /hydrateAppleTracks/);
  const bridgeMusic = read("bridge-music.cjs");
  assert.match(bridgeMusic, /\/bridge\/apple\/lookup/);
  assert.match(bridgeMusic, /previewUrl/);
  assert.ok(pkg.build.files.includes("bridge-music.cjs"),
    "the split music backend must ship in the packaged app");
  assert.match(html, /id="itunes-store-link"[^>]*>VIEW IN ITUNES/);
  assert.match(app, /PROVIDED COURTESY OF ITUNES/);
  assert.match(html, /name="wm-music" value="itunes" checked/);
  assert.match(html, /name="sm-music" value="itunes" checked/);
  assert.match(app, /musicService:\s*"itunes"/);
  assert.match(app, /itunesDefaultV1/);
  assert.match(proofs, /itunesDefaultPlaylistHydrates/);
});

test("playlist source column follows the right-aligned duration column", () => {
  assert.match(app, /li\.append\(n, name, tk, src\)/);
  assert.doesNotMatch(app, /li\.appendChild\(src\)[\s\S]{0,80}li\.append\(name, tk\)/);
  assert.match(css, /\.pl-list li \.src\s*\{[^}]*margin-left:\s*4px[^}]*text-align:\s*right/s);
});

test("an old bundled YouTube catalog migrates to iTunes without matching ordinary custom lists", () => {
  const defaults = [...player.matchAll(/^\s+applePreview\((\d+),\s*"([^"]+)"\),?$/gm)]
    .map(([, , title], index) => ({ type: "youtube", id: String(index).padStart(11, "0"), title, dur: 240 }));
  const storage = new Map([["claudeamp.tracks", JSON.stringify({
    v: 51, custom: true, name: "ClaudeAmp 90s", idx: 8, tracks: defaults,
  })]]);
  class AudioStub {
    addEventListener() {}
    pause() {}
  }
  const context = {
    Audio: AudioStub,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    navigator: {},
    document: {
      createElement: () => ({ style: {}, remove() {} }),
      head: { appendChild() {} }, body: { appendChild() {} },
    },
    window: {},
    URL: { revokeObjectURL() {}, createObjectURL: () => "" },
    setTimeout: () => 0, clearTimeout() {},
  };
  context.window = context;
  vm.runInNewContext(player + "\n;globalThis.__Music = Music;", context);
  context.__Music.init({});
  assert.equal(context.__Music.tracks.length, 50);
  assert.equal(context.__Music.tracks.filter(track => track.type === "apple").length, 50);
  assert.equal(context.__Music.tracks.every(track => track.dur === 30), true);
  assert.equal(context.__Music.activeName, "ClaudeAmp 90s Previews");
  const persisted = JSON.parse(storage.get("claudeamp.tracks"));
  assert.equal(persisted.v, 52);
  assert.equal(persisted.tracks.filter(track => track.type === "apple").length, 50);
});

test("search is source-aware and only presents playable results", () => {
  assert.match(html, /id="music-search-source"/);
  for (const source of ["apple", "youtube", "spotify"])
    assert.match(html, new RegExp(`value="${source}"`));
  assert.match(html, /placeholder="SEARCH FOR A SONG"/);
  assert.match(html, /id="yt-search-button"[^>]*aria-label="Search"[^>]*><\/button>/);
  assert.match(html, /id="mb-reset-button"[^>]*aria-label="Back to visualization"[^>]*hidden><\/button>/);
  assert.doesNotMatch(html, />FIND<|SEARCH YOUTUBE FOR A SONG/);
  assert.match(app, /Music\.filterPlayableYoutube\(items\)/);
  assert.match(player, /async function filterPlayableYoutube/);
  assert.match(read("bridge-music.cjs"), /filter\(item => item && item\.uri && item\.is_playable !== false\)/);
  assert.match(read("bridge-music.cjs"), /map\(applePreviewResult\)\.filter\(Boolean\)/);
  assert.match(css, /\.yt-result-add\s*\{[^}]*width:\s*36px/s);
  const searchIcon = css.match(/#yt-search-button::before\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(searchIcon, /data:image\/svg\+xml/);
  assert.match(searchIcon, /shape-rendering%3D%27crispEdges%27/);
  assert.match(searchIcon, /fill-opacity%3D%270\.6%27/);
  assert.match(searchIcon, /image-rendering:\s*pixelated/);
  assert.doesNotMatch(searchIcon, /border-radius|rotate\(/);
  assert.match(css, /#yt-search-button::after\s*\{\s*content:\s*none;\s*\}/);
  assert.match(css, /#mb-reset-button\s*\{[^}]*width:\s*18px/s);
  assert.match(app, /function resetMusicSearch\s*\(/);
  assert.match(app, /\$\("mb-reset-button"\)\.addEventListener\("click",\s*\(\) => resetMusicSearch\(\)\)/);
  assert.match(app, /setMusicResultsVisible\(false\)/);
  assert.match(proofs, /visualizationResetRestoresMain/);
  assert.match(css, /--menu-select:\s*#1967D2/);
  assert.match(css, /\.w95-menu \.mi:hover\s*\{[^}]*background:\s*var\(--menu-select\)/s);
  assert.doesNotMatch(css, /\.w95-menu \.mi:hover\s*\{[^}]*#000080/s);
});

test("Rain and the playlist-style results scrollbar are release defaults", () => {
  assert.match(app, /fxOn:\s*true,\s*fxMode:\s*5/);
  assert.match(app, /rainDefaultV1/);
  assert.match(app, /visibleW \* RAIN_SCALE/);
  assert.match(app, /visibleH \* RAIN_SCALE/);
  assert.match(app, /if \(rain\) buildRain\(rainState\)/);
  // The rain is the 1.5.1 original restored verbatim at the owner's
  // request - with one later owner change: glyph cells at 1.5x (9 logical
  // px, was 6). Pacing (5.6 cells/second) and the 0.034/frame persistence
  // fade stay original. Do not "improve" it again.
  assert.match(app, /cell = 9 \* RAIN_SCALE/);
  assert.match(app, /GLYPHS\.speeds\[g\] \* 5\.6/);
  assert.match(app, /rgba\(0,0,0,0\.034\)/);
  assert.doesNotMatch(app, /RAINW\s*=|RAINH\s*=/);
  assert.match(html, /id="mb-results-scroll"/);
  assert.match(app, /attachAmpScroll\(\$\("yt-results"\),\s*\$\("mb-results-scroll"\),\s*28\)/);
  assert.match(css, /#yt-results::-webkit-scrollbar\s*\{\s*display:\s*none/);
  assert.match(proofs, /rainUsesFixedGlyphScale/);
});

test("half-step zoom options remain available", () => {
  assert.match(app, /zoom:\s*1\.5/);
  assert.match(app, /if \(!s\) S\.zoom = 1\.5/);
  assert.match(app, /Zoom 1\.5x/);
  assert.match(app, /setZoom\(1\.5\)/);
  assert.match(app, /Zoom 2\.5x/);
  assert.match(app, /setZoom\(2\.5\)/);
});

test("main menu is text-only with right-aligned state marks and footer account actions", () => {
  const mainMenu = app.slice(app.indexOf("function mainMenu"), app.indexOf("/* ------------------------- wrapped terminal"));
  const menuItems = mainMenu.slice(mainMenu.indexOf("openMenu(["));
  assert.doesNotMatch(mainMenu, /icon:/);
  assert.doesNotMatch(app, /className = "mi-icon"/);
  assert.match(css, /\.w95-menu \.mi\.checked::after\s*\{[^}]*right:\s*10px/s);
  assert.doesNotMatch(css, /\.w95-menu \.mi\.checked::before/);
  assert.ok(menuItems.indexOf('{ label: "About ClaudeAmp..."') < menuItems.indexOf("...accountItems"));
  assert.ok(menuItems.indexOf("...accountItems") < menuItems.indexOf('{ label: "Quit ClaudeAmp"'));
  // Both menu renderings dispatch through one command map, and the
  // preload carries the two menu channels.
  // The welcome runs on first launch only; it is no longer a menu item in
  // either rendering (owner's call). Settings carries everything it set.
  assert.doesNotMatch(mainMenu, /"Welcome"/);
  assert.doesNotMatch(read("js/menu-spec.js"), /id:\s*"welcome"/);
  assert.match(html, /data-tab="display"/);
  assert.equal((html.match(/name="sm-zoom"/g) || []).length, 5);
  assert.match(app, /input\[name="sm-zoom"\]:checked/);
  assert.match(preload, /onMenuCommand/);
  assert.match(preload, /setMenuState/);
});

test("user-facing provider language remains Model rather than Brain", () => {
  assert.doesNotMatch(app, /label:\s*"Brain:/i);
  assert.doesNotMatch(html, /<legend>\s*Brain\b/i);
  assert.match(app, /MODEL:\s*"\s*\+\s*provider\(\)\.label/);
  assert.match(html, /Refresh Models/);
});

test("playlist radio and modern Visualization controls remain wired", () => {
  assert.match(html, /id="pl-radio"[^>]*>RADIO<\/button>/);
  assert.match(html, /<script src="js\/radio\.js"><\/script>/);
  assert.match(app, /\$\("pl-radio"\)\.addEventListener\("click"/);
  assert.match(app, /winItem\("Visualization",\s*"win-mb"\)/);
  assert.match(app, /Video \(HD\)/);
  assert.match(app, /FX_MODES/);
});

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodeRgbaPng(data) {
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6);
  const bytesPerPixel = 4, stride = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0, source = 0; y < height; y++) {
    const filter = raw[source++];
    for (let x = 0; x < stride; x++, source++) {
      const left = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= bytesPerPixel ? pixels[(y - 1) * stride + x - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up :
        filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : -1;
      assert.notEqual(predictor, -1, "unsupported PNG filter " + filter);
      pixels[y * stride + x] = (raw[source] + predictor) & 255;
    }
  }
  return { width, height, pixels, pixel(x, y) {
    return [...pixels.subarray(y * stride + x * 4, y * stride + x * 4 + 4)];
  } };
}

test("Windows icon packages the high-resolution gradient claw mark", () => {
  const ico = fs.readFileSync(path.join(root, "assets", "claw-icon.ico"));
  const count = ico.readUInt16LE(4);
  let largest = null;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = ico[entry] || 256;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    if (!largest || width > largest.width) largest = { width, size, offset };
  }
  assert.equal(largest.width, 256);
  const png = decodeRgbaPng(ico.subarray(largest.offset, largest.offset + largest.size));
  // Full-bleed brand icon WITH standard rounded corners: the yellow-to-orange
  // gradient fills the square behind the claw-diamond art, but the canvas
  // corners are transparent (the rounded-rect mask) like a regular app icon.
  // Gradient color is judged at edge midlines inside the rounding, by
  // green/red ratio so exact gradient stops can be retuned without
  // rewriting the test.
  assert.equal(png.pixel(0, 0)[3], 0, "square corner must be masked off");
  assert.equal(png.pixel(253, 253)[3], 0, "square corner must be masked off");
  const [topRed, topGreen, topBlue, topAlpha] = png.pixel(64, 4);
  assert.ok(topRed > 235 && topGreen > 150 && topBlue < 100 && topAlpha === 255,
    `expected yellow top edge; got ${topRed},${topGreen},${topBlue},${topAlpha}`);
  const [botRed, botGreen, botBlue, botAlpha] = png.pixel(64, 251);
  assert.ok(botRed > 225 && botGreen > 100 && botGreen < 180 && botBlue < 90 && botAlpha === 255,
    `expected orange bottom edge; got ${botRed},${botGreen},${botBlue},${botAlpha}`);
  assert.ok(topGreen / topRed > botGreen / botRed + 0.1,
    "background must shift from yellow at the top toward orange at the bottom");
  // The claw-diamond art sits inset on the gradient (about 82% of the
  // canvas) rather than bleeding to the edges; sample points sit inside it.
  const [starRed, starGreen, starBlue, starAlpha] = png.pixel(126, 74);
  assert.ok(starRed > 240 && starGreen > 140 && starBlue < 80 && starAlpha === 255,
    `expected gold sparkle; got ${starRed},${starGreen},${starBlue},${starAlpha}`);
  const [clawRed, clawGreen, clawBlue, clawAlpha] = png.pixel(128, 190);
  assert.ok(clawRed > 230 && clawGreen > 70 && clawGreen < 170 && clawBlue < 80 && clawAlpha === 255,
    `expected orange gradient claw; got ${clawRed},${clawGreen},${clawBlue},${clawAlpha}`);
  // The diamond fill behind the claw stays the original neutral white/grey.
  const [fillRed, fillGreen, fillBlue, fillAlpha] = png.pixel(80, 150);
  assert.ok(fillRed > 200 && Math.abs(fillRed - fillGreen) < 12 && Math.abs(fillGreen - fillBlue) < 12 &&
    fillAlpha === 255,
    `expected neutral diamond fill; got ${fillRed},${fillGreen},${fillBlue},${fillAlpha}`);
});

test("Windows taskbar icon has a real packaged path and upgrade-time pin repair", () => {
  assert.deepEqual(pkg.build.extraResources, [
    { from: "assets/claw-icon.ico", to: "claw-icon.ico" },
  ]);
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
  assert.match(main, /function appIconPath\(\)/);
  assert.match(main, /path\.join\(process\.resourcesPath, "claw-icon\.ico"\)/);
  assert.match(main, /icon:\s*appIconPath\(\)/);
  assert.match(installer, /CreateShortCut[\s\S]*resources\\claw-icon\.ico/);
  assert.match(installer, /User Pinned\\TaskBar/);
  assert.match(installer, /WinShell::SetLnkAUMI[\s\S]*\$\{APP_ID\}/);
  assert.match(installer, /SHChangeNotify/);
  assert.match(installer, /ie4uinit\.exe[\s\S]*-show/);
  // allowToChangeInstallationDirectory forces keep-shortcuts OFF in
  // electron-builder's NSIS templates (installUtil.nsh) for every run
  // without --updated - and nothing here ever passes --updated. With it
  // set, every manual upgrade unpinned the taskbar icon and recreated
  // user-deleted shortcuts, and the pin repair above could never run.
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, undefined,
    "allowToChangeInstallationDirectory kills upgrade-time shortcut keeping");
});

test("Setup.exe: filled FILE icon, transparent WINDOW art", () => {
  // The owner's spec: Setup.exe's FILE icon (Explorer) is the same filled
  // rounded plaque as the installed app - no installerIcon override, so
  // electron-builder compiles win.icon into Setup.exe as MUI_ICON. The
  // RUNNING Setup window is different: its titlebar, taskbar entry, and
  // header show the transparent claw art, swapped in at GUI init with
  // WM_SETICON so the compiled file icon stays untouched.
  assert.equal(pkg.build.nsis.installerIcon, undefined);
  assert.equal(pkg.build.win.icon, "assets/claw-icon.ico");
  assert.equal(fs.existsSync(path.join(root, "assets", "claw-mark.ico")), true,
    "assets/claw-mark.ico is the transparent runtime window art");
  assert.match(installer, /MUI_CUSTOMFUNCTION_GUIINIT/);
  assert.match(installer, /claw-mark\.ico/);
  assert.match(installer, /SendMessage \$HWNDPARENT 0x0080/);
});
