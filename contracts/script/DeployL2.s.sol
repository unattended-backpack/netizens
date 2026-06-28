// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { ICreateX } from "../src/interfaces/ICreateX.sol";
import { NetizenBridgeL2 } from "../src/NetizenBridgeL2.sol";
import { Script, console2 } from "forge-std/Script.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title Deploy L2
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Deploy the L2-side Netizens bridge.

  @custom:date June 22nd, 2026.
*/
contract DeployL2 is
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

  /// World Computer Netizens (WCN) on L2.
  address constant WCN = 0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44;

  /// OP-Stack L2CrossDomainMessenger predeploy.
  address constant L2_MESSENGER = 0x4200000000000000000000000000000000000007;

  /// Canonical CreateX factory.
  address constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;

  /**
    Deploy the ownerless NetizenBridgeL2 on L2: a plain CREATE on localnet, or a
    CreateX CREATE3 vanity deploy when a deployer-permissioned salt is supplied.

    @return _ The deployed NetizenBridgeL2 contract.
  */
  function run () external returns (NetizenBridgeL2) {
    NetizenBridgeL2 _bridgeOutput;
    uint256 _pk = vm.envUint("DEPLOYER_KEY");
    address _deployer = vm.addr(_pk);
    address _l1Target = vm.envAddress("NETIZEN_L1_ADDRESS");
    bytes32 _salt = vm.envOr("BRIDGE_L2_SALT", bytes32(0));
    vm.startBroadcast(_pk);
    if (_salt == bytes32(0)) {

      // Plain CREATE (localnet / testing).
      _bridgeOutput = new NetizenBridgeL2(WCN, L2_MESSENGER, _l1Target);
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
        "DeployL2: salt must be deployer-permissioned (first 20 bytes = deployer)"
      );
      bytes memory _initCode =
        abi.encodePacked(
          type(NetizenBridgeL2).creationCode,
          abi.encode(WCN, L2_MESSENGER, _l1Target)
        );
      _bridgeOutput = NetizenBridgeL2(
        ICreateX(CREATEX).deployCreate3(_salt, _initCode)
      );
      address _expected = vm.envOr("BRIDGE_L2_ADDRESS", address(0));
      if (_expected != address(0) && address(_bridgeOutput) != _expected) {
        revert UnexpectedAddress(address(_bridgeOutput), _expected);
      }
    }
    vm.stopBroadcast();
    console2.log("NetizenBridgeL2 deployed at:", address(_bridgeOutput));
    console2.log("  nft:      ", WCN);
    console2.log("  l1Target: ", _l1Target);
    console2.log(
      "NEXT (step 3): on L1 run WireL1 with  BRIDGE_L2_ADDRESS=",
      address(_bridgeOutput)
    );
    return _bridgeOutput;
  }
}

