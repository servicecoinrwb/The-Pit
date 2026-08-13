/* ── pit.js ───────────────────────────────────────────────────────────
   Everything that touches the chain. No rendering, no DOM.

   One copy of every address and ABI. Three separate pages each keeping
   their own copies is how a page spent an afternoon decoding a new 
   contract with an old tuple while another page read it correctly.
*/

export const CHAIN = 5042002;
export const CHAIN_HEX = "0x4CEF52";
export const SCAN = "https://testnet.arcscan.app";

/* The feeder serves the price history.
   A browser can only record while it is open and focused — background tabs
   have their timers throttled and closed ones record nothing — so a chart
   accumulated client-side has holes in it that no charting library can fill.
   Five hours of a live market became twenty-eight minutes of candles, and
   reopening the page put 18:45 next to 23:23 with a straight line between.
   The feeder never sleeps and is already polling, so the series lives there
   and every viewer sees the same chart. */
export const FEED = "https://arc-feeder-production.up.railway.app";

export const A = {
  engine:    "0xFC3B06a7c12E52D14BE7762800863619Aea533aB",
  chips:     "0x207A26e236520b41e98098dCd656D453CDA931d6",
  ballast:   "0x056C788f75F2b3eb3641bA21De14022E1a476362",
  floorplan: "0x195dcD8665c4CAF5F1341E03a9AcB182F60a75E2",
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

/* thirdweb is deliberately absent. It answers server-to-server but sends no
   Access-Control-Allow-Origin for browser requests, so every read from a page
   fails CORS — and it rate limits on top of that. An endpoint that cannot be
   called from a browser does not belong in a browser's rotation. */
const RPCS = [
  "https://rpc.blockdaemon.testnet.arc.network",
  "https://arc-testnet.drpc.org",
  "https://rpc.quicknode.testnet.arc.network",
];

export const MARKETS = [
  { id: 1, sym: "ETH",  lev: 50 },
  { id: 2, sym: "BTC",  lev: 50 },
  { id: 8, sym: "SOL",  lev: 40 },
  { id: 9, sym: "XRP",  lev: 40 },
  { id: 7, sym: "GOLD", lev: 30 },
  { id: 3, sym: "US30", lev: 20 },
  { id: 4, sym: "SPX",  lev: 20 },
  { id: 5, sym: "NAS",  lev: 20 },
  { id: 6, sym: "WTI",  lev: 20 },
];

export const RING = 20;   // matches the contract's ring size
export const STATUS = ["Live", "Not listed", "Paused", "No price", "Stale", "Closed"];

const E = window.ethers;

// ── abis ──────────────────────────────────────────────────────────────

const ENGINE_ABI = [
  "function peek(uint256) view returns (uint256 value,uint64 updatedAt,uint64 roundId,uint8 s)",
  "function owner() view returns (address)",
  "function markets(uint256) view returns (bool listed,bool paused,bool hasSessions,uint16 maxLeverageX,uint16 maxDeviationBps,uint32 maxStaleness,uint32 fundingFactor,uint32 maxFundingBps,uint128 maxOpenInterest,string symbol)",
  "function setPusher(address,bool)",
  "function forcePush(uint256,uint128)",
  "function setPaused(uint256,bool)",
  "function pauseAll()",
  "function configureMarket(uint256,uint16,uint16,uint32,uint32,uint32,uint128)",
];

const FLOOR_ABI = [
  "function open(uint256,bool,uint256,uint256) returns (uint256)",
  "function close(uint256)",
  "function closePartial(uint256,uint256)",
  "function addMargin(uint256,uint256)",
  "function setTriggers(uint256,uint128,uint128)",
  "function positionsOf(address) view returns (uint256[])",
  "function positionView(uint256) view returns (tuple(address owner,uint32 marketId,bool isLong,uint64 openedAt,uint128 size,uint128 margin,uint128 entryPrice,int256 entryFunding,uint256 entryBorrow,uint128 stopLoss,uint128 takeProfit) p,uint256 price,int256 pnl,int256 funding,int256 equity,uint256 maintenance,uint256 liqPrice,bool liquidatable)",
  "function marketView(uint256) view returns (uint256 longSize,uint256 shortSize,int256 skew,int256 fundingHourly,int256 cumFunding,uint256 reserved,uint256 price,uint8 status)",
  "function poolPnl() view returns (int256)",
  "function tradeStats(address) view returns (uint256 closed,int256 net,uint256 fees,uint256 wins)",
  "function recentTrades(address) view returns (tuple(uint32 marketId,bool isLong,uint64 closedAt,uint128 size,uint128 entryPrice,uint128 exitPrice,int128 net)[])",
  "function openFeeBps() view returns (uint256)",
  "function maxProfitBps() view returns (uint256)",
  "function minSize() view returns (uint256)",
];

const VAULT_ABI = [
  "function positionOf(address) view returns (uint256 shares,uint256 worth,uint256 basis,uint256 free,int256 earned)",
  "function stats() view returns (uint256 assets,uint256 raw,uint256 idle,uint256 reserved,uint256 supply,uint256 assetsPerShare,bool healthy,bool ready)",
  "function deposit(uint256,address) returns (uint256)",
  "function withdraw(uint256,address,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function initialised() view returns (bool)",
  "function initialise(uint256)",
  "function perp() view returns (address)",
];

const CHIPS_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet()",
  "function mint(address,uint256)",
];

