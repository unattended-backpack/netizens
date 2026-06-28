// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { ICrossDomainMessenger } from "./interfaces/ICrossDomainMessenger.sol";
import { ReentrancyGuard } from "solady/utils/ReentrancyGuard.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title IWCN
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Subset of the WCN ERC721 we depend on. WCN exposes a standard
  owner-or-approved `burn` plus `ownerOf`.

  @custom:date June 22nd, 2026.
*/
interface IWCN {

  /**
    Returns the current owner of `_tokenId`.

    @param _tokenId The token to look up.

    @return _ The address that currently owns `_tokenId`.
  */
  function ownerOf (
    uint256 _tokenId
  ) external view returns (address);

  /**
    Burns `_tokenId`. Reverts unless the caller is the owner of, or approved
    for, the token.

    @param _tokenId The token to burn.
  */
  function burn (
    uint256 _tokenId
  ) external;
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title INetizenL1
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  The L1 target's bridge entry point, used to ABI-encode the relayed message.

  @custom:date June 22nd, 2026.
*/
interface INetizenL1 {

  /**
    Mints the bridged `_tokenIds` to `_to` on Ethereum and forwards any bridged
    Ether. Invoked on L1 by the canonical cross-domain messenger relay.

    @param _to The L1 recipient of the minted tokens and any bridged Ether.
    @param _tokenIds The tokenIds to mint on L1, mirroring the burned originals.
  */
  function finalizeBridge (
    address _to,
    uint256[] calldata _tokenIds
  ) external payable;
}

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title  Netizen Bridge L2
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  The L2 side of the "World Computer Netizens" bridge. A holder approves this
  contract for their NFT(s), then calls `bridge`: the contract burns the NFT(s)
  on L2 and sends one canonical cross-domain message that mints the same
  tokenIds against NetizenL1 on Ethereum once proven and finalized through the
  OptimismPortal. Any Ether sent as `msg.value` rides that same message and is
  delivered to the L1 recipient in the same finalization.

  @custom:date June 22nd, 2026.
*/
contract NetizenBridgeL2 is
  ReentrancyGuard {

  /**
    Emitted when a holder burns tokens and/or sends Ether to bridge them home to
    Ethereum, one event per bridge call.

    @param from The holder who burned the tokens.
    @param l1Recipient The Ethereum address that will receive the tokens.
    @param tokenIds The bridged tokenIds.
    @param ethAmount Ether bridged alongside, delivered to `l1Recipient`.
  */
  event BridgeInitiated (
    address indexed from,
    address indexed l1Recipient,
    uint256[] tokenIds,
    uint256 ethAmount
  );

  /// The WCN collection on L2.
  IWCN public immutable nft;

  /// The L2CrossDomainMessenger predeploy (0x4200...0007).
  ICrossDomainMessenger public immutable l2Messenger;

  /// The NetizenL1 contract on Ethereum that mints the bridged tokens.
  address public immutable l1Target;

  /**
    Max tokenIds per bridge call. Sized so the largest WCN holder (380) exits in
    a single batch with no frontend chunking. The hard ceiling is the L1 relay's
    `baseGas` (≈ minGasLimit·64/63 + overhead) staying under EIP-7825's per-tx
    cap (16,777,216); baseGas at MAX_BATCH is fixed by the constants below, so a
    full batch is always relayable.
  */
  uint256 public constant MAX_BATCH = 400;

  /**
    Relay gas budget = BASE_GAS + PER_TOKEN_GAS * n, forwarded to
    NetizenL1.finalizeBridge on L1. PER_TOKEN_GAS is the guaranteed floor per
    token; BASE_GAS also covers finalizeBridge's one-time Ether forward.
  */
  uint32 public constant BASE_GAS = 200_000;

  /**
    Per-token component of the relay gas budget (see BASE_GAS): the guaranteed
    gas floor forwarded per bridged token to NetizenL1.finalizeBridge's mint.
  */
  uint32 public constant PER_TOKEN_GAS = 38_000;

  /**
    Wires the immutable references and reverts if any is the zero address.

    @param _nft The WCN ERC721 collection on L2.
    @param _l2Messenger The L2CrossDomainMessenger predeploy.
    @param _l1Target The NetizenL1 contract on Ethereum that mints bridged
      tokens.
  */
  constructor (
    address _nft,
    address _l2Messenger,
    address _l1Target
  ) {
    require(
      _nft != address(0) && _l2Messenger != address(0)
      && _l1Target != address(0), "NetizenBridgeL2: zero addr"
    );
    nft = IWCN(_nft);
    l2Messenger = ICrossDomainMessenger(_l2Messenger);
    l1Target = _l1Target;
  }

  /**
    Burn `tokenIds` and bridge them to `l1Recipient` on Ethereum. Any Ether sent
    as msg.value rides the same cross-domain message and is delivered to
    `l1Recipient` on L1 in the same finalization. Caller must own each token and
    have approved this contract (`approve` or `setApprovalForAll`).

    @param _tokenIds The tokenIds to burn and bridge (may be empty for an
      Ether-only bridge).
    @param _l1Recipient The Ethereum address that will receive the tokens.
  */
  function bridge (
    uint256[] calldata _tokenIds,
    address _l1Recipient
  ) external payable nonReentrant {
    require(_l1Recipient != address(0), "NetizenBridgeL2: zero recipient");
    uint256 n = _tokenIds.length;
    require(n <= MAX_BATCH, "NetizenBridgeL2: bad batch size");

    /*
      Allow an Ether-only bridge (no tokens) so a holder can sweep Ether home
      even with no Netizens; just disallow a no-op (no tokens and no value).
    */
    require(n > 0 || msg.value > 0, "NetizenBridgeL2: nothing to bridge");
    for (uint256 i; i < n; ++i) {

      /*
        Bind the burn to the caller; burn() authorizes on THIS bridge's
        approval, not on who called bridge(), so without this check anyone could
        exploit any standing approval an owner granted this bridge (a per-token
        approve OR setApprovalForAll) to burn that owner's token and mint it to
        themselves.
      */
      require(
        nft.ownerOf(_tokenIds[i]) == msg.sender,
        "NetizenBridgeL2: not token owner"
      );

      // Reverts unless this contract is owner-or-approved for the token.
      nft.burn(_tokenIds[i]);
    }
    bytes memory _message =
      abi.encodeCall(INetizenL1.finalizeBridge, (_l1Recipient, _tokenIds));

    // Safe: n <= MAX_BATCH (400) => value <= 15_400_000, far below uint32 max.
    uint32 _minGasLimit =
      uint32(uint256(BASE_GAS) + uint256(PER_TOKEN_GAS) * n);

    /*
      The user's bridged Ether rides the message; the L1 portal releases it to
      NetizenL1.finalizeBridge, which forwards it to l1Recipient.
    */
    l2Messenger.sendMessage{ value: msg.value }(
      l1Target, _message, _minGasLimit
    );
    emit BridgeInitiated(msg.sender, _l1Recipient, _tokenIds, msg.value);
  }
}

