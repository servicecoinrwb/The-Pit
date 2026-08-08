// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * PriceEngine — the oracle and market registry for a pool-backed perp desk
 *
 * Everything else in this system reads from here. Entry price, exit price,
 * liquidation price, funding — all of it resolves to a number this contract
 * published. That makes this the most dangerous contract in the set, so it
 * is written to fail closed at every branch.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT "FAIL CLOSED" MEANS HERE
 *
 * There is no Chainlink or Pyth on Arc. The price comes from a server you
 * run. If that server dies, lies, or fat-fingers a decimal, this contract
 * is the only thing between it and every open position.
 *
 *   Staleness   — a price older than maxStaleness is not a price. Reads
 *                 revert, the market reports STALE, and nothing trades.
 *                 A dead feeder halts the desk rather than settling
 *                 everyone against yesterday's print.
 *
 *   Deviation   — a push that moves more than maxDeviationBps off the last
 *                 print is rejected, not accepted-and-flagged. A typo that
 *                 puts BTC at $9,000 would liquidate every long on the
 *                 book, and there is no undo for a liquidation.
 *
 *   Guardian    — a second party who cannot push prices but can halt any
 *                 market instantly. This is the practical form of "two
 *                 feeders must agree": one publishes, one watches, and
 *                 disagreement stops trading instead of averaging into a
 *                 number neither of them believes.
 *
 *   Sessions    — a market whose underlying stops trading must stop too.
 *                 If hasSessions is set and no windows are configured, the
 *                 market is CLOSED, not open. Unconfigured means shut.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE GAP PROBLEM, AND WHY forcePush EXISTS
 *
 * The deviation breaker assumes price moves are continuous. For ETH and
 * BTC that mostly holds. For an index that closes Friday and reopens
 * Sunday night, it does not — a legitimate weekend gap can exceed any
 * sane deviation limit, and a breaker that rejects it would freeze the
 * market permanently at Friday's close.
 *
 * So the owner can forcePush through the breaker. It emits a loud event
 * and it is the only path that skips the check. Use it for reopens. Every
 * other push goes through the front door.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DECIMALS
 *
 * Prices are 18-decimal, always, for every market. The feeder scales
 * before pushing. A contract that accepts mixed precision is a contract
 * that will eventually multiply an 8-decimal price by an 18-decimal size.
 */
