// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title  MockGameFactory  (LOCALNET ONLY — never deploy to production)
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  A stand-in that acts as BOTH the DisputeGameFactory and the single dispute
  game. On the local anvil fork there is no Kailua proposer, so no real dispute
  game commits to the fork's L2 state. The relayer calls setGame() after each
  bridge withdrawal with the L2 fork's output root, so the REAL OptimismPortal2
  accepts the user's proveWithdrawalTransaction + finalizeWithdrawalTransaction
  — exactly mirroring the ForkIntegration test, but live. The portal's
  `disputeGameFactory` storage slot is pointed at this contract (via
  anvil_setStorageAt).

  @custom:date June 22nd, 2026.
*/
contract MockGameFactory {

  /**
    A single entry returned by findLatestGames, describing a dispute game in the
    shape viem's getWithdrawalStatus expects.

    @param index The index of the game in the factory.
    @param metadata GameId: packed (gameType | timestamp | proxy)
    @param timestamp The creation timestamp of the game.
    @param rootClaim The L2 output root claimed by the game.
    @param extraData abi.encode(l2BlockNumber)
  */
  struct GameSearchResult {
    uint256 index;
    bytes32 metadata;
    uint64 timestamp;
    bytes32 rootClaim;
    bytes extraData;
  }

  /// The L2 output root claimed by the current mock game.
  bytes32 public rootClaim;

  /// The L2 block number committed to by the current mock game.
  uint256 internal _l2Block;

  /// The dispute game type reported by this mock.
  uint32 internal _gameType;

  /// The creation timestamp of the current mock game.
  uint64 internal _createdAt;

  /// The resolution timestamp of the current mock game.
  uint64 internal _resolvedAt;

  /**
    Construct the mock factory with a fixed dispute game type.

    @param _gameType_ The dispute game type to report for the mock game.
  */
  constructor (
    uint32 _gameType_
  ) {
    _gameType = _gameType_;
  }

  /**
    Point the (single) game at a new output root + timestamps.

    @param _root The L2 fork output root to claim for the game.
    @param _l2Block_ The L2 block number the output root commits to.
    @param _createdAt_ The creation timestamp to report for the game.
    @param _resolvedAt_ The resolution timestamp to report for the game.
  */
  function setGame (
    bytes32 _root,
    uint256 _l2Block_,
    uint64 _createdAt_,
    uint64 _resolvedAt_
  ) external {
    rootClaim = _root;
    _l2Block = _l2Block_;
    _createdAt = _createdAt_;
    _resolvedAt = _resolvedAt_;
  }

  /**
    ── DisputeGameFactory surface ──────────────────────────────────────────

    @return _ The number of games in the factory; always one for this mock.
  */
  function gameCount () external pure returns (uint256) {
    return 1;
  }

  /**
    Look up a game by its index in the factory.

    @param _index The index of the game to look up; ignored — this mock always
      describes its single game.

    @return _ The game type, creation timestamp, and proxy address of the game.
  */
  function gameAtIndex (
    uint256 _index
  ) external view returns (uint32, uint64, address) {
    return (_gameType, _createdAt, address(this));
  }

  /**
    viem's getWithdrawalStatus discovers games via findLatestGames.

    @param _gameType_ The dispute game type to filter by; ignored by this mock.
    @param _start The start index to search from; ignored by this mock.
    @param _n The maximum number of games to return; ignored by this mock.

    @return _ A single-element array describing the mock game.
  */
  function findLatestGames (
    uint32 _gameType_,
    uint256 _start,
    uint256 _n
  ) external view returns (GameSearchResult[] memory) {
    GameSearchResult[] memory _games_ = new GameSearchResult[](1);
    _games_[0] = GameSearchResult({
      index: 0,
      metadata: bytes32(
        (uint256(_gameType) << 224) | (uint256(_createdAt) << 160) | uint256(
          uint160(address(this))
        )
      ),
      timestamp: _createdAt,
      rootClaim: rootClaim,
      extraData: abi.encode(_l2Block)
    });
    return _games_;
  }

  /**
    ── IDisputeGame surface (the game IS this contract) ────────────────────

    @return _ The game status; always 2 (GameStatus.DEFENDER_WINS) for this
      mock.
  */
  function status () external pure returns (uint8) {

    // GameStatus.DEFENDER_WINS
    return 2;
  }

  /**
    Return the dispute game type of this game.

    @return _ The dispute game type reported by this mock.
  */
  function gameType () external view returns (uint32) {
    return _gameType;
  }

  /**
    Return the creation timestamp of this game.

    @return _ The creation timestamp of the current mock game.
  */
  function createdAt () external view returns (uint64) {
    return _createdAt;
  }

  /**
    Return the resolution timestamp of this game.

    @return _ The resolution timestamp of the current mock game.
  */
  function resolvedAt () external view returns (uint64) {
    return _resolvedAt;
  }

  /**
    Return the L2 block number this game commits to.

    @return _ The L2 block number committed to by the current mock game.
  */
  function l2BlockNumber () external view returns (uint256) {
    return _l2Block;
  }

  /**
    Report whether this game's type was the respected type when it was created.

    @return _ Always true for this mock.
  */
  function wasRespectedGameTypeWhenCreated () external pure returns (bool) {
    return true;
  }

  /**
    Return the extra data associated with this game.

    @return _ The game's extra data; always empty for this mock.
  */
  function extraData () external pure returns (bytes memory) {
    return hex"";
  }
}

