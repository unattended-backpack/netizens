import { useQuery } from '@tanstack/react-query';
import { type Address, getAddress } from 'viem';
import { l2Public } from '../lib/clients';
import { WCN_ADDRESS, transferEvent, WCN_DEPLOY_BLOCK } from '../constants/bridge';

/**
 * Enumerate the WCN tokenIds currently held by `owner` on MegaETH. WCN is not
 * Enumerable, so we derive holdings from Transfer logs: collect every transfer that
 * touches `owner`, and for each tokenId the most recent one decides current ownership.
 * No per-token ownerOf calls — just two indexed getLogs.
 */
async function fetchOwnedTokenIds(owner: Address): Promise<bigint[]> {
  const tip = await l2Public.getBlockNumber();
  const [incoming, outgoing] = await Promise.all([
    l2Public.getLogs({ address: WCN_ADDRESS, event: transferEvent, args: { to: owner }, fromBlock: WCN_DEPLOY_BLOCK, toBlock: tip }),
    l2Public.getLogs({ address: WCN_ADDRESS, event: transferEvent, args: { from: owner }, fromBlock: WCN_DEPLOY_BLOCK, toBlock: tip }),
  ]);

  const events = [...incoming, ...outgoing].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber! < b.blockNumber! ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  // Last transfer per tokenId wins.
  const lastTo = new Map<string, Address>();
  for (const e of events) {
    lastTo.set((e.args.tokenId as bigint).toString(), getAddress(e.args.to as Address));
  }

  const me = getAddress(owner);
  const owned = [...lastTo.entries()].filter(([, to]) => to === me).map(([id]) => BigInt(id));
  owned.sort((a, b) => (a < b ? -1 : 1));
  return owned;
}

export function useNetizens(owner: Address | undefined) {
  return useQuery({
    queryKey: ['netizens', owner],
    queryFn: () => fetchOwnedTokenIds(owner!),
    enabled: !!owner,
    staleTime: 15_000,
    refetchInterval: 20_000, // so "at risk" shrinks as batches burn
  });
}
