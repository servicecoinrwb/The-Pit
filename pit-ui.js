/* ── pit-ui.js ────────────────────────────────────────────────────────
   Panels and rendering. Reads state from pit.js, draws through pit-chart.js,
   and owns no chain knowledge of its own.
*/

import * as P from "./pit.js";
import * as C from "./pit-chart.js";
import * as D from "./pit-draw.js";

const E = window.ethers;

/* A missing element absorbs writes rather than throwing. Panels move around,
   and a stale reference used to abort a whole refresh — blanking every live
   panel below the dead line. */
const NULLNODE = new Proxy({}, {
  get(_, k) {
    if (k === "querySelectorAll" || k === "querySelector") return () => [];
    if (k === "className" || k === "textContent" || k === "innerHTML") return "";
    return () => {};
  },
  set() { return true; },
});
const $ = id => document.getElementById(id) || NULLNODE;

// ── state ─────────────────────────────────────────────────────────────

const S = {
  view: "trade",
  market: 1,
  tf: 300,
  side: "long", kind: "market",
  orders: [], orderError: null,
  wallet: null, signer: null,
  prices: {}, markets: {}, positions: [], posError: null,
  pool: null, chips: 0n, owner: null,
  history: null, histError: null,
  candles: {}, feedError: null,
  openDrawer: null,
  loaded: false,
};

const TFS = [{ k: "1m", s: 60 }, { k: "5m", s: 300 }, { k: "15m", s: 900 }, { k: "1h", s: 3600 }];

function log(msg, hash) {
  const d = document.createElement("div");
  d.innerHTML = `${new Date().toLocaleTimeString()} — ${msg}` +
    (hash ? ` <a href="${P.SCAN}/tx/${hash}" target="_blank" rel="noopener">view</a>` : "");
  $("log").prepend(d);
}

function note(id, msg, kind) {
  const n = $(id);
  n.textContent = msg || "";
  n.className = "why" + (kind ? " " + kind : "");
}

async function send(fn, label, whyId) {
  if (!S.signer) { note(whyId, "Connect a wallet first.", "err"); return false; }
  try {
    note(whyId, "Waiting for signature…");
    const tx = await fn();
    note(whyId, "Submitted…");
    log(label + " submitted", tx.hash);
    await tx.wait();
    note(whyId, label + " confirmed.", "ok");
    log(label + " confirmed", tx.hash);
    S.history = null;                 // a close changes the tally
    await refresh();
    return true;
  } catch (e) {
    const m = e.shortMessage || e.reason || e.message || "failed";
    note(whyId, m, "err");
    log(label + " failed: " + m);
    return false;
  }
}

// ── views ─────────────────────────────────────────────────────────────

function setView(v) {
  S.view = v;
  document.querySelectorAll("[data-view]").forEach(b =>
    b.classList.toggle("on", b.dataset.view === v));
  document.querySelectorAll("[data-panel]").forEach(p =>
    p.classList.toggle("on", p.dataset.panel === v));
  paintAll();
  if (v === "trade") {
    // The panel was display:none until a moment ago, so the chart measured a
    // container with no size. Nudging it after the switch is cheaper than
    // rebuilding and covers the case where trade was not the first view.
    requestAnimationFrame(() => { C.resize(); drawChart(); });
  }
}

// ── market tabs and stats ─────────────────────────────────────────────

function paintMarkets() {
  $("mkts").innerHTML = P.MARKETS.map(m => {
    const p = S.prices[m.id];
    const st = p ? p.status : 3;
    const cls = st === 0 ? "ok" : st === 5 ? "warn" : "bad";
    return `<button class="mkt${m.id === S.market ? " on" : ""}" data-mkt="${m.id}">
      <span class="s">${m.sym}</span>
      <span class="p">${p && p.price ? "$" + P.money(p.price) : "—"}</span>
      <span class="st ${cls}">${P.STATUS[st] ?? "—"}</span></button>`;
  }).join("");

  $("mkts").querySelectorAll("[data-mkt]").forEach(b => b.onclick = () => {
    S.market = Number(b.dataset.mkt);
    paintMarkets(); paintStats(); quote();
    loadCandles().then(drawChart);
    drawChart();
  });
}

function paintStats() {
  const m = S.markets[S.market] || {};
  const p = S.prices[S.market];
  const span = C.historySpan(S.market);
  const s = C.series[S.market] || [];
  let chg = "—";
  if (s.length > 1) chg = ((s[s.length - 1].p / s[0].p - 1) * 100).toFixed(2) + "%";

  const fr = m.funding !== undefined ? Number(E.formatUnits(m.funding, 18)) * 100 : null;
  const pool = S.pool && S.pool.stats;
  const owed = S.pool && S.pool.owed;

  $("stats").innerHTML = `
    <div class="stat"><span class="k">Mark</span>
      <span class="v">${p && p.price ? "$" + P.money(p.price) : "—"}</span></div>
    <div class="stat"><span class="k">Change${span ? " · " + P.dur(span) : ""}</span>
      <span class="v ${chg.startsWith("-") ? "bad" : "ok"}">${chg}</span></div>
    <div class="stat"><span class="k">Funding / hr</span>
      <span class="v">${fr === null ? "—"
        : (fr >= 0 ? "Longs pay " : "Pool pays ") + Math.abs(fr).toFixed(4) + "%"}</span></div>
    <div class="stat"><span class="k">Open interest L / S</span>
      <span class="v">${m.long !== undefined
        ? P.fmt(m.long, 6, 0) + " / " + P.fmt(m.short, 6, 0) : "—"}</span></div>
    <div class="stat"><span class="k">Pool free</span>
      <span class="v">${pool ? P.fmt(pool[2], 6, 0) + " CHIP" : "—"}</span></div>
    <div class="stat"><span class="k">Pool owes</span>
      <span class="v ${owed > 0n ? "bad" : "ok"}">${owed === null || owed === undefined ? "—"
        : (owed < 0n ? "-" : "") + P.fmt(owed < 0n ? -owed : owed, 6)}</span></div>`;
}

// ── chart ─────────────────────────────────────────────────────────────

