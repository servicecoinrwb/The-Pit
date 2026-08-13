/* ── pit-draw.js ──────────────────────────────────────────────────────
   Drawing tools as an SVG layer over the chart.

   Lightweight Charts has no drawing primitives, so this rides on top and
   asks the chart where things belong: timeToCoordinate and priceToCoordinate
   for rendering, their inverses for input. That means a level drawn on 5m is
   the same level on 1h, and a trendline keeps its anchors through zoom, pan
   and new candles — because the drawing is stored in time and price, never
   in pixels.
*/

import { A } from "./pit.js";

const KEY = "pit.draw.v2";

let store = {};          // marketId -> [{type, pts:[{t,p}], colour}]
let mode = null;         // "h" | "t" | "e" | null
let pending = null;      // first click of a two-point drawing
let host = null, svg = null;
let chartRef = null, seriesRef = null, marketRef = null;
let onModeChange = () => {};

// ── persistence ───────────────────────────────────────────────────────

export function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || "null");
    // Keyed to the desk: drawings against one contract's prices should not
    // reappear over another's.
    store = (j && j.floorplan === A.floorplan) ? (j.d || {}) : {};
  } catch (e) { store = {}; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ floorplan: A.floorplan, d: store })); }
  catch (e) { }
}

function mine() { return store[marketRef] ||= []; }

// ── wiring ────────────────────────────────────────────────────────────

export function attach(container, chart, candleSeries, marketId, notify) {
  chartRef = chart; seriesRef = candleSeries; marketRef = marketId;
  if (notify) onModeChange = notify;

  if (!host || host.parentElement !== container) {
    host = document.createElement("div");
    host.className = "drawlayer";
    container.style.position = "relative";
    container.appendChild(host);

    host.addEventListener("pointerdown", onPointer);
  }
  render();
}

export function setMarket(id) { marketRef = id; render(); }

export function setMode(m) {
  mode = mode === m ? null : m;
  pending = null;
  // Only capture clicks while armed, so panning the chart still works when
  // no tool is selected.
  if (host) host.style.pointerEvents = mode ? "auto" : "none";
  onModeChange(mode);
  render();
}

export function currentMode() { return mode; }

export function clearMarket() {
  store[marketRef] = [];
  save();
  setMode(null);
}

// ── input ─────────────────────────────────────────────────────────────

function onPointer(ev) {
  if (!mode || !chartRef || !seriesRef) return;
  const r = host.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;

  const t = chartRef.timeScale().coordinateToTime(x);
  const p = seriesRef.coordinateToPrice(y);
  if (t == null || p == null) return;

  if (mode === "h") {
    mine().push({ type: "h", pts: [{ t, p }] });
    save(); setMode(null);
  } else if (mode === "t" || mode === "r") {
    if (!pending) { pending = { t, p }; render(); }
    else {
      mine().push({ type: mode, pts: [pending, { t, p }] });
      pending = null; save(); setMode(null);
    }
  } else if (mode === "e") {
    erase(x, y);
    setMode(null);
  }
}

/** Removes the nearest drawing, but only within reach — otherwise a click on
    empty space silently deletes something across the chart. */
function erase(x, y) {
  const list = mine();
  let best = -1, bestDist = 1e9;
  list.forEach((d, i) => {
    const pts = d.pts.map(project).filter(Boolean);
    if (!pts.length) return;
    let dist;
    if (d.type === "h") dist = Math.abs(pts[0].y - y);
    else if (pts.length === 2) {
      if (d.type === "r") {
        const x1 = Math.min(pts[0].x, pts[1].x), x2 = Math.max(pts[0].x, pts[1].x);
        const y1 = Math.min(pts[0].y, pts[1].y), y2 = Math.max(pts[0].y, pts[1].y);
        const dx = Math.max(x1 - x, 0, x - x2), dy = Math.max(y1 - y, 0, y - y2);
        dist = Math.hypot(dx, dy);
      } else {
        const [a, b] = pts;
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        dist = Math.abs((b.y - a.y) * x - (b.x - a.x) * y + b.x * a.y - b.y * a.x) / L;
      }
    } else return;
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  if (best >= 0 && bestDist < 14) { list.splice(best, 1); save(); }
}

// ── rendering ─────────────────────────────────────────────────────────

function project(pt) {
  if (!chartRef || !seriesRef) return null;
  const x = chartRef.timeScale().timeToCoordinate(pt.t);
  const y = seriesRef.priceToCoordinate(pt.p);
  if (x == null || y == null) return null;
  return { x, y };
}

export function render() {
  if (!host) return;
  const list = store[marketRef] || [];
  const w = host.clientWidth, h = host.clientHeight;

  const parts = [];
  for (const d of list) {
    const pts = d.pts.map(project);
    if (pts.some(p => !p)) continue;         // scrolled out of view

    if (d.type === "h") {
      parts.push(`<line class="dl h" x1="0" y1="${pts[0].y.toFixed(1)}" x2="${w}" y2="${pts[0].y.toFixed(1)}"/>`);
      parts.push(`<text class="dlab" x="6" y="${(pts[0].y - 5).toFixed(1)}">${d.pts[0].p.toFixed(4)}</text>`);
    } else if (d.type === "t") {
      parts.push(`<line class="dl" x1="${pts[0].x.toFixed(1)}" y1="${pts[0].y.toFixed(1)}"
        x2="${pts[1].x.toFixed(1)}" y2="${pts[1].y.toFixed(1)}"/>`);
    } else if (d.type === "r") {
      const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
      parts.push(`<rect class="dr" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
        width="${Math.abs(pts[1].x - pts[0].x).toFixed(1)}"
        height="${Math.abs(pts[1].y - pts[0].y).toFixed(1)}"/>`);
    }
  }

  if (pending) {
    const p = project(pending);
    if (p) parts.push(`<circle class="dp" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"/>`);
  }

  host.innerHTML = `<svg width="${w}" height="${h}" style="position:absolute;inset:0">${parts.join("")}</svg>`;
  host.style.cursor = mode ? "crosshair" : "default";
}

export function hint() {
  return mode === "h" ? "Click the chart to place a price level"
       : mode === "t" ? "Click two points to draw a trendline"
       : mode === "r" ? "Click two corners to draw a box"
       : mode === "e" ? "Click a drawing to remove it"
       : "";
}
