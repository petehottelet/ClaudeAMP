"use strict";

/* The self-verification harness: runVerifyProof drives the live app through
   ~40 runtime checks for `verify:app` and the release gate; runSmokeProof
   is the packaged-app variant behind the --smoke-* flags. Split out of
   main.cjs so the shell logic stays readable; the ctx object carries the
   flags, window state, and mac-state accessors the proofs poke. This file
   ships in the package because scripts/smoke-packaged.cjs runs the
   installed app with --smoke-report. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loginShellArgs, isRealTerminalBackend } = require("./terminal-platform.cjs");

module.exports = function createProofs(ctx) {

async function runVerifyProof(window) {
  const v = { platform: process.platform, ok: false, failures: [] };
  const check = (name, pass, detail) => {
    v[name] = pass;
    if (detail !== undefined) v[name + "Detail"] = detail;
    if (!pass) v.failures.push(name);
  };
  try {
    await wait(1500); // let fonts/layout settle and the shape re-report
    // Fresh userData means first-run: the full-screen welcome overlay is up,
    // which (correctly) makes the whole desktop solid. Dismiss it so the
    // steady-state shape is what gets measured.
    const welcomeMusicLayout = await window.webContents.executeJavaScript(`(() => {
      const grid = document.querySelector('#welcome-modern .music-grid');
      const choices = Array.from(grid?.querySelectorAll('.choice-card') || []);
      const rects = choices.map(choice => {
        const rect = choice.getBoundingClientRect();
        return { left: Math.round(rect.left), top: Math.round(rect.top),
          width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      const result = {
        choiceCount: choices.length,
        radioCount: choices.filter(choice => choice.querySelector('input[type="radio"][name="wm-music"]')).length,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns : '',
        rects,
      };
      try { localStorage.setItem('claudeamp.onboarding.setup.v2', 'done'); } catch (_) {}
      const overlay = document.getElementById('welcome-modern');
      if (overlay) overlay.hidden = true;
      const tip = document.getElementById('menu-onboarding');
      if (tip) {
        tip.hidden = false;
        const main = document.getElementById('win-main');
        const requiredTop = tip.offsetHeight + 12;
        if (main && main.offsetTop < requiredTop)
          WM.moveDockGroup('win-main', 0, requiredTop - main.offsetTop, false);
      }
      return result;
    })()`);
    await wait(80);
    check("welcomeMusicChoicesStacked", welcomeMusicLayout.choiceCount === 3 &&
      welcomeMusicLayout.radioCount === 3 &&
      new Set(welcomeMusicLayout.rects.map(rect => rect.top)).size === 3 &&
      new Set(welcomeMusicLayout.rects.map(rect => rect.left)).size === 1 &&
      new Set(welcomeMusicLayout.rects.map(rect => rect.width)).size === 1,
      welcomeMusicLayout);
    const musicUi = await window.webContents.executeJavaScript(`(() => {
      const probe = document.createElement('button');
      probe.className = 'plbtn yt-result-add added'; probe.textContent = 'ADDED';
      probe.style.position = 'fixed'; probe.style.left = '-9999px';
      document.body.appendChild(probe);
      const addedButton = { clientWidth: probe.clientWidth, scrollWidth: probe.scrollWidth };
      probe.remove();
      return {
        sourceValues: Array.from(document.getElementById('music-search-source')?.options || []).map(o => o.value),
        searchPlaceholder: document.getElementById('yt-search-input')?.placeholder || '',
        searchButtonLabel: document.getElementById('yt-search-button')?.getAttribute('aria-label') || '',
        resetButtonLabel: document.getElementById('mb-reset-button')?.getAttribute('aria-label') || '',
        resetButtonInitiallyHidden: !!document.getElementById('mb-reset-button')?.hidden,
        resultsScrollbar: !!document.getElementById('mb-results-scroll'),
        rainVisible: !document.getElementById('fx-canvas')?.hidden &&
          document.getElementById('fx-pick')?.textContent.trim() === 'RAIN',
        defaultTrackCount: Music.tracks.length,
        defaultAppleTracks: Music.tracks.filter(track => track.type === 'apple').length,
        track33: Music.tracks[32]?.title || '',
        setupMusic: document.querySelector('input[name="wm-music"]:checked')?.value || '',
        settingsMusic: document.querySelector('input[name="sm-music"]:checked')?.value || '',
        searchMusic: document.getElementById('music-search-source')?.value || '',
        addedButton,
      };
    })()`);
    check("sourceAwareMusicSearch", ["apple", "youtube", "spotify"].every(source =>
      musicUi.sourceValues.includes(source)) && musicUi.searchPlaceholder === "SEARCH FOR A SONG" &&
      musicUi.searchButtonLabel === "Search", musicUi);
    const resetUi = await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('yt-search-input');
      const results = document.getElementById('yt-results');
      const reset = document.getElementById('mb-reset-button');
      input.value = 'ALICE IN CHAINS'; results.hidden = false; reset.hidden = false;
      reset.click();
      return { input: input.value, resultsHidden: results.hidden, resetHidden: reset.hidden };
    })()`);
    check("visualizationResetRestoresMain", musicUi.resetButtonLabel === "Back to visualization" &&
      musicUi.resetButtonInitiallyHidden && !resetUi.input && resetUi.resultsHidden && resetUi.resetHidden,
      { initial: musicUi, reset: resetUi });
    check("visualizationDefaultsToRain", musicUi.rainVisible, musicUi);
    const rainBefore = await window.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('win-mb');
      const canvas = document.getElementById('fx-canvas');
      window.__claudeampRainVerifySize = { width: panel.style.width, height: panel.style.height };
      const before = { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
        bitmapWidth: canvas.width, bitmapHeight: canvas.height };
      panel.style.width = (panel.offsetWidth + 137) + 'px';
      panel.style.height = (panel.offsetHeight + 113) + 'px';
      return before;
    })()`);
    // The backing rebuild rides the animation-frame loop, which macOS
    // throttles hard for occluded CI windows - a fixed wait races it (the
    // v1.6.4 mac release leg lost that race). Poll until the bitmap has
    // followed the stage, up to a generous deadline, then judge the
    // settled state.
    let rainAfter = null;
    for (let tries = 0; tries < 50; tries++) {
      await wait(60);
      rainAfter = await window.webContents.executeJavaScript(`(() => {
        const canvas = document.getElementById('fx-canvas');
        return { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
          bitmapWidth: canvas.width, bitmapHeight: canvas.height };
      })()`);
      if (rainAfter.bitmapWidth > rainBefore.bitmapWidth &&
          rainAfter.bitmapHeight > rainBefore.bitmapHeight) break;
    }
    await window.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('win-mb');
      const saved = window.__claudeampRainVerifySize;
      if (saved) { panel.style.width = saved.width; panel.style.height = saved.height; }
      delete window.__claudeampRainVerifySize;
      return true;
    })()`);
    const uniformRainScale = measurement => measurement.cssWidth > 0 && measurement.cssHeight > 0 &&
      Math.abs(measurement.bitmapWidth / measurement.cssWidth -
        measurement.bitmapHeight / measurement.cssHeight) < 0.02;
    check("rainUsesFixedGlyphScale", uniformRainScale(rainBefore) && uniformRainScale(rainAfter) &&
      rainAfter.cssWidth > rainBefore.cssWidth && rainAfter.cssHeight > rainBefore.cssHeight &&
      rainAfter.bitmapWidth > rainBefore.bitmapWidth && rainAfter.bitmapHeight > rainBefore.bitmapHeight,
      { before: rainBefore, after: rainAfter });
    await wait(80);
    check("itunesPreviewPlaylistDefault", musicUi.defaultTrackCount === 50 &&
      musicUi.defaultAppleTracks === 50 && musicUi.track33 === "Mustard Plug - Mr. Smiley", musicUi);
    check("itunesDefaultMusicChoice", musicUi.setupMusic === "itunes" &&
      musicUi.settingsMusic === "itunes" && musicUi.searchMusic === "apple", musicUi);
    check("visualizationUsesPlaylistScrollbar", musicUi.resultsScrollbar, musicUi);
    check("addedButtonTextFits", musicUi.addedButton.scrollWidth <= musicUi.addedButton.clientWidth, musicUi.addedButton);
    const providerIcons = await window.webContents.executeJavaScript(`(() =>
      Array.from(document.querySelectorAll('#settings-modern input[name="sm-provider"]')).map(input => {
        const icon = input.closest('.choice-card')?.querySelector('.choice-icon');
        return { provider: input.value, src: icon?.getAttribute('src') || '',
          loaded: !!icon?.complete && icon.naturalWidth > 0 && icon.naturalHeight > 0 };
      }))()`);
    const expectedProviderIcons = {
      "claude-cli": "assets/provider-icons/claudecode-color.svg",
      "codex-cli": "assets/provider-icons/codex-color.svg",
      ollama: "assets/provider-icons/ollama.svg",
      claude: "assets/provider-icons/claude-color.svg",
      openai: "assets/provider-icons/openai.svg",
      gemini: "assets/provider-icons/gemini-color.svg",
    };
    check("providerIconsPackaged", providerIcons.length === 6 && providerIcons.every(icon =>
      expectedProviderIcons[icon.provider] === icon.src && icon.loaded), providerIcons);
    const onboardingArrow = await window.webContents.executeJavaScript(`(() => {
      const tip = document.getElementById('menu-onboarding');
      const arrow = tip?.querySelector('.onboarding-arrow');
      const menu = document.querySelector('#win-main .tb-menu');
      if (!tip || !arrow || !menu) return {};
      const zoom = Number(getComputedStyle(document.getElementById('desktop')).zoom) || 1;
      const arrowRect = arrow.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      return {
        width: arrowRect.width, height: arrowRect.height, zoom,
        x: Math.floor(arrowRect.left), y: Math.floor(arrowRect.top),
        right: Math.ceil(arrowRect.right), bottom: Math.ceil(arrowRect.bottom),
        arrowCenter: arrowRect.left + arrowRect.width / 2,
        menuLeft: menuRect.left, menuRight: menuRect.right,
      };
    })()`);
    check("onboardingArrowCompact", onboardingArrow.width <= 12 * onboardingArrow.zoom + 0.5 &&
      onboardingArrow.height <= 8 * onboardingArrow.zoom + 0.5, onboardingArrow);
    check("onboardingArrowPointsAtMenu", onboardingArrow.arrowCenter >= onboardingArrow.menuLeft &&
      onboardingArrow.arrowCenter <= onboardingArrow.menuRight, onboardingArrow);
    let onboardingArrowInNativeShape = false;
    for (let i = 0; i < 10 && !onboardingArrowInNativeShape; i++) {
      onboardingArrowInNativeShape = ctx.lastShape.some(rect => rect.x <= onboardingArrow.x &&
        rect.y <= onboardingArrow.y && rect.x + rect.width >= onboardingArrow.right &&
        rect.y + rect.height >= onboardingArrow.bottom);
      if (!onboardingArrowInNativeShape) await wait(30);
    }
    check("onboardingArrowInNativeShape", onboardingArrowInNativeShape,
      { arrow: onboardingArrow, shape: ctx.lastShape });
    if (ctx.smokeScreenshot) {
      const image = await window.webContents.capturePage();
      fs.writeFileSync(ctx.smokeScreenshot, image.toPNG());
    }
    await window.webContents.executeJavaScript(`(() => {
      const tip = document.getElementById('menu-onboarding');
      if (tip) tip.hidden = true;
    })()`);
    // The shape re-reports asynchronously after the DOM change: wait until
    // the rect count settles (two identical reads) instead of a fixed sleep.
    let settled = -1;
    for (let i = 0; i < 20; i++) {
      await wait(200);
      if (ctx.lastShape.length > 0 && ctx.lastShape.length === settled) break;
      settled = ctx.lastShape.length;
    }
    check("windowVisible", window.isVisible());
    check("windowFocusable", window.isFocusable());
    const bounds = window.getContentBounds();
    const area = ctx.lastShape.reduce((sum, r) => sum + r.width * r.height, 0);
    v.shapeRectCount = ctx.lastShape.length;
    v.regionRatio = bounds.width * bounds.height ? area / (bounds.width * bounds.height) : 1;
    const panels = await window.webContents.executeJavaScript(
      `document.querySelectorAll('.wa-window:not(.hidden)').length`);
    v.visiblePanels = panels;
    // The solid region must cover the panels but stay well under the full
    // desktop, so the gaps between windows really are pass-through.
    check("shapeCoversPanels", ctx.lastShape.length >= panels && panels >= 5,
      { rects: ctx.lastShape.length, panels });
    // The point is that the shape is NOT one opaque full-window rect; the
    // actual pass-through proof is macMissDetectsGap below. Hosted CI
    // runners expose small virtual displays (1024x768-class), so the same
    // six panels legitimately cover ~86% there - keep this about the
    // presence of real gaps rather than tying it to one screen size.
    check("gapsRemain", v.regionRatio > 0 && v.regionRatio < 0.95, v.regionRatio);

    if (process.platform === "win32" || process.platform === "linux") {
      check("nativeShapeApplied", !ctx.shapeApplyError, ctx.shapeApplyError);
    }
    if (process.platform === "darwin") {
      // Freeze the cursor poll: the runner's mouse sits wherever it sits, and
      // a poll tick mid-assertion would race the deterministic checks below.
      ctx.freezeMacPoll();
      ctx.setMacState({ rendererOver: false, pollOver: false, held: false });
      // The window must start ignoring the mouse (gaps pass through)...
      check("macStartsIgnoring", ctx.macIgnoring === true);
      // ...the poll predicate must say "panel" for a point inside a rect and
      // "gap" for a point outside every rect...
      const rect = ctx.lastShape[0];
      const inside = rect ? ctx.screenPointOverShape(bounds.x + rect.x + 2, bounds.y + rect.y + 2) : false;
      check("macHitDetectsPanel", inside === true);
      let gapPoint = null;
      for (let gx = 0; gx < bounds.width && !gapPoint; gx += 40)
        for (let gy = 0; gy < bounds.height && !gapPoint; gy += 40)
          if (!ctx.lastShape.some(r => gx >= r.x && gx < r.x + r.width && gy >= r.y && gy < r.y + r.height))
            gapPoint = { x: gx, y: gy };
      check("macMissDetectsGap", !gapPoint || ctx.screenPointOverShape(bounds.x + gapPoint.x, bounds.y + gapPoint.y) === false);
      // ...a point just OUTSIDE a panel edge but inside the pre-arm halo must
      // already arm interactivity (clicks are never forwarded while ignoring,
      // so arming must beat the click) while staying a strict miss. Probe a
      // rect whose left halo is real gap - welded panels share seams.
      let edge = null;
      for (const r of ctx.lastShape) {
        const d = ctx.screenShapeDecision(bounds.x + r.x - (ctx.macHittest.ENTER_MARGIN - 1), bounds.y + r.y + 2);
        if (!d.over) { edge = d; break; }
      }
      check("macEnterMarginPreArmsEdge", !!edge && edge.near === true,
        edge || "no rect with a free left edge");
      // ...and both renderer signals must flip the native ignore flag.
      ctx.setMacState({ rendererOver: true });
      check("macInteractiveOverPanel", ctx.macIgnoring === false);
      ctx.setMacState({ rendererOver: false, pollOver: false, held: false });
      check("macIgnoresOverGap", ctx.macIgnoring === true);
      ctx.setMacState({ held: true });
      check("macHeldPinsInteractive", ctx.macIgnoring === false);
      ctx.setMacState({ held: false });
      // For the click test below the window must accept input.
      ctx.setMacState({ rendererOver: true });
    }

    // A real synthesized click through the input pipeline must toggle a
    // control (the EQ ON button), i.e. clicks are captured where they should be.
    const target = await window.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('eq-on');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               lit: el.classList.contains('lit') };
    })()`);
    const clickAt = (x, y) => {
      window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    };
    clickAt(target.x, target.y);
    await wait(300);
    const litAfter = await window.webContents.executeJavaScript(
      `document.getElementById('eq-on').classList.contains('lit')`);
    check("clickCaptured", litAfter !== target.lit, { before: target.lit, after: litAfter });
    clickAt(target.x, target.y); // restore
    if (process.platform === "darwin") { ctx.setMacState({ rendererOver: false }); }

    // The PTY must spawn a real shell and echo a marker back.
    v.pty = await new Promise(resolve => {
      let pty;
      try { pty = require("node-pty"); }
      catch (error) { resolve({ ok: false, error: "node-pty missing: " + error.message }); return; }
      const shellBin = process.platform === "win32" ? "cmd.exe" : ctx.resolveLoginShell();
      let proc = null, out = "", settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        try { if (proc) proc.kill(); } catch (_) {}
        resolve(result);
      };
      try {
        // ConPTY works now that the node-pty conout worker path is patched
        // (see the term-open handler); let node-pty use it.
        const proofOptions = { name: "xterm-256color", cols: 80, rows: 24,
          cwd: os.homedir(), env: process.env };
        if (process.platform === "win32") proofOptions.useConpty = true;
        proc = pty.spawn(shellBin, loginShellArgs(), proofOptions);
      } catch (error) { finish({ ok: false, error: error.message }); return; }
      const timer = setTimeout(() => finish({ ok: false, error: "pty timeout", tail: out.slice(-200) }), 25000);
      proc.onData(data => {
        out += data;
        if (out.includes("CLAUDEAMP_PTY_OK")) { clearTimeout(timer); finish({ ok: true, shell: shellBin }); }
      });
      setTimeout(() => { try { proc.write("echo CLAUDEAMP_PTY_OK\r"); } catch (_) {} }, 1200);
    });
    check("ptyWorks", !!v.pty.ok, v.pty);

    // The local ctx.bridge must be serving the app itself.
    const served = await window.webContents.executeJavaScript(
      `fetch('/', {cache:'no-store'}).then(r => r.status).catch(() => 0)`);
    check("bridgeServes", served === 200, served);

    // Every bundled entry must resolve by its Apple track ID to an actual
    // iTunes preview. Checking only the first entry previously allowed a
    // partially broken default catalog to escape the packaged proof.
    let preview = {};
    for (let i = 0; i < 30; i++) {
      preview = await window.webContents.executeJavaScript(`(() => {
        const tracks = Music.tracks || [];
        const first = tracks[0] || {};
        return {
          total: tracks.length,
          apple: tracks.filter(track => track.type === 'apple').length,
          hydrated: tracks.filter(track => track.type === 'apple' && /^https:\\/\\//.test(track.url || '') &&
            /^https:\\/\\//.test(track.storeUrl || '')).length,
          url: first.url || '', storeUrl: first.storeUrl || '', type: first.type || ''
        };
      })()`);
      if (preview.hydrated === preview.total && preview.total > 0) break;
      await wait(250);
    }
    check("itunesDefaultPlaylistHydrates", preview.total === 50 && preview.apple === 50 &&
      preview.hydrated === 50, preview);
    check("itunesPreviewHydrates", preview.type === "apple" && /^https:\/\//.test(preview.url) &&
      /^https:\/\//.test(preview.storeUrl), preview);
    if (preview.url) {
      const playTarget = await window.webContents.executeJavaScript(`(() => {
        const rect = document.getElementById('t-play').getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      clickAt(playTarget.x, playTarget.y);
      let playback = {};
      for (let i = 0; i < 32; i++) {
        playback = await window.webContents.executeJavaScript(`(() => {
          const clock = Music.time();
          return { mode: Music.mode, elapsed: clock.t, duration: clock.d };
        })()`);
        if (playback.mode === "playing" && playback.elapsed > 0) break;
        await wait(250);
      }
      check("itunesPreviewPlays", playback.mode === "playing" && playback.elapsed > 0 &&
        playback.duration > 0 && playback.duration <= 31, playback);
      await window.webContents.executeJavaScript(`Music.stop()`);
    } else {
      check("itunesPreviewPlays", false, { error: "preview never hydrated" });
    }

    // FULL renderer terminal round-trip through the real UI: open the
    // Terminal from the hamburger menu, then require the xterm panel to
    // show actual shell output. This is the path a user sees; the raw PTY
    // check above alone let a silently-black renderer slip through once.
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#win-main .tb-menu').click();
      setTimeout(() => {
        const item = Array.from(document.querySelectorAll('#ctxmenu *'))
          .find(el => el.textContent.trim() === 'Terminal' && el.children.length === 0);
        if (item) item.click();
      }, 150);
    })()`);
    let rowsText = "", noteText = "", terminalBackend = "";
    for (let i = 0; i < 40; i++) {
      await wait(500);
      const state = await window.webContents.executeJavaScript(`(() => {
        const rows = document.querySelector('#term-holder .xterm-rows');
        const note = document.getElementById('term-note');
        const noteStyle = note ? getComputedStyle(note) : null;
        const noteVisible = !!note && noteStyle.display !== 'none' &&
          noteStyle.visibility !== 'hidden' && Number(noteStyle.opacity || 1) > 0;
        return { rows: rows ? rows.textContent : '',
                 note: noteVisible ? note.textContent : '', noteVisible,
                 backend: document.getElementById('term-holder')?.dataset.backend || '' };
      })()`).catch(() => ({ rows: "", note: "" }));
      rowsText = String(state.rows || "");
      noteText = String(state.note || "");
      terminalBackend = String(state.backend || "");
      // Diagnostic rows appear immediately; they are not terminal readiness.
      // Keep polling until the overlay clears and xterm contains shell output.
      if (rowsText.trim() && !noteText.trim()) break;
    }
    v.terminalPanelText = (rowsText.trim() || noteText.trim()).slice(0, 200);
    // A pass needs real shell output / the CLI hint in the xterm rows —
    // an error note or a still-black panel both fail.
    check("terminalRendersOutput", rowsText.trim().length > 0 && !noteText.trim(),
      { rows: rowsText.trim().slice(0, 120), note: noteText.trim().slice(0, 120) });
    check("terminalUsesRealPty", isRealTerminalBackend(process.platform, terminalBackend),
      terminalBackend || "missing backend");
    const terminalChrome = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#win-main .tb-menu').click();
      const rows = Array.from(document.querySelectorAll('#ctxmenu .mi'));
      const ai = rows.find(row => row.textContent.trim() === 'Mode: AI Chat');
      const shell = rows.find(row => row.textContent.trim() === 'Mode: Real Terminal');
      const playlist = document.getElementById('pl-scroll');
      const terminal = document.getElementById('term-scroll');
      const playlistThumb = playlist?.querySelector('.amp-scroll-thumb');
      const terminalThumb = terminal?.querySelector('.amp-scroll-thumb');
      const result = {
        aiChecked: !!ai?.classList.contains('checked'),
        shellChecked: !!shell?.classList.contains('checked'),
        terminalScrollbar: !!terminal,
        sameWidth: !!playlist && !!terminal && getComputedStyle(playlist).width === getComputedStyle(terminal).width,
        sameThumb: !!playlistThumb && !!terminalThumb &&
          getComputedStyle(playlistThumb).backgroundImage === getComputedStyle(terminalThumb).backgroundImage,
        nativeScrollbarHidden: getComputedStyle(document.querySelector('#term-holder .xterm-viewport')).scrollbarWidth === 'none',
      };
      document.getElementById('ctxmenu').hidden = true;
      return result;
    })()`);
    check("terminalMenuShowsRealMode", terminalChrome.shellChecked && !terminalChrome.aiChecked, terminalChrome);
    check("terminalUsesPlaylistScrollbar", terminalChrome.terminalScrollbar && terminalChrome.sameWidth &&
      terminalChrome.sameThumb && terminalChrome.nativeScrollbarHidden, terminalChrome);
    const overlayState = await window.webContents.executeJavaScript(`(() => {
      const note = document.getElementById('term-note');
      const style = note ? getComputedStyle(note) : null;
      return { hidden: !!note && note.hidden,
        display: style ? style.display : 'missing',
        pointerEvents: style ? style.pointerEvents : 'missing' };
    })()`);
    check("terminalOverlayHidden", overlayState.hidden && overlayState.display === "none", overlayState);

    if (process.platform === "win32") {
      // mode con requires a console device. It fails under the old stdio-pipe
      // fallback even though echo/cd appear to work, so this distinguishes a
      // genuine interactive terminal from the exact false positive users saw.
      await window.webContents.executeJavaScript(
        `window.claudeampTerm.input('mode con\\r')`);
      let consoleText = "";
      for (let i = 0; i < 30; i++) {
        await wait(250);
        consoleText = await window.webContents.executeJavaScript(`(() => {
          const rows = document.querySelector('#term-holder .xterm-rows');
          return rows ? rows.textContent : '';
        })()`).catch(() => "");
        if (/Status for device CON|Lines:\s*\d+/i.test(String(consoleText))) break;
      }
      check("terminalHasConsoleDevice", /Status for device CON|Lines:\s*\d+/i.test(String(consoleText)),
        String(consoleText).trim().slice(-240));
    } else {
      check("terminalHasConsoleDevice", true, "not required outside Windows");
    }

    // Prove the UI is interactive, not merely displaying a startup prompt.
    // xterm does not locally echo typed characters, so seeing this command in
    // its rows proves renderer -> IPC -> PTY -> shell -> IPC -> renderer.
    const uiMarker = "CLAUDEAMP_UI_INPUT_OK";
    await window.webContents.executeJavaScript(
      `window.claudeampTerm.input('echo ${uiMarker}\\r')`);
    let interactiveText = "";
    for (let i = 0; i < 30; i++) {
      await wait(250);
      interactiveText = await window.webContents.executeJavaScript(`(() => {
        const rows = document.querySelector('#term-holder .xterm-rows');
        return rows ? rows.textContent : '';
      })()`).catch(() => "");
      if (String(interactiveText).includes(uiMarker)) break;
    }
    check("terminalAcceptsInput", String(interactiveText).includes(uiMarker),
      String(interactiveText).trim().slice(-160));

    // On a developer machine with Claude Code installed, exercise the exact
    // full-screen program from the bug report. This stays optional in generic
    // CI images, but is a required check whenever the executable is present.
    const claudeCandidates = process.platform === "win32" ? [
      path.join(os.homedir(), ".local", "bin", "claude.exe"),
      path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
    ] : [path.join(os.homedir(), ".local", "bin", "claude")];
    const claudeExecutable = claudeCandidates.find(candidate => candidate && fs.existsSync(candidate));
    v.claudeCliAvailable = claudeExecutable || false;
    if (claudeExecutable) {
      await window.webContents.executeJavaScript(`window.claudeampTerm.input('claude\\r')`);
      let claudeText = "";
      for (let i = 0; i < 40; i++) {
        await wait(500);
        claudeText = await window.webContents.executeJavaScript(`(() => {
          const rows = document.querySelector('#term-holder .xterm-rows');
          return rows ? rows.textContent : '';
        })()`).catch(() => "");
        if (/Claude Code|Welcome back|Recent activity|Tips for getting started|Not logged in/i.test(String(claudeText))) break;
      }
      check("claudeCliRendersTui",
        /Claude Code|Welcome back|Recent activity|Tips for getting started|Not logged in/i.test(String(claudeText)),
        String(claudeText).trim().slice(0, 400));
    }
    // End the first proof's PTY before reloading the renderer. Claude may be at
    // a trust/onboarding screen where Ctrl+C is intentionally ignored; leaving
    // that host alive would let its repaint race the fresh cold-start terminal.
    await window.webContents.executeJavaScript(`window.claudeampTerm.close()`);
    await wait(400);

    // Cold-relaunch regression: persist a standalone terminal as visible while
    // chat remains the primary mode, then reload the renderer. The restored
    // terminal must start itself without the user closing/reopening its frame.
    const reloadFinished = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 15000);
      window.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    await window.webContents.executeJavaScript(`(() => {
      try {
        const settings = JSON.parse(localStorage.getItem('claudeamp.settings') || '{}');
        settings.chatMode = 'chat'; settings.zoom = 1; settings.zoomV5 = true;
        localStorage.setItem('claudeamp.settings', JSON.stringify(settings));
        localStorage.setItem('claudeamp.onboarding.setup.v2', 'done');
        // This reload specifically verifies restored terminal geometry. Keep
        // the separate menu-tip onboarding from moving only one dock group.
        localStorage.setItem('claudeamp.onboarding.menu.v2', 'done');
        if (typeof WM !== 'undefined' && WM.saveLayout) WM.saveLayout();
        const layout = JSON.parse(localStorage.getItem('claudeamp.layout.v2') || '{}');
        // Deliberately persist the terminal one logical pixel below the main
        // window. Layout restore must weld that near-alignment to an exact top
        // edge, matching what users expect from the default docked shell slot.
        layout['win-main'] = Object.assign({}, layout['win-main'] || {},
          {x:14, y:12, hidden:false, shaded:false});
        layout['win-term'] = Object.assign({}, layout['win-term'] || {},
          {x:289, y:13, w:480, h:220, hidden:false, shaded:false});
        // Keep the chat window visible (chat is still the selected mode) but
        // place it immediately to the right of the terminal. Reusing its
        // current coordinates here can overlap the terminal after the earlier
        // onboarding probe moved the dock group, which makes dock
        // normalization correctly choose a different edge and invalidates
        // this isolated one-pixel weld check.
        layout['win-chat'] = Object.assign({}, layout['win-chat'] || {},
          {x:769, y:12, w:480, h:220, hidden:false, shaded:false});
        localStorage.setItem('claudeamp.layout.v2', JSON.stringify(layout));
      } catch (_) {}
      setTimeout(() => location.reload(), 25);
      return true;
    })()`);
    check("rendererReloaded", await reloadFinished);

    let restored = {};
    for (let i = 0; i < 50; i++) {
      await wait(500);
      restored = await window.webContents.executeJavaScript(`(() => {
        const terminalWindow = document.getElementById('win-term');
        const mainWindow = document.getElementById('win-main');
        const terminalHolder = document.getElementById('term-holder');
        const xterm = document.querySelector('#term-holder .xterm');
        const screen = document.querySelector('#term-holder .xterm-screen');
        const rows = document.querySelector('#term-holder .xterm-rows');
        const note = document.getElementById('term-note');
        const noteStyle = note ? getComputedStyle(note) : null;
        const rowElements = rows ? Array.from(rows.children) : [];
        const rowTexts = rowElements.map(row => row.textContent || '');
        const cursor = document.querySelector('#term-holder .xterm-cursor');
        const cursorRow = cursor ? rowElements.findIndex(row => row.contains(cursor)) : -1;
        let promptRow = -1;
        rowTexts.forEach((text, index) => { if (/[A-Za-z]:\\\\.*>\\s*$/.test(text)) promptRow = index; });
        return {
          windowVisible: !!terminalWindow && !terminalWindow.classList.contains('hidden'),
          terminalTop: terminalWindow?.getBoundingClientRect().top ?? null,
          mainTop: mainWindow?.getBoundingClientRect().top ?? null,
          xtermPresent: !!xterm,
          rows: rows ? rows.textContent : '',
          noteVisible: !!noteStyle && noteStyle.display !== 'none' && noteStyle.visibility !== 'hidden',
          note: note ? note.textContent : '',
          fontFamily: screen ? getComputedStyle(screen).fontFamily : '',
          backend: terminalHolder?.dataset.backend || '',
          cursorRow, promptRow, rowTexts,
        };
      })()`).catch(() => ({}));
      const cursorReady = process.platform !== "win32" || restored.cursorRow >= 0;
      if (restored.xtermPresent && String(restored.rows || "").trim() &&
          !restored.noteVisible && cursorReady) break;
    }
    const restoredText = String(restored.rows || "");
    check("restoredTerminalStarts", restored.windowVisible && restored.xtermPresent &&
      restoredText.trim().length > 0 && !restored.noteVisible, restored);
    check("restoredTerminalUsesRealPty", isRealTerminalBackend(process.platform, restored.backend),
      restored.backend || "missing backend");
    check("terminalSnapsToMainTop", restored.terminalTop !== null &&
      restored.mainTop !== null && restored.terminalTop === restored.mainTop,
      { terminalTop: restored.terminalTop, mainTop: restored.mainTop });
    check("terminalHidesDiagnostics", !/\[claudeamp\]|host:|pty\.spawn|readiness round trip/i.test(restoredText),
      restoredText.slice(0, 240));
    // macOS uses Menlo/Monaco (it ships neither Lucida Console nor Cascadia
    // Mono, and Courier New garbles the CLI's block art); everywhere else
    // the classic Lucida Console stack applies.
    check("terminalUsesBlockFont", process.platform === "darwin"
      ? /Menlo/i.test(String(restored.fontFamily || ""))
      : /Lucida Console/i.test(String(restored.fontFamily || "")),
      restored.fontFamily || "missing");
    if (process.platform === "win32")
      check("terminalCursorOnPrompt", restored.cursorRow >= 0 && restored.cursorRow === restored.promptRow,
        { cursorRow: restored.cursorRow, promptRow: restored.promptRow,
          rows: Array.isArray(restored.rowTexts) ? restored.rowTexts.slice(0, 12) : [] });

    const restoredMarker = "CLAUDEAMP_RESTORED_OK";
    await window.webContents.executeJavaScript(
      `window.claudeampTerm.input('echo ${restoredMarker}\\r')`);
    let restoredInteractive = "";
    for (let i = 0; i < 30; i++) {
      await wait(250);
      restoredInteractive = await window.webContents.executeJavaScript(`(() => {
        const rows = document.querySelector('#term-holder .xterm-rows');
        return rows ? rows.textContent : '';
      })()`).catch(() => "");
      if (String(restoredInteractive).includes(restoredMarker)) break;
    }
    check("restoredTerminalAcceptsInput", String(restoredInteractive).includes(restoredMarker),
      String(restoredInteractive).trim().slice(-160));

    v.ok = v.failures.length === 0;
  } catch (error) {
    v.error = (error && error.stack) || String(error);
    v.ok = false;
  }
  try {
    fs.mkdirSync(path.dirname(ctx.verifyReport), { recursive: true });
    fs.writeFileSync(ctx.verifyReport, JSON.stringify(v, null, 2));
  } catch (_) {}
  await wait(200);
  ctx.app.exit(v.ok ? 0 : 2);
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function runSmokeProof(window) {
  const bounds = window.getContentBounds();
  const shapeArea = () => ctx.lastShape.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  const report = {
    desktop: true,
    frame: false,
    browserChrome: false,
    menuBarVisible: window.isMenuBarVisible(),
    transparentWindowConfigured: true,
    nativeShapeSupported: process.platform === "win32" || process.platform === "linux",
    shapeApplyError: ctx.shapeApplyError,
    shapeRectCount: ctx.lastShape.length,
    shapeRevision: ctx.shapeRevision,
    shapeArea: shapeArea(),
    desktopArea: bounds.width * bounds.height,
  };
  report.nativeRegionRatio = report.desktopArea ? report.shapeArea / report.desktopArea : 1;
  report.boundingBoxEliminated = report.shapeRectCount >= 6 && report.nativeRegionRatio < 0.5 && !ctx.shapeApplyError;
  try {
    await wait(1200);
    Object.assign(report, await window.webContents.executeJavaScript(`(() => {
      const pixelRule = Array.from(document.styleSheets).flatMap(sheet => {
        try { return Array.from(sheet.cssRules || []); } catch (_) { return []; }
      }).find(rule => rule.selectorText === '#yt-wrap.indexed-video iframe');
      const onboardingTooltip = (() => {
        const tip = document.getElementById('menu-onboarding');
        if (!tip) return { present: false };
        const main = document.getElementById('win-main').getBoundingClientRect();
        const menu = document.querySelector('#win-main .tb-menu').getBoundingClientRect();
        const caret = tip.querySelector('.onboarding-arrow').getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        const value = {
          present: getComputedStyle(tip).display !== 'none',
          aboveMainWindow: tipRect.bottom < main.top,
          caretAttached: caret.top <= tipRect.bottom + 1 && caret.bottom >= main.top,
          pointsAtMenu: (caret.left + caret.width / 2) >= menu.left &&
            (caret.left + caret.width / 2) <= menu.right,
          caretRect: {
            x: Math.floor(caret.left), y: Math.floor(caret.top),
            right: Math.ceil(caret.right), bottom: Math.ceil(caret.bottom),
          },
          mentionsCliAuth: /authenticate your CLI/i.test(tip.textContent),
          mentionsOptions: /additional options/i.test(tip.textContent),
          animation: getComputedStyle(tip).animationName,
          sparkles: tip.querySelectorAll('.pixel-sparkles i').length,
        };
        if (!${ctx.smokeScreenshot ? "true" : "false"}) {
          tip.querySelector('.onboarding-close')?.click();
          value.dismissPersisted = localStorage.getItem('claudeamp.onboarding.menu.v2') === 'done';
        }
        return value;
      })();
      const chatInput = document.getElementById('chat-input');
      chatInput.value = 'SMOKE AUTH GUIDE MESSAGE';
      document.getElementById('chat-send').click();
      const guideMenu = document.getElementById('ctxmenu');
      const guideRow = guideMenu.querySelector('[data-menu-id="claude-login"]');
      const guideTip = guideRow?.querySelector('.menu-auth-tooltip');
      const rowRect = guideRow?.getBoundingClientRect();
      const authTipRect = guideTip?.getBoundingClientRect();
      const zoom = Number(getComputedStyle(document.getElementById('desktop')).zoom) || 1;
      const authenticationGuide = {
        menuAutoOpened: !guideMenu.hidden,
        correctLoginHighlighted: !!guideRow?.classList.contains('login-onboarding'),
        highlightAnimation: guideRow ? getComputedStyle(guideRow).animationName : '',
        rowSparkles: guideRow?.querySelectorAll(':scope > .pixel-sparkles i').length || 0,
        tooltipPresent: !!guideTip,
        tooltipMentionsTerminal: /terminal/i.test(guideTip?.textContent || ''),
        tooltipSparkles: guideTip?.querySelectorAll('.pixel-sparkles i').length || 0,
        tooltipPointsAtLogin: !!(rowRect && authTipRect && authTipRect.left > rowRect.right &&
          Math.abs((authTipRect.top + 19 * zoom) - (rowRect.top + rowRect.height / 2)) <= 3),
        inputPreserved: chatInput.value === 'SMOKE AUTH GUIDE MESSAGE',
        demoReplySuppressed: !/local tape loop|demo loop/i.test(document.getElementById('chat-log').textContent),
      };
      guideMenu.hidden = true;
      return {
        desktopBridge: !!(window.claudeAmpDesktop && window.claudeAmpDesktop.isDesktop),
        claudeLoginBridge: typeof window.claudeAmpDesktop?.openClaudeLogin === 'function',
        claudeLoginCompletionBridge: typeof window.claudeAmpDesktop?.onClaudeLoginComplete === 'function',
        claudeLoginButton: !!document.getElementById('claude-login'),
        codexLoginBridge: typeof window.claudeAmpDesktop?.openCodexLogin === 'function',
        codexLoginCompletionBridge: typeof window.claudeAmpDesktop?.onCodexLoginComplete === 'function',
        codexLoginButton: !!document.getElementById('codex-login'),
        nativeBridge: !!window.claudeampNative,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        desktopBackground: getComputedStyle(document.getElementById('desktop')).backgroundColor,
        visiblePanels: Array.from(document.querySelectorAll('.wa-window')).filter(el => getComputedStyle(el).display !== 'none').length,
        searchBarPresent: !!document.getElementById('yt-search-form'),
        pixelFilterEnabled: document.getElementById('yt-wrap').classList.contains('indexed-video'),
        pixelFilterLabel: document.getElementById('fx-pick').textContent.trim(),
        pixelTransform: pixelRule && pixelRule.style.transform,
        pixelSourceWidth: pixelRule && pixelRule.style.width,
        monoStereo: document.getElementById('cv-info').height === 12,
        firstTrack: Music.tracks[0] && Music.tracks[0].title,
        secondTrack: Music.tracks[1] && Music.tracks[1].title,
        appleBadgePresent: document.querySelector('#pl-list li:first-child .src')?.textContent === 'I',
        ollamaProvider: !!ClaudeAPI.PROVIDERS.ollama,
        ollamaLocalBridge: ClaudeAPI.PROVIDERS.ollama?.local === 'ollama',
        ollamaOption: !!document.querySelector('input[name="sm-provider"][value="ollama"]'),
        aboutTaglineExact: /A classically-styled terminal interface for Claude Code, OpenAI Codex,\\s+and Ollama\\. For Windows, macOS, and Linux\\./.test(document.getElementById('dlg-about').textContent),
        startupDockedIds: WM.dockedIds('win-main'),
        defaultZoom: Number(getComputedStyle(document.getElementById('desktop')).zoom),
        onboardingTooltip,
        authenticationGuide,
      };
    })()`));

    const beforeMove = ctx.shapeRevision;
    Object.assign(report, await window.webContents.executeJavaScript(`(() => {
      const ids = WM.dockedIds('win-main');
      const before = Object.fromEntries(ids.map(id => {
        const el = document.getElementById(id);
        return [id, { x: el.offsetLeft, y: el.offsetTop }];
      }));
      const moved = WM.moveDockGroup('win-eq', 7, 5);
      const together = moved.length === ids.length && moved.every(id => {
        const el = document.getElementById(id);
        return el.offsetLeft - before[id].x === 7 && el.offsetTop - before[id].y === 5;
      });
      const seams = (() => {
        const r = id => {
          const el = document.getElementById(id);
          return { x: el.offsetLeft, y: el.offsetTop, right: el.offsetLeft + el.offsetWidth,
            bottom: el.offsetTop + el.offsetHeight };
        };
        const main = r('win-main'), eq = r('win-eq'), usage = r('win-usage');
        const mb = r('win-mb'), chat = r('win-chat'), playlist = r('win-pl');
        return [eq.y - main.bottom, usage.y - eq.bottom, mb.y - usage.bottom,
          chat.x - main.right, playlist.y - chat.bottom];
      })();
      return { dockedGroupMovesTogether: together, dockSeams: seams,
        dockSeamsClean: seams.every(gap => gap === 0) };
    })()`));
    await wait(180);
    report.dragUpdatesNativeShape = ctx.shapeRevision > beforeMove;
    const beforeShade = ctx.shapeRevision;
    await window.webContents.executeJavaScript(`WM.toggleShade('win-eq')`);
    await wait(180);
    report.shadeUpdatesNativeShape = ctx.shapeRevision > beforeShade;
    report.shadedPanelHeight = await window.webContents.executeJavaScript(
      `Math.round(document.getElementById('win-eq').getBoundingClientRect().height)`
    );
    await window.webContents.executeJavaScript(`(() => {
      WM.toggleShade('win-eq');
      WM.moveDockGroup('win-main', -7, -5);
    })()`);
    await wait(180);

    if (ctx.smokeAbout) {
      await window.webContents.executeJavaScript(`(() => {
        const dialog = document.getElementById('dlg-about');
        dialog.hidden = false;
        dialog.style.left = '400px';
        dialog.style.top = '70px';
        dialog.style.zIndex = '200';
      })()`);
      await wait(180);
      Object.assign(report, await window.webContents.executeJavaScript(`(() => {
        const dialog = document.getElementById('dlg-about');
        const title = getComputedStyle(dialog.querySelector('.w95-title'));
        return {
          aboutVisible: !dialog.hidden,
          aboutGradient: title.backgroundImage,
          aboutHasAuthor: /Pete Hottelet/.test(dialog.textContent),
          aboutHasGithub: !!dialog.querySelector('a[href*="github.com/petehottelet/claudeamp"]'),
          aboutRemovedLoving: !/loving/i.test(dialog.textContent),
          aboutBrandImageLoaded: !!dialog.querySelector('.about-logo')?.complete &&
            dialog.querySelector('.about-logo').naturalWidth > 0,
        };
      })()`));
    }

    if (ctx.smokeSettings || ctx.smokeSettingsMusic) {
      await window.webContents.executeJavaScript(`(() => {
        const welcome = document.getElementById('welcome-modern');
        const settings = document.getElementById('settings-modern');
        const tip = document.getElementById('menu-onboarding');
        if (welcome) welcome.hidden = true;
        if (tip) tip.hidden = true;
        if (settings) settings.hidden = false;
        if (${ctx.smokeSettingsMusic ? "true" : "false"}) {
          document.querySelectorAll('#sm-tabs .sm-tab').forEach(tab => {
            const active = tab.dataset.tab === 'music';
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
          });
          document.querySelectorAll('#settings-modern .sm-tab-panel').forEach(panel => {
            panel.hidden = panel.dataset.panel !== 'music';
          });
        }
      })()`);
      await wait(180);
      Object.assign(report, await window.webContents.executeJavaScript(`(() => {
        const icons = Array.from(document.querySelectorAll('#settings-modern .choice-icon'));
        return {
          settingsVisible: !document.getElementById('settings-modern').hidden,
          settingsMusicVisible: !document.querySelector('#settings-modern [data-panel="music"]')?.hidden,
          settingsMusicChoice: document.querySelector('input[name="sm-music"]:checked')?.value || '',
          settingsProviderIcons: icons.map(icon => ({
            src: icon.getAttribute('src'), loaded: icon.complete && icon.naturalWidth > 0,
          })),
        };
      })()`));
    }

    if (ctx.smokeScreenshot) {
      if (ctx.smokeVisualizationResults) {
        await window.webContents.executeJavaScript(`(() => {
          document.getElementById('welcome-modern').hidden = true;
          document.getElementById('menu-onboarding').hidden = true;
          document.getElementById('ctxmenu').hidden = true;
          const source = document.getElementById('music-search-source');
          const input = document.getElementById('yt-search-input');
          source.value = 'apple'; input.value = 'ALICE IN CHAINS';
          document.getElementById('yt-search-form').requestSubmit();
        })()`);
        await wait(2500);
      }
      const image = await window.webContents.capturePage();
      const bitmap = image.toBitmap();
      report.screenshotTopLeftAlpha = bitmap.length >= 4 ? bitmap[3] : null;
      report.transparentWindow = report.screenshotTopLeftAlpha === 0;
      fs.writeFileSync(ctx.smokeScreenshot, image.toPNG());
      report.screenshot = ctx.smokeScreenshot;
    }
  } catch (error) {
    report.error = error && error.stack || String(error);
  }
  const finalBounds = window.getContentBounds();
  report.shapeRectCount = ctx.lastShape.length;
  report.shapeRevision = ctx.shapeRevision;
  report.shapeArea = shapeArea();
  report.desktopArea = finalBounds.width * finalBounds.height;
  report.nativeRegionRatio = report.desktopArea ? report.shapeArea / report.desktopArea : 1;
  const caret = report.onboardingTooltip?.caretRect;
  report.onboardingCaretInNativeShape = !!caret && ctx.lastShape.some(rect =>
    rect.x <= caret.x && rect.y <= caret.y &&
    rect.x + rect.width >= caret.right && rect.y + rect.height >= caret.bottom);
  const onboardingShape = ctx.smokeScreenshot && report.onboardingTooltip?.present ? 2 : 0;
  report.nativeRegionExact = report.shapeRectCount === report.visiblePanels +
    (report.aboutVisible ? 1 : 0) + onboardingShape;
  report.boundingBoxEliminated = report.nativeShapeSupported && !ctx.shapeApplyError &&
    report.nativeRegionExact && ctx.lastShape.every(rect => rect.width < finalBounds.width || rect.height < finalBounds.height);
  fs.mkdirSync(path.dirname(ctx.smokeReport), { recursive: true });
  fs.writeFileSync(ctx.smokeReport, JSON.stringify(report, null, 2));
  await wait(250);
  ctx.app.quit();
}

  return { runVerifyProof, runSmokeProof };
};
