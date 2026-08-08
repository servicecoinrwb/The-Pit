// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20}    from "@openzeppelin/contracts@5.0.2/token/ERC20/ERC20.sol";
import {ERC4626}  from "@openzeppelin/contracts@5.0.2/token/ERC20/extensions/ERC4626.sol";
import {IERC20}   from "@openzeppelin/contracts@5.0.2/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts@5.0.2/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/utils/SafeERC20.sol";
import {Math}     from "@openzeppelin/contracts@5.0.2/utils/math/Math.sol";

interface IPerpAccounting {
    /// @return Net unrealised PnL across all open positions, signed, in asset
    ///         units. Positive means traders are ahead and this vault owes.
    function poolPnl() external view returns (int256);
}

/**
 * Ballast — the counterparty pool
 *
 * Every trade on this desk is taken against this vault. There is no order
 * book and no matching. A trader who profits is paid from here; a trader
 * who loses pays into here. Depositors are, collectively, the house.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE THREE THINGS THIS SHIPS WITH, AND WHY
 *
 * A vault whose share price can run away is a vault that eats its own
 * depositors. That failure has been seen once already, so this one is
 * built with all three defences from the start rather than patched after.
 *
 *   1. VIRTUAL SHARES (decimals offset)
 *      Share price is computed as assets/supply. If an attacker deposits
 *      one unit, receives one share, then donates a large amount directly
 *      to the vault, one share is suddenly worth a fortune and the next
 *      depositor's share count rounds to zero. The offset adds a virtual
 *      balance to both sides of that division, so the attacker has to
 *      donate 10^offset times the victim's deposit to steal anything —
 *      which costs more than it takes.
 *
 *   2. DEAD SHARES SEEDED AT INITIALISE
 *      Virtual shares raise the cost of the attack. Real, permanently
 *      locked shares remove the precondition. Seeding mints to a burn
 *      address, so totalSupply has a hard floor above zero for the life of
 *      the contract and the divisor can never approach it.
 *
 *   3. A WITHDRAWAL FLOOR
 *      A vault emptied down to dust is the same broken state reached the
 *      slow way. Redemptions that would leave supply below the floor are
 *      refused outright, not rounded through.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT totalAssets() COUNTS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The vault's real worth is its balance minus what it owes to traders who
 * are currently winning. That liability is read live from the perp engine
 * so that share price reflects it the moment price moves, rather than at
 * settlement.
 *
 * Unrealised trader *losses* are not counted as vault assets. They are
 * money the vault has not been paid and might never be — the position can
 * turn around before it closes. Counting them would let an LP redeem
 * against a profit that has not landed, at the expense of whoever is
 * still in the pool when it evaporates. The vault marks its liabilities
 * to market and its gains only when they settle.
 *
 * ─────────────────────────────────────────────────────────────────────
 * RESERVATION
 *
 * Open positions can win. If LPs could withdraw everything while trades
 * are live, a winning trader would find nothing behind the promise. The
 * perp engine reserves an amount covering the profit it might have to pay,
 * and reserved assets cannot be withdrawn by anyone. Idle capital is the
 * only thing that leaves.
 */
