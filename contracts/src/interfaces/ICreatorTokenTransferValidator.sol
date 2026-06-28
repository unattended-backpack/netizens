// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title ICreatorTokenTransferValidator
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Minimal surface of the "Creator Token Transfer Validator" that NetizenL1 calls
  on every non-mint or burn transfer to enforce the collection's policy.

  @custom:date June 22nd, 2026.
*/
interface ICreatorTokenTransferValidator {

  /**
    Reverts if the transfer violates the collection's policy on this validator.

    @param _caller The operator initiating the transfer (`msg.sender` on the
      token).
    @param _from Current owner.
    @param _to Recipient.
    @param _tokenId The token being transferred.
  */
  function validateTransfer (
    address _caller,
    address _from,
    address _to,
    uint256 _tokenId
  ) external;
}

