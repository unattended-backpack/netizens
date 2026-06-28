// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { NetizenBridgeL2 } from "../src/NetizenBridgeL2.sol";
import { NetizenL1 } from "../src/NetizenL1.sol";
import { MockDisputeGame } from "./mocks/MockDisputeGame.sol";
import { Test, console2 } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";

/**
  An OP-stack L2-to-L1 withdrawal transaction, as reconstructed from the
  L2ToL1MessagePasser MessagePassed event and replayed against OptimismPortal2.

  @param nonce The withdrawal nonce assigned by the L2 message passer.
  @param sender The L2 sender of the withdrawal (the L2 cross-domain messenger).
  @param target The L1 target of the withdrawal (the L1 cross-domain messenger).
  @param value The ETH value carried by the withdrawal, in wei.
  @param gasLimit The minimum gas the L1 execution must be supplied (baseGas).
  @param data The calldata executed against the target on L1.
*/
struct WithdrawalTx {
  uint256 nonce;
  address sender;
  address target;
  uint256 value;
  uint256 gasLimit;
  bytes data;
}

/**
  The pre-image components that hash together to form an L2 output root, as the
  OptimismPortal2 verifies it during proveWithdrawalTransaction.

  @param version The output root version tag.
  @param stateRoot The L2 state root committed by the output.
  @param messagePasserStorageRoot The storage root of the L2ToL1MessagePasser.
  @param latestBlockhash The hash of the latest L2 block in the output.
*/
struct OutputRootProof {
  bytes32 version;
  bytes32 stateRoot;
  bytes32 messagePasserStorageRoot;
  bytes32 latestBlockhash;
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title IWCNlike
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  A minimal interface for the real World Computer Netizens (WCN) ERC-721
  collection on the MegaETH fork, exposing only what the bridge tests need.

  @custom:date June 22nd, 2026.
*/
interface IWCNlike {

  /**
    Return the current owner of a given token.

    @param _tokenId The token id to query.

    @return _ The address that owns `_tokenId`.
  */
  function ownerOf (
    uint256 _tokenId
  ) external view returns (address);

  /**
    Grant or revoke operator approval over all of the caller's tokens.

    @param _operator The operator whose approval is being set.
    @param _approved Whether the operator is approved for all tokens.
  */
  function setApprovalForAll (
    address _operator,
    bool _approved
  ) external;
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title IOptimismPortal2
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  A minimal interface for the live OptimismPortal2 on L1, exposing the prove and
  finalize entrypoints plus the parameters the fork tests read.

  @custom:date June 22nd, 2026.
*/
interface IOptimismPortal2 {

  /**
    Prove a withdrawal against a dispute game's L2 output root.

    @param _tx The withdrawal transaction being proven.
    @param _disputeGameIndex The index of the dispute game in the factory.
    @param _outputRootProof The output root pre-image committing to the state.
    @param _withdrawalProof The Merkle-Patricia proof of the withdrawal storage.
  */
  function proveWithdrawalTransaction (
    WithdrawalTx memory _tx,
    uint256 _disputeGameIndex,
    OutputRootProof calldata _outputRootProof,
    bytes[] calldata _withdrawalProof
  ) external;

  /**
    Finalize a previously-proven withdrawal once the dispute window has passed.

    @param _tx The withdrawal transaction to finalize and execute on L1.
  */
  function finalizeWithdrawalTransaction (
    WithdrawalTx memory _tx
  ) external;

  /**
    Return the dispute game factory the portal trusts.

    @return _ The address of the dispute game factory.
  */
  function disputeGameFactory () external view returns (address);

  /**
    Return the delay a proof must mature before finalization.

    @return _ The proof maturity delay, in seconds.
  */
  function proofMaturityDelaySeconds () external view returns (uint256);

  /**
    Return the delay after which a resolved dispute game is final.

    @return _ The dispute game finality delay, in seconds.
  */
  function disputeGameFinalityDelaySeconds () external view returns (uint256);

  /**
    Return the dispute game type the portal currently respects.

    @return _ The respected dispute game type.
  */
  function respectedGameType () external view returns (uint32);
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title IDisputeGameFactory
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  A minimal interface for the OptimismPortal2 dispute game factory, exposing the
  lookup the fork tests mock to inject a synthetic game.

