import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { l2Public } from '../lib/clients';

/** The connected address's native ETH balance on MegaETH (L2). */
export function useL2Balance(owner: Address | undefined) {
  return useQuery({
    queryKey: ['l2-balance', owner],
    queryFn: () => l2Public.getBalance({ address: owner! }),
    enabled: !!owner,
    staleTime: 30_000,
  });
}
