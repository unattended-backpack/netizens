// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { NetizenBridgeL2 } from "../src/NetizenBridgeL2.sol";
import { NetizenL1 } from "../src/NetizenL1.sol";
import { MockCrossDomainMessenger } from "./mocks/MockCrossDomainMessenger.sol";
import { MockWCN } from "./mocks/MockWCN.sol";
import { Test } from "forge-std/Test.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title NetizenBridgeTest
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Foundry unit-test suite covering the NetizenL1 collection and the
  NetizenBridgeL2 bridge: bridging, finalization, ETH forwarding, royalties,
  metadata locking, and ERC-721C transfer validation.

  @custom:date June 22nd, 2026.
*/
contract NetizenBridgeTest is
  Test {

  /**
    Emitted on L1 when a bridged token is minted to its recipient.

    @param to The address receiving the finalized token.
    @param tokenId The id of the minted token.
  */
  event BridgeFinalized (
    address indexed to,
    uint256 indexed tokenId
  );

  /**
    Emitted on L1 when a token id is skipped during finalization.

    @param tokenId The id of the skipped token.
  */
  event BridgeSkipped (
    uint256 indexed tokenId
  );

  /**
    Emitted on L2 when a bridge transfer is initiated.

    @param from The address initiating the bridge.
    @param l1Recipient The address to receive the tokens and ETH on L1.
    @param tokenIds The token ids being bridged.
    @param ethAmount The amount of ETH forwarded with the bridge.
  */
  event BridgeInitiated (
    address indexed from,
    address indexed l1Recipient,
    uint256[] tokenIds,
    uint256 ethAmount
  );

  /**
    Emitted when the collection's contract-level URI is updated.
  */
  event ContractURIUpdated ();

  /**
    Emitted when the token base URI is permanently locked.
  */
  event BaseURILocked ();

  /**
    ERC-4906 event signaling that metadata changed for a range of token ids.

    @param fromTokenId The first token id in the updated range.
    @param toTokenId The last token id in the updated range.
  */
  event BatchMetadataUpdate (
    uint256 fromTokenId,
    uint256 toTokenId
  );

  /// The mock WCN ERC-721 collection on L2.
  MockWCN wcn;

  /// The mock L2 cross-domain messenger.
  MockCrossDomainMessenger l2msgr;

  /// The mock L1 cross-domain messenger.
  MockCrossDomainMessenger l1msgr;

  /// The L2 bridge under test.
  NetizenBridgeL2 bridge;

  /// The L1 Netizen collection under test.
  NetizenL1 l1;

  /// The contract owner test address.
  address owner = makeAddr("owner");

  /// A token-holding test user.
  address alice = makeAddr("alice");

  /// A secondary test user.
  address bob = makeAddr("bob");

  /// The default L1 recipient test address.
  address l1recipient = makeAddr("l1recipient");

  /// The shared IPFS base URI for token metadata.
  string constant BASE =
    "ipfs://bafybeiabi7zjyuo7je4blxba6liprvhht6lcvk2psklin3woty4d4p4274/";

  /**
    Deploy the mock messengers and the L1/L2 contracts, wire the trusted bridge,
    and mint the starting tokens used across the suite.
  */
  function setUp () public {
    wcn = new MockWCN();
    l2msgr = new MockCrossDomainMessenger();
    l1msgr = new MockCrossDomainMessenger();

    // Deploy order mirrors the real wiring: L1 first (l2Bridge unset)...
    l1 = new NetizenL1(address(l1msgr), owner, BASE);

    // ...then the L2 bridge pointing at the L1 contract...
    bridge = new NetizenBridgeL2(address(wcn), address(l2msgr), address(l1));

    // ...then bind the trusted L2 bridge on L1.
    vm.prank(owner);
    l1.setL2Bridge(address(bridge));
    wcn.mint(alice, 1);
    wcn.mint(alice, 2);
    wcn.mint(bob, 3);
  }

  /**
    ABI-encode a string as standard `Error(string)` revert data.

    @param _s The revert reason message to encode.

    @return _ The encoded `Error(string)` revert data.
  */
  function _err (
    string memory _s
  ) internal pure returns (bytes memory) {
    return abi.encodeWithSignature("Error(string)", _s);
  }

  /**
    Build a single-element token id array.

    @param _a The token id to place in the array.

    @return _ A one-element array containing `_a`.
  */
  function _ids (
    uint256 _a
  ) internal pure returns (uint256[] memory) {
    uint256[] memory _r = new uint256[](1);
    _r[0] = _a;
    return _r;
  }

  /**
    Build a two-element token id array.

    @param _a The first token id.
    @param _b The second token id.

    @return _ A two-element array containing `_a` and `_b`.
  */
  function _ids (
    uint256 _a,
    uint256 _b
  ) internal pure returns (uint256[] memory) {
    uint256[] memory _r = new uint256[](2);
    _r[0] = _a;
    _r[1] = _b;
    return _r;
  }

  /// Relay whatever the L2 bridge last sent, as the L1 messenger would.
  function _relayLast () internal {
    l1msgr.relay(address(bridge), l2msgr.lastTarget(), l2msgr.lastMessage());
  }

  /**
    Bridging burns the L2 token and sends exactly one cross-domain message to L1
    with the dynamic gas budget.
  */
  function test_Bridge_BurnsTokenAndSendsMessage () public {
    vm.startPrank(alice);
    wcn.approve(address(bridge), 1);
    vm.expectEmit(true, true, false, true, address(bridge));
    emit BridgeInitiated(alice, l1recipient, _ids(1), 0);
    bridge.bridge(_ids(1), l1recipient);
    vm.stopPrank();

    // Token is burned on L2.
    vm.expectRevert();
    wcn.ownerOf(1);

    // Exactly one message, to the L1 contract, with the dynamic gas budget.
    assertEq(l2msgr.sendCount(), 1);
    assertEq(l2msgr.lastTarget(), address(l1));
    assertEq(
      uint256(l2msgr.lastMinGasLimit()),
      uint256(bridge.BASE_GAS()) + uint256(bridge.PER_TOKEN_GAS())
    );
  }

  /**
    A multi-token batch bridges end to end, minting every token to the recipient
    on L1.
  */
  function test_Bridge_BatchEndToEnd () public {
    vm.startPrank(alice);
    wcn.setApprovalForAll(address(bridge), true);
    bridge.bridge(_ids(1, 2), l1recipient);
    vm.stopPrank();
    _relayLast();
    assertEq(l1.ownerOf(1), l1recipient);
    assertEq(l1.ownerOf(2), l1recipient);
    assertEq(l1.totalSupply(), 2);
  }

  /// Bridging a token the caller does not own reverts.
  function test_Revert_BridgeNotTokenOwner () public {

    // alice approves for all, but bob (a non-owner) cannot bridge her token.
    vm.prank(alice);
    wcn.setApprovalForAll(address(bridge), true);
    vm.prank(bob);
    vm.expectRevert(_err("NetizenBridgeL2: not token owner"));
    bridge.bridge(_ids(1), bob);
  }

  /// Bridging a token without approving the bridge reverts.
  function test_Revert_BridgeWithoutApproval () public {

    // alice owns token 1 but never approved the bridge => burn reverts.
    vm.prank(alice);

    // OZ ERC721InsufficientApproval
    vm.expectRevert();
    bridge.bridge(_ids(1), l1recipient);
  }

  /// Bridging to the zero address reverts.
  function test_Revert_ZeroRecipient () public {
    vm.prank(alice);
    vm.expectRevert(_err("NetizenBridgeL2: zero recipient"));
    bridge.bridge(_ids(1), address(0));
  }

  /// Bridging with no tokens and no ETH is a true no-op and reverts.
  function test_Revert_NothingToBridge () public {

    /*
      Empty tokenIds AND zero value is a true no-op => reverts. (Empty tokenIds
      WITH value is allowed — that's the ETH-only sweep, covered below.)
    */
    vm.prank(alice);
    vm.expectRevert(_err("NetizenBridgeL2: nothing to bridge"));
    bridge.bridge(new uint256[](0), l1recipient);
  }

  /// Bridging a batch larger than the maximum allowed size reverts.
  function test_Revert_BatchTooLarge () public {
    uint256[] memory _big = new uint256[](401);
    vm.prank(alice);
    vm.expectRevert(_err("NetizenBridgeL2: bad batch size"));
    bridge.bridge(_big, l1recipient);
  }

  /// finalizeBridge reverts when not called through the cross-domain messenger.
  function test_Revert_FinalizeNotFromMessenger () public {
    vm.expectRevert(_err("NetizenL1: not messenger"));
    l1.finalizeBridge(l1recipient, _ids(1));
  }

  /**
    finalizeBridge reverts when the cross-domain sender is not the trusted L2
    bridge.
  */
  function test_Revert_FinalizeWrongXDomainSender () public {
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(1)));

    // Relayed by the messenger, but the L2 sender is not the trusted bridge.
    vm.expectRevert(_err("NetizenL1: not L2 bridge"));
    l1msgr.relay(bob, address(l1), _message);
  }

  /**
    A valid finalize mints the token to the recipient and emits BridgeFinalized.
  */
  function test_Finalize_MintsToRecipient () public {
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(7)));
    vm.expectEmit(true, true, false, false, address(l1));
    emit BridgeFinalized(l1recipient, 7);
    l1msgr.relay(address(bridge), address(l1), _message);
    assertEq(l1.ownerOf(7), l1recipient);
    assertEq(l1.totalSupply(), 1);
  }

  /**
    Replaying a finalize for an already-minted token skips it without reverting
    and leaves state unchanged.
  */
  function test_Finalize_SkipsExistingTokenIdempotently () public {
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(7)));
    l1msgr.relay(address(bridge), address(l1), _message);
    assertEq(l1.totalSupply(), 1);

    /*
      A replay of the same message must NOT revert (would brick the batch and
      lose already-burned tokens); it skips and leaves state unchanged.
    */
    vm.expectEmit(true, false, false, false, address(l1));
    emit BridgeSkipped(7);
    l1msgr.relay(address(bridge), address(l1), _message);
    assertEq(l1.ownerOf(7), l1recipient);
    assertEq(l1.totalSupply(), 1);
  }

  /**
    Finalize skips out-of-range token ids while still minting valid ones in the
    same batch.
  */
  function test_Finalize_SkipsOutOfRangeTokenId () public {

    /*
      A batch mixing a valid id with out-of-range ids (0 and > MAX_SUPPLY): the
      valid id mints; the out-of-range ones are skipped — never minted, never
      reverting.
    */
    uint256 _aboveRange = l1.MAX_SUPPLY() + 1;
    uint256[] memory _batch = new uint256[](3);

    // below range (WCN is 1-indexed)
    _batch[0] = 0;

    // valid
    _batch[1] = 9;

    // above range
    _batch[2] = _aboveRange;
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (alice, _batch));

    // must not revert
    l1msgr.relay(address(bridge), address(l1), _message);
    assertEq(l1.ownerOf(9), alice, "valid id minted");
    assertEq(l1.totalSupply(), 1, "only the valid id counted");
    vm.expectRevert();
    l1.ownerOf(0);
    vm.expectRevert();
    l1.ownerOf(_aboveRange);
  }

  /**
    A batch mixing an already-minted id with a new id mints the new one without
    reverting.
  */
  function test_Finalize_PartialBatchDoesNotBrick () public {

    // Mint id 5 first.
    l1msgr.relay(
      address(bridge), address(l1),
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(5)))
    );

    /*
      Now relay a batch containing the existing 5 and a new 6: 5 is skipped, 6
      is minted, no revert.
    */
    l1msgr.relay(
      address(bridge), address(l1),
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(5, 6)))
    );
    assertEq(l1.ownerOf(6), l1recipient);
    assertEq(l1.totalSupply(), 2);
  }

  /// A finalized token's URI matches the origin base URI scheme.
  function test_TokenURIParityWithOrigin () public {
    l1msgr.relay(
      address(bridge), address(l1),
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(42)))
    );
    assertEq(l1.tokenURI(42), string.concat(BASE, "42"));
  }

  /// The L1 max supply, name, and symbol match the expected collection values.
  function test_MaxSupplyParity () public view {
    assertEq(l1.maxSupply(), 4520);
    assertEq(l1.name(), "World Computer Netizens");
    assertEq(l1.symbol(), "WCN");
  }

  /// The L2 bridge address can only be set once.
  function test_SetL2Bridge_OnlyOnce () public {
    vm.prank(owner);
    vm.expectRevert(_err("NetizenL1: bridge already set"));
    l1.setL2Bridge(address(0xBEEF));
  }

  /// Only the owner can set the L2 bridge address.
  function test_SetL2Bridge_OnlyOwner () public {
    NetizenL1 _fresh =
      new NetizenL1(address(l1msgr), owner, BASE);
    vm.prank(alice);

    // OZ OwnableUnauthorizedAccount
    vm.expectRevert();
    _fresh.setL2Bridge(address(bridge));
  }

  /// Finalize reverts while the L2 bridge is still unset.
  function test_Finalize_RevertsWhileBridgeUnset () public {
    NetizenL1 _fresh =
      new NetizenL1(address(l1msgr), owner, BASE);

    // l2Bridge unset => any relay fails the auth check.
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(1)));
    vm.expectRevert(_err("NetizenL1: not L2 bridge"));
    l1msgr.relay(address(bridge), address(_fresh), _message);
  }

  /**
    ETH sent with bridge rides the single cross-domain message, with no separate
    withdrawal.
  */
  function test_Bridge_ForwardsEthValueToMessage () public {
    vm.deal(alice, 5 ether);
    vm.startPrank(alice);
    wcn.approve(address(bridge), 1);
    bridge.bridge{ value: 1 ether }(_ids(1), l1recipient);
    vm.stopPrank();

    // ETH rode the single sendMessage call (no separate withdrawal).
    assertEq(l2msgr.lastValue(), 1 ether);
    assertEq(l2msgr.sendCount(), 1);
    assertEq(address(l2msgr).balance, 1 ether);
  }

  /**
    An ETH-only bridge with no tokens sweeps ETH home over one message and mints
    nothing.
  */
  function test_Bridge_EthOnly_NoTokens () public {

    /*
      A holder with no Netizens (or who already bridged them all) can still
      sweep ETH home: empty tokenIds + msg.value > 0 is allowed and rides one
      cross-domain message.
    */
    vm.deal(alice, 5 ether);
    vm.startPrank(alice);
    vm.expectEmit(true, true, false, true, address(bridge));
    emit BridgeInitiated(alice, l1recipient, new uint256[](0), 1 ether);
    bridge.bridge{ value: 1 ether }(new uint256[](0), l1recipient);
    vm.stopPrank();
    assertEq(l2msgr.sendCount(), 1);
    assertEq(l2msgr.lastTarget(), address(l1));
    assertEq(l2msgr.lastValue(), 1 ether);

    // Finalize delivers the ETH and mints nothing.
    l1msgr.relay{ value: 1 ether }(
      address(bridge), l2msgr.lastTarget(), l2msgr.lastMessage()
    );
    assertEq(l1recipient.balance, 1 ether);
    assertEq(l1.totalSupply(), 0);
  }

  /// Finalize forwards attached ETH straight through to an EOA recipient.
  function test_Finalize_ForwardsEthToEoaRecipient () public {
    vm.deal(address(this), 5 ether);
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (l1recipient, _ids(7)));
    l1msgr.relay{ value: 2 ether }(address(bridge), address(l1), _message);
    assertEq(l1.ownerOf(7), l1recipient);

    // pushed straight through
    assertEq(l1recipient.balance, 2 ether);
  }

  /**
    Finalize force-delivers ETH to a gas-hungry recipient, with the mint
    succeeding and nothing stranded in the contract.
  */
  function test_Finalize_ForceDeliversToHostileRecipient () public {
    GasHungryReceiver r = new GasHungryReceiver();
    vm.deal(address(this), 5 ether);
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (address(r), _ids(8)));

    /*
      Recipient burns more than the friendly gas stipend, so the gas-capped call
      fails — but SafeTransferLib force-sends the ETH anyway. The mint succeeds,
      the recipient receives the full amount, and nothing is stranded in the
      contract.
    */
    l1msgr.relay{ value: 3 ether }(address(bridge), address(l1), _message);
    assertEq(l1.ownerOf(8), address(r), "mint must succeed");
    assertEq(address(r).balance, 3 ether, "ETH force-delivered, no escrow");
    assertEq(address(l1).balance, 0, "nothing stranded in the contract");
  }

  /**
    The immutable 5.6% royalty config, receiver, scaling, and ERC-2981/ERC-721
    interface support are all as expected.
  */
  function test_Royalty_ImmutableFivePointSix () public view {

    // 5.6% in basis points
    assertEq(uint256(l1.ROYALTY_FEE_NUMERATOR()), 560);
    assertEq(l1.ROYALTY_RECEIVER(), 0xe2ab52Af4b18E494F03Ed8519B5E448a48e92Fd0);
    (address _r, uint256 _amt) = l1.royaltyInfo(1, 10_000);
    assertEq(
      _r, l1.ROYALTY_RECEIVER(), "royalty receiver = hardcoded WCN payout"
    );
    assertEq(_amt, 560, "5.6% of 10_000");

    // Scales with sale price: 5.6% of 1 ETH.
    (, uint256 _amt2) = l1.royaltyInfo(1, 1 ether);
    assertEq(_amt2, 0.056 ether);

    /*
      Advertised over ERC-165 alongside ERC721 (no setter exists — it's
      immutable).
    */
    assertTrue(l1.supportsInterface(0x2a55205a), "ERC2981");
    assertTrue(l1.supportsInterface(0x80ac58cd), "ERC721");
  }

  /**
    Locking the base URI freezes token metadata while leaving contractURI
    updatable.
  */
  function test_BaseURI_LockFreezesTokenMetadata () public {

    // Owner can change the base URI before locking.
    vm.prank(owner);
    l1.setBaseURI("ipfs://before/");

    // Lock it (provable): emits BaseURILocked and flips the public flag.
    assertFalse(l1.baseURILocked());
    vm.expectEmit(true, true, true, true, address(l1));
    emit BaseURILocked();
    vm.prank(owner);
    l1.lockBaseURI();
    assertTrue(l1.baseURILocked());

    // After locking, setBaseURI always reverts — even for the owner.
    vm.prank(owner);
    vm.expectRevert(_err("NetizenL1: base URI locked"));
    l1.setBaseURI("ipfs://after/");

    // contractURI stays updatable — only the token base URI is frozen.
    vm.prank(owner);
    l1.setContractURI("ipfs://newcid");
    assertEq(l1.contractURI(), "ipfs://newcid");
  }

  /// Only the owner can lock the base URI.
  function test_BaseURI_OnlyOwnerCanLock () public {

    // Solady Ownable: Unauthorized
    vm.expectRevert();
    l1.lockBaseURI();
  }

  /// Updating the base URI emits the ERC-4906 batch metadata update event.
  function test_BaseURI_EmitsErc4906OnUpdate () public {
    assertTrue(l1.supportsInterface(0x49064906), "ERC-4906");
    vm.expectEmit(true, true, true, true, address(l1));
    emit BatchMetadataUpdate(0, type(uint256).max);
    vm.prank(owner);
    l1.setBaseURI("ipfs://updated/");
  }

  /**
    The contractURI is set at construction and only the owner can update it,
    emitting ContractURIUpdated.
  */
  function test_ContractURI_DefaultAndOwnerUpdate () public {

    // Collection metadata is set at construction (non-empty data URI).
    assertGt(bytes(l1.contractURI()).length, 0);

    // Non-owner cannot change it. Solady Ownable: Unauthorized
    vm.expectRevert();
    l1.setContractURI("ipfs://newcid");

    // Owner can; it emits ContractURIUpdated and updates the stored value.
    vm.expectEmit(true, true, true, true, address(l1));
    emit ContractURIUpdated();
    vm.prank(owner);
    l1.setContractURI("ipfs://newcid");
    assertEq(l1.contractURI(), "ipfs://newcid");
  }

  /**
    With no code at the hardcoded validator address, transfer validation is a
    no-op and ordinary transfers still work.
  */
  function test_C_DefaultValidatorNoOpWhenAbsent () public {

    /*
      The hardcoded v5 validator has no code in the test EVM, so the code.length
      guard makes _beforeTokenTransfer a no-op and ordinary transfers still
      work.
    */
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (alice, _ids(99)));
    l1msgr.relay(address(bridge), address(l1), _message);
    vm.prank(alice);
    l1.transferFrom(alice, bob, 99);
    assertEq(l1.ownerOf(99), bob);
  }

  /**
    The ICreatorToken interface, validation-function selector, and default
    hardcoded validator address are all as expected.
  */
  function test_C_InterfaceAndValidationFunction () public view {
    assertTrue(l1.supportsInterface(0xad0d7f6c), "ICreatorToken");
    (bytes4 _sig, bool _isView) = l1.getTransferValidationFunction();
    assertTrue(_sig == bytes4(0xcaee23ea), "validateTransfer selector");
    assertFalse(_isView);

    /*
      Hardcoded to Limit Break's v5 validator by default (owner can
      re-point/disable).
    */
    assertEq(l1.getTransferValidator(), l1.TRANSFER_VALIDATOR());
    assertEq(
      l1.TRANSFER_VALIDATOR(), 0x721C008fdff27BF06E7E123956E2Fe03B63342e3
    );
  }

  /// Only the owner can set the transfer validator.
  function test_C_OnlyOwnerSetsValidator () public {

    // Solady Ownable: Unauthorized
    vm.expectRevert();
    l1.setTransferValidator(address(0xdead));
  }

  /**
    The transfer validator gates ordinary transfers while bridge mints remain
    exempt.
  */
  function test_C_ValidatorGatesTransfersButNotBridgeMint () public {
    MockTransferValidator _validator = new MockTransferValidator();

    // policy rejects this operator
    _validator.setBlock(true);
    vm.prank(owner);
    l1.setTransferValidator(address(_validator));

    // Bridge mint still succeeds — mints (from == address(0)) are exempt.
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (alice, _ids(7)));
    l1msgr.relay(address(bridge), address(l1), _message);
    assertEq(l1.ownerOf(7), alice, "bridge mint must bypass the validator");

    // A real transfer is now gated → reverts via the validator.
    vm.prank(alice);
    vm.expectRevert(_err("MockValidator: blocked"));
    l1.transferFrom(alice, bob, 7);

    /*
      Allowing it → transfer succeeds, and the validator was actually consulted.
    */
    _validator.setBlock(false);
    vm.prank(alice);
    l1.transferFrom(alice, bob, 7);
    assertEq(l1.ownerOf(7), bob);
    assertGt(_validator.calls(), 0);
  }

  /// Disabling the validator restores unrestricted transfers.
  function test_C_DisablingValidatorRestoresFreeTransfers () public {
    MockTransferValidator _validator = new MockTransferValidator();
    _validator.setBlock(true);
    vm.startPrank(owner);
    l1.setTransferValidator(address(_validator));

    // disable enforcement
    l1.setTransferValidator(address(0));
    vm.stopPrank();
    bytes memory _message =
      abi.encodeCall(NetizenL1.finalizeBridge, (alice, _ids(8)));
    l1msgr.relay(address(bridge), address(l1), _message);
    vm.prank(alice);

    // no validator → free transfer
    l1.transferFrom(alice, bob, 8);
    assertEq(l1.ownerOf(8), bob);
  }
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title MockTransferValidator
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Stand-in for the ERC-721C transfer validator: records calls and, when armed,
  rejects transfers (simulating an operator the collection policy disallows).

  @custom:date June 22nd, 2026.