contract Ballast is ERC4626 {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotPerp();
    error ZeroAddress();
    error AlreadySet();
    error AlreadyInitialised();
    error NotInitialised();
    error SeedTooSmall(uint256 given, uint256 required);
    error DepositsPaused();
    error ExceedsIdle(uint256 want, uint256 idle);
    error BreaksFloor(uint256 supplyAfter, uint256 floor);
    error ReserveUnderflow(uint256 have, uint256 want);
    error CapExceeded(uint256 want, uint256 cap);

    // ------------------------------------------------------------- constants

    /// @dev Where seeded shares go to never come back.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev Shares minted to DEAD at initialise. Permanent floor on supply.
    uint256 public constant DEAD_SHARES = 1e12;

    /// @dev Redemptions may not leave total supply below this. DEAD_SHARES
    ///      alone already guarantees it, but the explicit check means a
    ///      future change to the seed cannot silently remove the floor.
    uint256 public constant MIN_SUPPLY = DEAD_SHARES;

    // ----------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;
    address public perp;          // set exactly once
    bool    public initialised;
    bool    public depositsPaused;

    uint8   private immutable _offset;

    /// @dev Assets earmarked against open positions. Not withdrawable.
    uint256 public reservedAssets;

    /// @dev Optional ceiling on total deposits. Zero means uncapped.
    uint256 public depositCap;

    /// @dev False if the last totalAssets() read could not reach the perp.
    ///      A UI should surface this loudly: share price is overstated
    ///      while it is false, because liabilities are not being counted.
    bool public lastPnlOk = true;

    // ---------------------------------------------------------------- events

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event PerpSet(address indexed perp);
    event Initialised(uint256 seedAssets, uint256 deadShares);
    event DepositsPausedSet(bool paused);
    event DepositCapSet(uint256 cap);
    event Reserved(uint256 amount, uint256 total);
    event Released(uint256 amount, uint256 total);
    event PaidOut(address indexed to, uint256 amount);

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPerp() {
        if (msg.sender != perp) revert NotPerp();
        _;
    }

    // ----------------------------------------------------------- constructor

    /**
     * @param asset_ Collateral token. On a testnet this should be a mintable
     *               stand-in — the faucet's 1 USDC/day cannot seed a pool
     *               deep enough for any of these numbers to mean anything.
     */
    constructor(IERC20 asset_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
    {
        owner = msg.sender;

        // Shares land on 18 decimals for a 6-decimal collateral, which is
        // what a front end expects. An 18-decimal collateral still gets a
        // meaningful offset rather than none, because an offset of zero is
        // the same as having no virtual shares at all.
        uint8 d = IERC20Metadata(address(asset_)).decimals();
        _offset = d >= 18 ? 6 : uint8(18 - d);

        emit OwnershipTransferred(address(0), msg.sender);
    }

    function _decimalsOffset() internal view override returns (uint8) {
        return _offset;
    }

    // ------------------------------------------------------------ initialise

    /**
     * Seeds the vault and locks the dead shares. Until this runs, every
     * deposit and every redemption reverts — an uninitialised vault has no
     * supply floor, which is precisely the state the first-depositor attack
     * needs.
     *
     * Approve `seedAssets` to this contract first, then call.
     */
    function initialise(uint256 seedAssets) external onlyOwner {
        if (initialised) revert AlreadyInitialised();

        // The seed must be worth at least one dead share at the opening
        // ratio, or the floor is nominal rather than real.
        uint256 required = DEAD_SHARES / (10 ** _offset);
        if (required == 0) required = 1;
        if (seedAssets < required) revert SeedTooSmall(seedAssets, required);

        initialised = true;

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), seedAssets);
        _mint(DEAD, DEAD_SHARES);

        emit Initialised(seedAssets, DEAD_SHARES);
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
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, msg.sender);
    }

    /**
     * The perp engine can move money out of this vault, so it is set once
     * and never again. A mutable pointer here would mean the owner could
     * redirect payouts at will, and depositors would be trusting a promise
     * rather than the code.
     */
    function setPerp(address p) external onlyOwner {
        if (perp != address(0)) revert AlreadySet();
        if (p == address(0)) revert ZeroAddress();
        perp = p;
        emit PerpSet(p);
    }

    function setDepositsPaused(bool v) external onlyOwner {
        depositsPaused = v;
        emit DepositsPausedSet(v);
    }

    function setDepositCap(uint256 cap) external onlyOwner {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    // ------------------------------------------------------------ accounting

    /// @dev Cash actually sitting here, before liabilities.
    function rawBalance() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /**
     * Balance less what open positions are currently up. See the header for
     * why unrealised trader losses are not added back.
     *
     * The perp read is wrapped: a reverting engine must not brick every
     * deposit and withdrawal in the vault. When it fails the vault falls
     * back to raw balance and flips `lastPnlOk` false, which is a signal to
     * halt trading rather than a state to keep operating in.
     */
    function totalAssets() public view override returns (uint256) {
        uint256 bal = rawBalance();
        address p = perp;
        if (p == address(0)) return bal;

        try IPerpAccounting(p).poolPnl() returns (int256 pnl) {
            if (pnl <= 0) return bal;
            uint256 owed = uint256(pnl);
            return owed >= bal ? 0 : bal - owed;
        } catch {
            return bal;
        }
    }

    /// @dev Same read, but reports whether the perp answered. Views cannot
    ///      write, so `lastPnlOk` is refreshed by `syncPnlHealth()`.
    function pnlHealthy() public view returns (bool) {
        address p = perp;
        if (p == address(0)) return true;
        try IPerpAccounting(p).poolPnl() returns (int256) {
            return true;
        } catch {
            return false;
        }
    }

    function syncPnlHealth() external {
        lastPnlOk = pnlHealthy();
    }

    /// @dev Withdrawable cash: on hand, minus what open positions have
    ///      claim to. This is the number a withdraw button should show.
    function idleAssets() public view returns (uint256) {
        uint256 bal = rawBalance();
        uint256 r = reservedAssets;
        return bal > r ? bal - r : 0;
    }

    // --------------------------------------------------------- perp hooks

    /**
     * Earmarks assets against a newly opened position. The perp calls this
     * with the maximum profit that position could be paid, so the money to
     * honour it is set aside before the trade is live rather than hoped for
     * when it closes.
     */
    function reserve(uint256 amount) external onlyPerp {
        uint256 idle = idleAssets();
        if (amount > idle) revert ExceedsIdle(amount, idle);
        reservedAssets += amount;
        emit Reserved(amount, reservedAssets);
    }

    function release(uint256 amount) external onlyPerp {
        uint256 r = reservedAssets;
        if (amount > r) revert ReserveUnderflow(r, amount);
        unchecked { reservedAssets = r - amount; }
        emit Released(amount, reservedAssets);
    }

    /**
     * Pays a winning trader. Draws against reserved capital, which is why
     * reservation happens at open — by the time this is called the money is
     * already committed and cannot have been withdrawn out from under it.
     */
    function payout(address to, uint256 amount) external onlyPerp {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = rawBalance();
        if (amount > bal) revert ExceedsIdle(amount, bal);

        uint256 r = reservedAssets;
        reservedAssets = amount > r ? 0 : r - amount;

        IERC20(asset()).safeTransfer(to, amount);
        emit PaidOut(to, amount);
    }

    // ---------------------------------------------------- 4626 restrictions

    function maxDeposit(address) public view override returns (uint256) {
        if (!initialised || depositsPaused) return 0;
        uint256 cap = depositCap;
        if (cap == 0) return type(uint256).max;
        uint256 ta = totalAssets();
        return ta >= cap ? 0 : cap - ta;
    }

    function maxMint(address a) public view override returns (uint256) {
        uint256 md = maxDeposit(a);
        return md == type(uint256).max ? type(uint256).max : previewDeposit(md);
    }

    /// @dev Bounded by idle cash, not by the depositor's share of paper
    ///      value. Shares backed by reserved capital cannot be redeemed
    ///      while the positions they are covering are still open.
    function maxWithdraw(address o) public view override returns (uint256) {
        if (!initialised) return 0;
        uint256 byShares = super.maxWithdraw(o);
        uint256 idle = idleAssets();
        return byShares < idle ? byShares : idle;
    }

    function maxRedeem(address o) public view override returns (uint256) {
        if (!initialised) return 0;
        uint256 byShares = super.maxRedeem(o);
        uint256 viaIdle = previewWithdraw(idleAssets());
        return byShares < viaIdle ? byShares : viaIdle;
    }

    // --------------------------------------------------------------- guards

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
    {
        if (!initialised) revert NotInitialised();
        if (depositsPaused) revert DepositsPaused();

        uint256 cap = depositCap;
        if (cap != 0) {
            uint256 after_ = totalAssets() + assets;
            if (after_ > cap) revert CapExceeded(after_, cap);
        }
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(
        address caller,
        address receiver,
        address o,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (!initialised) revert NotInitialised();

        // Reserved capital is spoken for. Refuse rather than pay out of the
        // money backing someone's open position.
        uint256 idle = idleAssets();
        if (assets > idle) revert ExceedsIdle(assets, idle);

        // The floor. Dead shares make this unreachable in practice; the
        // check is here so it stays unreachable if the seed ever changes.
        uint256 supplyAfter = totalSupply() - shares;
        if (supplyAfter < MIN_SUPPLY) revert BreaksFloor(supplyAfter, MIN_SUPPLY);

        super._withdraw(caller, receiver, o, assets, shares);
    }

    // ------------------------------------------------------------ view sugar

    /// @dev Everything a dashboard needs in one call.
    ///
    ///      `assetsPerShare` is what one whole share redeems for, in asset
    ///      units — divide by 10**assetDecimals to display it. Because of
    ///      the decimals offset this does not start at 1.0, and it should
    ///      not be dressed up to look like it does. What matters to an LP
    ///      is that it only moves when the desk makes or loses money, so a
    ///      UI should show its change since deposit rather than its
    ///      absolute value.
    function stats()
        external
        view
        returns (
            uint256 assets,
            uint256 raw,
            uint256 idle,
            uint256 reserved,
            uint256 supply,
            uint256 assetsPerShare,
            bool    healthy,
            bool    ready
        )
    {
        assets         = totalAssets();
        raw            = rawBalance();
        idle           = idleAssets();
        reserved       = reservedAssets;
        supply         = totalSupply();
        assetsPerShare = convertToAssets(10 ** decimals());
        healthy        = pnlHealthy();
        ready          = initialised && !depositsPaused;
    }
}