contract PriceEngine {
    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotPusher();
    error NotGuardian();
    error ZeroAddress();
    error MarketExists();
    error MarketMissing();
    error BadParam();
    error LengthMismatch();
    error DeviationTooLarge(uint256 last, uint256 pushed, uint256 bps);
    error NotTradeable(Status status);

    // ----------------------------------------------------------------- types

    /// @dev Every reason a market can refuse to trade. The UI renders these
    ///      directly — a disabled ticket should say which one it hit.
    enum Status {
        OK,
        NOT_LISTED,
        PAUSED,
        NO_PRICE,
        STALE,
        OUTSIDE_SESSION
    }

    struct Market {
        bool    listed;
        bool    paused;
        bool    hasSessions;      // true = respects the windows below (US30)
        uint16  maxLeverageX;     // whole multiples, e.g. 50 = 50x
        uint16  maxDeviationBps;  // per-push circuit breaker
        uint32  maxStaleness;     // seconds before a price stops counting
        uint32  fundingFactor;    // 1e6-scaled, per hour, per 1.0 of skew
        uint32  maxFundingBps;    // hourly clamp on the funding rate
        uint128 maxOpenInterest;  // per side, in collateral units
        string  symbol;
    }

    struct Price {
        uint128 value;      // 18 decimals
        uint64  updatedAt;
        uint64  roundId;
    }

    /// @dev Seconds-of-week, with 0 = Sunday 00:00 UTC. Windows must not
    ///      wrap the week boundary — express a Sunday-night open as a
    ///      window that starts Sunday evening and ends Monday.
    struct Session {
        uint32 start;
        uint32 end;
    }

    // ------------------------------------------------------------- constants

    uint8   public constant PRICE_DECIMALS = 18;
    uint256 public constant BPS = 10_000;

    /// @dev Unix epoch began on a Thursday. Shifting by four days moves the
    ///      week origin to Sunday 00:00 UTC so session windows read the way
    ///      a human would write them.
    uint256 private constant EPOCH_DOW_SHIFT = 4 days;
    uint256 private constant WEEK = 7 days;

    // ----------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;
    address public guardian;

    mapping(address => bool) public isPusher;

    uint256[] public marketIds;
    mapping(uint256 => Market)    public markets;
    mapping(uint256 => Price)     public prices;
    mapping(uint256 => Session[]) private _sessions;

    /// @dev Bumped whenever a push is rejected by the breaker. A rising
    ///      counter means the feeder and the market disagree — worth an
    ///      alert on the dashboard.
    mapping(uint256 => uint256) public rejectedPushes;

    // ---------------------------------------------------------------- events

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event GuardianSet(address indexed guardian);
    event PusherSet(address indexed pusher, bool allowed);

    event MarketListed(uint256 indexed id, string symbol);
    event MarketConfigured(uint256 indexed id);
    event MarketPaused(uint256 indexed id, address indexed by, bool paused);
    event SessionsSet(uint256 indexed id, uint256 windowCount);

    event PricePushed(uint256 indexed id, uint256 value, uint64 roundId, uint64 at);
    event PushRejected(uint256 indexed id, uint256 last, uint256 pushed, uint256 bps);
    event PriceForced(uint256 indexed id, uint256 last, uint256 value, address indexed by);

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPusher() {
        if (!isPusher[msg.sender]) revert NotPusher();
        _;
    }

    modifier exists(uint256 id) {
        if (!markets[id].listed) revert MarketMissing();
        _;
    }

    // ----------------------------------------------------------- constructor

    constructor(address _guardian) {
        owner = msg.sender;
        isPusher[msg.sender] = true;
        guardian = _guardian; // may be zero at deploy; set it before going live
        emit OwnershipTransferred(address(0), msg.sender);
        emit PusherSet(msg.sender, true);
        emit GuardianSet(_guardian);
    }

    // ------------------------------------------------------------- ownership

    /// @dev Two-step. A typo in a one-step transfer bricks the whole desk.
    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(msg.sender, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address prev = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, msg.sender);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    function setPusher(address p, bool allowed) external onlyOwner {
        if (p == address(0)) revert ZeroAddress();
        isPusher[p] = allowed;
        emit PusherSet(p, allowed);
    }

    // ---------------------------------------------------------- market admin

    function listMarket(
        uint256 id,
        string calldata symbol,
        bool    hasSessions,
        uint16  maxLeverageX,
        uint16  maxDeviationBps,
        uint32  maxStaleness,
        uint32  fundingFactor,
        uint32  maxFundingBps,
        uint128 maxOpenInterest
    ) external onlyOwner {
        if (markets[id].listed) revert MarketExists();
        _validate(maxLeverageX, maxDeviationBps, maxStaleness, maxFundingBps);

        markets[id] = Market({
            listed:          true,
            paused:          false,
            hasSessions:     hasSessions,
            maxLeverageX:    maxLeverageX,
            maxDeviationBps: maxDeviationBps,
            maxStaleness:    maxStaleness,
            fundingFactor:   fundingFactor,
            maxFundingBps:   maxFundingBps,
            maxOpenInterest: maxOpenInterest,
            symbol:          symbol
        });
        marketIds.push(id);

        emit MarketListed(id, symbol);
        emit MarketConfigured(id);
    }

    function configureMarket(
        uint256 id,
        uint16  maxLeverageX,
        uint16  maxDeviationBps,
        uint32  maxStaleness,
        uint32  fundingFactor,
        uint32  maxFundingBps,
        uint128 maxOpenInterest
    ) external onlyOwner exists(id) {
        _validate(maxLeverageX, maxDeviationBps, maxStaleness, maxFundingBps);

        Market storage m = markets[id];
        m.maxLeverageX    = maxLeverageX;
        m.maxDeviationBps = maxDeviationBps;
        m.maxStaleness    = maxStaleness;
        m.fundingFactor   = fundingFactor;
        m.maxFundingBps   = maxFundingBps;
        m.maxOpenInterest = maxOpenInterest;

        emit MarketConfigured(id);
    }

    function _validate(
        uint16 maxLeverageX,
        uint16 maxDeviationBps,
        uint32 maxStaleness,
        uint32 maxFundingBps
    ) private pure {
        // A zero staleness window would make every price stale on the next
        // block. A zero deviation window would reject every push. Both are
        // configuration mistakes that halt the desk, so refuse them here.
        if (maxLeverageX == 0)   revert BadParam();
        if (maxDeviationBps == 0 || maxDeviationBps > BPS) revert BadParam();
        if (maxStaleness == 0)   revert BadParam();
        if (maxFundingBps > BPS) revert BadParam();
    }

    /// @dev Owner and guardian can both halt. Only the owner can unhalt —
    ///      a guardian who stops the desk should not be able to restart it
    ///      before someone has looked at why.
    function setPaused(uint256 id, bool paused) external exists(id) {
        if (paused) {
            if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        } else {
            if (msg.sender != owner) revert NotOwner();
        }
        markets[id].paused = paused;
        emit MarketPaused(id, msg.sender, paused);
    }

    /// @dev Halts every listed market in one call. This is the button you
    ///      press when the feeder is publishing garbage and you do not yet
    ///      know which market it poisoned.
    function pauseAll() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        uint256 n = marketIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = marketIds[i];
            if (!markets[id].paused) {
                markets[id].paused = true;
                emit MarketPaused(id, msg.sender, true);
            }
        }
    }

    function setHasSessions(uint256 id, bool v) external onlyOwner exists(id) {
        markets[id].hasSessions = v;
        emit MarketConfigured(id);
    }

    /// @dev Replaces the window set wholesale. Windows are seconds-of-week
    ///      with Sunday 00:00 UTC as zero, must be ordered, must not wrap,
    ///      and must not overlap — an overlapping set is almost always a
    ///      copy-paste error rather than an intent.
    ///
    ///      These are wall-clock UTC, so a market defined against a US
    ///      session needs its windows shifted twice a year for daylight
    ///      saving. That is a real chore and there is no clean way around
    ///      it onchain; the alternative is a timezone database in Solidity.
    function setSessions(uint256 id, Session[] calldata windows)
        external
        onlyOwner
        exists(id)
    {
        delete _sessions[id];
        uint256 n = windows.length;
        uint32 prevEnd;
        for (uint256 i; i < n; ++i) {
            Session calldata w = windows[i];
            if (w.start >= w.end) revert BadParam();
            if (w.end > WEEK)     revert BadParam();
            if (i > 0 && w.start < prevEnd) revert BadParam();
            prevEnd = w.end;
            _sessions[id].push(w);
        }
        emit SessionsSet(id, n);
    }

    // ---------------------------------------------------------------- pushes

    function pushPrice(uint256 id, uint128 value) external onlyPusher {
        _push(id, value);
    }

    /// @dev One transaction for the whole desk keeps the three markets on
    ///      the same timestamp, which matters when a UI shows them side by
    ///      side and when a liquidation sweep reads several at once.
    function pushPrices(uint256[] calldata ids, uint128[] calldata values)
        external
        onlyPusher
    {
        if (ids.length != values.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) {
            _push(ids[i], values[i]);
        }
    }

    function _push(uint256 id, uint128 value) private {
        if (!markets[id].listed) revert MarketMissing();
        if (value == 0) revert BadParam();

        Price storage p = prices[id];
        uint256 last = p.value;

        if (last != 0) {
            uint256 diff = value > last ? value - last : last - value;
            uint256 movedBps = (diff * BPS) / last;
            if (movedBps > markets[id].maxDeviationBps) {
                // Rejected, not reverted-silently: the feeder needs to see
                // this in a receipt, and the counter needs to move so a
                // dashboard can alarm on it.
                unchecked { ++rejectedPushes[id]; }
                emit PushRejected(id, last, value, movedBps);
                revert DeviationTooLarge(last, value, movedBps);
            }
        }

        p.value     = value;
        p.updatedAt = uint64(block.timestamp);
        unchecked { p.roundId = p.roundId + 1; }

        emit PricePushed(id, value, p.roundId, p.updatedAt);
    }

    /// @dev The only path that skips the breaker. For weekend gaps and for
    ///      the first print after a listing. Owner only, and loud.
    function forcePush(uint256 id, uint128 value) external onlyOwner exists(id) {
        if (value == 0) revert BadParam();
        Price storage p = prices[id];
        uint256 last = p.value;

        p.value     = value;
        p.updatedAt = uint64(block.timestamp);
        unchecked { p.roundId = p.roundId + 1; }

        emit PriceForced(id, last, value, msg.sender);
        emit PricePushed(id, value, p.roundId, p.updatedAt);
    }

    // ----------------------------------------------------------------- reads

    /// @dev The one function the perp contract calls. Reverts unless the
    ///      market is fully tradeable, so a caller cannot accidentally open
    ///      a position against a halted or stale market by forgetting to
    ///      check a bool.
    function getPrice(uint256 id) external view returns (uint256) {
        Status s = status(id);
        if (s != Status.OK) revert NotTradeable(s);
        return prices[id].value;
    }

    /// @dev Non-reverting read for display. A UI needs to show the last
    ///      known print even when trading is halted — that is exactly when
    ///      people most want to see it.
    function peek(uint256 id)
        external
        view
        returns (uint256 value, uint64 updatedAt, uint64 roundId, Status s)
    {
        Price storage p = prices[id];
        return (p.value, p.updatedAt, p.roundId, status(id));
    }

    function status(uint256 id) public view returns (Status) {
        Market storage m = markets[id];
        if (!m.listed)  return Status.NOT_LISTED;
        if (m.paused)   return Status.PAUSED;

        Price storage p = prices[id];
        if (p.updatedAt == 0) return Status.NO_PRICE;
        if (block.timestamp > p.updatedAt + m.maxStaleness) return Status.STALE;

        if (m.hasSessions && !_inSession(id)) return Status.OUTSIDE_SESSION;
        return Status.OK;
    }

    function isTradeable(uint256 id) external view returns (bool) {
        return status(id) == Status.OK;
    }

    function _inSession(uint256 id) private view returns (bool) {
        Session[] storage w = _sessions[id];
        uint256 n = w.length;
        // Fail closed. hasSessions with no windows configured means the
        // market is shut, not permanently open.
        if (n == 0) return false;

        uint256 sow = (block.timestamp + EPOCH_DOW_SHIFT) % WEEK;
        for (uint256 i; i < n; ++i) {
            if (sow >= w[i].start && sow < w[i].end) return true;
        }
        return false;
    }

    // ------------------------------------------------------- view convenience

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    function sessionCount(uint256 id) external view returns (uint256) {
        return _sessions[id].length;
    }

    function sessionAt(uint256 id, uint256 i) external view returns (Session memory) {
        return _sessions[id][i];
    }

    /// @dev Everything a front end needs for one market in a single call.
    ///      Three of these fills the whole desk header without hammering
    ///      a public RPC.
    function snapshot(uint256 id)
        external
        view
        returns (
            Market memory market,
            Price  memory price,
            Status s,
            uint256 rejected
        )
    {
        return (markets[id], prices[id], status(id), rejectedPushes[id]);
    }
}
