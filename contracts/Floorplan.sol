// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20}    from "@openzeppelin/contracts@5.0.2/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/utils/SafeERC20.sol";

interface IPriceEngine {
    enum Status { OK, NOT_LISTED, PAUSED, NO_PRICE, STALE, OUTSIDE_SESSION }
    function getPrice(uint256 id) external view returns (uint256);
    function peek(uint256 id) external view
        returns (uint256 value, uint64 updatedAt, uint64 roundId, Status s);
    function markets(uint256 id) external view returns (
        bool listed, bool paused, bool hasSessions,
        uint16 maxLeverageX, uint16 maxDeviationBps, uint32 maxStaleness,
        uint32 fundingFactor, uint32 maxFundingBps, uint128 maxOpenInterest,
        string memory symbol
    );
}

interface IBallast {
    function reserve(uint256 amount) external;
    function release(uint256 amount) external;
    function payout(address to, uint256 amount) external;
    function idleAssets() external view returns (uint256);
}

/**
 * Floorplan — the perp engine
 *
 * Traders open against Ballast, which is the counterparty for every
 * position on the desk. There is no book and no matching: a trader who
 * wins is paid by the pool, a trader who loses pays into it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHERE THE MONEY SITS
 *
 * Trader margin is held here. Pool capital is held in Ballast. They are
 * never commingled, because the vault's share price is computed from its
 * own balance and margin belonging to traders would inflate it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PROFIT IS CAPPED, AND THAT IS NOT A DETAIL
 *
 * A long's profit is unbounded in principle — price can go anywhere. A
 * pool that promises unbounded payouts cannot reserve against them, and a
 * promise with nothing set aside is the thing that breaks when it is
 * finally called on.
 *
 * So profit is capped at maxProfitBps of position size, and exactly that
 * amount is reserved in the vault at open. By the time a winner closes,
 * the money was already committed and could not have been withdrawn out
 * from under them. The trade-off is real and it is stated in the UI: a
 * position that runs past the cap stops earning.
 *
 * ─────────────────────────────────────────────────────────────────────
 * HOW poolPnl() STAYS CHEAP
 *
 * Ballast reads total trader PnL on every share-price calculation, so it
 * cannot iterate positions. Instead each market keeps two running sums:
 * total size, and total size-divided-by-entry-price. Unrealised PnL for a
 * whole side then falls out of two multiplications regardless of how many
 * positions are open:
 *
 *     longPnl  =  price * Σ(size/entry)  −  Σ(size)
 *     shortPnl =  Σ(size)  −  price * Σ(size/entry)
 *
 * This is exact, not an average-entry approximation.
 *
 * ─────────────────────────────────────────────────────────────────────
 * FUNDING GOES TO THE POOL, BECAUSE THE POOL IS THE OTHER SIDE
 *
 * On a book, funding moves between longs and shorts. Here the pool is
 * counterparty to everyone, so when longs outweigh shorts the pool is net
 * short and collects from longs directly. Same economics, no distribution
 * machinery.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CLOSING NEEDS A LIVE PRICE
 *
 * You cannot exit a market the engine has halted, including US30 outside
 * its session. That is not an oversight — settling a position against a
 * stale or absent price is how one side gets robbed. Margin can always be
 * added, so a position can be defended through a closure even when it
 * cannot be exited.
 */
