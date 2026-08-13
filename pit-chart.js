/* ── pit-chart.js ─────────────────────────────────────────────────────
   The chart, on TradingView's Lightweight Charts.

   The previous version was hand-drawn SVG, and every property of a chart had
   to be rediscovered one bug at a time: axis labels colliding, candle widths
   that left the plot empty, a vertical scale that latched on a stray click,
   gaps that either vanished or swallowed the view. None of that work was
   interesting and none of it was ever finished.

   The data is unchanged — still the engine's own prints, bucketed here, so
   the chart shows the price positions actually settle against rather than an
   exchange's. What is gone is the drawing code.
*/

import { MARKETS, dp, money, dur, A } from "./pit.js";

const LWC = () => window.LightweightCharts;

/* Prices are cached locally because they come from PricePushed events, and
   log queries against a public endpoint are rate limited into uselessness.
   The series accumulates from the live tape instead. */
const CACHE_KEY = "pit.series.v2";
const CACHE_MAX = 6000;                     // ~50h per market at 30s

export const series = Object.fromEntries(MARKETS.map(m => [m.id, []]));

let chart = null, candleSeries = null;
let overlays = { ma20: null, ma50: null, bbu: null, bbl: null };
let priceLines = [];
let lastMarket = null, lastTf = null;

export const indicators = { ma20: false, ma50: false, bb: false };

// ── cache ─────────────────────────────────────────────────────────────

export function loadCache() {
  try {
    const j = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!j || j.floorplan !== A.floorplan) return 0;
    let n = 0;
    for (const k in series) {
      const arr = (j.s && j.s[k]) || [];
      series[k] = arr.filter(d => Number.isFinite(d.t) && Number.isFinite(d.p) && d.t > 0 && d.p > 0);
      n += series[k].length;
    }
    return n;
  } catch (e) { return 0; }
}

export function saveCache() {
  try {
    /* Never write less than is already stored. A short read used to be saved
       over a day of accumulated history, which is why the chart kept
       resetting to a few hours. */
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (e) { }
    const out = {};
    for (const k in series) {
      const mine = series[k] || [];
      const theirs = (stored && stored.floorplan === A.floorplan && stored.s && stored.s[k]) || [];
      if (theirs.length > mine.length) {
        const seen = new Set(mine.map(d => d.t));
        series[k] = mine.concat(theirs.filter(d => !seen.has(d.t)))
          .sort((a, b) => a.t - b.t).slice(-CACHE_MAX);
      }
      out[k] = series[k].slice(-CACHE_MAX);
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify({ floorplan: A.floorplan, s: out }));
  } catch (e) { /* quota, most likely; the series still lives in memory */ }
}

let ticks = 0;
export function record(id, price, at) {
  const s = series[id];
  if (!s) return;
  if (!Number.isFinite(price) || price <= 0) return;
  if (!Number.isFinite(at) || at <= 0) return;
  if (s.length && s[s.length - 1].t >= at) return;
  s.push({ t: at, p: price });
  if (s.length > CACHE_MAX) s.shift();
  if (++ticks % 2 === 0) saveCache();
}

export function historySpan(id) {
  const s = series[id] || [];
  return s.length > 1 ? s[s.length - 1].t - s[0].t : 0;
}

// ── candles ───────────────────────────────────────────────────────────

/**
 * The engine stores one price per push, not a candle. Bucketing those prints
 * gives OHLC that is genuinely this desk's — first print in a bucket opens
 * it, last one closes it.
 *
 * Candles sit next to each other regardless of the time between them, which
 * is what every charting package does: a stock chart does not render the
 * sixteen hours a market is shut, it puts Friday beside Monday. Spacing gaps
 * honestly was tried and it was worse — seven blank hours in the middle with
 * the real candles crushed to the edges.
 */
export function candles(id, secs) {
  const s = (series[id] || []).filter(d =>
    Number.isFinite(d.t) && Number.isFinite(d.p) && d.t > 0 && d.p > 0);
  if (!s.length) return [];
  const out = [];
  let b = null;
  for (const d of s) {
    const k = Math.floor(d.t / secs) * secs;
    if (!b || b.t !== k) { if (b) out.push(b); b = { t: k, o: d.p, h: d.p, l: d.p, c: d.p, n: 1 }; }
    else { b.h = Math.max(b.h, d.p); b.l = Math.min(b.l, d.p); b.c = d.p; b.n++; }
  }
  if (b) out.push(b);
  return out;
}

// ── indicator maths ───────────────────────────────────────────────────

function sma(v, n, i) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += v[k];
  return s / n;
}

function stdev(v, n, i, mean) {
  if (i < n - 1 || mean == null) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += (v[k] - mean) ** 2;
  return Math.sqrt(s / n);
}

// ── rendering ─────────────────────────────────────────────────────────

function palette() {
  const light = document.documentElement.classList.contains("light");
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return {
    bg: css("--ink"), text: css("--mute"), grid: css("--edge"),
    /* On paper the convention is fill, not colour: an up bar is hollow with
       an outline, a down bar is solid. It reads unambiguously where colour
       does not, and it is what a printed bar chart has always looked like. */
    up:         light ? css("--slab")  : css("--jade"),
    down:       light ? css("--paper") : css("--rust"),
    upBorder:   light ? css("--paper") : css("--jade"),
    downBorder: light ? css("--paper") : css("--rust"),
  };
}

