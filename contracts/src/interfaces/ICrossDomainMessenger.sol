// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title ICrossDomainMessenger
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Minimal interface to the OP-Stack CrossDomainMessenger, used on both domains.
  On L2 this is the predeploy at `0x4200000000000000000000000000000000000007`;
  on Ethereum it is the rabbitchain L1CrossDomainMessenger at
  `0x6c7198250087b29a8040ec63903bc130f4831cc9`.

  @custom:date June 22nd, 2026.
*/
interface ICrossDomainMessenger {

  /**
    Sends a message to a target on the other domain. On L2 this enqueues an
    L2->L1 withdrawal that must be proven and finalized before it is relayed on
    L1.

    @param _target Address of the contract to call on the other domain.
    @param _message ABI-encoded calldata to execute on `_target`.
    @param _minGasLimit Minimum gas that must be available to `_target` when the
      message is relayed.
  */
  function sendMessage (
    address _target,
    bytes calldata _message,
    uint32 _minGasLimit
  ) external payable;

  /**
    During an active relay, returns the address that sent the message on the
    other domain. Reverts or returns the default sentinel outside of a relay.

    @return _ The address that sent the message being relayed from the other
      domain.
  */
  function xDomainMessageSender () external view returns (address);
}

