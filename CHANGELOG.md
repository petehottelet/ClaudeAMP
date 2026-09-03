# Changelog

Notable changes to ClaudeAmp. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
the `package.json` version, which CI requires to agree with `js/version.js`.

## [Unreleased]

### Changed
- Chat: every model shows a typing indicator, three dots pulsing in a
  bubble on its side of the conversation, from the moment a message is
  sent until the first token arrives. It used to appear only for models
  that report their reasoning, and read "THINKING" with trailing dots.
- Settings: "More details, legal & privacy" unfolds a scrollable panel in
  place instead of opening a separate dialog.
- About: the stacked logo is rebuilt from the master artwork (same
  proportions as the site logo, trimmed to its edges) and sits with equal
  spacing above and below the URL.
- Visualization window: the music-source dropdown lettering carries the
  same emboss as the RAIN and search buttons beside it.

- Snake: the board is twice as dense (50x30 cells), so the snake and its
  pellet are half the size on screen at the same pace, and the pellet is a
  square like the snake's cells instead of a round dot.

### Fixed
- Visualization window: the search magnifier no longer comes out lopsided
  at 1x zoom on displays with fractional scaling (125%, 150%); it is
  vector art now and resamples evenly instead of nearest-neighbor.

## [1.7.5] - 2026-09-03

### Fixed
- Windows: clicks work again after the app loses and regains focus.
  1.7.4's window-blur handler reached the macOS click-through recompute on
  every platform and told the Windows window to ignore the mouse on the
  first focus loss (older builds masked it by re-arming on every shape
  report). The recompute is macOS-only now, and the Windows/Linux runner
  proves a blur never raises the ignore flag.
- Release pipeline: a version whose first release run failed part-way
  (1.7.5's own first attempt left a prerelease holding only the Windows
  and Linux installers) is rebuilt and published in full on the next
  release push instead of being stranded behind the "already released"
  guard. Promoted releases stay immutable.

### Added
- Settings has a Display tab with the desktop zoom (1x to 3x), the same
  steps as the Cmd/Ctrl shortcuts.

### Changed
- The Welcome item is gone from the menus (in-app and the macOS menu bar);
  the welcome still runs on first launch, and Settings carries everything
  it sets.
- The main-window dropdown no longer lists Mode: AI Chat / Mode: Real
  Terminal or the zoom steps: the Terminal item (Cmd/Ctrl+7) switches
  modes, and zoom lives in Settings > Display and on Cmd/Ctrl +, -, and 0.
  The macOS View menu keeps Actual Size, Zoom In, and Zoom Out.
- About ClaudeAmp is the same white panel as Settings, and both Settings
  and About can be dragged by their header.
- Rain glyphs are 1.5x larger, and every glyph in a drip is drawn as a
  solid green character (thicker strokes, slower fade) instead of thin
  strokes that went black a few cells behind the head.
- macOS: the three title-bar dots no longer carry the minus, shade, and X
  glyphs.
- Default playlist: tracks 22 and 24 swapped (The Lemonheads now at 22,
  Katrina & The Waves at 24). An existing playlist that is still exactly
  the bundled catalog follows the new order on next launch; edited
  playlists are untouched.

## [1.7.4] - 2026-09-03

### Fixed
- macOS: the real cause of clicks falling through after the cursor came to
  rest. Every window-shape report (once a second, and on every DOM change)
  re-ran the first-launch "ignore the mouse" setup, so the window flipped
  to click-through until the next cursor poll tick; a click made after
  resting was a coin flip while quick successive clicks always landed.
  Shape reports now only re-decide, the visualization ticker no longer
  triggers a report every frame, unchanged shapes are not re-sent, and the
  cursor poll is no longer gated on a window-visibility check that only
  read true by accident. The 1.7.3 power-save blocker, which kept the Mac
  from idle-sleeping and did nothing for this, is removed.