function showOHLC(c) {
  if (!c) { $("ohlc").textContent = ""; return; }
  const stamp = new Date(c.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const up = c.c >= c.o;
  $("ohlc").innerHTML = `<span style="color:var(--mute)">${stamp}</span> ` +
    `O <b>${P.money(c.o)}</b> H <b>${P.money(c.h)}</b> ` +
    `L <b>${P.money(c.l)}</b> C <b class="${up ? "ok" : "bad"}">${P.money(c.c)}</b>`;
}

/* Pulled on a change of market or timeframe, and refreshed on the cycle.
   Keyed by both so switching back does not re-fetch what is already here. */
async function loadCandles(force) {
  const key = S.market + ":" + S.tf;
  if (!force && S.candles[key] && Date.now() - S.candles[key].at < 20000) return;
  const r = await P.fetchCandles(S.market, S.tf);
  if (r.error) { S.feedError = r.error; return; }
  S.feedError = null;

  /* Merged, not replaced.
     Both sources are real prints from the same engine: this browser has
     whatever it was awake to observe, the feeder has everything since it last
     started. Letting whichever arrives second win is why the chart redrew
     into something completely different a moment after loading — five hours
     of local history replaced by twenty minutes of the feeder's.
     Taking the union keeps both, and as the feeder accumulates it becomes the
     whole series on its own. */
  const local = C.candles(S.market, S.tf);
  const byTime = new Map();
  for (const c of local) byTime.set(c.t, c);
  // The feeder's bucket wins on a collision: it saw every push, where a
  // browser may have caught one print out of the two in that bucket.
  for (const c of r.candles) byTime.set(c.t, c);

  S.candles[key] = {
    at: Date.now(),
    rows: [...byTime.values()].sort((a, b) => a.t - b.t),
    since: r.since,
    fromFeed: r.candles.length,
    fromLocal: local.length,
  };
}

/* Called from every path that builds a chart, not just the first one.
   It used to live inside drawChart's "if the chart does not exist yet"
   branch — but boot builds the chart directly, so by the time drawChart ran
   the chart existed and the drawing layer was never attached. The buttons
   toggled state nothing was listening to. */
let drawingAttached = false;
function attachDrawing() {
  const { chart, series } = C.raw();
  if (!chart || !series) return;
  D.attach($("chart"), chart, series, S.market, m => {
    document.querySelectorAll("[data-draw]").forEach(b =>
      b.classList.toggle("on", b.dataset.draw === m));
    $("drawhint").textContent = D.hint();
  });
  if (!drawingAttached) {
    // Drawings are stored in time and price, so they have to be reprojected
    // whenever the visible range moves.
    C.onViewChange(() => D.render());
    drawingAttached = true;
  }
}

function drawChart() {
  if (S.view !== "trade") return;
  if (!C.alive()) C.build($("chart"), showOHLC);
  attachDrawing();

  const p = S.prices[S.market];
  const key = S.market + ":" + S.tf;
  const held = S.candles[key];
  const r = C.draw(S.market, S.tf, p && p.price, held && held.rows);
  const sym = (P.MARKETS.find(m => m.id === S.market) || {}).sym;

  if (!r || r.count < 2) {
    $("thin").textContent = S.feedError
      ? `The price history service is unreachable (${S.feedError}), so this chart is ` +
        `showing only what this browser has observed since it was opened.`
      : `Not enough prints yet for ${sym} at this timeframe — history begins when the ` +
        `feeder starts. Try a shorter timeframe.`;
    $("zN").textContent = "";
    return;
  }

  $("thin").textContent = S.feedError
    ? `History service unreachable — showing only what this browser observed.`
    : r.count < 12
    ? `Only ${r.count} candles here so far. Shorter timeframes show more until it builds up.`
    : "";
  // Say where the candles came from. Two silent sources for one chart is how
  // it came to redraw into something different a second after loading.
  const src = held
    ? (held.fromFeed ? `${held.fromFeed} from the feed` : "local only")
      + (held.fromLocal > held.fromFeed ? ` · ${held.fromLocal} local` : "")
    : "local only";
  $("zN").textContent = `${r.count} candles${r.span ? " · " + P.dur(r.span) : ""} · ${src}`;

  C.markPositions(S.positions, S.market, v => Number(E.formatUnits(v, 18)));
  D.setMarket(S.market);
  if (!S.hovering) showOHLC(r.last);
}

// ── ticket ────────────────────────────────────────────────────────────

function quote() {
  const meta = P.MARKETS.find(m => m.id === S.market) || {};
  const size = Number($("fSize").value || 0);
  const marg = Number($("fMargin").value || 0);
  const p = (S.prices[S.market] || {}).price || 0;
  const st = (S.prices[S.market] || {}).status;

  const fee = size * 0.001;
  const net = marg - fee;
  const lev = net > 0 ? size / net : 0;

  $("qEntry").textContent = p ? "$" + P.money(p) : "no price";
  $("qLev").textContent = net > 0 ? lev.toFixed(1) + "x / " + meta.lev + "x max" : "—";
  $("qLev").className = "v " + (lev > meta.lev ? "bad" : "");
  $("qFee").textContent = fee ? P.money(fee, 2) + " CHIP" : "—";

  if (p && net > 0 && size > 0) {
    const room = net - size * 0.001 - size * 0.01;
    const move = room * p / size;
    const liq = S.side === "long" ? p - move : p + move;
    $("qLiq").textContent = liq > 0 ? "$" + P.money(liq) : "immediate";

    /* The cap is half of SIZE, so it never moves with margin — which reads as
       an enormous number next to a small stake. Against the margin actually
       at risk, and as the move that reaches it, it says something useful: at
       50x the position stops earning on a 1% move. */
    const cap = size * 0.5;
    $("qCap").textContent = P.money(cap, 2) + " CHIP · " + (cap / net).toFixed(1) + "x your margin";
    const movePct = 50 / lev;
    const target = S.side === "long" ? p * (1 + movePct / 100) : p * (1 - movePct / 100);
    $("qCapMove").textContent = movePct.toFixed(2) + "% · $" + P.money(target);
  } else {
    $("qLiq").textContent = "—";
    $("qCap").textContent = "—";
    $("qCapMove").textContent = "—";
  }

  const go = $("btnGo");
  go.textContent = S.kind === "resting" ? "Place " + S.side + " order" : "Open " + S.side;
  go.style.background = S.side === "long" ? "var(--jade)" : "var(--rust)";
  go.style.color = S.side === "long" ? "var(--ink)" : "var(--paper)";

  /* Which way a resting order fires is derived, not asked. A buy above the
     mark is a breakout stop; a buy below it is a limit. Making the trader
     choose "above or below" as well as a price is asking them to restate
     something the numbers already say, and it is the kind of question people
     get backwards. */
  const trig = Number($("fTrigger").value || 0);
  if (S.kind === "resting") {
    if (!trig || !p) {
      $("restSide").textContent = "Enter a trigger price.";
    } else {
      const above = trig > p;
      const what = S.side === "long"
        ? (above ? "buy stop — fills on a break upward" : "buy limit — fills on a dip")
        : (above ? "sell limit — fills on a rally" : "sell stop — fills on a break downward");
      $("restSide").innerHTML = `<b style="color:var(--paper)">${what}</b><br>` +
        `Filled at the oracle price when it crosses, not at ${P.money(trig)} — ` +
        `a gap through it fills past it. Margin is held by the desk until it fills or you cancel.`;
    }
  }

  let msg = "", kind = "";
  if (st !== 0) msg = `${meta.sym} is ${(P.STATUS[st] || "unavailable").toLowerCase()} — the engine will reject an open.`;
  else if (S.kind === "resting" && !trig) msg = "A resting order needs a trigger price.";
  else if (S.kind === "resting" && p && Math.abs(trig - p) / p < 0.0005)
    msg = "That trigger is where the price already is — use a market order.";
  else if (size < 10) msg = "Minimum size is 10 CHIP.";
  else if (net <= 0) msg = "Margin must exceed the open fee.";
  else if (lev > meta.lev) msg = `${lev.toFixed(1)}x is over the ${meta.lev}x cap on ${meta.sym}.`;
  if (msg) kind = "err";
  note("note", msg, kind);
  go.disabled = !!msg;
  if (msg) { go.style.background = "var(--edge)"; go.style.color = "var(--mute)"; }
}

// ── positions ─────────────────────────────────────────────────────────

function drawer(r) {
  const mark = Number(E.formatUnits(r.mark, 18));
  const lo = r.isLong ? "below " + P.money(mark) : "above " + P.money(mark);
  const hi = r.isLong ? "above " + P.money(mark) : "below " + P.money(mark);
  const slVal = r.sl && r.sl !== 0n ? E.formatUnits(r.sl, 18) : "";
  const tpVal = r.tp && r.tp !== 0n ? E.formatUnits(r.tp, 18) : "";
  const pcts = [25, 50, 75].map(pc =>
    `<button class="mini" data-pct="${r.id}:${pc}">${pc}%</button>`).join("");

  return `<tr><td colspan="10" class="mgrcell"><div class="mgr">
    <div class="mgrcol">
      <div class="mgrhead">Stop loss and take profit</div>
      <p class="mgrnote"><b>Fills at the oracle price when it executes, not at your trigger.</b>
        A gap straight through a stop fills past it — real slippage, because paying out at the
        trigger would put that gap on the pool.</p>
      <p class="mgrnote">Anyone can execute a crossed trigger and takes 0.05% of size for it.
        A halted market fires nothing, so a weekend gap settles on the reopen.</p>
      <div class="mgrrow">
        <label>Stop loss<input type="text" data-sl="${r.id}" value="${slVal}" placeholder="${lo}"></label>
        <label>Take profit<input type="text" data-tp="${r.id}" value="${tpVal}" placeholder="${hi}"></label>
      </div>
      <div class="mgrrow">
        <button class="mini" data-settrig="${r.id}">Set triggers</button>
        <button class="mini" data-cleartrig="${r.id}">Clear both</button>
      </div>
      <div class="why" data-whyt="${r.id}"></div>
    </div>
    <div class="mgrcol">
      <div class="mgrhead">Close part of it</div>
      <p class="mgrnote">The remainder keeps its entry, leverage and liquidation price — only size
        and margin shrink, and funding carries on from where it was. A partial close is not a new
        trade.</p>
      <p class="mgrnote">A leftover below the minimum settles in full rather than leaving dust.</p>
      <div class="mgrrow">
        <label>Size to close<input type="text" data-part="${r.id}" placeholder="of ${P.fmt(r.size, 6, 0)}"></label>
      </div>
      <div class="mgrrow">${pcts}
        <button class="mini" data-dopart="${r.id}">Close that much</button></div>
      <div class="mgrrow">
        <button class="mini" data-addm="${r.id}">Add 50 margin</button></div>
      <div class="why" data-whyp="${r.id}"></div>
    </div>
  </div></td></tr>`;
}

function paintPositions() {
  if (!S.wallet) {
    $("tabPos").innerHTML = '<div class="none">Connect a wallet to see your positions.</div>';
    return;
  }
  if (!S.positions.length) {
    $("tabPos").innerHTML = S.posError
      ? `<div class="none" style="color:var(--rust)">${S.posError}<br>
         That is a read failure, not an empty account — try the RPC switch.</div>`
      : '<div class="none">No open positions.<br>Rows turn red when equity nears maintenance — anyone can liquidate at that point.</div>';
    return;
  }

  const rows = S.positions.map(r => {
    const sym = (P.MARKETS.find(m => m.id === r.market) || {}).sym || r.market;
    const pct = r.margin > 0n ? Number(r.pnl) * 100 / Number(r.margin) : 0;
    const trig = (r.sl === 0n && r.tp === 0n)
      ? '<span style="color:var(--mute)">none</span>'
      : [r.sl !== 0n ? `<span class="bad">SL ${P.fmt(r.sl, 18)}</span>` : null,
         r.tp !== 0n ? `<span class="ok">TP ${P.fmt(r.tp, 18)}</span>` : null]
        .filter(Boolean).join(" · ");

    return `<tr class="${r.danger ? "danger" : ""}">
      <td><span class="tag ${r.isLong ? "long" : "short"}">${r.isLong ? "LONG" : "SHORT"}</span> ${sym}</td>
      <td>${P.fmt(r.size, 6)}</td><td>${P.fmt(r.margin, 6)}</td>
      <td>${P.fmt(r.entry, 18)}</td><td>${P.fmt(r.mark, 18)}</td>
      <td class="${r.pnl >= 0n ? "ok" : "bad"}">${r.pnl >= 0n ? "+" : "-"}${P.fmt(r.pnl < 0n ? -r.pnl : r.pnl, 6)} (${pct.toFixed(1)}%)</td>
      <td>${Number(r.funding) >= 0 ? "" : "-"}${P.fmt(r.funding < 0n ? -r.funding : r.funding, 6)}</td>
      <td class="${r.danger ? "bad" : "warn"}">${P.fmt(r.liq, 18)}</td>
      <td style="font-size:11px">${trig}</td>
      <td><button class="mini" data-mgr="${r.id}">${S.openDrawer === r.id ? "Close panel" : "Manage"}</button>
          <button class="mini" data-close="${r.id}">Close</button></td></tr>`
      + (S.openDrawer === r.id ? drawer(r) : "");
  }).join("");

  $("tabPos").innerHTML = `<table><thead><tr>
    <th>Market</th><th>Size</th><th>Margin</th><th>Entry</th><th>Mark</th>
    <th>PnL</th><th>Funding</th><th>Liq. price</th><th>Triggers</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  wirePositions();
}

function wirePositions() {
  const T = $("tabPos");
  const floor = () => P.contract("floor", S.signer);

  T.querySelectorAll("[data-mgr]").forEach(b => b.onclick = () => {
    S.openDrawer = S.openDrawer === b.dataset.mgr ? null : b.dataset.mgr;
    paintPositions();
  });

  T.querySelectorAll("[data-close]").forEach(b => b.onclick = () =>
    send(() => floor().close(b.dataset.close), "Close #" + b.dataset.close, "note"));

  T.querySelectorAll("[data-addm]").forEach(b => b.onclick = async () => {
    const id = b.dataset.addm, why = `[data-whyp="${id}"]`;
    const amt = E.parseUnits("50", 6);
    if (!await ensureAllowance(amt, P.A.floorplan, why)) return;
    await sendTo(why, () => floor().addMargin(id, amt), "Add margin");
  });

  T.querySelectorAll("[data-pct]").forEach(b => b.onclick = () => {
    const [id, pc] = b.dataset.pct.split(":");
    const r = S.positions.find(x => x.id === id);
    if (!r) return;
    const amt = (Number(E.formatUnits(r.size, 6)) * Number(pc) / 100).toFixed(2);
    const box = T.querySelector(`[data-part="${id}"]`);
    if (box) box.value = amt;
  });

  T.querySelectorAll("[data-settrig]").forEach(b => b.onclick = async () => {
    const id = b.dataset.settrig, why = `[data-whyt="${id}"]`;
    const slv = (T.querySelector(`[data-sl="${id}"]`)?.value || "").trim();
    const tpv = (T.querySelector(`[data-tp="${id}"]`)?.value || "").trim();
    if (!slv && !tpv) return setWhy(why, "Enter a stop, a target, or both.", "err");

    /* Checked here as well as on chain. The revert carries no data on this
       network, so a local check is the only way the reason reaches anyone. */
    const r = S.positions.find(x => x.id === id);
    const mark = Number(E.formatUnits(r.mark, 18));
    const sl = slv ? Number(slv) : 0, tp = tpv ? Number(tpv) : 0;
    const bad = r.isLong
      ? (sl && sl >= mark ? "A long's stop has to sit below the mark."
        : tp && tp <= mark ? "A long's target has to sit above the mark." : null)
      : (sl && sl <= mark ? "A short's stop has to sit above the mark."
        : tp && tp >= mark ? "A short's target has to sit below the mark." : null);
    if (bad) return setWhy(why, bad + ` Mark is ${P.money(mark)}.`, "err");

    await sendTo(why, () => floor().setTriggers(id,
      slv ? E.parseUnits(slv, 18) : 0n, tpv ? E.parseUnits(tpv, 18) : 0n), "Set triggers");
  });

  T.querySelectorAll("[data-cleartrig]").forEach(b => b.onclick = () =>
    sendTo(`[data-whyt="${b.dataset.cleartrig}"]`,
      () => floor().setTriggers(b.dataset.cleartrig, 0n, 0n), "Clear triggers"));

  T.querySelectorAll("[data-dopart]").forEach(b => b.onclick = async () => {
    const id = b.dataset.dopart, why = `[data-whyp="${id}"]`;
    const raw = (T.querySelector(`[data-part="${id}"]`)?.value || "").trim();
    if (!raw) return setWhy(why, "Enter how much of the size to close.", "err");
    const amt = E.parseUnits(raw, 6);
    const r = S.positions.find(x => x.id === id);
    if (amt > r.size) return setWhy(why, `That is more than the position holds.`, "err");
    await sendTo(why, () => floor().closePartial(id, amt), "Close part of #" + id);
  });
}

function setWhy(sel, msg, kind) {
  const n = document.querySelector(sel);
  if (!n) return;
  n.textContent = msg;
  n.className = "why" + (kind ? " " + kind : "");
}

async function sendTo(sel, fn, label) {
  if (!S.signer) return setWhy(sel, "Connect a wallet first.", "err");
  try {
    setWhy(sel, "Waiting for signature…");
    const tx = await fn();
    setWhy(sel, "Submitted…");
    await tx.wait();
    setWhy(sel, label + " confirmed.", "ok");
    log(label + " confirmed", tx.hash);
    await refresh();
  } catch (e) {
    setWhy(sel, e.shortMessage || e.reason || e.message, "err");
  }
}

/** One large approval rather than an exact one per trade. The spender is the
    same contract either way, and two signatures per trade is friction with no
    safety benefit. */
async function ensureAllowance(amount, spender, whySel) {
  const c = P.contract("chips", S.signer);
  try {
    if ((await c.allowance(S.wallet, spender)) >= amount) return true;
    const tx = await c.approve(spender, E.parseUnits("100000000", 6));
    if (whySel) setWhy(whySel, "Approving…");
    await tx.wait();
    return true;
  } catch (e) {
    if (whySel) setWhy(whySel, e.shortMessage || e.message, "err");
    return false;
  }
}

// ── desk ──────────────────────────────────────────────────────────────

function paintOrders() {
  if (!S.wallet) {
    $("tabOrders").innerHTML = '<div class="none">Connect a wallet to see your resting orders.</div>';
    return;
  }
  if (S.orderError) {
    $("tabOrders").innerHTML = `<div class="none" style="color:var(--rust)">${S.orderError}</div>`;
    return;
  }
  if (!S.orders.length) {
    $("tabOrders").innerHTML = `<div class="none">No resting orders.<br>
      A resting order holds its margin in the desk until it fills or you cancel it —
      that capital is committed even though nothing is open yet.</div>`;
    return;
  }

  const rows = S.orders.map(o => {
    const sym = (P.MARKETS.find(m => m.id === o.market) || {}).sym || o.market;
    const mark = (S.prices[o.market] || {}).price || 0;
    const t = P.num(o.trigger, 18);
    const away = mark ? ((t - mark) / mark * 100) : 0;
    const what = o.isLong
      ? (o.above ? "buy stop" : "buy limit")
      : (o.above ? "sell limit" : "sell stop");
    return `<tr>
      <td><span class="tag ${o.isLong ? "long" : "short"}">${o.isLong ? "LONG" : "SHORT"}</span> ${sym}</td>
      <td style="color:var(--mute)">${what}</td>
      <td>${P.fmt(o.size, 6, 0)}</td>
      <td>${P.fmt(o.margin, 6)}</td>
      <td>${P.money(t)}</td>
      <td class="${Math.abs(away) < 0.25 ? "warn" : ""}">${mark ? (away >= 0 ? "+" : "") + away.toFixed(2) + "%" : "—"}</td>
      <td><button class="mini" data-cancelord="${o.id}">Cancel</button></td></tr>`;
  }).join("");

  $("tabOrders").innerHTML = `<table><thead><tr>
    <th>Market</th><th>Kind</th><th>Size</th><th>Margin held</th>
    <th>Trigger</th><th>Away</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;

  $("tabOrders").querySelectorAll("[data-cancelord]").forEach(b => b.onclick = () =>
    send(() => P.contract("floor", S.signer).cancelOrder(b.dataset.cancelord),
      "Cancel order #" + b.dataset.cancelord, "note"));
}

function paintDesk() {
  const rows = P.MARKETS.map(m => {
    const s = S.markets[m.id];
    if (!s) return "";
    if (s.long === 0n && s.short === 0n) return "";
    const fr = Number(E.formatUnits(s.funding, 18)) * 100;
    return `<tr><td>${m.sym}</td><td>${P.fmt(s.long, 6, 0)}</td><td>${P.fmt(s.short, 6, 0)}</td>
      <td>${(fr >= 0 ? "Longs pay " : "Pool pays ") + Math.abs(fr).toFixed(4) + "%/hr"}</td>
      <td>${P.fmt(s.reserved, 6, 0)}</td></tr>`;
  }).filter(Boolean).join("");

  $("tabDesk").innerHTML = rows
    ? `<table><thead><tr><th>Market</th><th>Long OI</th><th>Short OI</th>
       <th>Funding</th><th>Reserved</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="none">Nothing open on the desk.</div>';
}

// ── portfolio ─────────────────────────────────────────────────────────

function paintHistory() {
  const h = S.history;

  if (!S.wallet) {
    $("fTrades").innerHTML = '<div class="none">Connect a wallet to see your closed trades.</div>';
    $("fCurve").innerHTML = "";
    return;
  }
  if (S.histError) {
    $("fTrades").innerHTML = `<div class="none" style="color:var(--rust)">
      Could not read your trade history.<br>${S.histError}<br>
      That is a read failure, not an empty account — try the RPC switch.</div>`;
    return;
  }
  if (!h || !h.stats || h.stats.closed === 0) {
    $("fTrades").innerHTML = `<div class="none">No closed trades yet.<br>
      History is kept by the desk itself, so it survives a bad connection —
      what you see here is what the contract holds, not what a log query
      managed to return.</div>`;
    $("fCurve").innerHTML = "";
    return;
  }

  const st = h.stats;
  const rate = st.closed ? Math.round(st.wins / st.closed * 100) : 0;
  const net = P.num(st.net, 6);
  const sgn = v => (v >= 0 ? "+" : "-") + P.money(Math.abs(v), 2);

  const rows = h.trades.map(t => {
    const sym = (P.MARKETS.find(m => m.id === t.market) || {}).sym || t.market;
    const when = new Date(t.at * 1000).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<tr>
      <td><span class="tag ${t.isLong ? "long" : "short"}">${t.isLong ? "LONG" : "SHORT"}</span> ${sym}</td>
      <td>${P.fmt(t.size, 6, 0)}</td>
      <td>${P.fmt(t.entry, 18)}</td>
      <td>${P.fmt(t.exit, 18)}</td>
      <td class="${t.net >= 0n ? "ok" : "bad"}">${t.net >= 0n ? "+" : "-"}${P.fmt(t.net < 0n ? -t.net : t.net, 6)}</td>
      <td style="color:var(--mute)">${when}</td></tr>`;
  }).join("");

  $("fTrades").innerHTML = `
    <div class="stats">
      <div class="stat"><span class="k">Realized net</span>
        <span class="v ${net >= 0 ? "ok" : "bad"}">${sgn(net)}</span>
        <span class="s">what came back, less what went in</span></div>
      <div class="stat"><span class="k">Closed trades</span>
        <span class="v">${st.closed}</span>
        <span class="s">${st.closed > P.RING ? "showing the last " + P.RING : "all shown below"}</span></div>
      <div class="stat"><span class="k">Win rate</span>
        <span class="v">${rate}%</span>
        <span class="s">${st.wins} up · ${st.closed - st.wins} down</span></div>
      <div class="stat"><span class="k">Fees paid</span>
        <span class="v">${P.fmt(st.fees, 6, 2)}</span>
        <span class="s">0.1% each way on size</span></div>
    </div>
    <table><thead><tr>
      <th>Market</th><th>Size</th><th>Entry</th><th>Exit</th><th>Net</th><th>Closed</th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  drawCurve(h.trades);
}

/**
 * Cumulative net, oldest to newest. The trades arrive newest first because
 * that is the right order for a table, so they are reversed here rather than
 * stored twice.
 */
function drawCurve(trades) {
  const box = $("fCurve");
  if (!box || trades.length < 2) { if (box) box.innerHTML = ""; return; }

  const pts = [0];
  let run = 0;
  for (const t of [...trades].reverse()) { run += P.num(t.net, 6); pts.push(run); }

  const W = Math.max(360, box.clientWidth || 800), H = 200;
  const PL = 8, PR = 70, PT = 14, PB = 18;
  let lo = Math.min(0, ...pts), hi = Math.max(0, ...pts);
  if (hi === lo) { hi = lo + 1; lo -= 1; }
  const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const X = i => PL + (pts.length > 1 ? i / (pts.length - 1) : 0) * (W - PL - PR);
  const Y = v => PT + (hi - v) / (hi - lo) * (H - PT - PB);

  let grid = "";
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3, y = Y(v);
    grid += `<line class="cgl" x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}"/>`
         +  `<text class="cax" x="${W - PR + 6}" y="${(y + 3.5).toFixed(1)}">${P.money(v, 2)}</text>`;
  }
  const line = pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const col = last >= 0 ? "var(--jade)" : "var(--rust)";

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}
    <line class="czero" x1="${PL}" y1="${Y(0).toFixed(1)}" x2="${W - PR}" y2="${Y(0).toFixed(1)}"/>
    <polyline class="cline" points="${line}" stroke="${col}"/>
    <circle cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="3.5" fill="${col}"/>
  </svg>`;
}

function paintPortfolio() {
  const st = S.pool && S.pool.stats;
  const mine = S.pool && S.pool.mine;

  const total = st ? P.num(st[0], 6) : 0;
  const idle  = st ? P.num(st[2], 6) : 0;
  const res   = st ? P.num(st[3], 6) : 0;

  const shares = mine ? mine[0] : 0n;
  const worth  = mine ? P.num(mine[1], 6) : 0;
  const basis  = mine ? P.num(mine[2], 6) : 0;
  const free   = mine ? P.num(mine[3], 6) : 0;
  const earned = mine ? P.num(mine[4], 6) : 0;
  const share  = total > 0 ? worth / total * 100 : 0;
  const isLp   = shares > 0n;
  const sgn = v => (v >= 0 ? "+" : "-") + P.money(Math.abs(v), 2);

  $("fStats").innerHTML = `
    <div class="stat"><span class="k">Your LP position</span>
      <span class="v">${isLp ? P.money(worth, 2) : "—"}</span>
      <span class="s">${isLp ? share.toFixed(1) + "% of the pool" : "not a depositor"}</span></div>
    <div class="stat"><span class="k">You put in</span>
      <span class="v">${isLp ? P.money(basis, 2) : "—"}</span>
      <span class="s">read from the vault, not from events</span></div>
    <div class="stat"><span class="k">Earned as the house</span>
      <span class="v ${earned >= 0 ? "ok" : "bad"}">${isLp ? sgn(earned) : "—"}</span>
      <span class="s">fees, less what traders are up</span></div>
    <div class="stat"><span class="k">Withdrawable now</span>
      <span class="v">${isLp ? P.money(free, 2) : "—"}</span>
      <span class="s">${isLp && free < worth
        ? P.money(worth - free, 2) + " backs open positions" : "capped by idle capital"}</span></div>
    <div class="stat"><span class="k">Your Chips</span>
      <span class="v">${P.fmt(S.chips, 6, 2)}</span>
      <span class="s">test collateral</span></div>`;

  $("fPool").innerHTML = `<div class="sec">
    <div class="kvrow"><span>Pool holds</span><b>${P.money(total, 2)} CHIP</b></div>
    <div class="kvrow"><span>Idle, free to back new positions</span><b>${P.money(idle, 2)} CHIP</b></div>
    <div class="kvrow"><span>Reserved against open positions</span><b>${P.money(res, 2)} CHIP</b></div>
    <div class="kvrow"><span>Liability feed</span>
      <b class="${st && st[6] ? "ok" : "bad"}">${st ? (st[6] ? "reachable" : "unreachable — pool value overstated") : "—"}</b></div>

    ${isLp ? "" : `<p class="secP" style="margin-top:14px">You are not a depositor. Depositing makes
      you counterparty to every trade here — traders who lose pay into the pool, traders who win are
      paid out of it, and every fee lands here regardless of who was right.</p>`}

    <div class="lprow">
      <input type="text" id="lpDep" placeholder="amount to deposit">
      <button class="lpbtn" id="btnDep">Approve &amp; deposit</button>
    </div>
    ${isLp ? `<div class="lprow">
      <input type="text" id="lpWd" placeholder="amount to withdraw">
      <button class="lpbtn ghost" id="btnWd">Withdraw</button>
      <button class="lpbtn ghost" id="btnWdAll">Withdraw all</button>
    </div>` : ""}

    <p class="secP" style="margin-top:12px">Withdrawals are capped by idle capital rather than by what
      your shares are worth. Money reserved against an open position belongs to that position until it
      closes — a winning trader has to be payable from something, and that something cannot also have
      been withdrawn.</p>
    <div class="why" id="whyLp"></div>
  </div>

  <div class="sec">
    <h3 class="secH">Test collateral</h3>
    <p class="secP">Chips stands in for USDC because the Arc faucet gives a dollar a day, which cannot
      seed a pool deep enough for any number here to mean anything. Six decimals, open mint, worthless
      on purpose.</p>
    <div class="lprow">
      <button class="lpbtn ghost" id="btnMint">Mint 100,000</button>
      <button class="lpbtn ghost" id="btnMint5">Mint 500,000</button>
    </div>
    <div class="why" id="whyMint"></div>
  </div>`;

  wirePortfolio();
}

function wirePortfolio() {
  const vault = () => P.contract("vault", S.signer);
  const chips = () => P.contract("chips", S.signer);

  const dep = $("btnDep");
  if (dep.onclick !== undefined) dep.onclick = async () => {
    const raw = ($("lpDep").value || "").trim();
    if (!raw) return note("whyLp", "Enter an amount.", "err");
    const amt = E.parseUnits(raw, 6);
    if (S.chips < amt) return note("whyLp", `Only ${P.fmt(S.chips, 6)} CHIP on hand.`, "err");
    if (!await ensureAllowance(amt, P.A.ballast, "#whyLp")) return;
    await send(() => vault().deposit(amt, S.wallet), "Deposit " + raw, "whyLp");
  };

  const wd = $("btnWd");
  if (wd.onclick !== undefined) wd.onclick = async () => {
    const raw = ($("lpWd").value || "").trim();
    if (!raw) return note("whyLp", "Enter an amount.", "err");
    await send(() => vault().withdraw(E.parseUnits(raw, 6), S.wallet, S.wallet), "Withdraw " + raw, "whyLp");
  };

  const all = $("btnWdAll");
  if (all.onclick !== undefined) all.onclick = async () => {
    // Redeem by shares so the last exit cannot strand dust from rounding.
    const sh = await vault().maxRedeem(S.wallet);
    if (sh === 0n) return note("whyLp", "Nothing withdrawable right now.", "err");
    await send(() => vault().redeem(sh, S.wallet, S.wallet), "Withdraw everything available", "whyLp");
  };

  $("btnMint").onclick  = () => send(() => chips().faucet(), "Mint 100,000", "whyMint");
  $("btnMint5").onclick = () => send(() =>
    chips().mint(S.wallet, E.parseUnits("500000", 6)), "Mint 500,000", "whyMint");
}

// ── admin ─────────────────────────────────────────────────────────────

function paintAdmin() {
  $("aAddrs").innerHTML = [
    ["Price engine", P.A.engine], ["Pool", P.A.ballast],
    ["Desk", P.A.floorplan], ["Collateral", P.A.chips],
  ].map(([n, a]) => `<div class="kvrow"><span>${n}</span>
    <b><a href="${P.SCAN}/address/${a}" target="_blank" rel="noopener">${P.short(a)}</a></b></div>`).join("");

  const known = S.owner !== null;
  $("aOwner").textContent = !S.wallet ? "—"
    : !known ? "could not read"
    : S.owner ? "you" : "not you";
  $("aOwner").className = known && S.owner ? "ok" : "";
  $("aOwnerNote").textContent = !S.wallet
    ? "Connect a wallet to see whether you hold the owner key."
    : !known ? "Ownership could not be checked — that is the chain not answering, not a permissions problem."
    : S.owner ? "You hold the owner key, so the controls below will go through."
    : "These controls exist but every one reverts from this address. The contracts enforce that, not the page.";

  $("ownerOnly").hidden = !S.owner;
}

function wireAdmin() {
  const en = () => P.contract("engine", S.signer);

  $("aSetPusher").onclick = () => {
    const a = ($("aPusher").value || "").trim();
    if (!E.isAddress(a)) return note("whyAdmin", "Not a valid address.", "err");
    send(() => en().setPusher(a, true), "Authorise pusher", "whyAdmin");
  };

  $("aForce").onclick = () => {
    const id = Number($("aFpId").value || 0), px = ($("aFpPx").value || "").trim();
    if (!id || !px) return note("whyAdmin", "Market id and price are both required.", "err");
    send(() => en().forcePush(id, E.parseUnits(px, 18)), "Force push market " + id, "whyAdmin");
  };

  $("aPause").onclick = () => {
    const id = Number($("aPauseId").value || 0);
    if (!id) return note("whyAdmin", "Which market?", "err");
    send(() => en().setPaused(id, true), "Pause market " + id, "whyAdmin");
  };
  $("aUnpause").onclick = () => {
    const id = Number($("aPauseId").value || 0);
    if (!id) return note("whyAdmin", "Which market?", "err");
    send(() => en().setPaused(id, false), "Unpause market " + id, "whyAdmin");
  };
  $("aPauseAll").onclick = () => send(() => en().pauseAll(), "Pause every market", "whyAdmin");
}

// ── refresh ───────────────────────────────────────────────────────────

/* Callers overlap — boot, connecting, switching view, the timer, and every
   transaction. Two cycles in the same second doubled the request burst
   against a connection that had not warmed up, which is what the cold-start
   failures were. Overlapping callers join the run in flight. */
let inFlight = null;

export function refresh() {
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh() {
  try {
    S.prices = await P.readPrices();
    for (const m of P.MARKETS) {
      const p = S.prices[m.id];
      if (p) C.record(m.id, p.price, p.at);
    }
    S.loaded = true;
    P.noteRead(true);
    $("rpcWarn").textContent = "";
  } catch (e) {
    /* Report the failure so the endpoint can be stepped past. CORS never
       resolves on its own — the endpoint will refuse every browser request for
       as long as it stays selected — so sitting on it means a page that never
       recovers. */
    const switched = P.noteRead(false, e);
    if (switched) {
      log(switched);
      $("rpcN").textContent = String(P.rpcLabel());
      $("rpcWarn").textContent = "switched endpoint";
      // Retry once on the new endpoint rather than waiting out the interval.
      setTimeout(() => refresh(), 800);
      return;
    }
    $("rpcWarn").textContent = S.loaded ? "reads refused" : "loading…";
    if (S.loaded) log("Price read failed: " + (e.shortMessage || e.message));
  }

  try { S.markets = await P.readMarkets(); } catch (e) { }
  // Force, because the point of the cycle is to pick up the newest candle.
  try { await loadCandles(true); } catch (e) { }

  if (S.wallet) {
    try {
      const r = await P.readPositions(S.wallet);
      S.positions = r.rows; S.posError = r.error;
    } catch (e) { }
      try {
      const o = await P.readOrders(S.wallet);
      S.orders = o.rows; S.orderError = o.error;
    } catch (e) { }
  }
  if (S.wallet) {
    try { S.chips = await P.readChips(S.wallet); } catch (e) { }
    try { S.owner = await P.isOwner(S.wallet); } catch (e) { }
  }
  try { S.pool = await P.readPool(S.wallet); } catch (e) { }
  if (S.wallet) {
    try {
      const h = await P.readHistory(S.wallet);
      S.history = h; S.histError = h.error;
    } catch (e) { S.histError = e.message; }
  }

  paintAll();
}

function paintAll() {
  // Each painter guarded. One failing should degrade that panel, not blank
  // every live one below it.
  const safe = (fn, name) => { try { fn(); } catch (e) { log(name + " failed: " + e.message); } };
  safe(paintMarkets, "Markets");
  safe(paintStats, "Stats");
  safe(quote, "Ticket");
  safe(paintPositions, "Positions");
  safe(paintOrders, "Orders");
  safe(paintDesk, "Desk");
  safe(paintPortfolio, "Portfolio");
  safe(paintHistory, "History");
  safe(paintAdmin, "Admin");
  if (S.view === "trade") safe(drawChart, "Chart");
}

// ── boot ──────────────────────────────────────────────────────────────

export async function boot() {
  $("tfs").innerHTML = TFS.map(t =>
    `<button class="tf${t.s === S.tf ? " on" : ""}" data-tf="${t.s}">${t.k}</button>`).join("");
  $("tfs").querySelectorAll("[data-tf]").forEach(b => b.onclick = () => {
    S.tf = Number(b.dataset.tf);
    $("tfs").querySelectorAll(".tf").forEach(x =>
      x.classList.toggle("on", Number(x.dataset.tf) === S.tf));
    loadCandles().then(drawChart);
    drawChart();
  });

  D.load();
  document.querySelectorAll("[data-draw]").forEach(b =>
    b.onclick = () => D.setMode(b.dataset.draw));
  $("clrDraw").onclick = () => D.clearMarket();

  document.querySelectorAll("[data-ind]").forEach(b => b.onclick = () => {
    C.indicators[b.dataset.ind] = !C.indicators[b.dataset.ind];
    b.classList.toggle("on", C.indicators[b.dataset.ind]);
    drawChart();
  });

  document.querySelectorAll("[data-view]").forEach(b =>
    b.onclick = () => setView(b.dataset.view));

  document.querySelectorAll(".side").forEach(b => b.onclick = () => {
    S.side = b.dataset.side;
    document.querySelectorAll(".side").forEach(x =>
      x.classList.toggle("on", x.dataset.side === S.side));
    quote();
  });

  document.querySelectorAll("[data-ftab]").forEach(b => b.onclick = () => {
    document.querySelectorAll("[data-ftab]").forEach(x => x.classList.toggle("on", x === b));
    $("fPool").hidden = b.dataset.ftab !== "pool";
    $("fTradesWrap").hidden = b.dataset.ftab !== "trades";
    if (b.dataset.ftab === "trades") paintHistory();
  });

  /* Scoped to [data-tab]. Both tab strips share the .tb class for styling,
     and binding onclick by class meant this handler replaced the portfolio
     one entirely — clicking "Closed trades" ran the trading-panel toggle and
     left both portfolio panels showing at once.

     Assignment replaces; it does not add. Two handlers on the same selector
     is one handler. */
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => {
    document.querySelectorAll("[data-tab]").forEach(x => x.classList.toggle("on", x === b));
    $("tabPos").hidden    = b.dataset.tab !== "pos";
    $("tabOrders").hidden = b.dataset.tab !== "orders";
    $("tabDesk").hidden = b.dataset.tab !== "desk";
    $("tabLog").hidden  = b.dataset.tab !== "log";
  });

  ["fSize", "fMargin"].forEach(id => $(id).addEventListener("input", quote));
  $("levs").innerHTML = [2, 5, 10, 20, 50].map(l =>
    `<button class="lv" data-lv="${l}">${l}x</button>`).join("");
  $("levs").querySelectorAll("[data-lv]").forEach(b => b.onclick = () => {
    const size = Number($("fSize").value || 0);
    if (!size) return;
    $("fMargin").value = (size / Number(b.dataset.lv)).toFixed(2);
    quote();
  });

  $("btnGo").onclick = async () => {
    const size = E.parseUnits(($("fSize").value || "0").trim(), 6);
    const marg = E.parseUnits(($("fMargin").value || "0").trim(), 6);
    if (S.chips < marg) return note("note", `Only ${P.fmt(S.chips, 6)} CHIP on hand.`, "err");
    if (!await ensureAllowance(marg, P.A.floorplan, "#note")) return;

    if (S.kind === "resting") {
      const t = Number($("fTrigger").value || 0);
      const p = (S.prices[S.market] || {}).price || 0;
      if (!t || !p) return note("note", "A resting order needs a trigger price.", "err");
      // spec is [marketId, trigger, size, margin, expiry] — packed into an
      // array because the contract ran out of stack otherwise.
      const spec = [S.market, E.parseUnits(String(t), 18), size, marg, 0];
      return send(() => P.contract("floor", S.signer)
        .placeOrder(spec, S.side === "long", t > p), "Place " + S.side + " order", "note");
    }

    await send(() => P.contract("floor", S.signer).open(S.market, S.side === "long", size, marg),
      "Open " + S.side, "note");
  };

  document.querySelectorAll("[data-kind]").forEach(b => b.onclick = () => {
    S.kind = b.dataset.kind;
    document.querySelectorAll("[data-kind]").forEach(x =>
      x.classList.toggle("on", x.dataset.kind === S.kind));
    $("restBox").hidden = S.kind !== "resting";
    quote();
  });
  $("fTrigger").addEventListener("input", quote);

  $("zFit").onclick = () => C.fit();

  $("btnRpc").onclick = () => {
    P.rotateRpc();
    $("rpcN").textContent = String(P.rpcLabel());
    log("switched to RPC " + P.rpcLabel() + " of " + P.rpcCount());
    refresh();
  };
  $("rpcN").textContent = String(P.rpcLabel());

  $("btnTheme").onclick = () => {
    const light = !document.documentElement.classList.contains("light");
    document.documentElement.classList.toggle("light", light);
    localStorage.setItem("pit.theme", light ? "light" : "dark");
    $("btnTheme").textContent = light ? "☀" : "☾";
    // The chart bakes the palette into its options, so it has to be rebuilt.
    C.build($("chart"), showOHLC);
    drawingAttached = false;      // the old chart object is gone
    attachDrawing();
    drawChart();
  };
  if (localStorage.getItem("pit.theme") === "light") {
    document.documentElement.classList.add("light");
    $("btnTheme").textContent = "☀";
  }

  $("btnConnect").onclick = () => doConnect(true);

  wireAdmin();

  // Without this the first paint leaves both portfolio panels visible until
  // something is clicked.
  $("fTradesWrap").hidden = true;
  $("fPool").hidden = false;

  const cached = C.loadCache();
  if (cached) log(`cache: ${cached} points, ${P.dur(Math.max(...P.MARKETS.map(m => C.historySpan(m.id))))} of history`);

  /* The chart measures its container when it is built, and the grips are what
     set --charth. Building first measured a container with no height, so the
     chart came up zero-tall and stayed that way until a refresh — by which
     point the height was already in localStorage and the order no longer
     mattered. That is exactly why it worked on the second load and never the
     first. */
  gripV();
  gripH();

  // Two frames, so the browser has applied the height before it is measured.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  C.build($("chart"), showOHLC);
  attachDrawing();
  paintAll();

  /* One cheap call before the burst. A fresh provider has to resolve the
     network and open a connection on its first request, and firing twenty
     reads into that cold state is what failed at load. */
  try { await P.provider().getBlockNumber(); } catch (e) { }
  await doConnect(false);
  await loadCandles(true);
  await refresh();
  setInterval(refresh, 30000);

  /* A chart built against a container that was not laid out yet stays the
     wrong size silently. Watching the container catches that, and covers the
     window being resized or the panel being shown for the first time. */
  if (window.ResizeObserver) {
    let last = 0;
    new ResizeObserver(() => {
      const h = $("chart").clientHeight;
      if (h > 0 && Math.abs(h - last) > 2) { last = h; D.render(); }
    }).observe($("chart"));
  }
}

/** Vertical: the boundary between chart and the tables below it. */
function gripV() {
  const KEY = "pit.charth", MIN = 220, MAX = 900;
  const apply = (px, persist) => {
    const h = Math.max(MIN, Math.min(MAX, Math.round(px)));
    document.documentElement.style.setProperty("--charth", h + "px");
    if (persist) { try { localStorage.setItem(KEY, String(h)); } catch (e) { } }
    D.render();
  };
  apply(Number(localStorage.getItem(KEY)) || Math.min(470, Math.round(innerHeight * 0.52)), false);

  const g = $("grip");
  let start = null;
  g.addEventListener?.("pointerdown", ev => {
    start = { y: ev.clientY, h: $("chart").clientHeight };
    g.classList.add("dragging"); document.body.classList.add("resizing");
    g.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });
  addEventListener("pointermove", ev => {
    if (start) apply(start.h + (ev.clientY - start.y), false);
  });
  addEventListener("pointerup", ev => {
    if (!start) return;
    apply($("chart").clientHeight, true);
    start = null;
    g.classList.remove("dragging"); document.body.classList.remove("resizing");
    g.releasePointerCapture?.(ev.pointerId);
  });
  g.addEventListener?.("dblclick", () => apply(470, true));
}

/** Horizontal: the split between the chart and the order ticket. */
function gripH() {
  const KEY = "pit.tickw", MIN = 240, MAX = 560;
  const apply = (px, persist) => {
    const w = Math.max(MIN, Math.min(MAX, Math.round(px)));
    document.documentElement.style.setProperty("--tickw", w + "px");
    if (persist) { try { localStorage.setItem(KEY, String(w)); } catch (e) { } }
    D.render();
  };
  apply(Number(localStorage.getItem(KEY)) || 316, false);

  const g = $("vgrip");
  let start = null;
  g.addEventListener?.("pointerdown", ev => {
    const cur = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--tickw")) || 316;
    start = { x: ev.clientX, w: cur };
    g.classList.add("dragging"); document.body.classList.add("vresizing");
    g.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });
  addEventListener("pointermove", ev => {
    // Dragging left widens the chart, so the ticket grows as the pointer
    // moves toward the left edge — hence the inverted delta.
    if (start) apply(start.w - (ev.clientX - start.x), false);
  });
  addEventListener("pointerup", ev => {
    if (!start) return;
    apply(parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--tickw")) || 316, true);
    start = null;
    g.classList.remove("dragging"); document.body.classList.remove("vresizing");
    g.releasePointerCapture?.(ev.pointerId);
  });
  g.addEventListener?.("dblclick", () => apply(316, true));
}

async function doConnect(prompt) {
  try {
    const r = await P.connect(prompt);
    if (!r) return;
    S.signer = r.signer;
    S.wallet = r.address;
    $("dot").className = "dot on";
    $("who").textContent = P.short(r.address);
    log("Connected " + P.short(r.address));
    await refresh();
  } catch (e) {
    if (prompt) note("note", e.shortMessage || e.message, "err");
  }
}

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
}