export function build(box, onCrosshair) {
  if (!LWC() || !box) return null;
  box.innerHTML = "";
  const c = palette();

  chart = LWC().createChart(box, {
    layout: { background: { color: c.bg }, textColor: c.text,
              fontFamily: '"IBM Plex Mono",monospace', fontSize: 11 },
    grid: { vertLines: { color: c.grid, style: 1 }, horzLines: { color: c.grid, style: 1 } },
    rightPriceScale: { borderColor: c.grid, scaleMargins: { top: 0.12, bottom: 0.12 } },
    timeScale: { borderColor: c.grid, timeVisible: true, secondsVisible: false,
                 rightOffset: 4, barSpacing: 9 },
    crosshair: { mode: LWC().CrosshairMode.Normal },
    handleScroll: true, handleScale: true, autoSize: true,
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: c.up, downColor: c.down,
    borderUpColor: c.upBorder, borderDownColor: c.downBorder,
    wickUpColor: c.upBorder, wickDownColor: c.downBorder,
    borderVisible: true,
  });

  chart.subscribeCrosshairMove(p => {
    const d = p.seriesData?.get(candleSeries);
    onCrosshair(d ? { t: p.time, o: d.open, h: d.high, l: d.low, c: d.close } : null);
  });

  overlays = { ma20: null, ma50: null, bbu: null, bbl: null };
  lastMarket = null; lastTf = null;
  return chart;
}

export function draw(marketId, tf, markPrice) {
  if (!chart || !candleSeries) return null;
  const cs = candles(marketId, tf);
  if (cs.length < 2) return { count: cs.length, span: 0 };

  const changed = lastMarket !== marketId || lastTf !== tf;
  if (changed) {
    const d = dp(markPrice || cs[cs.length - 1].c);
    candleSeries.applyOptions({
      priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) },
    });
  }

  candleSeries.setData(cs.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));

  /* Only fit on a change of market or timeframe. Refitting every refresh
     throws away the zoom and scroll position the user just set, which makes
     a live chart unusable. */
  if (changed) { chart.timeScale().fitContent(); lastMarket = marketId; lastTf = tf; }

  drawIndicators(cs);
  return { count: cs.length, span: cs[cs.length - 1].t - cs[0].t, last: cs[cs.length - 1] };
}

function lineFor(key, colour) {
  if (overlays[key]) return overlays[key];
  overlays[key] = chart.addLineSeries({
    color: colour, lineWidth: 1,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  return overlays[key];
}

function dropLine(key) {
  if (!overlays[key]) return;
  chart.removeSeries(overlays[key]);
  overlays[key] = null;
}

function drawIndicators(cs) {
  const closes = cs.map(c => c.c);
  const at = i => cs[i].t;

  if (indicators.ma20) {
    lineFor("ma20", "#d9a441").setData(
      cs.map((c, i) => { const v = sma(closes, 20, i); return v == null ? null : { time: at(i), value: v }; })
        .filter(Boolean));
  } else dropLine("ma20");

  if (indicators.ma50) {
    lineFor("ma50", "#8a5fc0").setData(
      cs.map((c, i) => { const v = sma(closes, 50, i); return v == null ? null : { time: at(i), value: v }; })
        .filter(Boolean));
  } else dropLine("ma50");

  if (indicators.bb) {
    const up = [], lo = [];
    for (let i = 0; i < cs.length; i++) {
      const m = sma(closes, 20, i); if (m == null) continue;
      const sd = stdev(closes, 20, i, m); if (sd == null) continue;
      up.push({ time: at(i), value: m + 2 * sd });
      lo.push({ time: at(i), value: m - 2 * sd });
    }
    lineFor("bbu", "#8ba3bd").setData(up);
    lineFor("bbl", "#8ba3bd").setData(lo);
  } else { dropLine("bbu"); dropLine("bbl"); }
}

/**
 * Entry, liquidation and any triggers drawn on the price scale.
 *
 * This is the overlay that actually matters while a position is open, and the
 * hand-rolled chart never had it.
 */
export function markPositions(rows, marketId, fmtUnits) {
  if (!candleSeries) return;
  priceLines.forEach(l => { try { candleSeries.removePriceLine(l); } catch (e) { } });
  priceLines = [];

  for (const r of rows) {
    if (Number(r.market) !== marketId) continue;
    const add = (price, colour, title, style) => {
      if (!price) return;
      priceLines.push(candleSeries.createPriceLine({
        price, color: colour, lineWidth: 1, lineStyle: style,
        axisLabelVisible: true, title,
      }));
    };
    add(fmtUnits(r.entry), "#6fb7e3", r.isLong ? "long entry" : "short entry", 0);
    add(fmtUnits(r.liq),   "#b5512f", "liquidation", 2);
    if (r.sl && r.sl !== 0n) add(fmtUnits(r.sl), "#d9a441", "stop", 3);
    if (r.tp && r.tp !== 0n) add(fmtUnits(r.tp), "#5fa88a", "target", 3);
  }
}

export function fit() { chart && chart.timeScale().fitContent(); }
export function raw() { return { chart, series: candleSeries }; }

/* The drawing layer projects from time and price to pixels, so it has to
   redraw whenever the visible range moves — pan, zoom, or a new candle. */
export function onViewChange(fn) {
  if (!chart) return;
  chart.timeScale().subscribeVisibleTimeRangeChange(fn);
  chart.subscribeCrosshairMove(() => {});   // keeps the handler list warm
}
export function alive() { return !!chart; }