- macOS: dragging a slider, grip, or resizer keeps the window listening
  even when the hand drifts off the panel. Those controls cancel the
  pointer press (which silently suppresses the mouse events the drag pin
  listened for), so the pin never engaged and a drift past the panel's
  halo could flip the window to click-through mid-drag and swallow the
  next click. The pin now follows pointer events; finishing a playlist
  drag also releases it, so the first click into another app afterwards
  is no longer eaten.
- macOS: the verification suite on the mac runner now exercises every
  arming signal, sustained shape churn under a spy, an overflowing
  popup, the cursor poll under a controlled cursor, and (where the runner
  allows real input) a genuine click against the native ignore flag.

## [1.7.3] - 2026-09-01

### Fixed
- Terminal: the top of the window no longer stays black with text
  crammed into the bottom. The WebGL renderer painted the grid into the
  bottom-left 1/zoom of its canvas under the desktop's CSS zoom (the
  first-run default is 1.5x); the terminal now uses the canvas renderer,
  which sizes for the zoom and fills the panel.
- The first-run tooltip's caret is 30% larger with a uniform 2px
  outline; the old 1px staircase read as stray black squares once the
  desktop zoom scaled it up.
- macOS: clicks no longer fall through to the app behind after the
  desktop sat idle for a while. App Nap was coalescing the cursor poll
  that arms the panels (and Chromium was throttling the overlay's
  hit-test), so the first click after a pause landed before the window
  woke; the app now opts out of suspension and throttling, and any
  activation re-arms immediately.

### Changed
- Windows: the running Setup window - titlebar icon, taskbar entry, and
  header - shows the transparent claw art. Setup.exe's file icon in
  Explorer stays the filled plaque matching the installed app.
- The rain screensaver is the 1.5.1 original again, restored verbatim
  from the old repository's history - glyph size, pacing, trail fade,
  and glow exactly as they were.
- README badges are live shields.io images in the glossy style - the
  version badge tracks the latest GitHub release by itself.

## [1.7.2] - 2026-09-01

### Fixed
- Windows: the Setup executable embeds the same filled rounded brand
  icon as the installed app, so the installer's file, window, and
  taskbar presence all match. (The transparent installer icon from
  1.6.4 is gone.)
- Terminal: block art (the Claude Code mascot included) renders
  cell-exact on every platform - GPU renderer with a canvas fallback
  and xterm's own box/block glyphs, integer cell heights at every zoom
  step, one font stack with Menlo covering macOS, truecolor for TUIs,
  and Unicode 11 widths so columns stay aligned.
- The rain's trail characters are solid glowing character-green, not
  dark outlines.
- The first-run tooltip's caret is clean stepped pixel art with a tight
  outline - no stray black pixels under the tip.
- A returning Terminal-mode user who dismisses the re-shown welcome
  with its close button still gets their terminal opened.
- Re-running the welcome no longer switches a signed-in Codex or Ollama
  user back to Claude, and finishing it in chat mode now puts the chat
  window back if the terminal was showing.
- Windows: upgrades keep your taskbar pin and respect a deleted desktop
  shortcut, and the pin's icon is repaired during the upgrade. (The
  installer's choose-a-directory page is gone - it silently forced
  shortcut recreation on every upgrade.)
- Releases are published as prereleases until every installer and its
  checksum are verified, so the "latest" release - the install script
  and the in-app update check read it - can never be empty or partial.
- The rain screensaver paces by real elapsed time (no more double-speed
  fall on 120 Hz displays) and survives a missing glyph sheet.
- Saved layouts restore correctly when panels were hidden or the zoom
  differed, and changing zoom pulls stranded panels back on screen.
- macOS: a panel hanging off the left edge of the screen no longer
  leaves a phantom click-swallowing strip at the desktop's left edge.

### Added
- macOS: a native menu bar mirroring the in-app menu - ClaudeAmp, File,
  Edit, View, Account (when signed in), Window, and Help, with keyboard
  shortcuts (Cmd+1-7 toggle windows, Cmd+, opens Settings, Cmd+0/=/-
  drive zoom) and checkmarks that track the app live. One spec
  (js/menu-spec.js) drives both renderings so they cannot drift; there
  is no Services item. The same shortcuts work on Windows and Linux
  with the bar hidden.
