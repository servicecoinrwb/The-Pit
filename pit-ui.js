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
  side: "long",
  wallet: null, signer: null,
  prices: {}, markets: {}, positions: [], posError: null,
  pool: null, chips: 0n, owner: null,
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
  if (v === "trade") drawChart();
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
    paintMarkets(); paintStats(); drawChart(); quote();
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

function drawChart() {
  if (S.view !== "trade") return;
  if (!C.alive()) {
    C.build($("chart"), showOHLC);
    const { chart, series } = C.raw();
    D.attach($("chart"), chart, series, S.market, m => {
      document.querySelectorAll("[data-draw]").forEach(b =>
        b.classList.toggle("on", b.dataset.draw === m));
      $("drawhint").textContent = D.hint();
    });
    // Redraw the overlay whenever the visible range moves, or the drawings
    // detach from the candles they were placed against.
    C.onViewChange(() => D.render());
  }

  const p = S.prices[S.market];
  const r = C.draw(S.market, S.tf, p && p.price);
  const sym = (P.MARKETS.find(m => m.id === S.market) || {}).sym;

  if (!r || r.count < 2) {
    $("thin").textContent = `Not enough prints yet for ${sym} at this timeframe — ` +
      `the feed builds the chart as it publishes. Try a shorter timeframe.`;
    $("zN").textContent = "";
    return;
  }

  $("thin").textContent = r.count < 12
    ? `Only ${r.count} candles here so far. Shorter timeframes show more until it builds up.`
    : "";
  $("zN").textContent = `${r.count} candles${r.span ? " · " + P.dur(r.span) : ""}`;

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
  go.textContent = "Open " + S.side;
  go.style.background = S.side === "long" ? "var(--jade)" : "var(--rust)";
  go.style.color = S.side === "long" ? "var(--ink)" : "var(--paper)";

  let msg = "", kind = "";
  if (st !== 0) msg = `${meta.sym} is ${(P.STATUS[st] || "unavailable").toLowerCase()} — the engine will reject an open.`;
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
    $("rpcWarn").textContent = "";
  } catch (e) {
    if (!S.loaded) $("rpcWarn").textContent = "loading…";
    else log("Price read failed: " + (e.shortMessage || e.message));
  }

  try { S.markets = await P.readMarkets(); } catch (e) { }

  if (S.wallet) {
    try {
      const r = await P.readPositions(S.wallet);
      S.positions = r.rows; S.posError = r.error;
    } catch (e) { }
    try { S.chips = await P.readChips(S.wallet); } catch (e) { }
    try { S.owner = await P.isOwner(S.wallet); } catch (e) { }
  }
  try { S.pool = await P.readPool(S.wallet); } catch (e) { }

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
  safe(paintDesk, "Desk");
  safe(paintPortfolio, "Portfolio");
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

  document.querySelectorAll(".tb").forEach(b => b.onclick = () => {
    document.querySelectorAll(".tb").forEach(x => x.classList.toggle("on", x === b));
    $("tabPos").hidden  = b.dataset.tab !== "pos";
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
    await send(() => P.contract("floor", S.signer).open(S.market, S.side === "long", size, marg),
      "Open " + S.side, "note");
  };

  $("zFit").onclick = () => C.fit();

  /* Two grips: the chart's height, and the split between chart and ticket.
     The library autosizes, which is not the same as letting you choose — a
     chart you deliberately made taller should stay that way. */
  gripV();
  gripH();

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
    drawChart();
  };
  if (localStorage.getItem("pit.theme") === "light") {
    document.documentElement.classList.add("light");
    $("btnTheme").textContent = "☀";
  }

  $("btnConnect").onclick = () => doConnect(true);

  wireAdmin();

  const cached = C.loadCache();
  if (cached) log(`cache: ${cached} points, ${P.dur(Math.max(...P.MARKETS.map(m => C.historySpan(m.id))))} of history`);

  C.build($("chart"), showOHLC);
  paintAll();

  /* One cheap call before the burst. A fresh provider has to resolve the
     network and open a connection on its first request, and firing twenty
     reads into that cold state is what failed at load. */
  try { await P.provider().getBlockNumber(); } catch (e) { }
  await doConnect(false);
  await refresh();
  setInterval(refresh, 30000);
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
