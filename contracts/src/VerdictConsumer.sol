// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice ERC-165, declared here rather than imported so the receiver surface
///         is one file. The CRE Forwarder checks it before delivering.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice The CRE Forwarder's delivery interface.
/// @dev The Forwarder calls `onReport` after it has verified the DON's
///      signatures over the report. `metadata` is not ABI-encoded — it is a
///      packed header the Forwarder builds, laid out as
///      `bytes32 workflowId | bytes10 workflowName | address workflowOwner`,
///      which is why it is read with assembly below rather than `abi.decode`.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title VerdictConsumer
/// @notice The settlement point for LP-safety verdicts scored inside a
///         Chainlink CRE confidential workflow.
///
/// ## What this contract is actually asserting
///
/// A verdict here is not "the seller says AVOID". The report reaching
/// `onReport` was signed by the Workflow DON only after it verified the
/// attestation of the AWS Nitro enclave that produced it, so the assertion is:
///
///   *an attested enclave, running the published workflow binary, over evidence
///   committed to by `evidenceHash`, returned this rating.*
///
/// That is a strictly stronger claim than a signature from the seller's key,
/// and it is the claim the premium tier sells. The seller cannot forge it
/// without breaking the enclave, and cannot quietly re-score yesterday's
/// evidence into a friendlier answer without changing `evidenceHash`.
///
/// ## Why so little is stored
///
/// The full verdict is seven signals, each with a headline, a paragraph of
/// reasoning and a block of labelled evidence. Publishing that on Sepolia would
/// hand away the product — an LP-safety report in the clear is a report nobody
/// needs to buy. So 105 bytes land here and the rest is sold off-chain:
///
/// | Field | Why it is public |
/// | --- | --- |
/// | `rating`, `confidenceBp` | the claim itself; useless to withhold |
/// | `failMask`, `warnMask` | makes the claim falsifiable — you can see *which* tests failed, not why |
/// | `assessedAt` | the instant the evidence describes; lets a reader judge staleness |
/// | `evidenceHash` | a commitment, not a disclosure |
///
/// `evidenceHash` is the keystone. A buyer who has paid holds the ~9kB
/// `AnalystInput` the enclave scored, hashes it, and compares. Match, and the
/// report on chain provably concerns those exact bytes. Mismatch, and the
/// seller substituted the evidence and the buyer can prove it. A passer-by who
/// has not paid learns nothing from a hash.
///
/// ## Security posture
///
/// Three gates, all optional after construction except the first:
///
///   1. `forwarder` — only the CRE Forwarder may call `onReport`. Required at
///      construction and non-zero, because a receiver anyone can call is not a
///      receiver, it is a bulletin board.
///   2. `expectedAuthor` — the workflow owner the report must come from.
///   3. `expectedWorkflowId` — the exact workflow. The tightest gate: a
///      workflow id changes when the binary or the config changes, so pinning
///      it means a modified scorer cannot write here.
///
/// Gates 2 and 3 default to disabled so the contract can be deployed before the
/// workflow is registered — the workflow id does not exist until then. Turning
/// them on afterwards is the intended lifecycle, and `verdictsAreGated()` says
/// out loud whether that step was ever taken.
contract VerdictConsumer is IReceiver {
    /// @notice Rating codes, ordered by severity.
    /// @dev `INSUFFICIENT_DATA` sits *above* `AVOID` on purpose. It is not
    ///      "worse than avoid"; it is "do not act on this at all", and placing
    ///      it beyond AVOID stops a `rating <= CAUTION` style check from
    ///      quietly treating a missing measurement as a mild concern.
    uint8 public constant RATING_ACCEPTABLE = 0;
    uint8 public constant RATING_CAUTION = 1;
    uint8 public constant RATING_AVOID = 2;
    uint8 public constant RATING_INSUFFICIENT_DATA = 3;

    /// @notice Bit positions in `failMask` / `warnMask`. Frozen: they are part
    ///         of the report encoding, so appending is fine and reordering is a
    ///         breaking change. Mirrors `SIGNAL_BITS` in seller/cre/verdict.ts.
    uint8 public constant SIGNAL_INVENTORY_BALANCE = 0;
    uint8 public constant SIGNAL_EXECUTABLE_DEPTH = 1;
    uint8 public constant SIGNAL_DEPTH_VS_TVL = 2;
    uint8 public constant SIGNAL_SLIPPAGE_CURVE = 3;
    uint8 public constant SIGNAL_FEE_RETURN = 4;
    uint8 public constant SIGNAL_ACTIVITY_CONTINUITY = 5;
    uint8 public constant SIGNAL_LP_CONCENTRATION = 6;

    struct Verdict {
        uint8 rating;
        uint16 confidenceBp;
        uint8 failMask;
        uint8 warnMask;
        uint64 assessedAt;
        bytes32 evidenceHash;
        /// @dev Block timestamp of settlement, as distinct from `assessedAt`.
        ///      The two differ by however long the DON took, and conflating
        ///      them would let a stale verdict look fresh.
        uint64 settledAt;
    }

    address public immutable owner;

    address public forwarder;
    address public expectedAuthor;
    bytes32 public expectedWorkflowId;

    /// @notice Latest verdict per pool. Keyed by the pool address the enclave judged.
    mapping(address pool => Verdict) private _verdicts;
    /// @notice Every pool that has ever settled, so the set is enumerable off chain.
    address[] private _pools;
    mapping(address pool => bool) private _known;

    event VerdictSettled(
        address indexed pool,
        uint8 indexed rating,
        uint16 confidenceBp,
        uint8 failMask,
        uint8 warnMask,
        uint64 assessedAt,
        bytes32 evidenceHash
    );
    event ForwarderUpdated(address indexed previous, address indexed next);
    event ExpectedAuthorUpdated(address indexed previous, address indexed next);
    event ExpectedWorkflowIdUpdated(bytes32 indexed previous, bytes32 indexed next);

    error ForwarderRequired();
    error NotOwner(address caller);
    error NotForwarder(address caller, address expected);
    error WrongAuthor(address received, address expected);
    error WrongWorkflow(bytes32 received, bytes32 expected);
    error UnknownRating(uint8 rating);
    error ConfidenceOutOfRange(uint16 confidenceBp);
    error NoVerdict(address pool);
    /// @dev Two verdicts over the same evidence should agree, so a *later*
    ///      `assessedAt` is what distinguishes a new judgement from a replay.
    error StaleVerdict(uint64 incoming, uint64 stored);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @param _forwarder The CRE Forwarder for this chain. On Sepolia:
    ///        0xF8344CFd5c43616a4366C34E3EEE75af79a74482.
    constructor(address _forwarder) {
        if (_forwarder == address(0)) revert ForwarderRequired();
        owner = msg.sender;
        forwarder = _forwarder;
        emit ForwarderUpdated(address(0), _forwarder);
    }

    // --- Delivery ----------------------------------------------------------

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender, forwarder);

        if (expectedAuthor != address(0) || expectedWorkflowId != bytes32(0)) {
            (bytes32 workflowId,, address workflowOwner) = _decodeMetadata(metadata);
            if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
                revert WrongWorkflow(workflowId, expectedWorkflowId);
            }
            if (expectedAuthor != address(0) && workflowOwner != expectedAuthor) {
                revert WrongAuthor(workflowOwner, expectedAuthor);
            }
        }

        _settle(report);
    }

    function _settle(bytes calldata report) private {
        (
            address pool,
            uint8 rating,
            uint16 confidenceBp,
            uint8 failMask,
            uint8 warnMask,
            uint64 assessedAt,
            bytes32 evidenceHash
        ) = abi.decode(report, (address, uint8, uint16, uint8, uint8, uint64, bytes32));

        // Validate rather than trust. The Forwarder proves *who* signed, not
        // that the payload is well-formed, and a rating of 7 stored silently
        // would be read by every consumer as "not ACCEPTABLE" — an unknown
        // value must not be able to masquerade as a judgement.
        if (rating > RATING_INSUFFICIENT_DATA) revert UnknownRating(rating);
        if (confidenceBp > 10_000) revert ConfidenceOutOfRange(confidenceBp);

        Verdict storage stored = _verdicts[pool];
        if (stored.assessedAt != 0 && assessedAt <= stored.assessedAt) {
            revert StaleVerdict(assessedAt, stored.assessedAt);
        }

        if (!_known[pool]) {
            _known[pool] = true;
            _pools.push(pool);
        }

        _verdicts[pool] = Verdict({
            rating: rating,
            confidenceBp: confidenceBp,
            failMask: failMask,
            warnMask: warnMask,
            assessedAt: assessedAt,
            evidenceHash: evidenceHash,
            settledAt: uint64(block.timestamp)
        });

        emit VerdictSettled(pool, rating, confidenceBp, failMask, warnMask, assessedAt, evidenceHash);
    }

    // --- Reads -------------------------------------------------------------

    /// @notice The latest verdict for a pool. Reverts if there is none, rather
    ///         than returning a zero struct — a zeroed `Verdict` decodes as
    ///         `ACCEPTABLE` at 0% confidence, which is the single most dangerous
    ///         thing this contract could hand back for a pool nobody has judged.
    function verdictOf(address pool) external view returns (Verdict memory) {
        Verdict memory verdict = _verdicts[pool];
        if (verdict.assessedAt == 0) revert NoVerdict(pool);
        return verdict;
    }

    function hasVerdict(address pool) external view returns (bool) {
        return _verdicts[pool].assessedAt != 0;
    }

    /// @notice Does the stored verdict commit to exactly these evidence bytes?
    /// @dev The buyer's half of the trade: they hold the bundle the enclave
    ///      scored, hash it, and ask the chain. This is a view over data they
    ///      already have — it reveals nothing to a caller who does not.
    function verdictCommitsTo(address pool, bytes32 evidenceHash) external view returns (bool) {
        Verdict memory verdict = _verdicts[pool];
        return verdict.assessedAt != 0 && verdict.evidenceHash == evidenceHash;
    }

    function signalFailed(address pool, uint8 bit) external view returns (bool) {
        return (_verdicts[pool].failMask & (uint8(1) << bit)) != 0;
    }

    function signalWarned(address pool, uint8 bit) external view returns (bool) {
        return (_verdicts[pool].warnMask & (uint8(1) << bit)) != 0;
    }

    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    function poolAt(uint256 index) external view returns (address) {
        return _pools[index];
    }

    /// @notice Whether the workflow-identity gates are actually switched on.
    /// @dev Deliberately public and deliberately blunt. Both gates default off
    ///      because the workflow id does not exist until the workflow is
    ///      registered, which means every deployment spends a window accepting
    ///      any report the Forwarder delivers. A reader should be able to see
    ///      whether that window was ever closed without reading three getters
    ///      and knowing that zero means "off".
    function verdictsAreGated() external view returns (bool) {
        return expectedAuthor != address(0) || expectedWorkflowId != bytes32(0);
    }

    // --- Administration ----------------------------------------------------

    function setForwarder(address _forwarder) external onlyOwner {
        if (_forwarder == address(0)) revert ForwarderRequired();
        emit ForwarderUpdated(forwarder, _forwarder);
        forwarder = _forwarder;
    }

    function setExpectedAuthor(address _author) external onlyOwner {
        emit ExpectedAuthorUpdated(expectedAuthor, _author);
        expectedAuthor = _author;
    }

    function setExpectedWorkflowId(bytes32 _workflowId) external onlyOwner {
        emit ExpectedWorkflowIdUpdated(expectedWorkflowId, _workflowId);
        expectedWorkflowId = _workflowId;
    }

    // --- Plumbing ----------------------------------------------------------

    /// @dev `metadata` is packed, not ABI-encoded: 32 bytes of workflow id, then
    ///      10 bytes of workflow name, then 20 bytes of owner address, with no
    ///      offset word and no padding. `abi.decode` cannot read that layout.
    function _decodeMetadata(bytes memory metadata)
        internal
        pure
        returns (bytes32 workflowId, bytes10 workflowName, address workflowOwner)
    {
        assembly {
            workflowId := mload(add(metadata, 32))
            workflowName := mload(add(metadata, 64))
            workflowOwner := shr(mul(12, 8), mload(add(metadata, 74)))
        }
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
