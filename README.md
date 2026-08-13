The Pit

A pool-backed perpetuals desk on Arc testnet (chain 5042002). Nine markets, no order book, no token.

Live at pittrades.com.

Open outcry ran on a stepped octagon, and it worked because there was always somebody on the other side. There is nobody here. A pool of deposited capital is counterparty to every position: traders who win are paid out of it, traders who lose pay into it. Depositors are, collectively, the house.

Contracts

Arc testnet, chain 5042002. Gas is testnet USDC.

	Address	Job
PriceEngine	0xFC3B06a7c12E52D14BE7762800863619Aea533aB	Publishes prices. Halts a market when the feed goes stale or the session closes.
Ballast	0x8AE1D9c982DE72fDb9039d4bea296ed3a8ea355c	The pool. ERC-4626 vault, counterparty to every position.
Floorplan	0x6dD48Fc5C03ad3B1D1DBD44E776Cb0BbDA372DE1	The desk. Opens, funds, closes and liquidates positions against the pool.
Chips	0x207A26e236520b41e98098dCd656D453CDA931d6	Test collateral. Six decimals, open mint, worthless by design.
Feeder wallet	0xd7F6163A44735bA651533A9457D8d4147d4cd8C1	Publishes prices and runs the keeper.

Floorplan needs via_ir = true — it is past the legacy pipeline's stack limit. That is set in foundry.toml rather than passed on the command line, so verification uses the same settings the tests ran under.

Markets
id	Market	Feed	Sessions
1	ETH	Coinbase + Kraken	24/7
2	BTC	Coinbase + Kraken	24/7
8	SOL	Coinbase + Kraken	24/7
9	XRP	Coinbase + Kraken	24/7
7	GOLD	Coinbase + Kraken (PAXG)	24/7
3	US30	Yahoo YM=F	Sun 18:00 to Fri 17:00 ET
4	SPX	Yahoo ES=F	same
5	NAS	Yahoo NQ=F	same
6	WTI	Yahoo CL=F	same

Gold is PAXG rather than the GC futures contract, which makes it real-time and cross-checked instead of delayed and single-source. That is a better feed, and it is why the metal trades around the clock here.

How it works

No book, no matching. Prices come from an oracle. Size is available at the mark until the pool runs out of room to honour it.

Profit is capped at half your size, and exactly that amount is reserved in the pool the moment you open, so a winner is always payable. The cost is that a runner stops earning past the cap. A pool that promises unbounded payouts cannot reserve against them, and an unreserved promise is the one that breaks.

Funding goes to the pool, because the pool is the other side. When longs outweigh shorts the pool is net short and collects from longs directly. Set to 1%/hr at full skew — at the 0.24%/day it launched with, nobody who was right by 5% would have noticed it.

Open positions pay borrow, scaled to how much of the pool is committed. Funding nets to nothing on a balanced book and fees only arrive when someone trades; the borrow fee is what pays the pool for carrying risk in between.

A stale feed shuts the desk. A price older than five minutes stops counting as a price. A dead feeder closes the floor rather than settling anyone against an old print.

Stops live on chain. A front end cannot close your position for you, so stop losses and take profits are stored with the position. Anyone may execute a crossed trigger and takes 0.05% of size for it — that reward is what makes them get serviced rather than merely permitted.

Cost basis is stored, not reconstructed. The vault records what each account has put in and taken out, so a depositor's return is one call. It used to be rebuilt by walking Deposit and Withdraw events, which meant log queries, which meant rate limits, partial answers, and a page telling a funded depositor they had never deposited.

What it will not do

A stop fills where the oracle is, not where you set it. Price gapping through a stop fills past it, and that difference is yours. Paying out at the trigger would put the gap on the pool, and depositors did not agree to cover the worst moment of someone else's trade.

A halted market traps a position. Closing needs a live price, because settling against a stale one robs whichever side the staleness favours. Margin can still be added, so a position can be defended through a closure even when it cannot be exited. A weekend gap on an index settles on the reopen.

Four markets run on delayed, unchecked data. US30, SPX, NAS and WTI come from a single free source, typically ten to fifteen minutes behind. Anyone holding a real-time terminal knows where they are before this desk does. Academic on a testnet; disqualifying anywhere real.

Fees are 0.1% each way on size, not margin. A 1,000-size trade costs 2 CHIP round trip regardless of leverage, so small moves are not tradeable. A 19-cent win on ETH at that size is still a 19-dollar loss after costs.

