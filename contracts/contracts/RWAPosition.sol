// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title RWAPosition
/// @notice ERC-4626 vault representing a protected RWA exposure.
/// @dev The vault holds two balances: the RWA asset itself, and whatever
///      defensive stablecoin a protective rotation has moved into. Both count
///      toward `totalAssets`, so a rotation does not dilute depositors — the
///      defensive leg is valued through `defensivePriceE18`, which the admin
///      keeps in step with the oracle feed. Only the ProtectionExecutor may
///      move assets out for protection, and it must return the proceeds in the
///      same transaction.
contract RWAPosition is ERC4626, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");

    /// @notice Stablecoin protective rotations land in.
    IERC20 public immutable defensiveAsset;

    /// @notice Price of one defensive unit in asset units, scaled by 1e18.
    uint256 public defensivePriceE18 = 1e18;

    uint8 private immutable _assetDecimals;
    uint8 private immutable _defensiveDecimals;

    /// @notice Assets currently checked out by the executor mid-rotation.
    uint256 public pendingProtection;

    event ProtectionCheckedOut(address indexed executor, uint256 assets);
    event ProtectionSettled(address indexed executor, uint256 assetsOut, uint256 defensiveIn);
    event DefensivePriceUpdated(uint256 previous, uint256 current);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error NothingPending();
    error PriceOutOfRange(uint256 price);

    constructor(
        IERC20 asset_,
        IERC20 defensiveAsset_,
        string memory name_,
        string memory symbol_,
        address admin
    ) ERC20(name_, symbol_) ERC4626(asset_) {
        if (address(defensiveAsset_) == address(0) || admin == address(0)) revert ZeroAddress();
        defensiveAsset = defensiveAsset_;
        _assetDecimals = IERC20Metadata(address(asset_)).decimals();
        _defensiveDecimals = IERC20Metadata(address(defensiveAsset_)).decimals();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRICER_ROLE, admin);
    }

    /// @inheritdoc ERC4626
    /// @dev RWA held + defensive held (valued in asset units) + anything a
    ///      rotation currently has in flight.
    function totalAssets() public view override returns (uint256) {
        return
            IERC20(asset()).balanceOf(address(this)) +
            defensiveInAssetUnits() +
            pendingProtection;
    }

    /// @notice Defensive stablecoin balance expressed in asset units.
    function defensiveInAssetUnits() public view returns (uint256) {
        uint256 bal = defensiveAsset.balanceOf(address(this));
        if (bal == 0) return 0;
        uint256 valued = (bal * defensivePriceE18) / 1e18;
        if (_defensiveDecimals == _assetDecimals) return valued;
        if (_defensiveDecimals < _assetDecimals) {
            return valued * (10 ** (_assetDecimals - _defensiveDecimals));
        }
        return valued / (10 ** (_defensiveDecimals - _assetDecimals));
    }

    /// @notice Share of the vault currently sitting in the defensive asset, in bps.
    function defensiveShareBps() external view returns (uint256) {
        uint256 total = totalAssets();
        if (total == 0) return 0;
        return (defensiveInAssetUnits() * 10_000) / total;
    }

    /// @notice Move RWA assets to the executor so it can perform a swap.
    /// @dev Must be followed by `settleProtection` in the same transaction; the
    ///      executor is the only caller and is reentrancy-guarded here.
    function checkoutForProtection(uint256 assets)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (assets == 0) revert ZeroAmount();
        uint256 available = IERC20(asset()).balanceOf(address(this));
        if (assets > available) revert InsufficientLiquidity(assets, available);

        pendingProtection += assets;
        IERC20(asset()).safeTransfer(msg.sender, assets);
        emit ProtectionCheckedOut(msg.sender, assets);
    }

    /// @notice Close out a rotation: the executor reports how much it swapped
    ///         and has already transferred the defensive proceeds back in.
    function settleProtection(uint256 assetsOut, uint256 defensiveIn)
        external
        onlyRole(EXECUTOR_ROLE)
        nonReentrant
    {
        if (pendingProtection == 0) revert NothingPending();
        if (assetsOut > pendingProtection) revert InsufficientLiquidity(assetsOut, pendingProtection);

        pendingProtection -= assetsOut;
        emit ProtectionSettled(msg.sender, assetsOut, defensiveIn);
    }

    /// @notice Update the defensive asset's price in asset units (1e18 scale).
    function setDefensivePrice(uint256 newPriceE18) external onlyRole(PRICER_ROLE) {
        // Guard against a fat-fingered feed wiping out or inflating vault value.
        if (newPriceE18 < 0.5e18 || newPriceE18 > 2e18) revert PriceOutOfRange(newPriceE18);
        emit DefensivePriceUpdated(defensivePriceE18, newPriceE18);
        defensivePriceE18 = newPriceE18;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        super._deposit(caller, receiver, assets, shares);
    }

    /// @dev Withdrawals draw on the RWA leg. If a rotation has moved value into
    ///      the defensive asset, the owner redeems that portion via
    ///      `redeemDefensive` rather than forcing a swap back on exit.
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        uint256 available = IERC20(asset()).balanceOf(address(this));
        if (assets > available) revert InsufficientLiquidity(assets, available);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @notice Burn shares against the defensive leg, receiving stablecoin.
    /// @param shares Shares to burn.
    /// @return defensiveOut Stablecoin transferred to the caller.
    function redeemDefensive(uint256 shares, address receiver)
        external
        nonReentrant
        returns (uint256 defensiveOut)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 assetValue = previewRedeem(shares);
        uint256 defensiveBal = defensiveAsset.balanceOf(address(this));

        // Convert the asset-denominated claim back into defensive units.
        uint256 scaled = assetValue;
        if (_defensiveDecimals < _assetDecimals) {
            scaled = scaled / (10 ** (_assetDecimals - _defensiveDecimals));
        } else if (_defensiveDecimals > _assetDecimals) {
            scaled = scaled * (10 ** (_defensiveDecimals - _assetDecimals));
        }
        defensiveOut = (scaled * 1e18) / defensivePriceE18;
        if (defensiveOut > defensiveBal) revert InsufficientLiquidity(defensiveOut, defensiveBal);

        _burn(msg.sender, shares);
        defensiveAsset.safeTransfer(receiver, defensiveOut);
    }
}
