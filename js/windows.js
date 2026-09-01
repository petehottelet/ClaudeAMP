/* ClaudeAmp — window manager: dragging with edge snapping, z-order,
   windowshade, show/hide, resizing for playlist-style windows. */
"use strict";

const WM = (() => {
  const SNAP = 11;
  const DOCK_EPS = 1.01;
  const LAYOUT_KEY = "claudeamp.layout.v2";
  const desktop = document.getElementById("desktop");
  let zTop = 10;
  const wins = [];

  function zoomFactor() {
    const r = desktop.getBoundingClientRect();
    return r.width / desktop.offsetWidth || 1;
  }

  function bringToFront(el) {
    el.style.zIndex = ++zTop;
    wins.forEach(w => w.classList.toggle("active", w === el));
  }

  function bringGroupToFront(group, active) {
    group.filter(w => w !== active).forEach(w => { w.style.zIndex = ++zTop; });
    active.style.zIndex = ++zTop;
    wins.forEach(w => w.classList.toggle("active", w === active));
  }

  function windowRect(win) {
    const x = win.offsetLeft, y = win.offsetTop;
    return { x, y, width: win.offsetWidth, height: win.offsetHeight,
      right: x + win.offsetWidth, bottom: y + win.offsetHeight };
  }

  function reverseSide(side) {
    return { right: "left", left: "right", below: "above", above: "below" }[side];
  }

  // A one-logical-pixel seam still counts as docked so it can be welded shut.
  function dockRelation(a, b) {
    const ra = windowRect(a), rb = windowRect(b), candidates = [];
    const verticalOverlap = Math.min(ra.bottom, rb.bottom) - Math.max(ra.y, rb.y);
    const horizontalOverlap = Math.min(ra.right, rb.right) - Math.max(ra.x, rb.x);
    if (verticalOverlap > 0) {
      candidates.push({ side: "right", cross: rb.y - ra.y, gap: Math.abs(ra.right - rb.x) });
      candidates.push({ side: "left",  cross: rb.y - ra.y, gap: Math.abs(rb.right - ra.x) });
    }
    if (horizontalOverlap > 0) {
      candidates.push({ side: "below", cross: rb.x - ra.x, gap: Math.abs(ra.bottom - rb.y) });
      candidates.push({ side: "above", cross: rb.x - ra.x, gap: Math.abs(rb.bottom - ra.y) });
    }
    candidates.sort((one, two) => one.gap - two.gap);
    return candidates[0] && candidates[0].gap <= DOCK_EPS ? candidates[0] : null;
  }

  function dockGraph(list = wins.filter(w => !w.classList.contains("hidden"))) {
    const graph = new Map(list.map(win => [win, []]));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const relation = dockRelation(list[i], list[j]);
      if (!relation) continue;
      graph.get(list[i]).push({ win: list[j], side: relation.side, cross: relation.cross });
      graph.get(list[j]).push({ win: list[i], side: reverseSide(relation.side), cross: -relation.cross });
    }
    return graph;
  }

  function dockedGroup(win, graph = dockGraph()) {
    const found = [], seen = new Set([win]), queue = [win];
    while (queue.length) {
      const current = queue.shift(); found.push(current);
      for (const edge of graph.get(current) || []) if (!seen.has(edge.win)) {
        seen.add(edge.win); queue.push(edge.win);
      }
    }
    return found;
  }

  function placedFrom(from, edge) {
    const target = edge.win;
    // A one-pixel cross-axis drift is visual noise, not intentional stagger.
    // Dock detection already accepts a one-pixel seam; weld the matching top
    // or left edges exactly so persisted layouts cannot reopen visibly crooked.
    const cross = Math.abs(edge.cross) <= DOCK_EPS ? 0 : edge.cross;
    if (edge.side === "right") return { x: from.x + from.width, y: from.y + cross };
    if (edge.side === "left")  return { x: from.x - target.offsetWidth, y: from.y + cross };
    if (edge.side === "below") return { x: from.x + cross, y: from.y + from.height };
    return { x: from.x + cross, y: from.y - target.offsetHeight };
  }

  function weldGroup(group, root = group[0], graph = dockGraph(group)) {
    if (!root || group.length < 2) return group;
    const allowed = new Set(group), placed = new Map([[root, windowRect(root)]]), queue = [root];
    while (queue.length) {
      const current = queue.shift(), from = placed.get(current);
      from.width = current.offsetWidth; from.height = current.offsetHeight;
      for (const edge of graph.get(current) || []) {
        if (!allowed.has(edge.win) || placed.has(edge.win)) continue;
        const next = placedFrom(from, edge);
        placed.set(edge.win, { ...next, width: edge.win.offsetWidth, height: edge.win.offsetHeight });
        queue.push(edge.win);
      }
    }
    placed.forEach((position, member) => {
      member.style.left = Math.round(position.x) + "px";
      member.style.top = Math.round(position.y) + "px";
    });
    return group;
  }

  function normalizeAllDocks() {
    const graph = dockGraph(), seen = new Set();
    for (const win of wins) {
      if (seen.has(win) || win.classList.contains("hidden")) continue;
      const group = dockedGroup(win, graph);
      group.forEach(member => seen.add(member));
      weldGroup(group, win, graph);
    }
  }

  function otherEdges(self) {
    const edges = { v: [0, desktop.offsetWidth], h: [0, desktop.offsetHeight] };
    for (const w of wins) {
      if (w === self || w.classList.contains("hidden")) continue;
      const x = w.offsetLeft, y = w.offsetTop,
            r = x + w.offsetWidth, b = y + w.offsetHeight;
      edges.v.push(x, r);
      edges.h.push(y, b);
    }
    return edges;
  }

  function snapGroupDelta(group, starts, raw, axis) {
    const targets = axis === "x" ? [0, desktop.offsetWidth] : [0, desktop.offsetHeight];
    for (const other of wins) {
      if (group.includes(other) || other.classList.contains("hidden")) continue;
      const rect = windowRect(other);
      targets.push(axis === "x" ? rect.x : rect.y, axis === "x" ? rect.right : rect.bottom);
    }
    let best = raw, bestDist = SNAP + 1;
    for (const member of group) {
      const start = starts.get(member);
      const edges = axis === "x" ? [start.x, start.x + member.offsetWidth] :
        [start.y, start.y + member.offsetHeight];
      for (const edge of edges) for (const target of targets) {
        const adjustment = target - (edge + raw), distance = Math.abs(adjustment);
        if (distance < bestDist) { bestDist = distance; best = raw + adjustment; }
      }
    }
    return bestDist <= SNAP ? best : raw;
  }

  function clampGroupDelta(group, starts, dx, dy) {
    const left = Math.min(...group.map(w => starts.get(w).x));
    const top = Math.min(...group.map(w => starts.get(w).y));
    const right = Math.max(...group.map(w => starts.get(w).x + w.offsetWidth));
    const width = right - left;
    dx = Math.max(-width + 30 - left, Math.min(dx, desktop.offsetWidth - 30 - left));
    dy = Math.max(-top, Math.min(dy, desktop.offsetHeight - 14 - top));
    return { dx, dy };
  }

  function applyGroupDelta(group, starts, dx, dy) {
    for (const member of group) {
      const start = starts.get(member);
      member.style.left = Math.round(start.x + dx) + "px";
      member.style.top = Math.round(start.y + dy) + "px";
    }
  }

  function makeDraggable(win) {
    const bar = win.querySelector(".titlebar");
    let startX = 0, startY = 0, group = [], starts = new Map(), dragging = false;

    bar.addEventListener("pointerdown", e => {
      if (e.target.closest(".tb-btn") || e.target.closest(".tb-menu")) return;
      dragging = true;
      const z = zoomFactor();
      startX = e.clientX / z; startY = e.clientY / z;
      const graph = dockGraph();
      // The main window is the anchor: dragging it moves the ENTIRE docked
      // cluster together. Dragging a satellite window instead pulls just that
      // one out of the dock (bringing it back within SNAP re-welds it). Hold
      // Shift (or Alt) on a satellite to move the whole cluster too.
      const whole = win.id === "win-main" || e.shiftKey || e.altKey;
      group = whole ? dockedGroup(win, graph) : [win];
      weldGroup(group, win, graph);
      starts = new Map(group.map(member => [member, { x: member.offsetLeft, y: member.offsetTop }]));
      bar.setPointerCapture(e.pointerId);
      bringGroupToFront(group, win);
    });
    bar.addEventListener("pointermove", e => {
      if (!dragging) return;
      const z = zoomFactor();
      let dx = Math.round(e.clientX / z - startX);
      let dy = Math.round(e.clientY / z - startY);
      dx = snapGroupDelta(group, starts, dx, "x");
      dy = snapGroupDelta(group, starts, dy, "y");
      ({ dx, dy } = clampGroupDelta(group, starts, dx, dy));
      applyGroupDelta(group, starts, dx, dy);
    });
    const up = e => {
      if (!dragging) return;
      dragging = false;
      try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
      saveLayout();
    };
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);

    bar.addEventListener("dblclick", e => {
      if (e.target.closest(".tb-btn") || e.target.closest(".tb-menu")) return;
      toggleShade(win.id);
    });
  }

  function makeResizable(win) {
    const grip = win.querySelector(".pl-grip");
    if (!grip) return;
    let startX = 0, startY = 0, origW = 0, origH = 0, resizing = false;
    grip.addEventListener("pointerdown", e => {
      resizing = true;
      const z = zoomFactor();
      startX = e.clientX / z; startY = e.clientY / z;
      origW = win.offsetWidth; origH = win.offsetHeight;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener("pointermove", e => {
      if (!resizing) return;
      const z = zoomFactor();
      let w = Math.max(200, origW + (e.clientX / z - startX));
      let h = Math.max(80,  origH + (e.clientY / z - startY));
      // snap the right/bottom edge to neighbouring windows' edges, so a
      // window resized beneath another matches its width (aligned right edges).
      const edges = otherEdges(win);
      const x = win.offsetLeft, y = win.offsetTop;
      const nearest = (cur, targets, base) => {
        let best = cur, bestDist = SNAP + 1;
        for (const t of targets) {
          const d = Math.abs(base + cur - t);
          if (d < bestDist) { bestDist = d; best = t - base; }
        }
        return bestDist <= SNAP ? best : cur;
      };
      w = nearest(w, edges.v, x);
      h = nearest(h, edges.h, y);
      w = Math.max(200, w); h = Math.max(80, h);
      win.style.width = w + "px";
      win.style.height = h + "px";
    });
    const up = e => {
      if (!resizing) return;
      resizing = false;
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      saveLayout();
    };
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);

    addEdgeResizers(win);
  }

  // Drag the left / right / bottom edges to resize (the corner grip still
  // does both axes at once). Left keeps the right edge pinned; right and
  // bottom snap to neighbouring windows' edges like the grip does.
  function addEdgeResizers(win) {
    for (const side of ["left", "right", "bottom"]) {
      const handle = document.createElement("div");
      handle.className = "rz-edge rz-" + side;
      win.appendChild(handle);
      let sx = 0, sy = 0, ox = 0, oy = 0, ow = 0, oh = 0, active = false;
      handle.addEventListener("pointerdown", e => {
        if (win.classList.contains("shaded")) return;
        active = true;
        const z = zoomFactor();
        sx = e.clientX / z; sy = e.clientY / z;
        ox = win.offsetLeft; oy = win.offsetTop;
        ow = win.offsetWidth; oh = win.offsetHeight;
        handle.setPointerCapture(e.pointerId);
        e.preventDefault(); e.stopPropagation();
      });
      handle.addEventListener("pointermove", e => {
        if (!active) return;
        const z = zoomFactor();
        const dx = e.clientX / z - sx, dy = e.clientY / z - sy;
        const edges = otherEdges(win);
        const snap = (value, targets) => {
          let best = value, bestDist = SNAP + 1;
          for (const t of targets) { const d = Math.abs(value - t); if (d < bestDist) { bestDist = d; best = t; } }
          return bestDist <= SNAP ? best : value;
        };
        if (side === "right") {
          let right = snap(ox + ow + dx, edges.v);
          win.style.width = Math.max(200, right - ox) + "px";
        } else if (side === "left") {
          const right = ox + ow;
          let left = snap(ox + dx, edges.v);
          left = Math.min(left, right - 200);
          win.style.left = Math.round(left) + "px";
          win.style.width = (right - left) + "px";
        } else { // bottom
          let bottom = snap(oy + oh + dy, edges.h);
          win.style.height = Math.max(80, bottom - oy) + "px";
        }
      });
      const up = e => {
        if (!active) return;
        active = false;
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        saveLayout();
      };
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    }
  }

  function toggle(id, show) {
    const w = document.getElementById(id);
    if (!w) return false;
    const hide = show === undefined ? !w.classList.contains("hidden") : !show;
    w.classList.toggle("hidden", hide);
    if (!hide) bringToFront(w);
    saveLayout();
    return !hide;
  }

  function visible(id) {
    const w = document.getElementById(id);
    return !!w && !w.classList.contains("hidden");
  }

  function toggleShade(id) {
    const win = document.getElementById(id);
    if (!win) return false;
    const graph = dockGraph(), group = dockedGroup(win, graph);
    win.classList.toggle("shaded");
    weldGroup(group, win, graph);
    saveLayout(false);
    return win.classList.contains("shaded");
  }

  function dockedIds(id) {
    const win = document.getElementById(id);
    return win ? dockedGroup(win).map(member => member.id) : [];
  }

  function moveDockGroup(id, dx, dy, persist = true) {
    const win = document.getElementById(id);
    if (!win) return [];
    const graph = dockGraph(), group = dockedGroup(win, graph);
    weldGroup(group, win, graph);
    const starts = new Map(group.map(member => [member, { x: member.offsetLeft, y: member.offsetTop }]));
    ({ dx, dy } = clampGroupDelta(group, starts, Math.round(dx), Math.round(dy)));
    applyGroupDelta(group, starts, dx, dy);
    if (persist) saveLayout(false);
    return group.map(member => member.id);
  }

  /* ---- layout persistence ---- */
  function saveLayout(normalize = true) {
    try {
      if (normalize) normalizeAllDocks();
      const data = {};
      for (const w of wins) {
        // Read the inline styles, not offset* metrics: a hidden window
        // measures 0x0 at 0,0 and a shaded one measures titlebar-only,
        // which would wreck the saved geometry across reloads.
        const px = v => { const n = parseInt(v, 10); return isNaN(n) ? undefined : n; };
        data[w.id] = {
          x: px(w.style.left) ?? w.offsetLeft,
          y: px(w.style.top) ?? w.offsetTop,
          w: px(w.style.width),
          h: px(w.style.height),
          hidden: w.classList.contains("hidden"),
          shaded: w.classList.contains("shaded"),
        };
      }
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function loadLayout() {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    } catch (_) { return null; }
  }

  function place(win, x, y) {
    win.style.left = Math.round(x) + "px";
    win.style.top = Math.round(y) + "px";
  }

  // Measured size when the window is visible; the data-* design size when it
  // is display:none (a hidden window measures 0x0, which would collapse the
  // layout math for everything placed after it).
  function designSize(win) {
    return {
      w: win.offsetWidth || parseInt(win.dataset.w, 10) || 275,
      h: win.offsetHeight || parseInt(win.dataset.h, 10) || 100,
    };
  }

  function dockDefaultLayout() {
    const main = document.getElementById("win-main");
    const eq = document.getElementById("win-eq");
    const usage = document.getElementById("win-usage");
    const minibrowser = document.getElementById("win-mb");
    const chat = document.getElementById("win-chat");
    const playlist = document.getElementById("win-pl");
    const terminal = document.getElementById("win-term");
    const x = 14, y = 12;
    let columnY = y;
    for (const win of [main, eq, usage, minibrowser]) {
      place(win, x, columnY);
      columnY += designSize(win).h;
    }
    const rightX = x + designSize(main).w;
    place(chat, rightX, y);
    const slot = designSize(chat);
    place(playlist, rightX, y + slot.h);
    if (terminal) {
      // The chat and the terminal share ONE slot - the mode switch swaps
      // whichever is visible into the other's place - so the default layout
      // must not budget a third stacked window for the terminal: that used
      // to start the terminal off the bottom edge of shorter desktops.
      place(terminal, rightX, y);
      terminal.style.width = slot.w + "px";
      terminal.style.height = slot.h + "px";
    }
    // On a desktop too short for a full column, keep every titlebar
    // reachable (same clamp rule the drag logic enforces).
    for (const win of [main, eq, usage, minibrowser, chat, playlist, terminal]) {
      if (!win) continue;
      const left = parseInt(win.style.left, 10) || 0;
      const top = parseInt(win.style.top, 10) || 0;
      place(win,
        Math.max(30 - designSize(win).w, Math.min(left, desktop.offsetWidth - 30)),
        Math.max(0, Math.min(top, desktop.offsetHeight - 14)));
    }
  }

  // A saved layout from a taller desktop restores with panels clamped into a
  // pile at the bottom edge - visible but unusable. Two signs of a pile, and
  // neither happens in an arrangement someone made on purpose: a visible,
  // unshaded window at least three-quarters buried under another, or a
  // titlebar so covered by other panels it can no longer be dragged out.
  function titlebarBuried(win, others) {
    const rect = windowRect(win);
    const y = rect.y + 7; // titlebar centerline
    let covered = 0;
    const SAMPLES = 10;
    for (let i = 0; i < SAMPLES; i++) {
      const x = rect.x + (rect.width * (i + 0.5)) / SAMPLES;
      if (others.some(other => {
        const o = windowRect(other);
        return x >= o.x && x < o.right && y >= o.y && y < o.bottom;
      })) covered++;
    }
    return covered >= SAMPLES * 0.9;
  }
  function layoutLooksPiled() {
    const shown = wins.filter(w =>
      !w.classList.contains("hidden") && !w.classList.contains("shaded"));
    for (let i = 0; i < shown.length; i++) {
      if (titlebarBuried(shown[i], shown.filter(w => w !== shown[i]))) return true;
      for (let j = i + 1; j < shown.length; j++) {
        const a = windowRect(shown[i]), b = windowRect(shown[j]);
        const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        if (w <= 0 || h <= 0) continue;
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        if (smaller > 0 && w * h >= smaller * 0.75) return true;
      }
    }
    return false;
  }

  function init() {
    const saved = loadLayout();
    document.querySelectorAll(".wa-window").forEach(win => {
      wins.push(win);
      if (win.dataset.resize) {
        win.style.width = win.dataset.w + "px";
        win.style.height = win.dataset.h + "px";
      } else {
        win.style.width = win.dataset.w + "px";
      }
    });
    dockDefaultLayout();
    if (saved) wins.forEach(win => {
      const d = saved[win.id];
      if (!d) return;
      /* A layout saved on a bigger desktop (external display unplugged, zoom
         raised) can restore panels beyond the window; on macOS everything
         outside panel rects ignores the mouse, so the app would be visible
         but untouchable. Clamp like clampGroupDelta does during drags. */
      const x = Math.max(30 - win.offsetWidth, Math.min(d.x, desktop.offsetWidth - 30));
      const y = Math.max(0, Math.min(d.y, desktop.offsetHeight - 14));
      place(win, x, y);
      if (win.dataset.resize) {
        if (d.w) win.style.width = d.w + "px";
        if (d.h) win.style.height = d.h + "px";
      }
      win.classList.toggle("hidden", !!d.hidden);
      win.classList.toggle("shaded", !!d.shaded);
    });
    if (saved && layoutLooksPiled()) dockDefaultLayout();
    /* The window can still be settling into its real size when this runs
       (macOS in particular reports interim bounds at startup), which lays
       panels out against the wrong desktop dimensions. Until the user
       touches the layout - or one already existed - re-tile on resize so
       the default arrangement always matches the desktop it ends up on. */
    let retileOnResize = !saved;
    window.addEventListener("resize", () => {
      if (!retileOnResize) return;
      dockDefaultLayout();
      normalizeAllDocks();
    });
    const armRetileOff = () => { retileOnResize = false; };
    window.addEventListener("pointerdown", armRetileOff, true);
    normalizeAllDocks();
    wins.forEach(win => {
      makeDraggable(win);
      makeResizable(win);
      win.addEventListener("pointerdown", () => bringToFront(win));
    });
    bringToFront(document.getElementById("win-main"));
  }

  return { init, toggle, toggleShade, visible, bringToFront, zoomFactor, saveLayout,
    dockedIds, moveDockGroup };
})();
