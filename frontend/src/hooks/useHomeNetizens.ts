import { useQuery } from '@tanstack/react-query';
import { type Address } from 'viem';
import { l1Public } from '../lib/clients';
import { NETIZEN_L1_ADDRESS, NETIZEN_L1_DEPLOY_BLOCK, L1_LOG_CHUNK, L1_CHAIN_ID, BRIDGE_READY } from '../constants/bridge';
import { scanOwnedTokens } from '../lib/tokenScan';

/**
 * The tokenIds `owner` holds on NetizenL1 (the L1 mirror) — the Netizens that have made it "home".
 * Uses the shared incremental, localStorage-cached Transfer-log scan (see scanOwnedTokens); only
 * runs once the bridge contracts are configured.
 */
export function useHomeNetizens(owner: Address | undefined) {
  return useQuery({
    queryKey: ['home-netizens', owner],
    queryFn: () => scanOwnedTokens({
      client: l1Public,
      contract: NETIZEN_L1_ADDRESS,
      owner: owner!,
      deployBlock: NETIZEN_L1_DEPLOY_BLOCK,
      chunk: L1_LOG_CHUNK,
      chainId: L1_CHAIN_ID,
    }),
    enabled: !!owner && BRIDGE_READY,
    staleTime: 15_000,
    refetchInterval: 20_000, // so "home" grows as batches finalize
  });
}
