// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title MockDisputeGame
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Minimal IDisputeGame stand-in for forked prove/finalize tests. Presents a
  resolved, DEFENDER_WINS game with a chosen rootClaim so the REAL
  OptimismPortal2 accepts a withdrawal proven against it. Only the dispute game
  is faked — the portal's proof verification, the messenger relay, and
  finalizeBridge all run for real.

  @custom:date June 22nd, 2026.
*/
contract MockDisputeGame {

  /// The root claim this game resolves to.
  bytes32 public immutable rootClaim;

  /// The dispute game type identifier.
  uint32 internal immutable _gameType;

  /// The timestamp at which the game was created.
  uint64 internal immutable _createdAt;

  /// The timestamp at which the game resolved.
  uint64 internal immutable _resolvedAt;

  /**
    Construct the mock dispute game with fixed claim and timing values.

    @param _root_ The root claim the game resolves to.
    @param _gameType_ The dispute game type identifier.
    @param _createdAt_ The creation timestamp to report.
    @param _resolvedAt_ The resolution timestamp to report.
  */
  constructor (
    bytes32 _root_,
    uint32 _gameType_,
    uint64 _createdAt_,
    uint64 _resolvedAt_
  ) {
    rootClaim = _root_;
    _gameType = _gameType_;
    _createdAt = _createdAt_;
    _resolvedAt = _resolvedAt_;
  }

  /**
    Report the game status, fixed to DEFENDER_WINS for these tests.

    @return _ The resolved game status (2 = GameStatus.DEFENDER_WINS).
  */
  function status () external pure returns (uint8) {
    return 2;
  }

  /**
    Return the configured dispute game type.

    @return _ The dispute game type identifier.
  */
  function gameType () external view returns (uint32) {
    return _gameType;
  }

  /**
    Return the configured creation timestamp.

    @return _ The timestamp at which the game was created.
  */
  function createdAt () external view returns (uint64) {
    return _createdAt;
  }

  /**
    Return the configured resolution timestamp.

    @return _ The timestamp at which the game resolved.
  */
  function resolvedAt () external view returns (uint64) {
    return _resolvedAt;
  }

  /**
    Return the L2 block number the game commits to.

    @return _ The committed L2 block number (always 1 in this mock).
  */
  function l2BlockNumber () external pure returns (uint256) {
    return 1;
  }

  /**
    Report whether the respected game type was used when this game was created.

    @return _ Always true in this mock.
  */
  function wasRespectedGameTypeWhenCreated () external pure returns (bool) {
    return true;
  }

  /**
    Return the game's extra data.

    @return _ Empty bytes in this mock.
  */
  function extraData () external pure returns (bytes memory) {
    return hex"";
  }

  /**
    Return the game type, root claim, and extra data together.

    @return _ A tuple of the game type, the root claim, and the extra data.
  */
  function gameData () external view returns (uint32, bytes32, bytes memory) {
    return (_gameType, rootClaim, hex"");
  }
}