const MC_ABI = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])",
];

// ── provider ──────────────────────────────────────────────────────────

/* One endpoint at a time, not a FallbackProvider. A fallback needs several
   endpoints to agree before it will send, and these answer inconsistently
   enough that agreement often never comes — the call then fails with
   "quorum not met" having never reached the chain. */
let rpcIdx = Number(localStorage.getItem("pit.rpc") || 0) % RPCS.length;
localStorage.setItem("pit.rpc", String(rpcIdx));
let _read = null;

export function provider() {
  if (!_read) {
    _read = new E.JsonRpcProvider(RPCS[rpcIdx], CHAIN, {
      staticNetwork: true, batchMaxCount: 20,
    });
  }
  return _read;
}

export function rpcLabel(){ return rpcIdx + 1; }
export function rpcCount(){ return RPCS.length; }
export function rotateRpc() {
  rpcIdx = (rpcIdx + 1) % RPCS.length;
  localStorage.setItem("pit.rpc", String(rpcIdx));
  _read = null;
}

/* A dead endpoint is worth stepping past on its own. The manual button is
   fine when someone is watching; a page left open needs to recover by itself,
   and CORS in particular never resolves — the endpoint will refuse every
   request from a browser for as long as it is selected.

   Rotation waits for sustained failure and for a quiet moment, because
   switching mid-cycle invalidates the provider the current reads are using
   and that failure rotates again — four endpoints cycled in a second, none of
   them given a chance to answer. */
let fails = 0, lastRotate = 0;

export function noteRead(ok, err) {
  if (ok) { fails = 0; return null; }
  fails++;
  const msg = (err?.message || "") + (err?.info ? JSON.stringify(err.info) : "");
  // CORS and 429 are properties of the endpoint, not of the moment. One is
  // enough; there is no point waiting for five.
  const fatal = /CORS|Access-Control|Failed to fetch|429|too many requests/i.test(msg);
  const enough = fatal || fails >= 4;
  const cooled = Date.now() - lastRotate > 20000;
  if (enough && cooled) {
    lastRotate = Date.now();
    fails = 0;
    const from = rpcIdx + 1;
    rotateRpc();
    return `RPC ${from} refused (${fatal ? "blocked or rate limited" : "repeated failures"}) — switched to ${rpcIdx + 1}`;
  }
  return null;
}

export const iface = {
  engine: new E.Interface(ENGINE_ABI),
  floor:  new E.Interface(FLOOR_ABI),
  vault:  new E.Interface(VAULT_ABI),
  chips:  new E.Interface(CHIPS_ABI),
};

export function contract(which, signerOrProvider) {
  const map = {
    engine: [A.engine, ENGINE_ABI],
    floor:  [A.floorplan, FLOOR_ABI],
    vault:  [A.ballast, VAULT_ABI],
    chips:  [A.chips, CHIPS_ABI],
  };
  const [addr, abi] = map[which];
  return new E.Contract(addr, abi, signerOrProvider || provider());
}

// ── batching ──────────────────────────────────────────────────────────

let mcOk = null;

/**
 * Nine markets read one at a time is nine round trips per panel per cycle,
 * which is what earned the 429s. Multicall3 sits at the same address on
 * nearly every chain; if it is missing here the caller falls back.
 */