  @custom:date June 22nd, 2026.
*/
interface IDisputeGameFactory {

  /**
    Look up the dispute game created at a given factory index.

    @param _index The index of the dispute game to look up.

    @return _ The game type, its creation timestamp, and its contract address.
  */
  function gameAtIndex (
    uint256 _index
  ) external view returns (uint32, uint64, address);
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title ForkIntegrationTest
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Two purposes: 1. test_GasMeasurement_* : measure the real gas `finalizeBridge`
  consumes per token, to size NetizenBridgeL2.PER_TOKEN_GAS / BASE_GAS and
  validate the batch-size ceiling against the Osaka ~16.78M per-tx cap. Runs
  with plain `forge test` (no RPC needed). 2. test_ForkE2E_* : full cross-domain
  flow on real forked state (MegaETH L2 + Ethereum L1): a real WCN holder
  approves + bridges, and the emitted message is relayed and minted on a fresh
  NetizenL1. Runs only when L1_FORK_RPC and L2_FORK_RPC are set; otherwise
  skipped.

  @custom:date June 22nd, 2026.
*/
contract ForkIntegrationTest is
  Test {

  /// The token base URI used for the freshly deployed NetizenL1 under test.
  string constant BASE =
    "ipfs://bafybeiabi7zjyuo7je4blxba6liprvhht6lcvk2psklin3woty4d4p4274/";

  /// The real World Computer Netizens collection address on the MegaETH fork.
  address constant WCN = 0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44;

  /// The L2 cross-domain messenger predeploy address.
  address constant L2_MESSENGER = 0x4200000000000000000000000000000000000007;

  /// The L2-to-L1 message passer predeploy address.
  address constant L2_MESSAGE_PASSER =
    0x4200000000000000000000000000000000000016;

  /// The EIP-7825 per-transaction gas cap introduced by the Osaka upgrade.
  uint256 constant OSAKA_TX_GAS_CAP = 16_777_216;

  /// The live OptimismPortal2 address on L1.
  address constant PORTAL = 0x7f82f57F0Dd546519324392e408b01fcC7D709e8;

  /// The live L1CrossDomainMessenger address on L1.
  address constant L1_MESSENGER = 0x6C7198250087B29A8040eC63903Bc130f4831Cc9;

  /// The amount of ETH bridged alongside the NFTs in the withdrawal tests.
  uint256 constant ETH_BRIDGE_AMOUNT = 0.5 ether;

  /// Measure finalizeBridge gas across batch sizes to derive per-token sizing.
  function test_GasMeasurement_FinalizeBridge () public {
    address _messenger = makeAddr("messenger");
    address _l2Bridge = makeAddr("l2Bridge");
    NetizenL1 _nft =
      new NetizenL1(_messenger, address(this), BASE);
    _nft.setL2Bridge(_l2Bridge);

    /*
      finalizeBridge reads MESSENGER.xDomainMessageSender(); make it return the
      bridge.
    */
    vm.mockCall(
      _messenger, abi.encodeWithSignature("xDomainMessageSender()"),
      abi.encode(_l2Bridge)
    );
    uint256[6] memory _sizes = [uint256(1), 2, 10, 30, 100, 200];
    uint256 _nextId = 1;
    uint256[6] memory _totals;
    console2.log("=== finalizeBridge gas (fresh recipient, unminted ids) ===");
    for (uint256 s; s < _sizes.length; ++s) {
      uint256 n = _sizes[s];
      uint256[] memory _ids = new uint256[](n);
      for (uint256 j; j < n; ++j) {
        _ids[j] = _nextId++;
      }
      address _to = makeAddr(string.concat("recipient", vm.toString(n)));
      vm.prank(_messenger);
      uint256 _g0 = gasleft();
      _nft.finalizeBridge(_to, _ids);
      uint256 _used = _g0 - gasleft();
      _totals[s] = _used;
      console2.log("batch N:", n);
      console2.log("  total gas:", _used);
      console2.log("  amortized/token:", _used / n);
    }

    /*
      Steady-state marginal per-token: strips fixed base + cold-first-token.
      (200 - 100)
    */
    uint256 _marginal = (_totals[5] - _totals[4]) / (_sizes[5] - _sizes[4]);

    // ~ N=1 minus one token
    uint256 _fixedBase = _totals[0] > _marginal ? _totals[0] - _marginal : 0;
    console2.log("=== derived sizing ===");
    console2.log("marginal gas/token (steady state):", _marginal);
    console2.log("fixed base (1 batch, ex-1-token):", _fixedBase);
    console2.log("suggested PER_TOKEN_GAS (~2x marginal):", _marginal * 2);
    console2.log("suggested BASE_GAS (~2x base):", _fixedBase * 2);

    /*
      Sanity vs the Osaka ~16.78M per-tx cap: minGasLimit must stay < ~15.9M
      deliverable. Report the largest N that fits at the *measured* marginal.
    */
    uint256 _deliverable = 15_900_000;
    uint256 _maxN = (_deliverable - _fixedBase) / _marginal;
    console2.log("max tokens deliverable in one relay (measured):", _maxN);
  }

  /// Verify a real holder can bridge a token whose relayed message mints on L1.
  function test_ForkE2E_BridgeAndRelay () public {
    string memory _l1Rpc = vm.envOr("L1_FORK_RPC", string(""));
    string memory _l2Rpc = vm.envOr("L2_FORK_RPC", string(""));
    if (bytes(_l1Rpc).length == 0 || bytes(_l2Rpc).length == 0) {
      emit log(
        "SKIP: set L1_FORK_RPC and L2_FORK_RPC to run the fork e2e test"
      );
      vm.skip(true);
      return;
    }
    uint256 _l1Fork = vm.createFork(_l1Rpc);
    uint256 _l2Fork = vm.createFork(_l2Rpc);
    address _recipient = makeAddr("l1recipient");

    /*
      --- L1: deploy a fresh NetizenL1 (messenger is mocked for relay below) ---
    */
    vm.selectFork(_l1Fork);
    address _messenger = makeAddr("l1messenger");
    NetizenL1 _nft =
      new NetizenL1(_messenger, address(this), BASE);

    // --- L2: deploy the bridge pointing at the L1 contract ---
    vm.selectFork(_l2Fork);
    NetizenBridgeL2 _bridge =
      new NetizenBridgeL2(WCN, L2_MESSENGER, address(_nft));

    // Find a real holder + tokenId on the MegaETH fork.
    (address _holder, uint256 _tokenId) = _findHolder();
    emit log_named_address("WCN holder", _holder);
    emit log_named_uint("tokenId", _tokenId);
    uint256[] memory _ids = new uint256[](1);
    _ids[0] = _tokenId;

    /*
      Holder approves + bridges (this is exactly what the deposit-as-holder
      executes via forced inclusion). Capture the emitted SentMessage.
    */
    vm.startPrank(_holder);
    IWCNlike(WCN).setApprovalForAll(address(_bridge), true);
    vm.recordLogs();
    _bridge.bridge(_ids, _recipient);
    vm.stopPrank();
    (address _target, bytes memory _message, ) = _extractSentMessage();
    assertEq(_target, address(_nft), "message target should be NetizenL1");

    // Token burned on L2.
    vm.expectRevert();
    IWCNlike(WCN).ownerOf(_tokenId);

    // --- L1: bind bridge, then relay the captured message as the messenger ---
    vm.selectFork(_l1Fork);
    _nft.setL2Bridge(address(_bridge));
    vm.mockCall(
      _messenger, abi.encodeWithSignature("xDomainMessageSender()"),
      abi.encode(address(_bridge))
    );
    vm.prank(_messenger);
    (bool _ok, ) = address(_nft).call(_message);
    assertTrue(_ok, "relay (finalizeBridge) call failed");
    assertEq(
      _nft.ownerOf(_tokenId), _recipient, "token not minted to recipient on L1"
    );
    assertEq(_nft.totalSupply(), 1);
    assertEq(
      _nft.tokenURI(_tokenId), string.concat(BASE, vm.toString(_tokenId))
    );
  }

  /**
    Bridge a SPECIFIC holder's real tokens end-to-end. Chunks into
    MAX_BATCH-sized bridge() calls (so >MAX_BATCH holdings work), relays each
    message, and asserts every token mints on L1. Run with: FORK_HOLDER=0x..
    FORK_TOKEN_IDS=1,2,3 plus the fork RPCs.
  */
  function test_ForkE2E_SpecificHolder () public {
    string memory _l1Rpc = vm.envOr("L1_FORK_RPC", string(""));
    string memory _l2Rpc = vm.envOr("L2_FORK_RPC", string(""));
    address _holder = vm.envOr("FORK_HOLDER", address(0));
    uint256[] memory _ids = vm.envOr("FORK_TOKEN_IDS", ",", new uint256[](0));
    if (
      bytes(_l1Rpc).length == 0 || bytes(_l2Rpc).length == 0
      || _holder == address(0) || _ids.length == 0
    ) {
      emit log(
        "SKIP: set L1_FORK_RPC, L2_FORK_RPC, FORK_HOLDER, FORK_TOKEN_IDS to run"
      );
      vm.skip(true);
      return;
    }
    uint256 _l1Fork = vm.createFork(_l1Rpc);
    uint256 _l2Fork = vm.createFork(_l2Rpc);
    address _recipient = makeAddr("l1recipient");
    vm.selectFork(_l1Fork);
    address _messenger = makeAddr("l1messenger");
    NetizenL1 _nft =
      new NetizenL1(_messenger, address(this), BASE);
    vm.selectFork(_l2Fork);
    NetizenBridgeL2 _bridge =
      new NetizenBridgeL2(WCN, L2_MESSENGER, address(_nft));
    uint256 _maxBatch = _bridge.MAX_BATCH();
    emit log_named_address("holder", _holder);
    emit log_named_uint("tokens", _ids.length);
    emit log_named_uint("MAX_BATCH", _maxBatch);

    // Confirm the holder really owns each id on the fork.
    for (uint256 i; i < _ids.length; ++i) {
      assertEq(
        IWCNlike(WCN).ownerOf(_ids[i]), _holder, "holder does not own tokenId"
      );
    }
    uint256 _numChunks = (_ids.length + _maxBatch - 1) / _maxBatch;
    bytes[] memory _messages = new bytes[](_numChunks);
    vm.startPrank(_holder);
    IWCNlike(WCN).setApprovalForAll(address(_bridge), true);
    vm.recordLogs();
    for (uint256 c; c < _numChunks; ++c) {
      uint256 _start = c * _maxBatch;
      uint256 _end =
        _start + _maxBatch > _ids.length ? _ids.length : _start + _maxBatch;
      uint256[] memory _slice = _chunk(_ids, _start, _end);
      _bridge.bridge(_slice, _recipient);

      // drains this chunk's logs
      Vm.Log[] memory _chunkLogs = vm.getRecordedLogs();
      (, bytes memory _message) = _findSentMessage(_chunkLogs);
      uint256 _minGasLimit = _findSentGasLimit(_chunkLogs);

      // on-chain baseGas
      uint256 _realGasLimit = _findMessagePassedGasLimit(_chunkLogs);
      _messages[c] = _message;
      emit log_named_uint("bridged chunk size", _slice.length);
      emit log_named_uint("  inner minGasLimit", _minGasLimit);
      emit log_named_uint(
        "  computed baseGas (formula)", _baseGas(_message, _minGasLimit)
      );
      emit log_named_uint("  REAL withdrawal gasLimit (chain)", _realGasLimit);

      /*
        The portal enforces realGasLimit; the finalize tx must declare >= it and
        is subject to EIP-7825. This is the true on-chain relayability check.
      */
      assertLt(
        _realGasLimit + 150_000, OSAKA_TX_GAS_CAP,
        "real withdrawal gasLimit exceeds Osaka cap"
      );
    }
    vm.stopPrank();

    // All burned on L2.
    for (uint256 i; i < _ids.length; ++i) {
      vm.expectRevert();
      IWCNlike(WCN).ownerOf(_ids[i]);
    }

    // Relay each chunk's message on L1.
    vm.selectFork(_l1Fork);
    _nft.setL2Bridge(address(_bridge));
    vm.mockCall(
      _messenger, abi.encodeWithSignature("xDomainMessageSender()"),
      abi.encode(address(_bridge))
    );
    for (uint256 c; c < _numChunks; ++c) {
      vm.prank(_messenger);
      (bool _ok, ) = address(_nft).call(_messages[c]);
      assertTrue(_ok, "relay failed");
    }

    // Every token minted to the recipient on L1.
    for (uint256 i; i < _ids.length; ++i) {
      assertEq(_nft.ownerOf(_ids[i]), _recipient, "token not minted on L1");
    }
    assertEq(_nft.totalSupply(), _ids.length);
    emit log_named_uint("minted on L1", _nft.totalSupply());
  }

  /**
    The MOST faithful local test: runs the REAL OptimismPortal2
    proveWithdrawalTransaction + finalizeWithdrawalTransaction on a forked L1,
    fast-forwarding the dispute window. Only the dispute game and the L2 state
    commitment are synthesized; the portal's proof verification, the real
    L1CrossDomainMessenger.relayMessage, and finalizeBridge all execute for
    real. Requires L1_FORK_RPC + L2_FORK_RPC.
  */
  function test_ForkE2E_RealProveFinalize () public {
    string memory _l1Rpc = vm.envOr("L1_FORK_RPC", string(""));
    string memory _l2Rpc = vm.envOr("L2_FORK_RPC", string(""));
    if (bytes(_l1Rpc).length == 0 || bytes(_l2Rpc).length == 0) {
      emit log("SKIP: set L1_FORK_RPC and L2_FORK_RPC to run");
      vm.skip(true);
      return;
    }
    uint256 _l1Fork = vm.createFork(_l1Rpc);
    uint256 _l2Fork = vm.createFork(_l2Rpc);
    address _recipient = makeAddr("l1recipient");

    // L1: NetizenL1 wired to the REAL L1CrossDomainMessenger.
    vm.selectFork(_l1Fork);
    NetizenL1 _nft =
      new NetizenL1(L1_MESSENGER, address(this), BASE);

    /*
      L2: bridge the token(s) in ONE batch; capture the real L2->L1 withdrawal.
      Defaults to a single discovered token; override with FORK_HOLDER +
      FORK_TOKEN_IDS to drive a real holder's full batch (e.g. the 380-holder).
    */
    (WithdrawalTx memory _wtx, bytes32 _wHash, address _bridgeAddr,
    uint256[] memory _ids) = _bridgeOnL2(_l2Fork, address(_nft), _recipient);
    assertEq(
      _wtx.target, L1_MESSENGER, "withdrawal target should be the L1 messenger"
    );
    assertEq(
      _wtx.sender, L2_MESSENGER, "withdrawal sender should be the L2 messenger"
    );

    // L1: real prove + finalize through the OptimismPortal2.
    _proveAndFinalize(_l1Fork, _nft, _bridgeAddr, _wtx, _wHash);
    vm.selectFork(_l1Fork);
    for (uint256 i; i < _ids.length; ++i) {
      assertEq(
        _nft.ownerOf(_ids[i]), _recipient,
        "token not minted via real prove+finalize"
      );
    }
    assertEq(_nft.totalSupply(), _ids.length);

    // The ETH rode the same withdrawal and was released by the real portal.
    assertEq(
      _recipient.balance, ETH_BRIDGE_AMOUNT, "bridged ETH not delivered on L1"
    );
    emit log_named_uint("minted via OptimismPortal2 path, count", _ids.length);
    emit log_named_uint("ETH delivered to recipient (wei)", _recipient.balance);
  }

  /**
    Bridge a holder's token(s) plus ETH on the L2 fork and capture the resulting
    L2-to-L1 withdrawal from the MessagePassed event.

    @param _l2Fork The L2 fork id to select before bridging.
    @param _nftAddr The L1 NetizenL1 address the bridge points at.
    @param _recipient The L1 address that should receive the bridged tokens.

    @return _ The captured withdrawal, its hash, the bridge address, and the
      ids.
  */
  function _bridgeOnL2 (
    uint256 _l2Fork,
    address _nftAddr,
    address _recipient
  ) internal returns (
    WithdrawalTx memory, bytes32, address, uint256[] memory
  ) {
    WithdrawalTx memory _wtxOutput;
    bytes32 _wHashOutput;
    address _bridgeAddrOutput;
    uint256[] memory _idsOutput;
    vm.selectFork(_l2Fork);
    NetizenBridgeL2 _bridge = new NetizenBridgeL2(WCN, L2_MESSENGER, _nftAddr);
    _bridgeAddrOutput = address(_bridge);
    address _holder = vm.envOr("FORK_HOLDER", address(0));
    _idsOutput = vm.envOr("FORK_TOKEN_IDS", ",", new uint256[](0));
    if (_holder == address(0) || _idsOutput.length == 0) {
      uint256 _tid;
      (_holder, _tid) = _findHolder();
      _idsOutput = new uint256[](1);
      _idsOutput[0] = _tid;
    }
    emit log_named_uint("bridging batch size", _idsOutput.length);

    /*
      Give the holder ETH to bridge alongside the NFTs (rides the same message).
    */
    vm.deal(_holder, ETH_BRIDGE_AMOUNT);
    vm.startPrank(_holder);
    IWCNlike(WCN).setApprovalForAll(_bridgeAddrOutput, true);
    vm.recordLogs();
    uint256 g = gasleft();
    _bridge.bridge{ value: ETH_BRIDGE_AMOUNT }(_idsOutput, _recipient);
    emit log_named_uint(
      "bridge() L2 gasUsed (burns + sendMessage)", g - gasleft()
    );
    vm.stopPrank();
    (_wtxOutput, _wHashOutput) = _extractWithdrawal(vm.getRecordedLogs());
    assertEq(
      _wtxOutput.value, ETH_BRIDGE_AMOUNT,
      "ETH should ride the withdrawal as value"
    );
    return (_wtxOutput, _wHashOutput, _bridgeAddrOutput, _idsOutput);
  }

  /**
    Run the real OptimismPortal2 prove + finalize flow on the L1 fork, warping
    past the dispute window so the withdrawal executes for real.

    @param _l1Fork The L1 fork id to select.
    @param _nft The NetizenL1 instance to bind the bridge on.
    @param _bridgeAddr The L2 bridge address authorized to mint on L1.
    @param _wtx The withdrawal transaction to prove and finalize.
    @param _wHash The withdrawal hash committed to by the synthetic proof.
  */
  function _proveAndFinalize (
    uint256 _l1Fork,
    NetizenL1 _nft,
    address _bridgeAddr,
    WithdrawalTx memory _wtx,
    bytes32 _wHash
  ) internal {
    vm.selectFork(_l1Fork);
    _nft.setL2Bridge(_bridgeAddr);
    (OutputRootProof memory _orp, bytes[] memory _proof, bytes32 _outputRoot) =
    _buildProof(
      _wHash
    );
    IOptimismPortal2 _portal = IOptimismPortal2(PORTAL);
    _injectGame(_portal, _outputRoot);
    uint256 _g0 = gasleft();
    _portal.proveWithdrawalTransaction(_wtx, 0, _orp, _proof);
    emit log_named_uint("proveWithdrawalTransaction gasUsed", _g0 - gasleft());
    vm.warp(
      block.timestamp + _portal.proofMaturityDelaySeconds() +
      _portal.disputeGameFinalityDelaySeconds() + 1
    );

    /*
      This single call folds in: portal overhead + relayMessage + ALL the mints.
    */
    uint256 _g1 = gasleft();
    _portal.finalizeWithdrawalTransaction(_wtx);
    emit log_named_uint(
      "finalizeWithdrawalTransaction gasUsed (everything folded in)",
      _g1 - gasleft()
    );
    emit log_named_uint(
      "  withdrawal gasLimit declared (baseGas)", _wtx.gasLimit
    );
  }

  /**
    Synthetic single-leaf storage proof for sentMessages[wHash] == 1, plus the
    output root committing to it. The portal verifies the proof for real.

    @param _wHash The withdrawal hash to encode into the storage proof leaf.

    @return _ The output root proof, the withdrawal proof, and the output root.
  */
  function _buildProof (
    bytes32 _wHash
  ) internal pure returns (OutputRootProof memory, bytes[] memory, bytes32) {
    bytes32 _storageKey = keccak256(abi.encode(_wHash, uint256(0)));

    // SecureMerkleTrie hashes the key
    bytes32 _pathHash = keccak256(abi.encode(_storageKey));

    // RLP leaf, value 0x01
    bytes memory _leaf =
      abi.encodePacked(bytes3(0xe3a120), _pathHash, bytes1(0x01));
    bytes[] memory _proof = new bytes[](1);
    _proof[0] = _leaf;
    OutputRootProof memory _orp = OutputRootProof({
      version: bytes32(0),
      stateRoot: bytes32(uint256(1)),
      messagePasserStorageRoot: keccak256(_leaf),
      latestBlockhash: bytes32(uint256(2))
    });
    bytes32 _outputRoot =
      keccak256(
        abi.encode(
          _orp.version, _orp.stateRoot, _orp.messagePasserStorageRoot,
          _orp.latestBlockhash
        )
      );
    return (_orp, _proof, _outputRoot);
  }

  /**
    Mock the dispute game factory so index 0 returns a synthetic, backdated game
    committing to the given output root for the portal to trust.

    @param _portal The portal whose factory and respected game type are read.
    @param _outputRoot The L2 output root the synthetic game should commit to.
  */
  function _injectGame (
    IOptimismPortal2 _portal,
    bytes32 _outputRoot
  ) internal {
    uint32 _rgt = _portal.respectedGameType();

    /*
      Game must have been created strictly BEFORE the withdrawal is proven, and
      at/after respectedGameTypeUpdatedAt. Backdate it an hour (still well after
      the respected-type update at ~1.778e9).
    */
    uint64 _created = uint64(block.timestamp) - 1 hours;
    MockDisputeGame _game =
      new MockDisputeGame(_outputRoot, _rgt, _created, _created);
    vm.mockCall(
      _portal.disputeGameFactory(),
      abi.encodeWithSelector(
        IDisputeGameFactory.gameAtIndex.selector, uint256(0)
      ), abi.encode(_rgt, _created, address(_game))
    );
  }

  /**
    Decode the L2ToL1MessagePasser MessagePassed event from recorded logs into a
    withdrawal transaction and its hash.

    @param _logs The recorded logs to scan for the MessagePassed event.

    @return _ The reconstructed withdrawal transaction and its withdrawal hash.
  */
  function _extractWithdrawal (
    Vm.Log[] memory _logs
  ) internal pure returns (WithdrawalTx memory, bytes32) {
    WithdrawalTx memory _wtxOutput;
    bytes32 _wHashOutput;
    bytes32 _sig =
      keccak256(
        "MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)"
      );
    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].emitter == L2_MESSAGE_PASSER && _logs[i].topics[0] == _sig) {
        _wtxOutput.nonce = uint256(_logs[i].topics[1]);
        _wtxOutput.sender = address(uint160(uint256(_logs[i].topics[2])));
        _wtxOutput.target = address(uint160(uint256(_logs[i].topics[3])));
        (_wtxOutput.value, _wtxOutput.gasLimit, _wtxOutput.data, _wHashOutput)
         = abi.decode(_logs[i].data, (uint256, uint256, bytes, bytes32));
        return (_wtxOutput, _wHashOutput);
      }
    }
    revert("MessagePassed not found");
    return (_wtxOutput, _wHashOutput);
  }

