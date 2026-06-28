import { useQuery } from '@tanstack/react-query';
import type { Address, Hash } from 'viem';
import { l2Public } from '../lib/clients';
import { WCN_ADDRESS, BRIDGE_L2_ADDRESS, WCN_DEPLOY_BLOCK, approvalForAllEvent, BRIDGE_READY } from '../constants/bridge';

/**
 * The tx hash of the owner's most recent setApprovalForAll(bridge, true) on MegaETH —
 * so the "Approve" step can show a real hash even when the user was already approved
 * (the approval predates this journey, so we have no locally-tracked hash).
 */
async function fetchApprovalTx(owner: Address): Promise<Hash | null> {
  if (!BRIDGE_READY) return null;
  const tip = await l2Public.getBlockNumber();
  const logs = await l2Public.getLogs({
    address: WCN_ADDRESS,
    event: approvalForAllEvent,
    args: { owner, operator: BRIDGE_L2_ADDRESS },
    fromBlock: WCN_DEPLOY_BLOCK,
    toBlock: tip,
  });
  const approved = logs.filter((l) => l.args.approved === true);
  return approved.length ? (approved[approved.length - 1].transactionHash as Hash) : null;
}

export function useApprovalTx(owner: Address | undefined) {
  return useQuery({
    queryKey: ['approval-tx', owner],
    queryFn: () => fetchApprovalTx(owner!),
    enabled: !!owner && BRIDGE_READY,
    staleTime: 60_000,
  });
}
