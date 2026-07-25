import { type Address, type PublicClient, getAddress } from 'viem';
import { transferEvent } from '../constants/bridge';

/**
 * Incremental, persisted holder scan. Enumerates the tokenIds `owner` currently holds on
 * `contract` by deriving ownership from ERC-721 Transfer logs, caching progress in localStorage.
 *
 * The first call scans deployBlock->tip in <=`chunk` windows (bounds RPCs that cap eth_getLogs,
 * e.g. QuickNode's ~10k-block limit). Later calls — this session or a future one — scan only the
 * delta since the persisted cursor, so returning users don't re-scan history and the every-poll
 * refetch stays cheap. The cursor is kept REORG_BUFFER blocks behind tip and that trailing window
 * is always re-scanned, so a shallow reorg is re-derived rather than baked into the cache.
 *
 * Every change to the owner's holdings shows up as a to:owner (incoming) or from:owner (outgoing)
 * log, so caching just the owned set — and replaying the delta onto it in block/log order — is
 * sufficient and keeps the cache tiny (only the owner's tokens).
 */

const CACHE_VERSION = 'v1';
const REORG_BUFFER = 16n;

type ScanCache = { lastBlock: string; owned: string[] };

const cacheKey = (chainId: number, contract: Address, owner: Address): string =>
  `netizen-bridge:scan:${CACHE_VERSION}:${chainId}:${contract.toLowerCase()}:${owner.toLowerCase()}`;

function loadCache(key: string): ScanCache | null {
  try {
    const raw = localStorage.getItem(key);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p.lastBlock === 'string' && Array.isArray(p.owned) ? (p as ScanCache) : null;
  } catch {
    return null;
  }
}
function saveCache(key: string, c: ScanCache): void {
  try { localStorage.setItem(key, JSON.stringify(c)); } catch { /* ignore quota / private mode */ }
}

export async function scanOwnedTokens(opts: {
  client: Pick<PublicClient, 'getBlockNumber' | 'getLogs'>;
  contract: Address;
  owner: Address;
  deployBlock: bigint;
  chunk: bigint;
  chainId: number;
}): Promise<bigint[]> {
  const { client, contract, owner, deployBlock, chunk, chainId } = opts;
  const key = cacheKey(chainId, contract, owner);
  const cached = loadCache(key);
  const me = getAddress(owner);
  const tip = await client.getBlockNumber();

  // `live` = current owned set (up to tip); seeded from cache, updated by the delta below.
  const live = new Set<string>(cached?.owned ?? []);
  const from = cached ? BigInt(cached.lastBlock) + 1n : deployBlock;

  if (from <= tip) {
    // Scan [from, tip] in <=chunk windows; each fetches the owner's incoming + outgoing transfers.
    const ranges: Array<{ from: bigint; to: bigint }> = [];
    for (let f = from; f <= tip; f += chunk + 1n) {
      ranges.push({ from: f, to: f + chunk > tip ? tip : f + chunk });
    }
    const perRange = await Promise.all(
      ranges.map(({ from: f, to }) =>
        Promise.all([
          client.getLogs({ address: contract, event: transferEvent, args: { to: owner }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: contract, event: transferEvent, args: { from: owner }, fromBlock: f, toBlock: to }),
        ]).then(([inc, out]) => [...inc, ...out]),
      ),
    );
    const events = perRange.flat().sort((a, b) =>
      a.blockNumber !== b.blockNumber ? (a.blockNumber! < b.blockNumber! ? -1 : 1) : (a.logIndex ?? 0) - (b.logIndex ?? 0),
    );

    // Persist only up to a cursor REORG_BUFFER behind tip; the trailing window stays unpersisted so
    // it is re-derived next time. `safe` mirrors `live` but excludes those recent (reorg-prone) blocks.
    const safeCursor = tip > REORG_BUFFER ? tip - REORG_BUFFER : deployBlock > 0n ? deployBlock - 1n : 0n;
    const safe = new Set<string>(cached?.owned ?? []);
    for (const e of events) {
      const id = (e.args.tokenId as bigint).toString();
      const incoming = getAddress(e.args.to as Address) === me; // to==owner => incoming; else from==owner => outgoing
      if (incoming) live.add(id); else live.delete(id);
      if (e.blockNumber! <= safeCursor) { if (incoming) safe.add(id); else safe.delete(id); }
    }
    const prevCursor = cached ? BigInt(cached.lastBlock) : deployBlock - 1n;
    const newCursor = safeCursor > prevCursor ? safeCursor : prevCursor;
    saveCache(key, { lastBlock: newCursor.toString(), owned: [...safe] });
  }

  return [...live].map((id) => BigInt(id)).sort((a, b) => (a < b ? -1 : 1));
}
