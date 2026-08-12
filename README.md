# The Pit

A pool-backed perpetuals desk on Arc testnet (chain 5042002).
Nine markets, no order book, no token.

Live at **[pittrades.com](https://pittrades.com)**.

Open outcry ran on a stepped octagon, and it worked because there was always
somebody on the other side. There is nobody here. A pool of deposited capital
is counterparty to every position: traders who win are paid out of it, traders
who lose pay into it. Depositors are, collectively, the house.

---

## Contracts

Arc testnet, chain 5042002. Gas is real testnet USDC.

| | Address | Job |
|---|---|---|
| **PriceEngine** | `0xFC3B06a7c12E52D14BE7762800863619Aea533aB` | Publishes prices. Halts a market when the feed goes stale or the session closes. |
| **Ballast2** | `0xEbca733Cc8b2d968C46d1B506718Df7D174E1c07` | The pool. ERC-4626 vault, counterparty to every position. |
| **Floorplan3** | `0xc0A8A08638aEFd0d39c2ad2e775c6DF490d9676B` | The desk. Opens, funds, closes and liquidates positions against the pool. |
| **Chips** | `0x207A26e236520b41e98098dCd656D453CDA931d6` | Test collateral. Six decimals, open mint, worthless by design. |
| Feeder wallet | `0xd7F6163A44735bA651533A9457D8d4147d4cd8C1` | Publishes prices and runs the keeper. |

`Floorplan3` needs `viaIR: true` to compile — it is past the legacy pipeline's
stack limit. Use `Floorplan3.standard-input.json` for verification; it carries
the exact settings.

---

## Markets

| id | Market | Feed | Sessions |
|---|---|---|---|
| 1 | ETH | Coinbase + Kraken | 24/7 |
| 2 | BTC | Coinbase + Kraken | 24/7 |
| 8 | SOL | Coinbase + Kraken | 24/7 |
| 9 | XRP | Coinbase + Kraken | 24/7 |
| 7 | GOLD | Coinbase + Kraken (PAXG) | 24/7 |
| 3 | US30 | Yahoo `YM=F` | Sun 18:00 to Fri 17:00 ET |
| 4 | SPX | Yahoo `ES=F` | same |
| 5 | NAS | Yahoo `NQ=F` | same |
| 6 | WTI | Yahoo `CL=F` | same |

Gold is PAXG rather than the GC futures contract, which makes it real-time and
cross-checked instead of delayed and single-source. That is a better feed, and
it is why the metal trades around the clock here.

---

## How it works

**No book, no matching.** Prices come from an oracle. Size is available at the
mark until the pool runs out of room to honour it.

**Profit is capped at half your size**, and exactly that amount is reserved in
the pool the moment you open, so a winner is always payable. The cost is that
a runner stops earning past the cap. A pool that promises unbounded payouts
cannot reserve against them, and an unreserved promise is the one that breaks.

**Funding goes to the pool**, because the pool is the other side. When longs
outweigh shorts the pool is net short and collects from longs directly. Set to
1%/hr at full skew — at the 0.24%/day it launched with, nobody who was right
by 5% would have noticed it.

**Open positions pay borrow**, scaled to how much of the pool is committed.
Funding nets to nothing on a balanced book and fees only arrive when someone
trades; the borrow fee is what pays the pool for carrying risk in between.

**A stale feed shuts the desk.** A price older than five minutes stops counting
as a price. A dead feeder closes the floor rather than settling anyone against
an old print.

**Stops live on chain.** A front end cannot close your position for you, so
stop losses and take profits are stored with the position. Anyone may execute
a crossed trigger and takes 0.05% of size for it — that reward is what makes
them get serviced rather than merely permitted.

---

## What it will not do

**A stop fills where the oracle is, not where you set it.** Price gapping
through a stop fills past it, and that difference is yours. Paying out at the
trigger would put the gap on the pool, and depositors did not agree to cover
the worst moment of someone else's trade.

**A halted market traps a position.** Closing needs a live price, because
settling against a stale one robs whichever side the staleness favours. Margin
can still be added, so a position can be defended through a closure even when
it cannot be exited. A weekend gap on an index settles on the reopen.

**Four markets run on delayed, unchecked data.** US30, SPX, NAS and WTI come
from a single free source, typically ten to fifteen minutes behind. Anyone
holding a real-time terminal knows where they are before this desk does.
Academic on a testnet; disqualifying anywhere real.

**Fees are 0.1% each way on size, not margin.** A 1,000-size trade costs 2 CHIP
round trip regardless of leverage, so small moves are not tradeable. A 19-cent
win on ETH at that size is still a 19-dollar loss after costs.

**The money is not money.** Collateral is a test token anyone can mint, on a
testnet, worthless on purpose.

---

## Things that went wrong, and what changed

**A position became permanently unclosable.** The first version tracked the
same reserved capital twice — once in the desk, once in the pool — and payouts
moved one without the other. Once they disagreed, `release()` reverted and
`close()` with it. Liquidation unwinds through the same path, so the position
could not be liquidated either. A live BTC trade hit it: the pool held
483.879140 reserved while the desk tried to release 500. Its margin is still
in the old contract.

The pool is now the only counter that decides anything. `releaseUpTo()` clamps
inside the vault and cannot revert for underflow, and `payout()` pays what it
holds rather than reverting when short — a close that cannot pay is a close
that cannot happen, which is the same trap by another route.

**Two counters for one quantity is a bug unless something enforces they match.**
Nothing did. `reservesim.js` reproduces the failure on v1 — 4,310 stuck out of
48,000 closes — and shows zero on v2.

**The vault ships with all three defences from the start**: virtual shares via
a decimals offset, dead shares locked at deploy, and a withdrawal floor.
`vaultsim.js` puts 100,000 CHIP through an inflation attack for a 0.0001
return.

---

## Repository

```
index.html   landing page
trade.html   the whole app - Trade / Portfolio / Setup
.nojekyll    empty, stops Jekyll interpreting the templates
```

Three pages became one because each kept its own copy of the addresses and
ABIs, and those copies drifted. The setup page spent an afternoon decoding a
new contract with an old tuple, showing equity in the quadrillions, while the
trade page read the same contract correctly.

### Feeder (Railway)

```
index.js     price publisher, nine markets
keeper.js    liquidations and trigger execution
package.json
```

| Variable | |
|---|---|
| `PRIVATE_KEY` | must be an authorised pusher |
| `FLOORPLAN` | desk address, for the keeper |
| `PUSH_SECONDS` | default 30 |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | optional alerts |

The feeder refuses to start if the key is not an authorised pusher, a market
is not listed, there is no gas, or the push interval leaves less than three
pushes of headroom against the staleness window. Failing at boot beats failing
at three in the morning.

**Two sources must agree** on the crypto markets, within 100 bps, or nothing is
published and the desk goes quiet. A single source is exactly the failure the
second one exists to catch.

**It predicts the deviation breaker rather than reacting to it.** Arc's public
RPCs return no revert data, so a rejected push is indistinguishable from any
other failure. The feeder runs the contract's own arithmetic first and never
sends a push that would be refused.

---

## Simulations

Not tests against a deployed contract — ports of the contract maths, run
against adversarial inputs.

| | |
|---|---|
| `vaultsim.js` | inflation attack, supply floor, reserved capital |
| `perpsim.js` | aggregate PnL exactness, payout bounds, funding clamp |
| `reservesim.js` | reproduces the stuck-position bug and its fix |
| `activesim.js` | active-market set under random churn |
| `trigsim.js` | trigger direction, partial close, slippage |

---

Testnet only. Nothing here is an investment, an offer, or a promise.