The money is not money. Collateral is a test token anyone can mint, on a testnet, worthless on purpose.

Four bugs that reached a live desk

All four were found by Foundry tests written after the fact. The hand-rolled JavaScript simulations they replaced had all passed, because they tested a reading of the contracts rather than the contracts.

A partial close silently destroyed the remainder. Closing 4,000 of a 10,000 position left a position of size zero — the other 6,000 simply gone. The cause was Position memory slice = p, which in Solidity copies the reference rather than the contents, so setting slice.size overwrote p.size and the remainder computed as 4,000 − 4,000.

No invariant caught this. The position still closed, collateral stayed conserved, the pool stayed solvent. It took a test asserting the remainder was specifically 6,000. That is the argument for writing both kinds.

positionView reverted on any settled position. _liqPrice divides by position size, and a closed position has none. From a front end this reads exactly like an RPC failure, and an afternoon went into blaming endpoints for it.

Reported liability ran ahead of the reservation, twice. First because unrealised profit was uncapped while payouts are capped, so the vault marked itself down against money it could never be asked for. Then, after that fix, because releaseUpTo clamps to the vault's balance — a close can free less than the position reserved while still removing its full size from the running totals, so the reservation trails the open interest. poolPnl now clamps to what the pool actually holds, which is the honest ceiling: it is all a winner can be paid from.

An earlier position became permanently unclosable. Reserved capital was tracked in two places — the desk and the pool — and payouts moved one without the other. Once they disagreed, release() reverted and close() with it, and because liquidation unwinds through the same path it could not be liquidated either. A live BTC trade hit it: the pool held 483.879140 reserved while the desk tried to release 500.

Two counters for one quantity is a bug unless something enforces they match. Nothing did.

Tests
cd contracts
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts
cd lib/openzeppelin-contracts && git checkout v5.0.2 && cd ../..
forge test -vv

31 tests, all passing. The invariants are the ones that matter — a handler opens, closes, partially closes, deposits, withdraws, moves prices and liquidates in whatever order the fuzzer picks, across 16,384 calls each.

	
invariant_everyPositionCanClose	every open position is closable by its owner right now
invariant_poolNeverOwesMoreThanItReserved	unrealised liability never exceeds what was set aside
invariant_collateralIsConserved	trading moves collateral, never creates it
invariant_supplyFloorHolds	share supply never falls through the dead-share floor
invariant_reservedIsNeverWithdrawable	reserved capital is never offered for withdrawal
invariant_noReserveWithoutOpenInterest	nothing stays reserved once nothing is open

Reserve.t.sol is a regression suite for the unclosable-position bug, written in the shape that caused it.

Repository
Frontend
index.html      landing page
app.html        the terminal
pit.js          addresses, ABIs, provider, every chain read
pit-chart.js    the chart, on TradingView's Lightweight Charts
pit-draw.js     drawing tools as an overlay
pit-ui.js       panels and rendering
.nojekyll

Split by layer rather than by page. One 90KB file meant every change risked the whole app; three pages meant three copies of the addresses drifting apart, and one of them spent an afternoon decoding a new contract with an old tuple while another read it correctly. One copy of each address, and no file large enough to be dangerous.

Drawings store their anchors in time and price rather than pixels, so a level drawn on 5m is the same level on 1h and survives zoom, pan and new candles.

Contracts
src/            PriceEngine, Ballast, Floorplan, Chips
test/           Base, Reserve, Vault, Perp, Invariant
script/         Deploy
foundry.toml
Feeder (Railway)
index.js     price publisher, nine markets
keeper.js    liquidations and trigger execution
package.json
Variable	
PRIVATE_KEY	the feeder key, which must be an authorised pusher
FLOORPLAN	desk address, for the keeper
PUSH_SECONDS	default 30
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID	optional alerts

The feeder refuses to start if the key is not an authorised pusher, a market is not listed, there is no gas, or the push interval leaves less than three pushes of headroom against the staleness window. Failing at boot beats failing at three in the morning.

Two sources must agree on the crypto markets, within 100 bps, or nothing is published and the desk goes quiet. A single source is exactly the failure the second one exists to catch.

It predicts the deviation breaker rather than reacting to it. Arc's public RPCs return no revert data, so a rejected push is indistinguishable from any other failure. The feeder runs the contract's own arithmetic first and never sends a push that would be refused.

Testnet only. Nothing here is an investment, an offer, or a promise.
