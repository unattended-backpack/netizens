// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { ERC721 } from "solady/tokens/ERC721.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title MockWCN
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Stand-in for the MegaETH WCN collection: ERC721 with an owner-or-approved
  `burn(uint256)` (matches the decoded burn(uint256)=0x42966c68 on the real
  contract). Solady's `_burn(by, id)` performs the owner-or-approved check.

  @custom:date June 22nd, 2026.
*/
contract MockWCN is
  ERC721 {

  /**
    Return the name of this token collection.

    @return _ The token collection name.
  */
  function name () public pure override returns (string memory) {
    return "World Computer Netizens";
  }

  /**
    Return the symbol of this token collection.

    @return _ The token collection symbol.
  */
  function symbol () public pure override returns (string memory) {
    return "WCN";
  }

  /**
    Return the metadata URI for a token; this mock returns an empty string for
    every token identifier.

    @param _tokenId The identifier of the token to query (unused by this mock).

    @return _ An empty string for all tokens.
  */
  function tokenURI (
    uint256 _tokenId
  ) public pure override returns (string memory) {
    return "";
  }

  /**
    Mint a token to a recipient.

    @param _to The address to receive the newly minted token.
    @param _tokenId The identifier of the token to mint.
  */
  function mint (
    address _to,
    uint256 _tokenId
  ) external {
    _mint(_to, _tokenId);
  }

  /**
    Burn a token held or approved by the caller, reverting if the caller is
    neither the owner nor an approved operator.

    @param _tokenId The identifier of the token to burn.
  */
  function burn (
    uint256 _tokenId
  ) external {
    _burn(msg.sender, _tokenId);
  }
}