*/
contract MockTransferValidator {

  /// Whether the validator currently rejects transfers.
  bool public blockTransfers;

  /// The number of times validateTransfer has been called.
  uint256 public calls;

  /**
    Arm or disarm transfer rejection.

    @param _b True to block transfers, false to allow them.
  */
  function setBlock (
    bool _b
  ) external {
    blockTransfers = _b;
  }

  /**
    Record a validation call and revert when blocking is armed.

    @param _caller The operator initiating the transfer (ignored stub param).
    @param _from The current token owner (ignored stub param).
    @param _to The transfer recipient (ignored stub param).
    @param _tokenId The token id being transferred (ignored stub param).
  */
  function validateTransfer (
    address _caller,
    address _from,
    address _to,
    uint256 _tokenId
  ) external {
    ++calls;
    require(!blockTransfers, "MockValidator: blocked");
  }
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title GasHungryReceiver
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Recipient whose receive() consumes more than ETH_PUSH_GAS (50k), so the
  friendly in-finalize call fails and SafeTransferLib's force-send path is
  exercised.

  @custom:date June 22nd, 2026.
*/
contract GasHungryReceiver {

  /// Scratch storage written by receive() to deliberately burn gas.
  uint256[16] private junk;

  receive () external payable {
    for (uint256 i; i < junk.length; ++i) {
      junk[i] = i + 1;
    }
  }
}

