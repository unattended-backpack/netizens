import { useQuery } from '@tanstack/react-query';
import { type Address, getAddress } from 'viem';
import { l1Public } from '../lib/clients';
import { NETIZEN_L1_ADDRESS, NETIZEN_L1_DEPLOY_BLOCK, transferEvent, BRIDGE_READY } from '../constants/bridge';

/**
 * Enumerate the tokenIds an owner holds on NetizenL1 (the L1 mirror) — i.e. the
 * Netizens that have made it "home". Same Transfer-log derivation as the L2 side, but
 * the contract is freshly deployed so the scan is tiny.
 */
async function fetchHomeTokenIds(owner: Address): Promise<bigint[]> {
  if (!BRIDGE_READY) return [];
  const tip = await l1Public.getBlockNumber();
  const [incoming, outgoing] = await Promise.all([
    l1Public.getLogs({ address: NETIZEN_L1_ADDRESS, event: transferEvent, args: { to: owner }, fromBlock: NETIZEN_L1_DEPLOY_BLOCK, toBlock: tip }),
    l1Public.getLogs({ address: NETIZEN_L1_ADDRESS, event: transferEvent, args: { from: owner }, fromBlock: NETIZEN_L1_DEPLOY_BLOCK, toBlock: tip }),
  ]);

  const events = [...incoming, ...outgoing].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber! < b.blockNumber! ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  const lastTo = new Map<string, Address>();
  for (const e of events) lastTo.set((e.args.tokenId as bigint).toString(), getAddress(e.args.to as Address));

  const me = getAddress(owner);
  const owned = [...lastTo.entries()].filter(([, to]) => to === me).map(([id]) => BigInt(id));
  owned.sort((a, b) => (a < b ? -1 : 1));
  return owned;
}

export function useHomeNetizens(owner: Address | undefined) {
  return useQuery({
    queryKey: ['home-netizens', owner],
    queryFn: () => fetchHomeTokenIds(owner!),
    enabled: !!owner && BRIDGE_READY,
    staleTime: 15_000,
    refetchInterval: 20_000, // so "home" grows as batches finalize
  });
}