- macOS: a Dock menu (Play/Pause, Next, Previous, Show Terminal), a
  correct native About panel, and the desktop overlay now follows you
  across Spaces (never over full-screen apps).
- macOS: CLAUDEAMP_HITTEST_TRACE=1 logs click-through decisions to
  userData/hittest.log for diagnosing missed clicks.
- The claudeamp.com landing page lives in `site/` (Vercel serves it via
  `vercel.json`): the wide logo and interface screenshot above the
  fold, the app's own palette, and download links.

## [1.7.1] - 2026-09-01

### Fixed
- The welcome screen runs again on a true first run after reinstalling:
  the Windows uninstaller now clears the app's data on a real uninstall
  (upgrades keep everything), and everyone sees the welcome once at the
  1.7 re-founding since older uninstallers left the previous data
  behind. Closing the welcome counts as seen - it never nags every
  boot, and stays reachable from the menu.
- The search button's magnifying glass is drawn and shown at native
  pixel size (a 7px ring with a two-pixel stepped handle). The old icon
  squeezed an 11px pixel grid into a 9px box, which smudged it.
- The rain screensaver's glow, thickness, and smooth motion are back.
  The 1.6.6 fix for black reversed-out characters stopped re-stamping
  the glowing heads each frame, which also dimmed and roughened them.
  Trails and their fade now live on an offscreen persistence surface
  and the heads composite on top of it every frame - constant glow,
  and the reversal cannot happen at all since head glow never reaches
  the surface trail stamps land on.

## [1.7.0] - 2026-09-01

First release from the re-founded repository. Includes everything
through 1.6.6: the finalized brand icons on every platform (conforming
macOS icon grid, full-bleed Windows/Linux, transparent installer UI),
the first-run welcome and layout fixes, the macOS terminal font, click
capture, opaque overlays and lazy keychain work, chat and terminal
reliability fixes, the security hardening series, release CI with
per-platform packaged verification, and the tuned rain screensaver.

## [1.6.6] - 2026-09-01

### Fixed
- macOS: the app icon conforms to the standard macOS icon grid - an
  824px rounded-square plaque (radius 185) centered on the 1024 canvas
  with a transparent margin, gradient fill, original diamond artwork at
  80% width. A conforming silhouette stops macOS 26 from shrinking the
  icon into its gray legacy box, and older macOS draws the same file
  correctly. Windows and Linux get the matching composition full-bleed,
  all nine .ico sizes regenerated.
- macOS: the terminal renders the Claude CLI's block-art banner
  correctly - the font stack used to fall through to Courier New (mac
  ships neither Lucida Console nor Cascadia Mono), whose block-element
  glyphs garble it. Menlo/Monaco on mac; Windows keeps its stack.
- Panels no longer start piled on top of each other when the window is
  still settling into its real size at startup (macOS reports interim
  bounds): the default layout re-tiles on resize until the user first
  touches it, and the saved-layout pile check also treats a titlebar
  buried under other panels as a pile.
- macOS: panel geometry is re-reported to the native hit-tester once a
  second as insurance, so a missed update can no longer leave a window
  permanently ignoring clicks.
- The rain screensaver no longer "reverses out" characters as black
  glyphs knocked out of green: at slow fall rates the glowing head was
  re-stamped every frame and saturated into a solid blob under the next
  darker trail stamp. The head now stamps once per step.

### Changed
- The rain screensaver falls 20% faster than 1.6.5 (still about 28%
  slower than the pre-1.6.5 pace).
- The menu reads Welcome / Settings / About ClaudeAmp in that order.
- The About screen text is shorter and friendlier.

## [1.6.5] - 2026-09-01

### Fixed
- macOS: the app icon fills the full icon space (the rounded gradient
  tile is the whole canvas, with the claw-diamond art sized to match the
  reference) instead of floating inside a transparent margin.
- macOS: the welcome and settings overlays are opaque white again. The
  frosted-glass treatment sampled nothing over the window's transparent
  desktop gaps, leaving detached white rectangles on a patchy
  translucent sheet.
