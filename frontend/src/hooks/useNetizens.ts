import { useQuery } from '@tanstack/react-query';
import { type Address } from 'viem';
import { l2Public } from '../lib/clients';
import { WCN_ADDRESS, WCN_DEPLOY_BLOCK, L2_LOG_CHUNK, L2_CHAIN_ID } from '../constants/bridge';
import { scanOwnedTokens } from '../lib/tokenScan';

/**
 * The WCN tokenIds `owner` currently holds on MegaETH (the "at risk" set). WCN is not Enumerable,
 * so ownership is derived from Transfer logs via the shared incremental, localStorage-cached scan
 * (see scanOwnedTokens) — no per-token ownerOf calls.
 */
export function useNetizens(owner: Address | undefined) {
  return useQuery({
    queryKey: ['netizens', owner],
    queryFn: () => scanOwnedTokens({
      client: l2Public,
      contract: WCN_ADDRESS,
      owner: owner!,
      deployBlock: WCN_DEPLOY_BLOCK,
      chunk: L2_LOG_CHUNK,
      chainId: L2_CHAIN_ID,
    }),
    enabled: !!owner,
    staleTime: 15_000,
    refetchInterval: 20_000, // so "at risk" shrinks as batches burn
  });
}
