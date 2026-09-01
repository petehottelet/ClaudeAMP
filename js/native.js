/* ClaudeAmp — native (Electron) glue. In the browser this is a no-op.
   Under Electron, visible panels become the exact native window region:
   transparent gaps are real desktop, not an invisible click-blocking box. */
"use strict";
(() => {
  if (!window.claudeampNative) return;
  document.documentElement.classList.add("native");
  if (window.claudeampNative.platform === "darwin")
    document.documentElement.classList.add("mac");

  // The onboarding caret extends beyond its tooltip's border box. It must be
  // reported as its own solid region or Windows setShape clips off the point.
  const SOLID = ".wa-window, .w95-dialog, .w95-menu, .onboarding-tip, .onboarding-arrow, .menu-auth-tooltip, .modern-ui";
  let frame = 0;
  let lastX = -1, lastY = -1;   // last known cursor position (for re-hit-test)
  let macReeval = () => {};      // set below on macOS; re-runs the hit-test
  const visible = el => {
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const updateShape = () => {
    frame = 0;
    const rects = Array.from(document.querySelectorAll(SOLID), el => {
      if (!visible(el)) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const x = Math.floor(r.left);
      const y = Math.floor(r.top);
      return {
        x,
        y,
        width: Math.max(1, Math.ceil(r.right) - x),
        height: Math.max(1, Math.ceil(r.bottom) - y),
      };
    }).filter(Boolean);
    window.claudeampNative.updateShape(rects);
    // A panel or menu can appear/move under a stationary cursor (no mousemove
    // to trigger a re-test), which would leave the window ignoring the mouse
    // over freshly-solid pixels and eat the first click. Re-hit-test here.
    macReeval();
  };
  const scheduleShape = () => {
    if (!frame) frame = requestAnimationFrame(updateShape);
  };

  new MutationObserver(scheduleShape).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  const sizes = new ResizeObserver(scheduleShape);
  document.querySelectorAll(SOLID).forEach(el => sizes.observe(el));
  window.addEventListener("resize", scheduleShape);
  window.claudeampNative.onBoundsChanged(scheduleShape);
  document.fonts?.ready.then(scheduleShape);
  scheduleShape();
  // Belt and suspenders: re-report once a second. If any geometry change
  // ever slips past the observers (or an IPC report is lost), a panel could
  // otherwise stay permanently outside the native hit region - on macOS
  // that reads as a window that ignores clicks until something else moves.
  setInterval(scheduleShape, 1000);

  // macOS click-through, driven from here. The main process keeps the
  // full-desktop window ignoring the mouse (forward:true), so mousemove still
  // reaches us even while ignoring. We hit-test the DOM directly under the
  // cursor and tell main to make the window interactive only over a real
  // panel - no cross-process coordinate math, which is what kept breaking.
  // A pressed button pins it interactive so a drag that briefly slips off a
  // panel edge isn't dropped.
  if (window.claudeampNative.platform === "darwin" && window.claudeampNative.setInteractive) {
    let current = null, held = false;
    const apply = on => {
      if (on === current) return;
      current = on;
      try { window.claudeampNative.setInteractive(on); } catch (_) {}
    };
    const overPanel = (x, y) => {
      if (x < 0 || y < 0) return false;
      const el = document.elementFromPoint(x, y);
      return !!(el && el.closest && el.closest(SOLID));
    };
    const setHeld = on => {
      if (on === held) return;
      held = on;
      try { window.claudeampNative.setHeld && window.claudeampNative.setHeld(on); } catch (_) {}
    };
    // Re-run whenever the DOM/shape changes so a panel appearing under a still
    // cursor becomes clickable immediately (see updateShape).
    macReeval = () => { if (!held) apply(overPanel(lastX, lastY)); };
    window.addEventListener("mousemove", e => {
      lastX = e.clientX; lastY = e.clientY;
      if (!held) apply(overPanel(e.clientX, e.clientY));
    }, true);
    window.addEventListener("mousedown", () => { setHeld(true); apply(true); }, true);
    const release = e => { setHeld(false); lastX = e.clientX; lastY = e.clientY; apply(overPanel(e.clientX, e.clientY)); };
    window.addEventListener("mouseup", release, true);
    window.addEventListener("mouseleave", () => { if (!held) apply(false); }, true);
  }

  // the main window's close button quits the app (in the browser it just
  // hides the window; a hidden main window in a click-through transparent
  // shell would leave an unreachable ghost app)
  window.addEventListener("click", e => {
    if (e.target && e.target.closest && e.target.closest("#win-main .tb-close"))
      window.claudeampNative.quit();
  }, true);
})();