- macOS: clicks entering a panel at speed land more reliably - the
  click-through pre-arm halo grows with cursor velocity (24 DIPs at
  rest, up to 96 for a flick) and the cursor poll runs at 6/16 ms
  instead of 8/32 ms.
- macOS: launching the app no longer prompts for keychain access when no
  API keys are stored - the OS keychain is first touched when a key is
  actually saved. A failed keychain write now falls back to local
  storage instead of losing the key on restart.

### Changed
- The rain screensaver falls 40% slower.

## [1.6.4] - 2026-09-01

### Fixed
- The Windows installer's own window - the top-left icon and every icon
  shown while installing - uses the transparent claw-diamond mark again
  (as 1.5 did), via a dedicated installer icon. The Setup file in
  Explorer, the installed app, and its shortcuts keep the solid rounded
  brand icon.

## [1.6.3] - 2026-09-01

### Changed
- The app, shortcut, and installer icons adopt the final brand mark: a
  rounded square (about 10% corner radius) with the yellow-to-orange
  gradient, the claw-diamond art inset with a soft drop shadow, and a
  subtle rim highlight. Inside the app nothing changes - every surface
  keeps the transparent claw-diamond art.

## [1.6.2] - 2026-09-01

### Fixed
- The app, shortcut, and installer icons have standard rounded corners:
  Windows and Linux get the full-canvas rounded rectangle, macOS gets the
  convention-sized rounded square with the transparent margin. Inside the
  app every surface keeps the transparent claw-diamond art.
- The welcome screen shows the claw mark again; a first run rendered no
  icon because the screen borrowed its image from a Settings panel that
  had never been opened.
- First-run panels no longer initialize on top of each other: finishing
  the welcome wizard in Terminal mode now moves the terminal into the
  chat window's slot instead of a third stacked position off the bottom
  of shorter desktops, the default layout budgets one shared slot for
  the chat/terminal pair, and a saved layout that restores as an
  unusable pile (panels clamped onto each other by a smaller desktop)
  is retiled to the default arrangement.

### Changed
- The rain screensaver draws its glyphs at twice the size.

### Added
- A passive update check: the desktop shell polls the latest GitHub
  release daily and the ticker announces when a newer version exists.
- The availability probe refuses a provably old Claude Code CLI (< v2)
  with an upgrade hint instead of failing mid-chat.
- Keyboard and screen-reader access for the volume/balance sliders and
  the EQ model tuner (ARIA slider contract, arrow keys, a live region).
- `CONTRIBUTING.md`, `SECURITY.md`, and issue templates (including a
  macOS click-through report).
- A bridge integration test suite driving a real bridge against a stubbed
  `claude` CLI, and unit-tested version-compare helpers.

### Security
- The CLI access level is enforced by the bridge against a ceiling owned
  by the desktop shell - a local process can no longer self-grant
  workspace or shell access, whatever it puts in the request body.
- In the desktop app, `/bridge/status` no longer discloses the bearer
  token or PATH; the token reaches the renderer over validated IPC only.
- API keys are encrypted at rest via the OS keychain (safeStorage), with
  automatic migration from localStorage and a browser-mode fallback.

### Changed
- Release CI now runs each platform's PACKAGED app through the full
  self-verification before anything publishes (Windows smoke, macOS .app,
  Linux unpacked binary under Xvfb).
- bridge.js split: music/search backends live in `bridge-music.cjs`,
  leaving the CLI relay and its security core an auditable ~860 lines;
  the CI proof harness moved out of `electron/main.cjs` into
  `electron/verify-proof.cjs` (fixing two poll early-exit conditions that
  could never match).

## [1.6.1] - 2026-09-01

### Fixed
- The app, shortcut, and installer icons are the full-bleed brand mark
  (original claw-diamond art over the yellow-to-orange background). The
  v1.6.0 installers shipped an intermediate icon built minutes before the
  final art landed.

### Changed
- Release pipeline: a `prepare` job creates the release once before the
  build fan-out (concurrent builds previously raced electron-builder into
  duplicate same-tag releases) and pins the tag to the commit being built;
  the checksums job heals any pre-existing duplicates.
