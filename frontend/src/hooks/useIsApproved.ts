import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { l2Public } from '../lib/clients';
import { WCN_ADDRESS, BRIDGE_L2_ADDRESS, wcnAbi } from '../constants/bridge';

/** Whether the bridge is already an approved operator for `owner`'s WCN on L2. */
export function useIsApproved(owner: Address | undefined) {
  return useQuery({
    queryKey: ['is-approved', owner, BRIDGE_L2_ADDRESS],
    queryFn: () =>
      l2Public.readContract({
        address: WCN_ADDRESS,
        abi: wcnAbi,
        functionName: 'isApprovedForAll',
        args: [owner!, BRIDGE_L2_ADDRESS],
      }) as Promise<boolean>,
    enabled: !!owner,
    staleTime: 30_000,
  });
}