export async function batch(calls) {
  if (mcOk === false) return null;
  try {
    const mc = new E.Contract(A.multicall, MC_ABI, provider());
    const res = await mc.aggregate3(
      calls.map(c => ({ target: c.to, allowFailure: true, callData: c.data }))
    );
    mcOk = true;
    return res;
  } catch (e) {
    const msg = e?.shortMessage || e?.message || "";
    // Distinguish "not deployed" from "this request timed out". Giving up on
    // multicall because one call was slow would leave every read going out
    // singly forever.
    if (/call revert|BAD_DATA|could not decode|no contract/i.test(msg)) mcOk = false;
    return null;
  }
}

// ── reads ─────────────────────────────────────────────────────────────

/** Price and status for every market, in one request where possible. */
export async function readPrices() {
  const out = {};
  let packed = null;
  try {
    packed = await batch(MARKETS.map(m => ({
      to: A.engine, data: iface.engine.encodeFunctionData("peek", [m.id]),
    })));
  } catch (e) { throw e; }

  if (packed) {
    MARKETS.forEach((m, i) => {
      if (!packed[i].success) return;
      const [value, updatedAt, , s] = iface.engine.decodeFunctionResult("peek", packed[i].returnData);
      out[m.id] = { price: Number(E.formatUnits(value, 18)), at: Number(updatedAt), status: Number(s) };
    });
    return out;
  }

  const en = contract("engine");
  let anyOk = false, lastErr = null;
  for (const m of MARKETS) {
    try {
      const [value, updatedAt, , s] = await en.peek(m.id);
      out[m.id] = { price: Number(E.formatUnits(value, 18)), at: Number(updatedAt), status: Number(s) };
      anyOk = true;
    } catch (e) { lastErr = e; }
  }
  // A cycle where nothing came back at all is the endpoint, not the markets.
  if (!anyOk && lastErr) throw lastErr;
  return out;
}

/** Open interest, funding and reservation per market. */
export async function readMarkets() {
  const out = {};
  const packed = await batch(MARKETS.map(m => ({
    to: A.floorplan, data: iface.floor.encodeFunctionData("marketView", [m.id]),
  })));

  if (packed) {
    MARKETS.forEach((m, i) => {
      if (!packed[i].success) return;
      const v = iface.floor.decodeFunctionResult("marketView", packed[i].returnData);
      out[m.id] = { long: v[0], short: v[1], funding: v[3], reserved: v[5] };
    });
    return out;
  }

  const fl = contract("floor");
  for (const m of MARKETS) {
    try {
      const v = await fl.marketView(m.id);
      out[m.id] = { long: v[0], short: v[1], funding: v[3], reserved: v[5] };
    } catch (e) { }
  }
  return out;
}

/**
 * A trader's open positions.
 *
 * Failures are reported rather than swallowed. A caught error that renders
 * as an empty list is indistinguishable from having no positions, and that
 * ambiguity sent a whole debugging session in the wrong direction.
 */
export async function readPositions(who) {
  if (!who) return { rows: [], error: null };
  const fl = contract("floor");
  let ids;
  try {
    ids = await fl.positionsOf(who);
  } catch (e) {
    return { rows: [], error: "Could not read your positions: " + (e.shortMessage || e.message) };
  }

  const rows = [];
  let failed = 0;
  for (const id of ids) {
    try {
      const v = await fl.positionView(id);
      const p = v[0];
      if (p.owner === E.ZeroAddress) continue;
      rows.push({
        id: id.toString(), market: Number(p.marketId), isLong: p.isLong,
        size: p.size, margin: p.margin, entry: p.entryPrice,
        sl: p.stopLoss, tp: p.takeProfit,
        mark: v[1], pnl: v[2], funding: v[3], equity: v[4],
        maintenance: v[5], liq: v[6], danger: v[7],
      });
    } catch (e) { failed++; }
  }
  return {
    rows,
    error: failed ? `${failed} of ${ids.length} positions could not be read.` : null,
  };
}

/** Pool state, and the caller's stake in it. */
export async function readPool(who) {
  const v = contract("vault");
  const out = { stats: null, mine: null, owed: null };
  try { out.stats = await v.stats(); } catch (e) { }
  try { out.owed = await contract("floor").poolPnl(); } catch (e) { }
  if (who) {
    /* One call for shares, worth, cost basis, withdrawable and earnings.
       This used to be reconstructed by walking Deposit and Withdraw events,
       which meant log queries — and log queries against a public endpoint
       meant rate limits, partial answers and a page telling a funded
       depositor they had never deposited. */
    try { out.mine = await v.positionOf(who); } catch (e) { }
  }
  return out;
}

