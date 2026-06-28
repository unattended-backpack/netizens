import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { l1Public } from '../lib/clients';

/** The connected address's native ETH balance on Ethereum (L1) — i.e. ETH that's home. */
export function useL1Balance(owner: Address | undefined) {
  return useQuery({
    queryKey: ['l1-balance', owner],
    queryFn: () => l1Public.getBalance({ address: owner! }),
    enabled: !!owner,
    staleTime: 15_000,
    refetchInterval: 20_000, // so it ticks up as batches finalize
  });
}