  /**
    Copy a half-open slice of a token id array into a new array.

    @param _arr The source array to slice.
    @param _start The inclusive start index of the slice.
    @param _end The exclusive end index of the slice.

    @return _ A new array holding `_arr[_start .. _end)`.
  */
  function _chunk (
    uint256[] memory _arr,
    uint256 _start,
    uint256 _end
  ) internal pure returns (uint256[] memory) {
    uint256[] memory _out = new uint256[](_end - _start);
    for (uint256 i; i < _out.length; ++i) {
      _out[i] = _arr[_start + i];
    }
    return _out;
  }

  /**
    Scan token ids 1..64 on the fork for the first one with a non-zero owner.

    @return _ The discovered holder address and the token id it owns.
  */
  function _findHolder () internal view returns (address, uint256) {
    for (uint256 _id = 1; _id <= 64; ++_id) {
      try IWCNlike(WCN).ownerOf(_id) returns (address _o) {
        if (_o != address(0)) return (_o, _id);
      } catch {}
    }
    revert("no WCN holder found in ids 1..64 on the fork");
  }

  /**
    Drain the recorded logs and decode the L2 messenger's SentMessage event.

    @return _ The message target, the relayed message calldata, and its gas
      limit.
  */
  function _extractSentMessage () internal returns (
    address, bytes memory, uint256
  ) {
    address _targetOutput;
    bytes memory _messageOutput;
    uint256 _gasLimitOutput;
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    (_targetOutput, _messageOutput) = _findSentMessage(_logs);
    _gasLimitOutput = _findSentGasLimit(_logs);
    return (_targetOutput, _messageOutput, _gasLimitOutput);
  }