- ESLint (flat config) now gates `verify:source` and pull requests; the
  dead in-chat wizard, Win95 Options dialog, and caller-less Tidal backend
  are removed (~580 lines).

## [1.6.0] - 2026-09-01

### Added
- Linux AppImage target (`npm run dist:linux`), built and published by
  release CI alongside the Windows and macOS installers; click-through
  window shaping uses the same native region path as Windows. The packaged
  AppImage passes the full `verify:app` self-verification, real terminal
  included.
- `/clear` (or `/new`) chat command resets the current conversation;
  hinted in the chat input placeholder.
- The About screen shows the stacked ClaudeAmp logo.

### Fixed
- The chat no longer announces "[CLAUDE CODE STARTED]" before every
  reply, and the waiting heartbeat only speaks when the CLI has been
  genuinely silent - never over a streaming answer.
- Streamed replies survive mid-answer re-renders (opening Settings while
  the model was typing used to eat the visible text).
- The SSE parser handles CRLF-framed provider streams and no longer drops
  the final buffered event of a response.
- A stale CLI session is forgotten and the message retried with full
  history instead of permanently wedging the conversation.
- Guided Claude login no longer signs the CLI out machine-wide first.
- Pasted chat images are downscaled to protect conversation storage, kept
  under the workspace as documented, cleaned up after each run, and a
  storage-full condition warns in the chat instead of silently ending
  history persistence.
- Standalone `node bridge.js` explains a taken port instead of crashing.
- Switching the music service away from Spotify sticks even while a
  Spotify track is playing.
- Real Terminal mode now actually auto-runs the chosen CLI (Claude Code,
  Codex, or `ollama run <model>`) as the wizard promises; previously the
  shell opened bare on every platform.
- macOS: clicks on a panel edge (title bar, close button) no longer fall
  through to the app behind — an 8-DIP pre-arm halo makes the window
  interactive before the click can land, with the cursor poll running at
  8 ms near panels / 32 ms elsewhere (`electron/mac-hittest.cjs`).
- macOS: `verify:app` release gate passes again — the restored-terminal
  check used a Windows-only backend name, so mac release CI could never go
  green.
- macOS: clicking the Dock icon restores a minimized window.
- macOS: saved window layouts are clamped to the current desktop on
  restore; a layout saved on a bigger display could strand every panel
  outside the click-through region.
- macOS: the darwin `spawn-helper` prebuilds get their executable bit at
  install time (npm ships them non-executable, which broke the terminal on
  the architecture the CI runner did not compile natively).
- macOS: the guided-login Terminal.app script inherits the app's resolved
  PATH, so nvm/Homebrew installs of `claude`/`codex` resolve there.
- macOS: Finder/Dock-launched shells get a UTF-8 `LANG` instead of the C
  locale.
- Choosing a new workspace folder now applies to new terminal sessions
  immediately instead of after an app restart.

### Security
- Read-only chat mode is enforced: the Claude Code relay now whitelists
  only `Read,Glob,Grep` (previously `--permission-mode dontAsk` left the
  edit, write, and shell tools enabled).
- Shell commands in workspace mode are a separate opt-in checkbox, off by
  default — an auto-approved shell is not confined to the workspace folder.
  The access-to-flags mapping is pinned by `test/bridge-security.test.cjs`.
- A Content-Security-Policy in `index.html` restricts the renderer to the
  hosts the app actually uses.

### Changed
- Releases publish only from `v*` tags; `release/**` branch pushes and
  manual dispatches build without publishing, so released bytes cannot be
  overwritten under the same names.
- Release CI attaches `SHA256SUMS.txt` covering every asset and fails the
  release unless both mac zips, the Windows installer, and the manifest
  verify; `install.sh` checks the downloaded zip against the manifest
  (warns and continues for older releases, refuses on mismatch).

## [1.5.1] - 2026-08-30

Rebranded ClaudeAmp release: retro desktop AI chat and terminal client with
the built-in iTunes-preview catalog, equalizer model tuning, usage monitor,
and the standalone frameless desktop app for Windows and macOS.
