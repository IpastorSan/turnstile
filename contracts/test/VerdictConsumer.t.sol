// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {VerdictConsumer, IReceiver, IERC165} from "../src/VerdictConsumer.sol";

/// @dev The Forwarder builds `metadata` by packing, not by ABI-encoding, so the
///      tests have to pack it the same way or `_decodeMetadata` reads garbage
///      and every identity gate passes for the wrong reason.
library ReportMetadata {
    function pack(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(workflowId, workflowName, workflowOwner);
    }
}

contract VerdictConsumerTest is Test {
    VerdictConsumer internal consumer;

    address internal constant FORWARDER = address(0xF0);
    address internal constant AUTHOR = address(0xA1);
    address internal constant POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    bytes32 internal constant WORKFLOW_ID = keccak256("turnstile-analyst-verdict");
    bytes10 internal constant WORKFLOW_NAME = bytes10("a1b2c3d4e5");

    /// @dev keccak256 over the 9,218-byte AnalystInput for USDC/WETH 0.05%
    ///      captured on 2026-09-07, as computed inside the enclave and printed
    ///      by `cre workflow simulate`. Pinned rather than invented so the
    ///      encoding this test asserts is the one that actually ran.
    bytes32 internal constant EVIDENCE_HASH =
        0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2;

    function setUp() public {
        consumer = new VerdictConsumer(FORWARDER, address(this));
    }

    // --- helpers -----------------------------------------------------------

    function _report(
        address pool,
        uint8 rating,
        uint16 confidenceBp,
        uint8 failMask,
        uint8 warnMask,
        uint64 assessedAt,
        bytes32 evidenceHash
    ) internal pure returns (bytes memory) {
        return abi.encode(pool, rating, confidenceBp, failMask, warnMask, assessedAt, evidenceHash);
    }

    function _metadata() internal pure returns (bytes memory) {
        return ReportMetadata.pack(WORKFLOW_ID, WORKFLOW_NAME, AUTHOR);
    }

    function _deliver(bytes memory report) internal {
        vm.prank(FORWARDER);
        consumer.onReport(_metadata(), report);
    }

    // --- construction ------------------------------------------------------

    function test_constructorRejectsZeroForwarder() public {
        vm.expectRevert(VerdictConsumer.ForwarderRequired.selector);
        new VerdictConsumer(address(0), address(this));
    }

    /// @dev Deploying through the canonical CREATE2 factory makes `msg.sender`
    ///      in the constructor the factory itself, so the owner has to be
    ///      passed in. Rejecting the zero address stops the ownerless variant
    ///      of that mistake — a consumer whose gates can never be closed.
    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(VerdictConsumer.OwnerRequired.selector);
        new VerdictConsumer(FORWARDER, address(0));
    }

    function test_theOwnerIsTheOnePassedIn() public {
        VerdictConsumer other = new VerdictConsumer(FORWARDER, AUTHOR);
        assertEq(other.owner(), AUTHOR);
    }

    function test_supportsTheReceiverInterface() public view {
        assertTrue(consumer.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(consumer.supportsInterface(type(IERC165).interfaceId));
        assertFalse(consumer.supportsInterface(bytes4(0xdeadbeef)));
    }

    // --- the happy path ----------------------------------------------------

    function test_settlesTheCompactVerdict() public {
        // CAUTION at 75%, warning on depth-vs-tvl (bit 2) and slippage-curve
        // (bit 3) — the exact verdict the enclave returned for USDC/WETH 0.05%
        // under the sealed calibration.
        uint8 warnMask = uint8((1 << 2) | (1 << 3));
        _deliver(_report(POOL, 1, 7500, 0, warnMask, 1_757_260_000, EVIDENCE_HASH));

        VerdictConsumer.Verdict memory v = consumer.verdictOf(POOL);
        assertEq(v.rating, consumer.RATING_CAUTION());
        assertEq(v.confidenceBp, 7500);
        assertEq(v.failMask, 0);
        assertEq(v.warnMask, warnMask);
        assertEq(v.assessedAt, 1_757_260_000);
        assertEq(v.evidenceHash, EVIDENCE_HASH);
        assertEq(v.settledAt, uint64(block.timestamp));

        assertTrue(consumer.signalWarned(POOL, consumer.SIGNAL_DEPTH_VS_TVL()));
        assertTrue(consumer.signalWarned(POOL, consumer.SIGNAL_SLIPPAGE_CURVE()));
        assertFalse(consumer.signalWarned(POOL, consumer.SIGNAL_EXECUTABLE_DEPTH()));
        assertFalse(consumer.signalFailed(POOL, consumer.SIGNAL_DEPTH_VS_TVL()));
    }

    function test_emitsTheSettlementEvent() public {
        vm.expectEmit(true, true, true, true);
        emit VerdictConsumer.VerdictSettled(POOL, 2, 1400, uint8(0x47), 0, 1_757_260_000, EVIDENCE_HASH);
        _deliver(_report(POOL, 2, 1400, uint8(0x47), 0, 1_757_260_000, EVIDENCE_HASH));
    }

    /// @dev The fake-USDT pool: AVOID at 14%, failing inventory-balance (0),
    ///      executable-depth (1), depth-vs-tvl (2) and lp-concentration (6).
    ///      Bits 0,1,2,6 == 0x47.
    function test_theFailMaskNamesTheFailedSignals() public {
        _deliver(_report(POOL, 2, 1400, uint8(0x47), 0, 1_757_260_000, EVIDENCE_HASH));

        assertTrue(consumer.signalFailed(POOL, consumer.SIGNAL_INVENTORY_BALANCE()));
        assertTrue(consumer.signalFailed(POOL, consumer.SIGNAL_EXECUTABLE_DEPTH()));
        assertTrue(consumer.signalFailed(POOL, consumer.SIGNAL_DEPTH_VS_TVL()));
        assertTrue(consumer.signalFailed(POOL, consumer.SIGNAL_LP_CONCENTRATION()));
        assertFalse(consumer.signalFailed(POOL, consumer.SIGNAL_SLIPPAGE_CURVE()));
        assertFalse(consumer.signalFailed(POOL, consumer.SIGNAL_FEE_RETURN()));
        assertFalse(consumer.signalFailed(POOL, consumer.SIGNAL_ACTIVITY_CONTINUITY()));
    }

    // --- the evidence commitment -------------------------------------------

    function test_theEvidenceHashIsWhatMakesTheVerdictCheckable() public {
        _deliver(_report(POOL, 1, 7500, 0, 0, 1_757_260_000, EVIDENCE_HASH));

        // The buyer holds the bundle and hashes it: match.
        assertTrue(consumer.verdictCommitsTo(POOL, EVIDENCE_HASH));
        // A seller who re-scored different evidence cannot pass this.
        assertFalse(consumer.verdictCommitsTo(POOL, keccak256("some other bundle")));
        // And an unjudged pool commits to nothing, rather than to zero.
        assertFalse(consumer.verdictCommitsTo(address(0xBEEF), bytes32(0)));
    }

    // --- who may write -----------------------------------------------------

    function test_onlyTheForwarderMayDeliver() public {
        bytes memory report = _report(POOL, 0, 9000, 0, 0, 1_757_260_000, EVIDENCE_HASH);
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(VerdictConsumer.NotForwarder.selector, address(0xBAD), FORWARDER)
        );
        consumer.onReport(_metadata(), report);
    }

    function test_theWorkflowIdGateRejectsAnotherWorkflow() public {
        consumer.setExpectedWorkflowId(WORKFLOW_ID);

        bytes memory wrong = ReportMetadata.pack(keccak256("someone-elses-workflow"), WORKFLOW_NAME, AUTHOR);
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerdictConsumer.WrongWorkflow.selector, keccak256("someone-elses-workflow"), WORKFLOW_ID
            )
        );
        consumer.onReport(wrong, _report(POOL, 0, 9000, 0, 0, 1_757_260_000, EVIDENCE_HASH));
    }

    function test_theAuthorGateRejectsAnotherOwner() public {
        consumer.setExpectedAuthor(AUTHOR);

        bytes memory wrong = ReportMetadata.pack(WORKFLOW_ID, WORKFLOW_NAME, address(0xBAD));
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictConsumer.WrongAuthor.selector, address(0xBAD), AUTHOR)
        );
        consumer.onReport(wrong, _report(POOL, 0, 9000, 0, 0, 1_757_260_000, EVIDENCE_HASH));
    }

    function test_bothGatesPassForTheRealWorkflow() public {
        consumer.setExpectedAuthor(AUTHOR);
        consumer.setExpectedWorkflowId(WORKFLOW_ID);
        assertTrue(consumer.verdictsAreGated());

        _deliver(_report(POOL, 1, 7500, 0, 0, 1_757_260_000, EVIDENCE_HASH));
        assertTrue(consumer.hasVerdict(POOL));
    }

    function test_aFreshDeploymentSaysItIsUngated() public view {
        // The window between deploying and registering the workflow is real and
        // this is the getter that makes it visible.
        assertFalse(consumer.verdictsAreGated());
    }

    function test_onlyTheOwnerMayChangeTheGates() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(VerdictConsumer.NotOwner.selector, address(0xBAD)));
        consumer.setExpectedAuthor(AUTHOR);
        vm.expectRevert(abi.encodeWithSelector(VerdictConsumer.NotOwner.selector, address(0xBAD)));
        consumer.setExpectedWorkflowId(WORKFLOW_ID);
        vm.expectRevert(abi.encodeWithSelector(VerdictConsumer.NotOwner.selector, address(0xBAD)));
        consumer.setForwarder(address(0xF1));
        vm.stopPrank();
    }

    function test_theForwarderCannotBeUnsetToZero() public {
        vm.expectRevert(VerdictConsumer.ForwarderRequired.selector);
        consumer.setForwarder(address(0));
    }

    // --- what a malformed report may not do --------------------------------

    function test_anUnknownRatingIsRejectedRatherThanStored() public {
        // The danger this defends: a rating of 7 stored silently reads as
        // "not ACCEPTABLE" to every consumer, so it would look like a judgement.
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(VerdictConsumer.UnknownRating.selector, uint8(7)));
        consumer.onReport(_metadata(), _report(POOL, 7, 9000, 0, 0, 1_757_260_000, EVIDENCE_HASH));
    }

    function test_confidenceAboveOneHundredPercentIsRejected() public {
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictConsumer.ConfidenceOutOfRange.selector, uint16(10_001))
        );
        consumer.onReport(_metadata(), _report(POOL, 0, 10_001, 0, 0, 1_757_260_000, EVIDENCE_HASH));
    }

    function test_anUnjudgedPoolRevertsRatherThanReadingAsAcceptable() public {
        // A zeroed Verdict struct decodes as ACCEPTABLE at 0% confidence, which
        // is the worst possible default for a pool nobody has assessed.
        vm.expectRevert(abi.encodeWithSelector(VerdictConsumer.NoVerdict.selector, POOL));
        consumer.verdictOf(POOL);
        assertFalse(consumer.hasVerdict(POOL));
    }

    // --- replay and ordering -----------------------------------------------

    function test_aLaterAssessmentReplacesAnEarlierOne() public {
        _deliver(_report(POOL, 0, 9000, 0, 0, 1_757_260_000, EVIDENCE_HASH));
        _deliver(_report(POOL, 2, 4000, uint8(1 << 1), 0, 1_757_263_600, keccak256("fresher bundle")));

        VerdictConsumer.Verdict memory v = consumer.verdictOf(POOL);
        assertEq(v.rating, consumer.RATING_AVOID());
        assertEq(v.assessedAt, 1_757_263_600);
        assertEq(v.evidenceHash, keccak256("fresher bundle"));
        // Still one pool, not two.
        assertEq(consumer.poolCount(), 1);
    }

    function test_replayingAnOlderVerdictIsRejected() public {
        _deliver(_report(POOL, 2, 4000, 0, 0, 1_757_263_600, EVIDENCE_HASH));

        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerdictConsumer.StaleVerdict.selector, uint64(1_757_260_000), uint64(1_757_263_600)
            )
        );
        consumer.onReport(_metadata(), _report(POOL, 0, 9000, 0, 0, 1_757_260_000, EVIDENCE_HASH));
    }

    function test_replayingTheSameVerdictIsRejected() public {
        bytes memory report = _report(POOL, 1, 7500, 0, 0, 1_757_260_000, EVIDENCE_HASH);
        _deliver(report);

        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerdictConsumer.StaleVerdict.selector, uint64(1_757_260_000), uint64(1_757_260_000)
            )
        );
        consumer.onReport(_metadata(), report);
    }

    // --- enumeration -------------------------------------------------------

    function test_poolsAreEnumerableInSettlementOrder() public {
        address second = address(0x3dcB9530EEA449E6E8AcE451419CFAf6F9b72394);
        _deliver(_report(POOL, 1, 7500, 0, 0, 1_757_260_000, EVIDENCE_HASH));
        _deliver(_report(second, 2, 1400, uint8(0x47), 0, 1_757_260_000, keccak256("fake usdt")));

        assertEq(consumer.poolCount(), 2);
        assertEq(consumer.poolAt(0), POOL);
        assertEq(consumer.poolAt(1), second);
    }

    // --- fuzz --------------------------------------------------------------

    function testFuzz_anyWellFormedVerdictRoundTrips(
        address pool,
        uint8 rating,
        uint16 confidenceBp,
        uint8 failMask,
        uint8 warnMask,
        uint64 assessedAt,
        bytes32 evidenceHash
    ) public {
        rating = uint8(bound(rating, 0, 3));
        confidenceBp = uint16(bound(confidenceBp, 0, 10_000));
        assessedAt = uint64(bound(assessedAt, 1, type(uint64).max));

        _deliver(_report(pool, rating, confidenceBp, failMask, warnMask, assessedAt, evidenceHash));

        VerdictConsumer.Verdict memory v = consumer.verdictOf(pool);
        assertEq(v.rating, rating);
        assertEq(v.confidenceBp, confidenceBp);
        assertEq(v.failMask, failMask);
        assertEq(v.warnMask, warnMask);
        assertEq(v.assessedAt, assessedAt);
        assertEq(v.evidenceHash, evidenceHash);
        assertTrue(consumer.verdictCommitsTo(pool, evidenceHash));
    }

    function testFuzz_aRatingOutsideTheEnumIsAlwaysRejected(uint8 rating) public {
        rating = uint8(bound(rating, 4, type(uint8).max));
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(VerdictConsumer.UnknownRating.selector, rating));
        consumer.onReport(_metadata(), _report(POOL, rating, 9000, 0, 0, 1_757_260_000, EVIDENCE_HASH));
    }
}