/**
 * A trader's closed-trade history, in two calls against the desk.
 *
 * This used to be assembled by walking Opened and Closed events, which meant
 * log queries — and log queries against a public endpoint get rate limited
 * into silence. The failure was not an error message; it was an empty table
 * and a page telling someone confidently that they had never closed a
 * position. The contract keeps the tally now, so a bad connection produces a
 * visible failure rather than a plausible lie.
 */
export async function readHistory(who) {
  if (!who) return { stats: null, trades: [], error: null };
  const fl = contract("floor");
  try {
    const [closed, net, fees, wins] = await fl.tradeStats(who);
    const raw = await fl.recentTrades(who);
    return {
      stats: { closed: Number(closed), net, fees, wins: Number(wins) },
      trades: raw.map(t => ({
        market: Number(t.marketId), isLong: t.isLong,
        at: Number(t.closedAt), size: t.size,
        entry: t.entryPrice, exit: t.exitPrice, net: t.net,
      })),
      error: null,
    };
  } catch (e) {
    // Reported rather than swallowed. An empty history and an unreadable one
    // are different answers and must not render the same.
    return { stats: null, trades: [], error: e.shortMessage || e.message };
  }
}

/**
 * Candles from the feeder, already bucketed.
 *
 * Bucketing server-side means two windows cannot disagree about the same
 * chart, which they can when each one buckets raw prints against its own
 * clock.
 */
export async function fetchCandles(marketId, tf, limit = 1500) {
  const url = `${FEED}/candles?market=${marketId}&tf=${tf}&limit=${limit}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("feeder returned " + r.status);
    const j = await r.json();
    return { candles: j.candles || [], since: j.since, error: null };
  } catch (e) {
    // Reported rather than swallowed: an empty chart and an unreachable
    // feeder are different problems and must not look the same.
    return { candles: [], since: null, error: e.name === "AbortError"
      ? "the feeder did not answer in time" : e.message };
  } finally { clearTimeout(timer); }
}

export async function readChips(who) {
  if (!who) return 0n;
  try { return await contract("chips").balanceOf(who); } catch (e) { return 0n; }
}

export async function isOwner(who) {
  if (!who) return null;
  try {
    const o = await contract("engine").owner();
    return o.toLowerCase() === who.toLowerCase();
  } catch (e) {
    // Unreadable is not the same as "no". Callers must be able to tell.
    return null;
  }
}

// ── wallet ────────────────────────────────────────────────────────────

/**
 * eth_accounts returns an already-authorised address with no prompt, so a
 * wallet approved once reconnects silently. eth_requestAccounts is only for
 * the first time, when a prompt is the right thing.
 */
export async function connect(prompt) {
  if (!window.ethereum) throw new Error("No wallet found.");
  let p = new E.BrowserProvider(window.ethereum);
  const have = await p.send("eth_accounts", []);
  if (!have.length) {
    if (!prompt) return null;
    await p.send("eth_requestAccounts", []);
  }

  if (Number((await p.getNetwork()).chainId) !== CHAIN) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }],
      });
    } catch (sw) {
      if (sw.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: CHAIN_HEX, chainName: "Arc Network Testnet",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: [RPCS[0]], blockExplorerUrls: [SCAN],
          }],
        });
      } else throw sw;
    }
    p = new E.BrowserProvider(window.ethereum);
  }

  const signer = await p.getSigner();
  return { provider: p, signer, address: await signer.getAddress() };
}

// ── formatting ────────────────────────────────────────────────────────

/* Two decimals is right for BTC and useless for XRP: a market trading near a
   dollar renders every price, every axis label and every entry as the same
   "1.01", so a chart full of movement reads as a flat line. */
export function dp(v) {
  const a = Math.abs(Number(v));
  if (!isFinite(a) || a === 0) return 2;
  if (a < 0.1) return 6;
  if (a < 1)   return 5;
  if (a < 10)  return 4;
  return 2;
}

export function money(v, places) {
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const d = places !== undefined ? places : dp(n);
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Formats an on-chain amount. Prices get precision by size; collateral
    stays at two places, because pool depth does not need six. */
export function fmt(v, decimals, places) {
  const n = Number(E.formatUnits(v, decimals));
  const d = places !== undefined ? places : (decimals === 18 ? dp(n) : 2);
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function dur(sec) {
  if (!isFinite(sec) || sec <= 0) return "";
  const m = Math.round(sec / 60);
  if (m < 90) return m + "m";
  const h = sec / 3600;
  if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + "h";
  return Math.round(h / 24) + "d";
}

export const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
export const num = (v, d) => Number(E.formatUnits(v, d));