contract Floorplan {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error ZeroAddress();
    error AlreadySet();
    error Paused();
    error BadParam();
    error MarketNotListed();
    error SizeTooSmall(uint256 size, uint256 min);
    error LeverageTooHigh(uint256 x, uint256 max);
    error OpenInterestCapped(uint256 want, uint256 cap);
    error PoolTooThin(uint256 need, uint256 idle);
    error NoPosition();
    error NotYours();
    error NotLiquidatable(int256 equity, uint256 maintenance);
    error StillHealthy();
    error Reentrant();

    // ------------------------------------------------------------- constants

    uint256 public constant BPS   = 10_000;
    uint256 private constant SCALE = 1e30;  // precision for Σ(size/entry)
    uint256 private constant HOUR  = 3600;
    uint256 private constant PRICE_ONE = 1e18;

    // ----------------------------------------------------------------- types

    struct Position {
        address owner;
        uint32  marketId;
        bool    isLong;
        uint64  openedAt;
        uint128 size;         // notional, collateral units
        uint128 margin;       // collateral units
        uint128 entryPrice;   // 18 decimals
        int256  entryFunding; // cumulative funding index at open
    }

    struct MarketState {
        uint128 longSize;
        uint128 shortSize;
        uint256 longOverEntry;   // Σ(size * SCALE / entry)
        uint256 shortOverEntry;
        int256  cumFunding;      // 1e18-scaled, signed; + means longs have paid
        uint64  lastFundingAt;
        uint128 reserved;        // reserved in Ballast against this market
    }

    // ----------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;
    bool    public paused;

    IERC20      public immutable collateral;
    IPriceEngine public immutable engine;
    IBallast    public ballast;

    uint256 public openFeeBps      = 10;    // 0.10% of size
    uint256 public closeFeeBps     = 10;
    uint256 public maintenanceBps  = 100;   // 1% of size
    uint256 public liqRewardBps    = 500;   // 5% of remaining margin
    uint256 public maxProfitBps    = 5_000; // 50% of size, and the reserve
    uint256 public minSize         = 10e6;  // 10 collateral units

    uint256 public nextId = 1;
    mapping(uint256 => Position)    public positions;
    mapping(uint256 => MarketState) public marketState;
    mapping(address => uint256[])   private _byOwner;

    uint256 private _lock;

    // ---------------------------------------------------------------- events

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event BallastSet(address indexed ballast);
    event PausedSet(bool paused);
    event ParamsSet(uint256 openFee, uint256 closeFee, uint256 maint, uint256 liqReward, uint256 maxProfit, uint256 minSize);

    event Opened(uint256 indexed id, address indexed trader, uint256 indexed marketId,
                 bool isLong, uint256 size, uint256 margin, uint256 entryPrice, uint256 fee);
    event Closed(uint256 indexed id, address indexed trader, uint256 exitPrice,
                 int256 pnl, int256 funding, uint256 fee, uint256 returned);
    event Liquidated(uint256 indexed id, address indexed trader, address indexed keeper,
                     uint256 exitPrice, uint256 reward, uint256 toPool);
    event MarginAdded(uint256 indexed id, uint256 amount, uint256 newMargin);
    event FundingAccrued(uint256 indexed marketId, int256 cumFunding, int256 hourlyRate);

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier live()      { if (paused) revert Paused(); _; }
    modifier guard()     {
        if (_lock == 1) revert Reentrant();
        _lock = 1; _; _lock = 0;
    }

    // ----------------------------------------------------------- constructor

    constructor(IERC20 collateral_, IPriceEngine engine_) {
        if (address(collateral_) == address(0) || address(engine_) == address(0)) revert ZeroAddress();
        owner      = msg.sender;
        collateral = collateral_;
        engine     = engine_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------- ownership

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(msg.sender, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address prev = owner;
        owner = msg.sender; pendingOwner = address(0);
        emit OwnershipTransferred(prev, msg.sender);
    }

    /// @dev Set once. This contract can pull payouts out of the vault, so a
    ///      swappable pointer would let the owner redirect trader money.
    function setBallast(address b) external onlyOwner {
        if (address(ballast) != address(0)) revert AlreadySet();
        if (b == address(0)) revert ZeroAddress();
        ballast = IBallast(b);
        emit BallastSet(b);
    }

    function setPaused(bool v) external onlyOwner {
        paused = v;
        emit PausedSet(v);
    }

    function setParams(
        uint256 openFee_, uint256 closeFee_, uint256 maint_,
        uint256 liqReward_, uint256 maxProfit_, uint256 minSize_
    ) external onlyOwner {
        // Fees above a couple of percent, or a maintenance floor above the
        // initial margin at max leverage, would make positions unopenable
        // or instantly liquidatable. Refuse the configuration rather than
        // discover it with real money in the contract.
        if (openFee_ > 200 || closeFee_ > 200) revert BadParam();
        if (maint_ == 0 || maint_ > 2_000)     revert BadParam();
        if (liqReward_ > 5_000)                revert BadParam();
        if (maxProfit_ == 0 || maxProfit_ > 50_000) revert BadParam();
        if (minSize_ == 0)                     revert BadParam();

        openFeeBps = openFee_; closeFeeBps = closeFee_; maintenanceBps = maint_;
        liqRewardBps = liqReward_; maxProfitBps = maxProfit_; minSize = minSize_;
        emit ParamsSet(openFee_, closeFee_, maint_, liqReward_, maxProfit_, minSize_);
    }

    // ---------------------------------------------------------------- funding

    /**
     * Advances the funding index for a market. Called before every size
     * change so that everyone accrues at the rate that applied while their
     * position was actually open, not the rate at the moment they closed.
     */
    function poke(uint256 marketId) public {
        MarketState storage m = marketState[marketId];
        uint64 nowTs = uint64(block.timestamp);

        if (m.lastFundingAt == 0) { m.lastFundingAt = nowTs; return; }
        uint256 dt = nowTs - m.lastFundingAt;
        if (dt == 0) return;

        int256 rate = fundingRatePerHour(marketId);
        if (rate != 0) {
            m.cumFunding += rate * int256(dt) / int256(HOUR);
            emit FundingAccrued(marketId, m.cumFunding, rate);
        }
        m.lastFundingAt = nowTs;
    }

    /// @dev 1e18-scaled fraction of size charged per hour. Positive means
    ///      longs pay the pool; negative means the pool pays longs.
    function fundingRatePerHour(uint256 marketId) public view returns (int256) {
        MarketState storage m = marketState[marketId];
        uint256 total = uint256(m.longSize) + uint256(m.shortSize);
        if (total == 0) return 0;

        (,,,,,, uint32 fundingFactor, uint32 maxFundingBps_,,) = engine.markets(marketId);

        int256 skew = int256(uint256(m.longSize)) - int256(uint256(m.shortSize));
        // factor is 1e6-scaled: 100 => 0.01% per hour at full one-sided skew
        int256 rate = skew * int256(uint256(fundingFactor)) * int256(PRICE_ONE)
                    / int256(total) / int256(1e6);

        int256 cap = int256(uint256(maxFundingBps_) * PRICE_ONE / BPS);
        if (rate >  cap) rate =  cap;
        if (rate < -cap) rate = -cap;
        return rate;
    }

    // ------------------------------------------------------------- accounting

    /// @dev Unrealised PnL of one side of one market, using running sums so
    ///      the cost does not grow with the number of open positions.
    function marketPnl(uint256 marketId, uint256 price) public view returns (int256) {
        MarketState storage m = marketState[marketId];
        int256 pnl;
        if (m.longOverEntry != 0) {
            uint256 nowVal = price * m.longOverEntry / SCALE;
            pnl += int256(nowVal) - int256(uint256(m.longSize));
        }
        if (m.shortOverEntry != 0) {
            uint256 nowVal = price * m.shortOverEntry / SCALE;
            pnl += int256(uint256(m.shortSize)) - int256(nowVal);
        }
        return pnl;
    }

    /**
     * Total unrealised trader PnL across the desk. Positive means the pool
     * owes. Ballast calls this on every share-price read, so it must never
     * revert — a halted or stale market still has open positions with real
     * value, and refusing to price them would freeze the whole vault.
     * Liabilities are therefore estimated from the last known print even
     * when that print is too old to trade on.
     */
    function poolPnl() external view returns (int256 total) {
        for (uint256 id = 1; id <= 3; ++id) {
            MarketState storage m = marketState[id];
            if (m.longSize == 0 && m.shortSize == 0) continue;
            (uint256 px,,,) = engine.peek(id);
            if (px == 0) continue;
            total += marketPnl(id, px);
        }
    }

    // ------------------------------------------------------------------ open

    function open(uint256 marketId, bool isLong, uint256 size, uint256 margin)
        external
        live
        guard
        returns (uint256 id)
    {
        if (size < minSize) revert SizeTooSmall(size, minSize);
        if (margin == 0)    revert BadParam();

        (uint256 price, uint256 netMargin) = _admit(marketId, isLong, size, margin);

        poke(marketId);
        MarketState storage m = marketState[marketId];

        _commit(marketId, isLong, size, price);

        id = nextId++;
        positions[id] = Position({
            owner:        msg.sender,
            marketId:     uint32(marketId),
            isLong:       isLong,
            openedAt:     uint64(block.timestamp),
            size:         uint128(size),
            margin:       uint128(netMargin),
            entryPrice:   uint128(price),
            entryFunding: m.cumFunding
        });
        _byOwner[msg.sender].push(id);

        emit Opened(id, msg.sender, marketId, isLong, size, netMargin, price, size * openFeeBps / BPS);
    }

    /// @dev Every reason a position may not exist, checked before any money
    ///      moves. Split out of open() to keep that function's stack shallow.
    function _admit(uint256 marketId, bool isLong, uint256 size, uint256 margin)
        internal
        returns (uint256 price, uint256 netMargin)
    {
        (bool listed,,, uint16 maxLevX,,,,, uint128 maxOI,) = engine.markets(marketId);
        if (!listed) revert MarketNotListed();

        // Reverts unless the market is fully tradeable — stale, paused and
        // out-of-session all stop here rather than deeper in the maths.
        price = engine.getPrice(marketId);

        uint256 fee = size * openFeeBps / BPS;
        if (margin <= fee) revert BadParam();
        netMargin = margin - fee;

        uint256 lev = size / netMargin;
        if (lev > maxLevX || lev == 0) revert LeverageTooHigh(lev, maxLevX);

        MarketState storage m = marketState[marketId];
        uint256 sideAfter = isLong ? uint256(m.longSize) + size : uint256(m.shortSize) + size;
        if (sideAfter > maxOI) revert OpenInterestCapped(sideAfter, maxOI);

        // Set aside the most this position could ever be paid, before it is
        // allowed to exist.
        uint256 need = size * maxProfitBps / BPS;
        uint256 idle = ballast.idleAssets();
        if (need > idle) revert PoolTooThin(need, idle);

        collateral.safeTransferFrom(msg.sender, address(this), margin);
        // The open fee is pool revenue and goes straight to the LPs.
        if (fee > 0) collateral.safeTransfer(address(ballast), fee);
    }

    /// @dev Reserves against the pool and folds the position into the
    ///      running sums that poolPnl() reads.
    function _commit(uint256 marketId, bool isLong, uint256 size, uint256 price) internal {
        MarketState storage m = marketState[marketId];

        uint256 need = size * maxProfitBps / BPS;
        ballast.reserve(need);
        m.reserved += uint128(need);

        uint256 overEntry = size * SCALE / price;
        if (isLong) {
            m.longSize      += uint128(size);
            m.longOverEntry += overEntry;
        } else {
            m.shortSize      += uint128(size);
            m.shortOverEntry += overEntry;
        }
    }

    // ----------------------------------------------------------- add margin

    /// @dev Always available, including on a halted or closed market. A
    ///      trader who cannot exit must at least be able to defend.
    function addMargin(uint256 id, uint256 amount) external guard {
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        if (p.owner != msg.sender) revert NotYours();
        if (amount == 0) revert BadParam();

        collateral.safeTransferFrom(msg.sender, address(this), amount);
        p.margin += uint128(amount);
        emit MarginAdded(id, amount, p.margin);
    }

    // ----------------------------------------------------------------- close

    function close(uint256 id) external guard {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        if (p.owner != msg.sender) revert NotYours();

        uint256 price = engine.getPrice(p.marketId);
        poke(p.marketId);

        (int256 pnl, int256 funding, uint256 fee, int256 equity) = _settleMath(p, price);

        _unwind(id, p);

        uint256 returned;
        if (equity > 0) {
            uint256 held = uint256(p.margin);

            // The pool never pays more than it set aside for this position.
            // Price profit is already capped at maxProfitBps, but funding is
            // not bounded in time — a position held long enough while the
            // pool is paying could otherwise claim more than was reserved,
            // and the money would come out of capital other LPs were told
            // was theirs to withdraw.
            uint256 ceiling = held + (uint256(p.size) * maxProfitBps / BPS);
            returned = uint256(equity);
            if (returned > ceiling) returned = ceiling;

            if (returned > held) {
                // Trader is up: the excess comes out of the pool, drawn
                // against capital reserved when the position opened.
                uint256 fromPool = returned - held;
                collateral.safeTransfer(p.owner, held);
                ballast.payout(p.owner, fromPool);
            } else {
                // Trader is down but solvent: the shortfall stays behind.
                collateral.safeTransfer(p.owner, returned);
                uint256 toPool = held - returned;
                if (toPool > 0) collateral.safeTransfer(address(ballast), toPool);
            }
        } else {
            // Wiped out. Everything left goes to the LPs who carried it.
            if (p.margin > 0) collateral.safeTransfer(address(ballast), p.margin);
        }

        emit Closed(id, p.owner, price, pnl, funding, fee, returned);
    }

    // ------------------------------------------------------------ liquidate

    function liquidate(uint256 id) external guard {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NoPosition();

        uint256 price = engine.getPrice(p.marketId);
        poke(p.marketId);

        (,, , int256 equity) = _settleMath(p, price);
        uint256 maintenance = uint256(p.size) * maintenanceBps / BPS;
        if (equity > int256(maintenance)) revert NotLiquidatable(equity, maintenance);

        _unwind(id, p);

        uint256 left   = equity > 0 ? uint256(equity) : 0;
        if (left > uint256(p.margin)) left = uint256(p.margin);
        uint256 reward = left * liqRewardBps / BPS;
        uint256 toPool = uint256(p.margin) - reward;

        if (reward > 0) collateral.safeTransfer(msg.sender, reward);
        if (toPool > 0) collateral.safeTransfer(address(ballast), toPool);

        emit Liquidated(id, p.owner, msg.sender, price, reward, toPool);
    }

    // ------------------------------------------------------------- internals

    /// @dev Profit is capped at maxProfitBps of size — exactly the amount
    ///      reserved at open. Losses are not capped by anything except the
    ///      margin, which is all the trader can lose.
    function _settleMath(Position memory p, uint256 price)
        internal
        view
        returns (int256 pnl, int256 funding, uint256 fee, int256 equity)
    {
        int256 diff = int256(price) - int256(uint256(p.entryPrice));
        if (!p.isLong) diff = -diff;
        pnl = int256(uint256(p.size)) * diff / int256(uint256(p.entryPrice));

        int256 cap = int256(uint256(p.size) * maxProfitBps / BPS);
        if (pnl > cap) pnl = cap;

        MarketState storage m = marketState[p.marketId];
        int256 delta = int256(m.cumFunding) - int256(p.entryFunding);
        // Positive cumFunding means longs have been paying.
        funding = int256(uint256(p.size)) * delta / int256(PRICE_ONE);
        if (!p.isLong) funding = -funding;

        fee = uint256(p.size) * closeFeeBps / BPS;

        equity = int256(uint256(p.margin)) + pnl - funding - int256(fee);
    }

    /// @dev Removes a position from the running sums and releases its
    ///      reservation. Subtracting the same overEntry term that was added
    ///      at open keeps the sums exact rather than drifting.
    function _unwind(uint256 id, Position memory p) internal {
        MarketState storage m = marketState[p.marketId];
        uint256 overEntry = uint256(p.size) * SCALE / uint256(p.entryPrice);

        if (p.isLong) {
            m.longSize      -= p.size;
            m.longOverEntry  = m.longOverEntry > overEntry ? m.longOverEntry - overEntry : 0;
        } else {
            m.shortSize      -= p.size;
            m.shortOverEntry = m.shortOverEntry > overEntry ? m.shortOverEntry - overEntry : 0;
        }

        uint256 rel = uint256(p.size) * maxProfitBps / BPS;
        if (rel > m.reserved) rel = m.reserved;
        m.reserved -= uint128(rel);
        ballast.release(rel);

        delete positions[id];
    }

    // ----------------------------------------------------------------- views

    function positionsOf(address who) external view returns (uint256[] memory) {
        return _byOwner[who];
    }

    /// @dev Live view of one position. `liquidatable` is what a keeper polls
    ///      and what a UI shows as a red banner before it becomes one.
    function positionView(uint256 id)
        external
        view
        returns (
            Position memory p,
            uint256 price,
            int256  pnl,
            int256  funding,
            int256  equity,
            uint256 maintenance,
            uint256 liqPrice,
            bool    liquidatable
        )
    {
        p = positions[id];
        if (p.owner == address(0)) return (p,0,0,0,0,0,0,false);

        (price,,,) = engine.peek(p.marketId);
        if (price == 0) return (p,0,0,0,0,0,0,false);

        (pnl, funding,, equity) = _settleMath(p, price);
        maintenance  = uint256(p.size) * maintenanceBps / BPS;
        liquidatable = equity <= int256(maintenance);
        liqPrice     = _liqPrice(p, maintenance);
    }

    /// @dev The price at which equity falls to maintenance, ignoring future
    ///      funding. Shown as guidance, not a guarantee — funding keeps
    ///      accruing and moves this number over time.
    function _liqPrice(Position memory p, uint256 maintenance) internal view returns (uint256) {
        MarketState storage m = marketState[p.marketId];
        int256 delta   = int256(m.cumFunding) - int256(p.entryFunding);
        int256 funding = int256(uint256(p.size)) * delta / int256(PRICE_ONE);
        if (!p.isLong) funding = -funding;

        int256 fee     = int256(uint256(p.size) * closeFeeBps / BPS);
        int256 room    = int256(uint256(p.margin)) - funding - fee - int256(maintenance);
        // room = allowable loss before liquidation, in collateral units
        int256 move    = room * int256(uint256(p.entryPrice)) / int256(uint256(p.size));

        int256 liq = p.isLong
            ? int256(uint256(p.entryPrice)) - move
            : int256(uint256(p.entryPrice)) + move;
        return liq < 0 ? 0 : uint256(liq);
    }

    function marketView(uint256 marketId)
        external
        view
        returns (
            uint256 longSize, uint256 shortSize, int256 skew,
            int256 fundingHourly, int256 cumFunding,
            uint256 reserved, uint256 price, uint8 status
        )
    {
        MarketState storage m = marketState[marketId];
        longSize  = m.longSize;
        shortSize = m.shortSize;
        skew      = int256(longSize) - int256(shortSize);
        fundingHourly = fundingRatePerHour(marketId);
        cumFunding    = m.cumFunding;
        reserved      = m.reserved;
        IPriceEngine.Status s;
        (price,,, s) = engine.peek(marketId);
        status = uint8(s);
    }
}