  /**
    Find the L2 messenger's SentMessage event in the logs and decode its target
    and relayed message calldata.

    @param _logs The recorded logs to scan for the SentMessage event.

    @return _ The message target on L1 and the relayed message calldata.
  */
  function _findSentMessage (
    Vm.Log[] memory _logs
  ) internal pure returns (address, bytes memory) {
    address _targetOutput;
    bytes memory _messageOutput;
    bytes32 _sig =
      keccak256("SentMessage(address,address,bytes,uint256,uint256)");
    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].emitter == L2_MESSENGER && _logs[i].topics[0] == _sig) {
        _targetOutput = address(uint160(uint256(_logs[i].topics[1])));
        (, _messageOutput, , ) = abi.decode(
          _logs[i].data, (address, bytes, uint256, uint256)
        );
        return (_targetOutput, _messageOutput);
      }
    }
    revert("SentMessage not found");
    return (_targetOutput, _messageOutput);
  }

  /**
    Find the L2 messenger's SentMessage event in the logs and decode its inner
    minimum gas limit.

    @param _logs The recorded logs to scan for the SentMessage event.

    @return _ The inner minGasLimit declared in the SentMessage event.
  */
  function _findSentGasLimit (
    Vm.Log[] memory _logs
  ) internal pure returns (uint256) {
    uint256 _gasLimitOutput;
    bytes32 _sig =
      keccak256("SentMessage(address,address,bytes,uint256,uint256)");
    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].emitter == L2_MESSENGER && _logs[i].topics[0] == _sig) {
        (, , , _gasLimitOutput) = abi.decode(
          _logs[i].data, (address, bytes, uint256, uint256)
        );
        return _gasLimitOutput;
      }
    }
    revert("SentMessage not found");
    return _gasLimitOutput;
  }

  /**
    The AUTHORITATIVE withdrawal gasLimit (== OP baseGas) the L1 portal will
    enforce, taken from the L2ToL1MessagePasser MessagePassed event — i.e.
    computed on-chain by MegaETH's own (possibly patched) messenger, not by us.

    @param _logs The recorded logs to scan for the MessagePassed event.

    @return _ The on-chain withdrawal gasLimit (baseGas) from the event.
  */
  function _findMessagePassedGasLimit (
    Vm.Log[] memory _logs
  ) internal pure returns (uint256) {
    uint256 _gasLimitOutput;
    bytes32 _sig =
      keccak256(
        "MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)"
      );
    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].emitter == L2_MESSAGE_PASSER && _logs[i].topics[0] == _sig) {

        // data = (value, gasLimit, data, withdrawalHash)
        (, _gasLimitOutput, , ) = abi.decode(
          _logs[i].data, (uint256, uint256, bytes, bytes32)
        );
        return _gasLimitOutput;
      }
    }
    revert("MessagePassed not found");
    return _gasLimitOutput;
  }

  /**
    OP CrossDomainMessenger.baseGas with STANDARD constants, for comparison
    against the chain's real value (MegaETH ran op-contracts v3 with a patch).

    @param _message The relayed message whose calldata length factors into gas.
    @param _minGasLimit The inner minimum gas limit requested for the message.

    @return _ The computed baseGas using OP's standard constants.
  */
  function _baseGas (
    bytes memory _message,
    uint256 _minGasLimit
  ) internal pure returns (uint256) {
    return 200_000 + (_message.length * 16) + (_minGasLimit * 64 / 63) + 40_000
     + 40_000 + 5_000;
  }
}

