// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { NetizenL1 } from "../src/NetizenL1.sol";
import { Script, console2 } from "forge-std/Script.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title Wire L1
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Bind the L1-side Netizens to the L2 bridge.

  @custom:date June 22nd, 2026.
*/
contract WireL1 is
  Script {

  /**
    Bind the trusted L2 bridge on NetizenL1 via setL2Bridge (a one-time
    operation), reverting unless the wiring takes effect on-chain.
  */
  function run () external {
    uint256 _pk = vm.envUint("DEPLOYER_KEY");
    NetizenL1 _nft = NetizenL1(vm.envAddress("NETIZEN_L1_ADDRESS"));
    address _l2Bridge = vm.envAddress("BRIDGE_L2_ADDRESS");
    require(_nft.L2_BRIDGE() == address(0), "WireL1: already wired");
    vm.startBroadcast(_pk);
    _nft.setL2Bridge(_l2Bridge);
    vm.stopBroadcast();

    // Post-condition: verify on-chain before declaring success.
    require(_nft.L2_BRIDGE() == _l2Bridge, "WireL1: wiring mismatch");
    console2.log("Wired NetizenL1:", address(_nft));
    console2.log("  l2Bridge =", _nft.L2_BRIDGE());
    console2.log("Bridge is live!");
  }
}

