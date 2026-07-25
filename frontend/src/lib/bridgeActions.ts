import type { Address, Hash, WalletClient } from 'viem';
import { parseAbiItem } from 'viem';
import { getWithdrawals, getL2TransactionHashes, walletActionsL1 } from 'viem/op-stack';
import { l1Public, l2Public } from './clients';
import {
  megaeth, DISPUTE_GAME_FACTORY, KAILUA_GAME_TYPE, OPTIMISM_PORTAL_ADDRESS,
  WCN_ADDRESS, BRIDGE_L2_ADDRESS, wcnAbi,
  WCN_DEPLOY_BLOCK, IS_LOCALNET,
} from '../constants/bridge';
import type { BridgeJob, Batch, BatchDerived } from './jobs';

const bridgeInitiatedEvent = parseAbiItem(
  'event BridgeInitiated(address indexed from, address indexed l1Recipient, uint256[] tokenIds, uint256 ethAmount)',
);

const factoryAbi = [
  { type: 'function', name: 'gameCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'gameAtIndex', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint32' }, { type: 'uint64' }, { type: 'address' }] },
] as const;
const gameAbi = [
  { type: 'function', name: 'l2BlockNumber', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'rootClaim', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'status', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'resolvedAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'createdAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
] as const;

// OptimismPortal2 reads. viem's getWithdrawalStatus/getTimeTo* can't decode the Kailua dispute
// factory's non-standard ABI (they throw), so we derive withdrawal state from the portal directly.
const portalAbi = [
  { type: 'function', name: 'finalizedWithdrawals', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'provenWithdrawals', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'address' }, { type: 'uint64' }] },
  { type: 'function', name: 'proofMaturityDelaySeconds', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'disputeGameFinalityDelaySeconds', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

/** Newest Kailua (gameType 1337) game whose root covers the withdrawal's L2 block. */
async function findOutput(withdrawalL2Block: bigint) {
  const gameCount = (await l1Public.readContract({ address: DISPUTE_GAME_FACTORY, abi: factoryAbi, functionName: 'gameCount' })) as bigint;
  for (let i = gameCount - 1n; i >= 0n; i--) {
    const [gameType, , gameAddr] = (await l1Public.readContract({ address: DISPUTE_GAME_FACTORY, abi: factoryAbi, functionName: 'gameAtIndex', args: [i] })) as [number, bigint, Address];
    if (Number(gameType) !== KAILUA_GAME_TYPE) continue;
    const l2Block = (await l1Public.readContract({ address: gameAddr, abi: gameAbi, functionName: 'l2BlockNumber' })) as bigint;
    if (l2Block < withdrawalL2Block) break;
    const rootClaim = (await l1Public.readContract({ address: gameAddr, abi: gameAbi, functionName: 'rootClaim' })) as Hash;
    return { outputIndex: i, outputRoot: rootClaim, l2BlockNumber: l2Block };
  }
  throw new Error('No dispute game covering this withdrawal has been proposed yet.');
}

/** On the localnet the relayer replays a deposit as a normal L2 tx (its own hash, not the
 *  OP-derived one), so locate the actual bridge tx via the BridgeInitiated event — which
 *  also works for an ETH-only batch (there's no burn to scan for). */
async function findL2BridgeTx(owner: Address, b: Batch): Promise<Hash | undefined> {
  try {
    const tip = await l2Public.getBlockNumber();
    const logs = await l2Public.getLogs({
      address: BRIDGE_L2_ADDRESS,
      event: bridgeInitiatedEvent,
      args: { from: owner },
      fromBlock: WCN_DEPLOY_BLOCK,
      toBlock: tip,
    });
    const want = b.tokenIds.map(String).sort().join(',');
    const wantEth = BigInt(b.ethAmount);
    for (let i = logs.length - 1; i >= 0; i--) {
      const ids = ((logs[i].args.tokenIds as readonly bigint[]) ?? []).map(String).sort().join(',');
      const hit = b.tokenIds.length > 0 ? ids === want : ids === '' && (logs[i].args.ethAmount as bigint) === wantEth;
      if (hit) return logs[i].transactionHash as Hash | undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive the withdrawal lifecycle for a landed L2 bridge, Kailua-correctly (viem's
 * getWithdrawalStatus throws on the Kailua factory's ABI). Prove-readiness comes from whether a
 * covering output root exists (findOutput); finalize-readiness from the portal's proven/finalized
 * state plus the proof-maturity + dispute-game-finality delays and the game's resolution.
 */
async function deriveWithdrawal(
  account: Address,
  l2r: Awaited<ReturnType<typeof l2Public.getTransactionReceipt>>,
): Promise<Partial<BatchDerived>> {
  const [withdrawal] = getWithdrawals(l2r);
  if (!withdrawal) return {};
  const wHash = withdrawal.withdrawalHash;
  const nowSec = Math.floor(Date.now() / 1000);

  const finalized = await l1Public
    .readContract({ address: OPTIMISM_PORTAL_ADDRESS, abi: portalAbi, functionName: 'finalizedWithdrawals', args: [wHash] })
    .catch(() => false);
  if (finalized) return { withdrawal: 'finalized' };

  const proven = await l1Public
    .readContract({ address: OPTIMISM_PORTAL_ADDRESS, abi: portalAbi, functionName: 'provenWithdrawals', args: [wHash, account] })
    .catch(() => null);
  const provenAt = proven ? Number(proven[1]) : 0;
  const gameProxy = proven ? proven[0] : ZERO_ADDR;

  if (provenAt > 0 && gameProxy.toLowerCase() !== ZERO_ADDR) {
    const [proofDelay, gameDelay] = await Promise.all([
      l1Public.readContract({ address: OPTIMISM_PORTAL_ADDRESS, abi: portalAbi, functionName: 'proofMaturityDelaySeconds' }).catch(() => 0n),
      l1Public.readContract({ address: OPTIMISM_PORTAL_ADDRESS, abi: portalAbi, functionName: 'disputeGameFinalityDelaySeconds' }).catch(() => 0n),
    ]);
    const [status, resolvedAt, createdAt] = await Promise.all([
      l1Public.readContract({ address: gameProxy, abi: gameAbi, functionName: 'status' }).catch(() => 0),
      l1Public.readContract({ address: gameProxy, abi: gameAbi, functionName: 'resolvedAt' }).catch(() => 0n),
      l1Public.readContract({ address: gameProxy, abi: gameAbi, functionName: 'createdAt' }).catch(() => 0n),
    ]);
    const resolved = Number(status) === 2; // GameStatus.DEFENDER_WINS
    // Finalizable once the proof has matured AND the game has resolved AND its air-gap has passed.
    // Surface ONE cumulative ETA (not a 7d proof-maturity timer that then resets to a fresh 3.5d
    // air-gap timer): take the max of the proof-maturity deadline and the game-resolution air-gap.
    // Before the game resolves, estimate its resolution as createdAt + the proof-maturity window
    // (the Kailua game window matches it on this chain); once resolved, use the exact resolvedAt
    // (near-identical, so the countdown doesn't jump).
    const resolveAt = resolved ? Number(resolvedAt) : Number(createdAt) + Number(proofDelay);
    const finalizeAt = Math.max(provenAt + Number(proofDelay), resolveAt + Number(gameDelay));
    if (resolved && nowSec >= finalizeAt) return { withdrawal: 'ready-to-finalize' };
    return { withdrawal: 'waiting-to-finalize', finalizeAtUnix: finalizeAt };
  }

  // Not yet proven: provable as soon as an output root covers the withdrawal's L2 block.
  try {
    await findOutput(l2r.blockNumber!);
    return { withdrawal: 'ready-to-prove' };
  } catch {
    return { withdrawal: 'waiting-to-prove' };
  }
}

/** Recompute the chain-derived progress of one batch. */
async function refreshBatch(account: Address, b: Batch): Promise<Batch> {
  const d: BatchDerived = { bridgeL1: false, bridgeL2: false };
  let l2TxHash = b.l2TxHash;

  if (b.bridgeHash) {
    const r = await l1Public.getTransactionReceipt({ hash: b.bridgeHash }).catch(() => null);
    d.bridgeL1 = !!r && r.status === 'success';
    if (d.bridgeL1 && r) {
      if (IS_LOCALNET) {
        // Always re-derive: the relayer's replay hash isn't the OP-derived one, and a
        // previously-stored (wrong) hash from an earlier build must be corrected.
        l2TxHash = (await findL2BridgeTx(account, b)) ?? l2TxHash;
      } else if (!l2TxHash) {
        l2TxHash = getL2TransactionHashes({ logs: r.logs })[0];
      }
    }
  }

  if (l2TxHash) {
    const l2r = await l2Public.getTransactionReceipt({ hash: l2TxHash }).catch(() => null);
    if (l2r && l2r.status === 'success') {
      d.bridgeL2 = true;
      Object.assign(d, await deriveWithdrawal(account, l2r).catch(() => ({})));
    } else if (l2r) {
      d.bridgeReverted = true;
    }
  }

  // If a submitted prove/finalize reverted, drop the hash so the cell becomes retryable
  // (otherwise it sits in "pending" forever). Pending-but-unmined receipts are left alone.
  let proveHash = b.proveHash;
  let finalizeHash = b.finalizeHash;
  if (proveHash) {
    const pr = await l1Public.getTransactionReceipt({ hash: proveHash }).catch(() => null);
    if (pr && pr.status !== 'success') proveHash = undefined;
  }
  if (finalizeHash) {
    const fr = await l1Public.getTransactionReceipt({ hash: finalizeHash }).catch(() => null);
    if (fr && fr.status !== 'success') finalizeHash = undefined;
  }
  return { ...b, l2TxHash, proveHash, finalizeHash, derived: d };
}

/** Read-only: recompute a journey's approve + per-batch progress. */
export async function refreshJobStatus(job: BridgeJob): Promise<Partial<BridgeJob>> {
  const approveDerived = { approveL1: false, approveL2: false };
  if (job.approveSkipped) {
    approveDerived.approveL1 = true;
    approveDerived.approveL2 = true;
  } else if (job.approveHash) {
    const r = await l1Public.getTransactionReceipt({ hash: job.approveHash }).catch(() => null);
    approveDerived.approveL1 = !!r && r.status === 'success';
    if (approveDerived.approveL1) {
      const ok = await l2Public
        .readContract({ address: WCN_ADDRESS, abi: wcnAbi, functionName: 'isApprovedForAll', args: [job.account, BRIDGE_L2_ADDRESS] })
        .catch(() => false);
      approveDerived.approveL2 = !!ok;
    }
  }

  const batches = await Promise.all(job.batches.map((b) => refreshBatch(job.account, b)));
  return { approveDerived, batches };
}

/** Prove one batch's withdrawal on Ethereum. */
export async function proveBatch(job: BridgeJob, batchIndex: number, walletClient: WalletClient): Promise<Hash> {
  const b = job.batches[batchIndex];
  if (!b?.l2TxHash) throw new Error('This batch has not landed on L2 yet');
  const w = walletClient.extend(walletActionsL1());
  const receipt = await l2Public.getTransactionReceipt({ hash: b.l2TxHash });
  const [withdrawal] = getWithdrawals(receipt);
  const output = await findOutput(receipt.blockNumber!);
  const proveArgs = await l2Public.buildProveWithdrawal({ output, withdrawal } as never);
  return w.proveWithdrawal({ ...proveArgs, targetChain: megaeth, account: walletClient.account! } as never);
}

/** Finalize one batch's withdrawal on Ethereum → mints + delivers ETH. */
export async function finalizeBatch(job: BridgeJob, batchIndex: number, walletClient: WalletClient): Promise<Hash> {
  const b = job.batches[batchIndex];
  if (!b?.l2TxHash) throw new Error('This batch has not landed on L2 yet');
  const w = walletClient.extend(walletActionsL1());
  const receipt = await l2Public.getTransactionReceipt({ hash: b.l2TxHash });
  const [withdrawal] = getWithdrawals(receipt);
  return w.finalizeWithdrawal({ targetChain: megaeth, withdrawal, account: walletClient.account! } as never);
}
