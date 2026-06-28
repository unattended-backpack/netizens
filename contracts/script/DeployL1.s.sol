// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { ICreateX } from "../src/interfaces/ICreateX.sol";
import { NetizenL1 } from "../src/NetizenL1.sol";
import { Script, console2 } from "forge-std/Script.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title Deploy L1
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Deploy the L1-side Netizens contract.

  @custom:date June 22nd, 2026.
*/
contract DeployL1 is
  Script {

  /**
    Thrown when a CREATE3 vanity deploy does not land at the expected mined
    address.

    @param deployed The address the contract was actually deployed to.
    @param expected The expected (mined) vanity address.
  */
  error UnexpectedAddress (
    address deployed,
    address expected
  );

  /**
    The L1-side L1CrossDomainMessenger (verified on-chain: portal() ==
    OptimismPortal2).
  */
  address constant L1_MESSENGER = 0x6C7198250087B29A8040eC63903Bc130f4831Cc9;

  /// Canonical CreateX factory.
  address constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;

  // The L2-side immutable IPFS metadata CID, so tokenURI(id) matches 1:1.
  string constant BASE_URI =
    "ipfs://bafybeiabi7zjyuo7je4blxba6liprvhht6lcvk2psklin3woty4d4p4274/";

  /**
    Deploy the NetizenL1 ERC-721 on Ethereum mainnet: a plain CREATE on
    localnet, or a CreateX CREATE3 vanity deploy when a deployer-permissioned
    salt is supplied.

    @return _ The deployed NetizenL1 contract.
  */
  function run () external returns (NetizenL1) {
    NetizenL1 _nftOutput;
    uint256 _pk = vm.envUint("DEPLOYER_KEY");
    address _deployer = vm.addr(_pk);
    address _owner = vm.envOr("OWNER", _deployer);
    bytes32 _salt = vm.envOr("NETIZEN_L1_SALT", bytes32(0));
    vm.startBroadcast(_pk);
    if (_salt == bytes32(0)) {

      // Plain CREATE (localnet / testing).
      _nftOutput = new NetizenL1(L1_MESSENGER, _owner, BASE_URI);
    } else {

      /*
        Vanity CREATE3 via CreateX. Require a deployer-permissioned salt (first
        20 bytes == deployer): otherwise the salt is permissionless and anyone
        who sees it (it's public in the broadcast) could front-run the deploy or
        seize the same vanity address with malicious bytecode on another chain.
        Mine salts with this 20-byte prefix.
      */
      require(
        bytes20(_salt) == bytes20(uint160(_deployer)),
        "DeployL1: salt must be deployer-permissioned (first 20 bytes = deployer)"
      );
      bytes memory _initCode =
        abi.encodePacked(
          type(NetizenL1).creationCode,
          abi.encode(L1_MESSENGER, _owner, BASE_URI)
        );
      _nftOutput = NetizenL1(ICreateX(CREATEX).deployCreate3(_salt, _initCode));
      address _expected = vm.envOr("NETIZEN_L1_ADDRESS", address(0));
      if (_expected != address(0) && address(_nftOutput) != _expected) {
        revert UnexpectedAddress(address(_nftOutput), _expected);
      }
    }
    vm.stopBroadcast();
    console2.log("NetizenL1 deployed at:", address(_nftOutput));
    console2.log("  owner:    ", _owner);
    console2.log("  messenger:", L1_MESSENGER);
    console2.log(
      "NEXT (step 2): deploy L2 bridge with  NETIZEN_L1_ADDRESS=",
      address(_nftOutput)
    );
    return _nftOutput;
  }
}

