import type { Address, Hash } from 'viem';
import { formatDuration } from './format';

/** One force-inclusion batch: a chunk of tokenIds (possibly empty for ETH-only) bridged in one deposit. */
export type Batch = {
  index: number;
  tokenIds: string[]; // decimal strings; empty for an ETH-only batch
  ethAmount: string; // wei this batch sweeps (full balance on the session's first batch, "0" otherwise)
  bridgeHash?: Hash;
  l2TxHash?: Hash;
  proveHash?: Hash;
  finalizeHash?: Hash;
  derived?: BatchDerived;
};

export type BatchDerived = {
  bridgeL1: boolean;
  bridgeL2: boolean;
  bridgeReverted?: boolean;
  withdrawal?: 'waiting-to-prove' | 'ready-to-prove' | 'waiting-to-finalize' | 'ready-to-finalize' | 'finalized';
  proveAtUnix?: number;
  finalizeAtUnix?: number;
};

/** One accumulating bridge journey per account: a shared approval + a growing list of batches. */
export type BridgeJob = {
  id: string;
  account: Address;
  recipient: Address;
  createdAt: number;
  updatedAt: number;
  approveSkipped?: boolean;
  approveHash?: Hash;
  approveDerived?: { approveL1: boolean; approveL2: boolean };
  batches: Batch[];
};

export type StepStatus = 'locked' | 'active' | 'pending' | 'waiting' | 'done' | 'error';
export type StepView = { status: StepStatus; detail: string; hash?: Hash };
export type BatchView = { index: number; ref: string; count: number; ethOnly: boolean; bridge: StepView; prove: StepView; finalize: StepView };
export type JourneyView = { approve: StepView; batches: BatchView[]; allFinalized: boolean };

const KEY = 'netizen-bridge:jobs:v3';

export function loadJobs(): BridgeJob[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as BridgeJob[]) : [];
    if (!Array.isArray(parsed)) return [];
    // Consolidate to ONE accumulating job per account (older builds made one per session),
    // so all batches live in a single continuous journey.
    const byAccount = new Map<string, BridgeJob>();
    for (const j of [...parsed].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!j?.account) continue;
      const k = j.account.toLowerCase();
      const ex = byAccount.get(k);
      if (!ex) byAccount.set(k, { ...j, batches: [...(j.batches ?? [])] });
      else {
        ex.batches.push(...(j.batches ?? []));
        ex.approveHash = ex.approveHash ?? j.approveHash;
        ex.approveSkipped = ex.approveSkipped || j.approveSkipped;
        ex.approveDerived = ex.approveDerived ?? j.approveDerived;
        ex.updatedAt = Math.max(ex.updatedAt, j.updatedAt);
      }
    }
    for (const j of byAccount.values()) j.batches = j.batches.map((b, i) => ({ ...b, index: i }));
    return [...byAccount.values()];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: BridgeJob[]): void {
  localStorage.setItem(KEY, JSON.stringify(jobs));
}

export function newJob(input: { account: Address; recipient: Address; approveSkipped?: boolean; approveHash?: Hash }): BridgeJob {
  return {
    id: `${input.account}-${Date.now()}`,
    account: input.account,
    recipient: input.recipient,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    approveSkipped: input.approveSkipped,
    approveHash: input.approveHash,
    batches: [],
  };
}

/** Chunk pending tokens + ETH into batch records. ETH rides the first batch; an empty
 *  token list with ETH yields a single ETH-only batch. */
export function chunkBatches(tokenIds: bigint[], ethAmount: bigint, size: number): Batch[] {
  const out: Batch[] = [];
  if (tokenIds.length === 0) {
    if (ethAmount > 0n) out.push({ index: 0, tokenIds: [], ethAmount: ethAmount.toString() });
    return out;
  }
  for (let i = 0; i < tokenIds.length; i += size) {
    out.push({
      index: out.length,
      tokenIds: tokenIds.slice(i, i + size).map((t) => t.toString()),
      ethAmount: out.length === 0 ? ethAmount.toString() : '0',
    });
  }
  return out;
}

/** The account's single accumulating journey, or null. */
export function theJob(jobs: BridgeJob[], account?: Address): BridgeJob | null {
  if (!account) return null;
  return jobs.find((j) => j.account.toLowerCase() === account.toLowerCase()) ?? null;
}

const countdown = (atUnix: number | undefined, nowSec: number, fallback: string) =>
  atUnix && atUnix > nowSec ? `~${formatDuration(atUnix - nowSec)}` : fallback;

function bridgeLabel(b: Batch): string {
  if (b.tokenIds.length === 0) return 'Sweep your ETH home.';
  return `Burn ${b.tokenIds.length}${b.ethAmount !== '0' ? ' + sweep ETH' : ''} on L2.`;
}

