// SPDX-License-Identifier: LicenseRef-VPL WITH AGPL-3.0-only
pragma solidity 0.8.35;

import { ICrossDomainMessenger } from
  "../../src/interfaces/ICrossDomainMessenger.sol";

/**
  @custom:benediction DEVS BENEDICAT ET PROTEGAT CONTRACTVM MEVM
  @title MockCrossDomainMessenger
  @author Tim Clancy <tim-clancy.eth>
  @custom:terry "Is this too much voodoo for the next ten centuries?"

  Test double for the OP-Stack CrossDomainMessenger. `sendMessage` records the
  outbound message (as the L2 messenger would). `relay` simulates the L1-side
  relay: it sets `xDomainMessageSender` to the claimed L2 sender and calls the
  target, mirroring relayMessage.

  @custom:date June 22nd, 2026.
*/
contract MockCrossDomainMessenger is
  ICrossDomainMessenger {

  /// The claimed other-domain sender, set only during an active `relay` call.
  address public override xDomainMessageSender;

  // Last captured outbound message.
  address public lastTarget;

  /// The calldata payload of the last captured outbound message.
  bytes public lastMessage;

  /// The minimum gas limit of the last captured outbound message.
  uint32 public lastMinGasLimit;

  /// The ETH value attached to the last captured outbound message.
  uint256 public lastValue;

  /// The total number of outbound messages captured.
  uint256 public sendCount;

  /**
    Capture an outbound cross-domain message, recording its target, payload, gas
    limit, and attached value as the L2 messenger would.

    @param _target The address the message would be delivered to.
    @param _message The calldata payload of the message.
    @param _minGasLimit The minimum gas limit requested for the other domain.
  */
  function sendMessage (
    address _target,
    bytes calldata _message,
    uint32 _minGasLimit
  ) external payable override {
    lastTarget = _target;
    lastMessage = _message;
    lastMinGasLimit = _minGasLimit;
    lastValue = msg.value;
    sendCount += 1;
  }

  /**
    Simulate relaying a message on the destination domain, forwarding any ETH
    value (as the real messenger does for value-bearing withdrawals).

    @param _xSender The address that "sent" the message on the other domain.
    @param _target The contract to call.
    @param _message The calldata to execute.
  */
  function relay (
    address _xSender,
    address _target,
    bytes calldata _message
  ) external payable {
    xDomainMessageSender = _xSender;
    (bool _ok, bytes memory _ret) = _target.call{ value: msg.value }(_message);
    xDomainMessageSender = address(0);
    if (!_ok) {
      assembly {
        revert(add(_ret, 0x20), mload(_ret))
      }
    }
  }
}

