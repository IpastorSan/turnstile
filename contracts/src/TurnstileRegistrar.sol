// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {LibLabel} from "@ens/v2/utils/LibLabel.sol";

import {TurnstileRegistry} from "./TurnstileRegistry.sol";

/// @title TurnstileRegistrar
/// @notice Pricing, availability and minting for Turnstile subnames.
///
/// Written from scratch. The ENSv2 docs describe a `SimpleSubnameRegistrar` to
/// model this on; it does not exist. MOV-212 grepped ensdomains/contracts-v2 rev 48b3e2d
/// end to end and `src/registrar/` contains only `AbstractETHRegistrar`,
/// `BatchRegistrar`, `ETHRegistrar`, `ETHRenewerV1` and `StandardRentPriceOracle`
/// — all of them about `.eth` second-level names, none about subnames.
///
/// Deployed standalone, not behind a proxy: the registrar holds no names and no
/// user balances beyond in-flight proceeds, so there is nothing to preserve across
/// an upgrade. Replacing it is a `revokeRootRoles` / `grantRootRoles` pair on the
/// registry, which is a smaller and more auditable operation than a UUPS upgrade.
///
/// Authority model, matching the tier invariant in CLAUDE.md: this contract holds
/// `ROLE_REGISTRAR | ROLE_RENEW` at root on the registry and nothing else. It can
/// sell and extend names. It cannot delete them, cannot change the registry's
/// parent, cannot upgrade it, and cannot grant itself anything further — every one
/// of those requires an `_ADMIN` role that lives with the operator identity.
contract TurnstileRegistrar is Ownable2Step, ReentrancyGuard {
    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @notice Shortest registerable label.
    uint256 public constant MIN_LABEL_LENGTH = 3;

    /// @notice Longest registerable label — the DNS label limit.
    uint256 public constant MAX_LABEL_LENGTH = 63;

    /// @notice Labels of length 1..TIERED_LENGTHS are priced individually; longer
    ///         ones all use `basePriceWeiPerSecond`.
    uint256 public constant TIERED_LENGTHS = 5;

    /// @notice Shortest registration or renewal.
    uint64 public constant MIN_DURATION = 28 days;

    /// @notice Longest single registration or renewal.
    uint64 public constant MAX_DURATION = 3650 days;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @notice The registry this registrar mints into — the Turnstile
    ///         `UserRegistry` proxy. Immutable: pointing a live registrar at a
    ///         different registry is a redeploy, not a setter.
    IPermissionedRegistry public immutable REGISTRY;

    /// @notice Where proceeds are swept. The seller's payout address; changing it
    ///         is an owner (cold tier) operation.
    address public paymentReceiver;

    /// @notice Resolver set on each newly minted subname. May be the zero address,
    ///         in which case the buyer sets their own via `ROLE_SET_RESOLVER`.
    address public defaultResolver;

    /// @notice Rent in wei per second for labels of length >= `TIERED_LENGTHS`.
    uint256 public basePriceWeiPerSecond;

    /// @dev Rent in wei per second indexed by label length. Index 0 is unused;
    ///      indices 1..TIERED_LENGTHS-1 are the short-label tiers.
    uint256[TIERED_LENGTHS] private _tierPriceWeiPerSecond;

    /// @notice Labels the seller has withheld from sale, by `keccak256(bytes(label))`.
    mapping(bytes32 labelHash => bool) public reserved;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice A subname was sold.
    event SubnameRegistered(
        string label,
        bytes32 indexed labelHash,
        address indexed owner,
        uint256 indexed tokenId,
        uint64 expiry,
        uint256 price
    );

    /// @notice A subname's registration was extended.
    event SubnameRenewed(
        string label,
        bytes32 indexed labelHash,
        uint64 newExpiry,
        uint256 price
    );

    /// @notice Pricing changed.
    event PricesUpdated(uint256[TIERED_LENGTHS] tierPriceWeiPerSecond, uint256 basePriceWeiPerSecond);

    /// @notice The payout address changed.
    event PaymentReceiverUpdated(address indexed paymentReceiver);

    /// @notice The resolver applied to new subnames changed.
    event DefaultResolverUpdated(address indexed defaultResolver);

    /// @notice A label was withheld from, or released for, sale.
    event ReservationUpdated(bytes32 indexed labelHash, bool reserved);

    /// @notice Proceeds were swept to `paymentReceiver`.
    event Withdrawn(address indexed paymentReceiver, uint256 amount);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice The label is not a legal Turnstile label. See `validLabel`.
    error InvalidLabel(string label);

    /// @notice The label is withheld, or already registered or reserved in the registry.
    error LabelUnavailable(string label);

    /// @notice The label is not currently registered, so it cannot be renewed.
    error LabelNotRegistered(string label);

    /// @notice Duration outside [`MIN_DURATION`, `MAX_DURATION`].
    error DurationOutOfRange(uint64 duration);

    /// @notice `msg.value` did not cover the quoted price.
    error InsufficientPayment(uint256 required, uint256 provided);

    /// @notice Refund of the overpayment failed, so the whole call is reverted
    ///         rather than the surplus being silently kept.
    error RefundFailed(address recipient, uint256 amount);

    /// @notice Sweep to `paymentReceiver` failed.
    error WithdrawFailed(address recipient, uint256 amount);

    /// @notice A zero address was supplied where one is not meaningful.
    error ZeroAddress();

    /// @notice There was nothing to sweep.
    error NothingToWithdraw();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param registry The Turnstile registry to mint into.
    /// @param owner_ The registrar owner — the seller's operator identity.
    /// @param paymentReceiver_ Where proceeds are swept.
    /// @param defaultResolver_ Resolver applied to new subnames; may be zero.
    /// @param tierPriceWeiPerSecond_ Per-second rent for labels of length
    ///        1..`TIERED_LENGTHS`-1. Index 0 is ignored.
    /// @param basePriceWeiPerSecond_ Per-second rent for longer labels.
    constructor(
        IPermissionedRegistry registry,
        address owner_,
        address paymentReceiver_,
        address defaultResolver_,
        uint256[TIERED_LENGTHS] memory tierPriceWeiPerSecond_,
        uint256 basePriceWeiPerSecond_
    )
        Ownable(owner_)
    {
        if (address(registry) == address(0)) {
            revert ZeroAddress();
        }
        REGISTRY = registry;
        _setPaymentReceiver(paymentReceiver_);
        _setDefaultResolver(defaultResolver_);
        _setPrices(tierPriceWeiPerSecond_, basePriceWeiPerSecond_);
    }

    ////////////////////////////////////////////////////////////////////////
    // Availability and pricing
    ////////////////////////////////////////////////////////////////////////

    /// @notice Whether `label` is a legal Turnstile label.
    ///
    /// Lowercase ASCII letters, digits and hyphens, no leading or trailing hyphen,
    /// `MIN_LABEL_LENGTH`..`MAX_LABEL_LENGTH` bytes.
    ///
    /// This is stricter than ENS, which accepts normalised unicode. The narrowing
    /// is deliberate and load-bearing: `LibLabel.id` is a plain `keccak256` of the
    /// raw bytes, so a label containing `.` would mint a token whose name has no
    /// single well-defined position in the hierarchy. Rejecting it here is the only
    /// place that can be enforced on-chain. Buyers wanting a unicode subname must
    /// normalise and punycode it off-chain first.
    function validLabel(string memory label) public pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 n = b.length;
        if (n < MIN_LABEL_LENGTH || n > MAX_LABEL_LENGTH) {
            return false;
        }
        if (b[0] == 0x2d || b[n - 1] == 0x2d) {
            return false; // no leading or trailing hyphen
        }
        for (uint256 i; i < n; ++i) {
            uint8 c = uint8(b[i]);
            bool ok = (c >= 0x61 && c <= 0x7a) || // a-z
                (c >= 0x30 && c <= 0x39) || //       0-9
                c == 0x2d; //                        -
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    /// @notice Whether `label` can be bought right now.
    /// @dev Combines our own policy (legal label, not withheld) with the registry's
    ///      state. A label the registry reports as `RESERVED` is unavailable to us:
    ///      promoting a reservation needs `ROLE_REGISTER_RESERVED`, which this
    ///      registrar deliberately does not hold.
    function available(string memory label) public view returns (bool) {
        if (!validLabel(label) || reserved[keccak256(bytes(label))]) {
            return false;
        }
        return REGISTRY.getStatus(LibLabel.id(label)) == IPermissionedRegistry.Status.AVAILABLE;
    }

    /// @notice Per-second rent for a label of `length` bytes.
    function priceWeiPerSecond(uint256 length) public view returns (uint256) {
        return length < TIERED_LENGTHS ? _tierPriceWeiPerSecond[length] : basePriceWeiPerSecond;
    }

    /// @notice The current per-length price table.
    /// @return tierPriceWeiPerSecond Index 0 unused, then lengths 1..`TIERED_LENGTHS`-1.
    /// @return base Per-second rent for lengths >= `TIERED_LENGTHS`.
    function prices()
        external
        view
        returns (uint256[TIERED_LENGTHS] memory tierPriceWeiPerSecond, uint256 base)
    {
        return (_tierPriceWeiPerSecond, basePriceWeiPerSecond);
    }

    /// @notice Total price to register or renew `label` for `duration` seconds.
    function rentPrice(string memory label, uint64 duration) public view returns (uint256) {
        return priceWeiPerSecond(bytes(label).length) * duration;
    }

    ////////////////////////////////////////////////////////////////////////
    // Buying
    ////////////////////////////////////////////////////////////////////////

    /// @notice Buy `label` for `owner`, for `duration` seconds from now.
    ///
    /// Overpayment is refunded to `msg.sender`. The subname is minted with no
    /// subregistry of its own; the buyer holds `ROLE_SET_SUBREGISTRY` and can add
    /// one later.
    ///
    /// @param label The label to buy, e.g. `alice` for `alice.turnstile.eth`.
    /// @param owner The address that will own the subname.
    /// @param duration Registration length in seconds.
    /// @return tokenId The minted ERC1155 token id.
    function register(string calldata label, address owner, uint64 duration)
        external
        payable
        nonReentrant
        returns (uint256 tokenId)
    {
        if (owner == address(0)) {
            revert ZeroAddress();
        }
        _checkDuration(duration);
        if (!validLabel(label)) {
            revert InvalidLabel(label);
        }
        if (!available(label)) {
            revert LabelUnavailable(label);
        }

        uint256 price = rentPrice(label, duration);
        if (msg.value < price) {
            revert InsufficientPayment(price, msg.value);
        }

        uint64 expiry = uint64(block.timestamp) + duration;
        tokenId = REGISTRY.register(
            label,
            owner,
            IRegistry(address(0)),
            defaultResolver,
            TurnstileRegistry.SUBNAME_OWNER_ROLES,
            expiry
        );

        emit SubnameRegistered(label, keccak256(bytes(label)), owner, tokenId, expiry, price);
        _refund(price);
    }

    /// @notice Extend `label` by `duration` seconds past its current expiry.
    /// @dev Anyone may renew anyone's name — the payment is the only gate, as in
    ///      ENS itself. Overpayment is refunded to `msg.sender`.
    function renew(string calldata label, uint64 duration) external payable nonReentrant {
        _checkDuration(duration);
        uint256 labelId = LibLabel.id(label);
        if (REGISTRY.getStatus(labelId) != IPermissionedRegistry.Status.REGISTERED) {
            revert LabelNotRegistered(label);
        }

        uint256 price = rentPrice(label, duration);
        if (msg.value < price) {
            revert InsufficientPayment(price, msg.value);
        }

        uint64 newExpiry = REGISTRY.getExpiry(labelId) + duration;
        REGISTRY.renew(labelId, newExpiry);

        emit SubnameRenewed(label, keccak256(bytes(label)), newExpiry, price);
        _refund(price);
    }

    ////////////////////////////////////////////////////////////////////////
    // Proceeds
    ////////////////////////////////////////////////////////////////////////

    /// @notice Sweep proceeds to `paymentReceiver`.
    /// @dev Permissionless on purpose: it only ever moves funds to the address the
    ///      owner already set, so there is no reason to make the seller's cold key
    ///      sign for a sweep.
    function withdraw() external nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        address recipient = paymentReceiver;
        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) {
            revert WithdrawFailed(recipient, amount);
        }
        emit Withdrawn(recipient, amount);
    }

    ////////////////////////////////////////////////////////////////////////
    // Owner controls
    ////////////////////////////////////////////////////////////////////////

    /// @notice Replace the price table.
    function setPrices(
        uint256[TIERED_LENGTHS] calldata tierPriceWeiPerSecond_,
        uint256 basePriceWeiPerSecond_
    )
        external
        onlyOwner
    {
        _setPrices(tierPriceWeiPerSecond_, basePriceWeiPerSecond_);
    }

    /// @notice Change where proceeds are swept.
    function setPaymentReceiver(address paymentReceiver_) external onlyOwner {
        _setPaymentReceiver(paymentReceiver_);
    }

    /// @notice Change the resolver applied to newly minted subnames.
    function setDefaultResolver(address defaultResolver_) external onlyOwner {
        _setDefaultResolver(defaultResolver_);
    }

    /// @notice Withhold labels from sale, or release them.
    /// @dev Withholding does not affect names already sold.
    function setReserved(string[] calldata labels, bool reserved_) external onlyOwner {
        for (uint256 i; i < labels.length; ++i) {
            bytes32 labelHash = keccak256(bytes(labels[i]));
            reserved[labelHash] = reserved_;
            emit ReservationUpdated(labelHash, reserved_);
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal
    ////////////////////////////////////////////////////////////////////////

    function _checkDuration(uint64 duration) private pure {
        if (duration < MIN_DURATION || duration > MAX_DURATION) {
            revert DurationOutOfRange(duration);
        }
    }

    /// @dev Return `msg.value - price` to the caller. Reverts the whole call if the
    ///      refund fails, so an overpaying contract without a receive function gets
    ///      its transaction rejected instead of donating the surplus.
    function _refund(uint256 price) private {
        uint256 surplus = msg.value - price;
        if (surplus == 0) {
            return;
        }
        (bool ok, ) = msg.sender.call{value: surplus}("");
        if (!ok) {
            revert RefundFailed(msg.sender, surplus);
        }
    }

    function _setPrices(
        uint256[TIERED_LENGTHS] memory tierPriceWeiPerSecond_,
        uint256 basePriceWeiPerSecond_
    )
        private
    {
        _tierPriceWeiPerSecond = tierPriceWeiPerSecond_;
        basePriceWeiPerSecond = basePriceWeiPerSecond_;
        emit PricesUpdated(tierPriceWeiPerSecond_, basePriceWeiPerSecond_);
    }

    function _setPaymentReceiver(address paymentReceiver_) private {
        if (paymentReceiver_ == address(0)) {
            revert ZeroAddress();
        }
        paymentReceiver = paymentReceiver_;
        emit PaymentReceiverUpdated(paymentReceiver_);
    }

    function _setDefaultResolver(address defaultResolver_) private {
        defaultResolver = defaultResolver_;
        emit DefaultResolverUpdated(defaultResolver_);
    }
}
