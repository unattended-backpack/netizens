// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { ICreatorTokenTransferValidator } from
  "./interfaces/ICreatorTokenTransferValidator.sol";
import { ICrossDomainMessenger } from "./interfaces/ICrossDomainMessenger.sol";
import { Ownable } from "solady/auth/Ownable.sol";
import { ERC2981 } from "solady/tokens/ERC2981.sol";
import { ERC721 } from "solady/tokens/ERC721.sol";
import { LibString } from "solady/utils/LibString.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title  Netizens on L1
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  This is the Ethereum version of Shiro's World Computer Netizens, rescued from
  the perfidious rabbitchain. Tokens are minted here only when a confirmed burn
  has been relayed through the canonical bridge: the `finalizeBridge` call must
  have as cross-domain sender our L2-side bridge.

  @custom:date June 22nd, 2026.
*/
contract NetizenL1 is
  ERC721,
  Ownable,
  ERC2981 {

  /**
    Emitted once when the L2 bridge is bound via `setL2Bridge`.

    @param l2Bridge The NetizenBridgeL2 address that was set.
  */
  event L2BridgeSet (
    address indexed l2Bridge
  );

  /**
    Emitted for each tokenId newly minted on L1 by a bridge finalization.

    @param to The recipient the token was minted to.
    @param tokenId The minted tokenId, mirroring the burned L2 original.
  */
  event BridgeFinalized (
    address indexed to,
    uint256 indexed tokenId
  );

  /**
    Emitted when a relayed tokenId is skipped (already minted, or outside the
    1..MAX_SUPPLY range).

    @param tokenId The tokenId that was skipped.
  */
  event BridgeSkipped (
    uint256 indexed tokenId
  );

  /**
    Emitted when the token metadata base URI changes.

    @param baseURI The new base URI.
  */
  event BaseURIUpdated (
    string baseURI
  );

  /**
    Emitted when a token's metadata changes.

    @param tokenId The token whose metadata changed.
  */
  event MetadataUpdate (
    uint256 tokenId
  );

  /**
    Emitted when a batch of token metadata changes.

    @param fromTokenId The first tokenId in the updated range.
    @param toTokenId The last tokenId in the updated range.
  */
  event BatchMetadataUpdate (
    uint256 fromTokenId,
    uint256 toTokenId
  );

  /**
    Emitted once when the owner permanently freezes the token metadata base URI.
  */
  event BaseURILocked ();

  /**
    Emitted when the contract-level metadata URI updates.
  */
  event ContractURIUpdated ();

  /**
    Emitted when bridged Ether is delivered to the recipient during finalize.

    @param to The recipient the bridged Ether was delivered to.
    @param amount The amount of Ether delivered.
  */
  event EthForwarded (
    address indexed to,
    uint256 amount
  );

  /**
    Emitted when the transfer validator changes.

    @param oldValidator The previous transfer validator.
    @param newValidator The new transfer validator (address(0) disables
      enforcement).
  */
  event TransferValidatorUpdated (
    address oldValidator,
    address newValidator
  );

  /// The supply hard cap mirrored from the L2-side collection.
  uint256 public constant MAX_SUPPLY = 4520;

  /// The default canonical transfer validator.
  address public constant TRANSFER_VALIDATOR =
    0x721C008fdff27BF06E7E123956E2Fe03B63342e3;

  /// An immutable ERC-2981 royalty fee, fixed at construction: 560 bps = 5.6%.
  uint96 public constant ROYALTY_FEE_NUMERATOR = 560;

  /**
    Immutable ERC-2981 royalty recipient, fixed at construction. This is the
    payout address the L2-side WCN collection uses. No setter; never changes.
  */
  address public constant ROYALTY_RECEIVER =
    0xe2ab52Af4b18E494F03Ed8519B5E448a48e92Fd0;

  /// The L1CrossDomainMessenger; only this may call `finalizeBridge`.
  address public immutable MESSENGER;

  /**
    The L2-side bridge contract (NetizenBridgeL2). Set exactly once after the L2
    bridge is deployed, then permanently fixed.
  */
  address public L2_BRIDGE;

  /// Running count of tokens minted on L1 via the bridge.
  uint256 private _minted;

  /// The token metadata base URI; tokenURI(id) is _base followed by the id.
  string private _base;

  /**
    Once true, setBaseURI is permanently disabled. The token metadata base URI
    (and thus tokenURI) is frozen forever.
  */
  bool public baseURILocked;

  /// The OpenSea contract-level (collection) metadata URI.
  string private _contractURI;

  /**
    Defaults to TRANSFER_VALIDATOR; every non-mint/burn transfer is gated by its
    collection policy. Owner-settable; address(0) disables enforcement.
  */
  address private _transferValidator;

  /**
    Construct the L1-side Netizens contract.

    @param _messenger The L1CrossDomainMessenger which calls `finalizeBridge`.
    @param _owner The initial owner (admin for validator and metadata controls).
    @param _baseURI The initial token metadata base URI.
  */
  constructor (
    address _messenger,
    address _owner,
    string memory _baseURI
  ) {
    MESSENGER = _messenger;
    _initializeOwner(_owner);
    _base = _baseURI;

    // Set the default contract-level metadata.
    _contractURI =
    "data:application/json;utf8,{\"name\":\"World Computer Netizens\",\"description\":\"Netizens are online cyber entities, souls wandering in the world computer... angels keeping your hardware safe.\",\"image\":\"https://i2c.seadn.io/collection/world-computer-netizens-megaeth/image_type_preview_media/43e341bd3278ec99addbf97f32568e/c843e341bd3278ec99addbf97f32568e.png?w=1920\",\"banner_image\":\"https://i2c.seadn.io/collection/world-computer-netizens-megaeth/image_type_hero_desktop/fbb3eb27b4206c2ce9db2879df9ef6/59fbb3eb27b4206c2ce9db2879df9ef6.png?w=1080\",\"external_link\":\"https://shishi520.io/wcnetizens\"}";

    // Set the default royalty details.
    _setDefaultRoyalty(ROYALTY_RECEIVER, ROYALTY_FEE_NUMERATOR);

    // Set the default transfer validator.
    _transferValidator = TRANSFER_VALIDATOR;
    emit TransferValidatorUpdated(address(0), TRANSFER_VALIDATOR);
  }

  /**
    Advertise ERC721 (ERC165 + 721 + metadata), ERC2981 royalties (0x2a55205a),
    ICreatorToken (0xad0d7f6c), and ERC-4906 metadata updates (0x49064906).

    @param _interfaceId The interface identifier to check.

    @return _ True if the interface is supported.
  */
  function supportsInterface (
    bytes4 _interfaceId
  ) public view virtual override(ERC721, ERC2981) returns (bool) {
    return _interfaceId == 0xad0d7f6c || _interfaceId == 0x49064906
    || ERC721.supportsInterface(_interfaceId)
    || ERC2981.supportsInterface(_interfaceId);
  }

  /**
    Returns the collection name.

    @return _ The collection name.
  */
  function name () public pure override returns (string memory) {
    return "World Computer Netizens";
  }

  /**
    Returns the collection symbol.

    @return _ The collection symbol.
  */
  function symbol () public pure override returns (string memory) {
    return "WCN";
  }

  /**
    The number of tokens minted on L1 so far via the bridge.

    @return _ The number of tokens minted on L1 so far.
  */
  function totalSupply () external view returns (uint256) {
    return _minted;
  }

  /**
    Returns the collection's max supply.

    @return _ The collection's max supply (4520).
  */
  function maxSupply () external pure returns (uint256) {
    return MAX_SUPPLY;
  }

  /**
    Returns the current token metadata base URI.

    @return _ The current token metadata base URI.
  */
  function baseURI () external view returns (string memory) {
    return _base;
  }

  /**
    Returns the metadata URI for `_tokenId` (the base URI followed by the
    decimal id). Reverts if the token does not exist.

    @param _tokenId The token to query.

    @return _ The token's metadata URI.
  */
  function tokenURI (
    uint256 _tokenId
  ) public view override returns (string memory) {
    if (!_exists(_tokenId)) {
      revert TokenDoesNotExist();
    }
    return string(abi.encodePacked(_base, LibString.toString(_tokenId)));
  }

  /**
    Return the contract-level metadata URI.

    @return _ The contract-level (collection) metadata URI.
  */
  function contractURI () external view returns (string memory) {
    return _contractURI;
  }

  /**
    Update the collection metadata URI. Owner-only; emits `ContractURIUpdated`.

    @param _uri The new contract-level metadata URI.
  */
  function setContractURI (
    string calldata _uri
  ) external onlyOwner {
    _contractURI = _uri;
    emit ContractURIUpdated();
  }

  /**
    Updates the metadata base URI. Reverts once the base URI has been
    permanently locked.

    @param _baseURI The new token metadata base URI.
  */
  function setBaseURI (
    string calldata _baseURI
  ) external onlyOwner {
    require(!baseURILocked, "NetizenL1: base URI locked");
    _base = _baseURI;
    emit BaseURIUpdated(_baseURI);
    emit BatchMetadataUpdate(0, type(uint256).max);
  }

  /**
    Permanently and provably revoke the owner's own ability to change the token
    metadata base URI. One-way: once called, `setBaseURI` always reverts and
    `tokenURI` is frozen. Does NOT affect `contractURI`; collection-level
    branding stays owner-updatable by design.
  */
  function lockBaseURI () external onlyOwner {
    baseURILocked = true;
    emit BaseURILocked();
  }

  /**
    The active transfer validator (address(0) = enforcement off).

    @return _ The active transfer validator (address(0) if enforcement is off).
  */
  function getTransferValidator () external view returns (address) {
    return _transferValidator;
  }

  /**
    Point the collection at a transfer validator (or address(0) to disable). The
    transfer-security level and operator list are configured on the validator
    itself, not here.

    @param _newValidator The new transfer validator (address(0) to disable
      enforcement).
  */
  function setTransferValidator (
    address _newValidator
  ) external onlyOwner {
    emit TransferValidatorUpdated(_transferValidator, _newValidator);
    _transferValidator = _newValidator;
  }

  /**
    The transfer validator selector in use.

    @return _ The validateTransfer selector (0xcaee23ea) and a bool that is
      false (the call is state-changing, not a view).
  */
  function getTransferValidationFunction () external pure returns (
    bytes4, bool
  ) {
    return (0xcaee23ea, false);
  }

  /**
    Enforce the validator's policy on real transfers; exempt mints and burns so
    bridge finalization is never gated.

    @param _from The current owner (address(0) for mints).
    @param _to The recipient (address(0) for burns).
    @param _id The tokenId being transferred.
  */
  function _beforeTokenTransfer (
    address _from,
    address _to,
    uint256 _id
  ) internal virtual override {
    if (_from != address(0) && _to != address(0)) {
      address v = _transferValidator;
      if (v != address(0) && v.code.length != 0) {
        ICreatorTokenTransferValidator(v).validateTransfer(
          msg.sender, _from, _to, _id
        );
      }
    }
  }

  /**
    Bind the L2 bridge. Callable once; afterwards immutable.

    @param _l2Bridge The NetizenBridgeL2 address.
  */
  function setL2Bridge (
    address _l2Bridge
  ) external onlyOwner {
    require(L2_BRIDGE == address(0), "NetizenL1: bridge already set");
    L2_BRIDGE = _l2Bridge;
    emit L2BridgeSet(_l2Bridge);
  }

  /**
    Mints the bridged tokenIds to `to` and forwards any bridged Ether.
    Authenticated by the canonical cross-domain path: caller must be the
    L1CrossDomainMessenger and the message's L2 sender must be the trusted L2
    bridge. Idempotent: an already-existing tokenId is skipped, never reverted;
    because the L2 burns are irreversible, a revert here would brick and lose
    the whole relayed batch. Uses _mint (not _safeMint). Bridged Ether arrives
    as `msg.value` and is force-delivered to `to` AFTER minting via
    SafeTransferLib.

    @param _to The recipient of the minted tokens and any bridged Ether.
    @param _tokenIds The tokenIds to mint, mirroring the burned L2 originals.
  */
  function finalizeBridge (
    address _to,
    uint256[] calldata _tokenIds
  ) external payable {
    require(msg.sender == MESSENGER, "NetizenL1: not messenger");
    require(
      L2_BRIDGE != address(0)
      && ICrossDomainMessenger(MESSENGER).xDomainMessageSender() == L2_BRIDGE,
      "NetizenL1: not L2 bridge"
    );

    // Process all bridged tokens.
    uint256 _newlyMinted;
    for (uint256 i; i < _tokenIds.length; ++i) {
      uint256 _id = _tokenIds[i];

      /*
        Defense-in-depth: WCN tokenIds are 1..MAX_SUPPLY. An out-of-range id can
        only arrive via a compromised/buggy L2 path; skip it (never revert) so
        it can't brick the batch and the advertised maxSupply() stays a real
        on-chain invariant.
      */
      if (_id == 0 || _id > MAX_SUPPLY) {
        emit BridgeSkipped(_id);
      } else if (!_exists(_id)) {
        _mint(_to, _id);
        unchecked {
          ++_newlyMinted;
        }
        emit BridgeFinalized(_to, _id);
      } else {
        emit BridgeSkipped(_id);
      }
    }

    // Update our mint tracking.
    if (_newlyMinted != 0) {
      unchecked {
        _minted += _newlyMinted;
      }
    }

    // Deliver bridged Ether.
    if (msg.value != 0) {
      SafeTransferLib.forceSafeTransferETH(_to, msg.value);
      emit EthForwarded(_to, msg.value);
    }
  }
}