/** View for a started batch (has a bridge tx), derived from chain state. */
function startedView(b: Batch, index: number, ref: string, nowSec: number): BatchView {
  const d = b.derived;
  const ethOnly = b.tokenIds.length === 0;

  let bridge: StepView;
  if (d?.bridgeReverted) bridge = { status: 'error', detail: 'bridge() reverted on L2. Retry.', hash: b.bridgeHash };
  else if (!b.bridgeHash) bridge = { status: 'active', detail: bridgeLabel(b) };
  else if (!d?.bridgeL1) bridge = { status: 'pending', detail: 'Confirming on Ethereum…', hash: b.bridgeHash };
  else if (!d?.bridgeL2) bridge = { status: 'pending', detail: 'Executing on L2…', hash: b.bridgeHash };
  else bridge = { status: 'done', detail: ethOnly ? 'Swept on L2.' : 'Burned on L2.', hash: b.bridgeHash };

  const wd = d?.withdrawal;
  const proven = wd === 'waiting-to-finalize' || wd === 'ready-to-finalize' || wd === 'finalized';
  let prove: StepView;
  if (!d?.bridgeL2) prove = { status: 'locked', detail: 'Unlocks once this batch lands on L2.' };
  else if (proven) prove = { status: 'done', detail: 'Proven on Ethereum.', hash: b.proveHash };
  else if (wd === 'ready-to-prove') prove = { status: b.proveHash ? 'pending' : 'active', detail: b.proveHash ? 'Proving…' : 'Submit the proof.', hash: b.proveHash };
  else prove = { status: 'waiting', detail: `Waiting for a state root ${countdown(d?.proveAtUnix, nowSec, '(short wait)')}` };

  let finalize: StepView;
  if (!proven) finalize = { status: 'locked', detail: 'Unlocks after proving.' };
  else if (wd === 'finalized') finalize = { status: 'done', detail: 'Home on Ethereum.', hash: b.finalizeHash };
  else if (wd === 'ready-to-finalize') finalize = { status: b.finalizeHash ? 'pending' : 'active', detail: b.finalizeHash ? 'Finalizing…' : 'Mint + receive ETH.', hash: b.finalizeHash };
  else finalize = { status: 'waiting', detail: `Challenge window ${countdown(d?.finalizeAtUnix, nowSec, '(~7 days)')}` };

  return { index, ref, count: b.tokenIds.length, ethOnly, bridge, prove, finalize };
}

/** View for a not-yet-started (preview) batch. */
function previewView(b: Batch, index: number, ref: string, approveL1: boolean): BatchView {
  return {
    index,
    ref,
    count: b.tokenIds.length,
    ethOnly: b.tokenIds.length === 0,
    bridge: { status: approveL1 ? 'active' : 'locked', detail: approveL1 ? bridgeLabel(b) : 'Unlocks after approval lands on Ethereum.' },
    prove: { status: 'locked', detail: 'Unlocks once this batch lands on L2.' },
    finalize: { status: 'locked', detail: 'Unlocks after proving.' },
  };
}

/** Derive the approve step + the flat batch list (started batches followed by previews). */
export function deriveJourney(
  job: BridgeJob | null,
  previewBatches: Batch[],
  approvedNow: boolean,
  nowSec: number,
  approveTxHash?: Hash,
): JourneyView {
  const ad = job?.approveDerived;
  const approveL1 = job ? !!(job.approveSkipped || ad?.approveL1) : approvedNow;
  const approveL2 = job ? !!(job.approveSkipped || ad?.approveL2) : approvedNow;

  let approve: StepView;
  if (job?.approveSkipped || (!job && approvedNow)) {
    approve = { status: 'done', detail: 'Already approved on L2.', hash: job?.approveHash ?? approveTxHash };
  } else if (!job?.approveHash) {
    approve = { status: 'active', detail: 'Authorize the bridge to burn your Netizens.' };
  } else if (!approveL1) {
    approve = { status: 'pending', detail: 'Confirming on Ethereum…', hash: job.approveHash };
  } else {
    approve = { status: 'done', detail: approveL2 ? 'Approved on L2.' : 'Submitted — landing on L2.', hash: job.approveHash };
  }

  const started = (job?.batches ?? []).map((b) => startedView(b, b.index, String(b.index), nowSec));
  const startIdx = job?.batches.length ?? 0;
  const preview = previewBatches.map((b, i) => previewView(b, startIdx + i, `p${i}`, approveL1));
  const batches = [...started, ...preview];

  const allFinalized =
    !!job && previewBatches.length === 0 && job.batches.length > 0 &&
    job.batches.every((b) => b.derived?.withdrawal === 'finalized');

  return { approve, batches, allFinalized };
}
