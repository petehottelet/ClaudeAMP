"use strict";

/* macOS click-through decision, kept pure so it is unit-testable from any OS
   (like terminal-platform.cjs).

   Why a pre-arm halo: with setIgnoreMouseEvents(true, {forward:true}) the
   page receives forwarded mousemoves but clicks are NEVER forwarded — a
   click only lands once a mousemove or a poll tick has already flipped
   ignore off. A fast entry onto a panel edge (a title bar or close button,
   clicked from another app in front) followed by an immediate click can
   beat both signals and fall through to the app behind. ENTER_MARGIN arms
   interactivity while the cursor is still up to that many DIPs OUTSIDE the
   nearest panel, so by the time the click arrives the window is already
   listening. The trade-off is deliberate: desktop clicks within the halo of
   a panel edge now hit ClaudeAmp instead of the desktop.

   Cadence: screen.getCursorScreenPoint() and getContentBounds() are
   microsecond getters, so fast polling is cheap — but 6 ms only matters
   when the cursor is near a panel. Far from every panel, 16 ms is plenty
   and keeps the idle wakeup rate down.

   A fixed halo still loses to a flick: at 3000+ DIP/s the cursor covers
   several halos between two polls and the click can land while the window
   is still ignoring. armMargin() therefore grows the halo with the
   distance the cursor moved since the previous poll, so a fast approach
   pre-arms from proportionally further out. */

const ENTER_MARGIN = 24; // DIPs of pre-arm halo around every panel rect
const MAX_MARGIN = 96;   // ceiling for the velocity-grown halo
const NEAR_MS = 6;       // poll cadence while inside any halo
const FAR_MS = 16;       // relaxed cadence when far from every panel

/* Halo for this tick, given how far the cursor travelled since the last
   one: at least ENTER_MARGIN, growing 1.5x the travel, capped so a wild
   flick across the desktop cannot arm the whole screen. */
function armMargin(travel) {
  const t = Number(travel) || 0;
  return Math.min(MAX_MARGIN, Math.max(ENTER_MARGIN, Math.round(t * 1.5)));
}

function insideRect(rect, x, y, pad) {
  return x >= rect.x - pad && x < rect.x + rect.width + pad &&
         y >= rect.y - pad && y < rect.y + rect.height + pad;
}

/* Decide interactivity for a window-content-relative point against the
   reported panel rects. `over` is the strict hit (inside a panel), `near`
   includes the pre-arm halo and is what should arm the window, `cadence`
   is how soon the caller should poll again. */
function decide(rects, x, y, margin = ENTER_MARGIN) {
  let over = false, near = false;
  for (const rect of rects || []) {
    if (!over && insideRect(rect, x, y, 0)) over = true;
    if (!near && insideRect(rect, x, y, margin)) near = true;
    if (over && near) break;
  }
  return { over, near, cadence: near ? NEAR_MS : FAR_MS };
}

module.exports = { ENTER_MARGIN, MAX_MARGIN, NEAR_MS, FAR_MS, decide, armMargin };
