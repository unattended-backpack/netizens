import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type Hash, encodeFunctionData } from 'viem';
import { useAccount, useWalletClient } from 'wagmi';
import {
  OPTIMISM_PORTAL_ADDRESS,
  WCN_ADDRESS,
  BRIDGE_L2_ADDRESS,
  BRIDGE_READY,
  BRIDGE_BATCH_SIZE,
  optimismPortalAbi,
  wcnAbi,
  bridgeL2Abi,
  formatWeiToEth,
} from '../constants/bridge';
import { newJob, theJob, deriveJourney, chunkBatches, type Batch } from '../lib/jobs';
import { proveBatch, finalizeBatch } from '../lib/bridgeActions';
import { l1Public } from '../lib/clients';
import { useNetizens } from '../hooks/useNetizens';
import { useHomeNetizens } from '../hooks/useHomeNetizens';
import { useApprovalTx } from '../hooks/useApprovalTx';
import { useL2Balance } from '../hooks/useL2Balance';
import { useL1Balance } from '../hooks/useL1Balance';
import { useIsApproved } from '../hooks/useIsApproved';
import { useBridgeJobs } from '../hooks/useBridgeJobs';
import { useToast } from '../contexts/ToastContext';
import { useSoundEffects } from '../hooks/useSoundEffects';
import { hasUserRejection } from '../utils/error';
import { BridgeSteps } from './BridgeSteps';
import './Bridge.css';

const MAX_BATCH = 400; // sanity cap on tokens pending in one session (chunked into deposits)

function NetizenCard({ id, state }: { id: bigint; state: 'risk' | 'bridging' | 'home' }) {
  const [failed, setFailed] = useState(false);
  const where = state === 'home' ? 'home on Ethereum' : state === 'bridging' ? 'bridging home' : 'still on L2';
  return (
    <div className={`netizen netizen--${state}`} title={`Netizen #${id} — ${where}`}>
      <span className="netizen__img">
        {failed ? (
          <span className="netizen__ph">#{id.toString()}</span>
        ) : (
          <img src={`/netizens/${id}.webp`} alt={`Netizen #${id}`} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        )}
      </span>
      <span className="netizen__id">#{id.toString()}</span>
    </div>
  );
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const i = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(i);
  }, []);
  return now;
}

export function Bridge() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { addToast } = useToast();
  const { playClickSound } = useSoundEffects();
  const now = useNow();

  const { data: tokenIds, isLoading: loadingTokens, error: tokensError } = useNetizens(address);
  const { data: homeIds } = useHomeNetizens(address);
  const { data: balance } = useL2Balance(address);
  const { data: l1Balance } = useL1Balance(address);
  const { data: approved } = useIsApproved(address);
  const { data: approvalTx } = useApprovalTx(address);
  const { jobs, addJob, patchJob, refreshNow } = useBridgeJobs(address);
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState<string | null>(null);

  const connected = !!address;
  const liveIds = tokenIds ?? []; // at risk — still on MegaETH
  const home = homeIds ?? []; // home — on Ethereum
  const liveEth = balance ?? 0n;
  const l1Eth = l1Balance ?? 0n;

  const job = theJob(jobs, address); // the single accumulating journey

  // Pending = current L2 holdings not yet in a started batch, plus un-swept ETH. These become
  // the next preview batches (appended to the journey when started). Supports ETH-only.
  const batchedTokens = new Set((job?.batches ?? []).flatMap((b) => b.tokenIds));
  const pendingIds = liveIds.filter((id) => !batchedTokens.has(id.toString()));
  // ETH committed to a started (non-reverted) batch that hasn't FINALIZED yet is "spoken
  // for" — still on L2 pre-burn, or in-flight post-burn — so subtract it from liveEth.
  // Keying on `finalized` (not `bridgeL2`) is deliberate: bridgeL2 and liveEth come from
  // different queries that update at different times, so subtracting only until the burn
  // landed left a window where the deduction stopped before liveEth caught up — briefly
  // making pendingEth positive and spawning a phantom "second batch". A batch only finalizes
  // long after its L2 deduction has settled, so by then liveEth is genuinely current; until
  // then the committed amount stays subtracted and no phantom appears. New ETH received after
  // a batch fully finalizes is still offered (its committed amount no longer subtracts).
  const committedEth = (job?.batches ?? []).reduce(
    (sum, b) => sum + (b.bridgeHash && b.ethAmount !== '0' && b.derived?.withdrawal !== 'finalized' && !b.derived?.bridgeReverted ? BigInt(b.ethAmount) : 0n),
    0n,
  );
  const pendingEth = liveEth > committedEth ? liveEth - committedEth : 0n;
  const previewBatches = chunkBatches(pendingIds, pendingEth, BRIDGE_BATCH_SIZE);

  const journey = deriveJourney(job, previewBatches, !!approved, now, approvalTx ?? undefined);

  // Counts: on L2 (at risk), committed-not-home (bridging), on L1 (home).
  const homeSet = new Set(home.map((t) => t.toString()));
  // Tokens committed to a started (non-reverted) batch flip to "bridging" the instant Start
  // lands — driven by job state, not by waiting for the L2 burn to drop them from the live
  // scan. Mirrors how finalize shows "home" instantly off the L1 mint.
  const startedTokens = new Set(
    (job?.batches ?? []).filter((b) => b.bridgeHash && !b.derived?.bridgeReverted).flatMap((b) => b.tokenIds),
  );
  const atRiskIds = liveIds.filter((id) => !startedTokens.has(id.toString()));
  const bridging = [...startedTokens].map((t) => BigInt(t)).filter((id) => !homeSet.has(id.toString()));
  const allNetizens = [
    ...atRiskIds.map((id) => ({ id, state: 'risk' as const })),
    ...bridging.map((id) => ({ id, state: 'bridging' as const })),
    ...home.map((id) => ({ id, state: 'home' as const })),
  ].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const hasPending = pendingIds.length > 0 || pendingEth > 0n;
  const tooMany = pendingIds.length > MAX_BATCH;
  const startBlockedLabel = !connected
    ? 'Connect your account'
    : !BRIDGE_READY
      ? 'Not configured'
      : tooMany
        ? `Too many (max ${MAX_BATCH})`
        : !hasPending
          ? 'Nothing to bridge'
          : null;

  // Wait for an L1 tx, toast on revert (with the hash), and report success/failure so the
  // caller only records the hash if it actually landed (a reverted one stays retryable).
  async function settled(hash: Hash, label: string): Promise<boolean> {
    const receipt = await l1Public.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') return true;
    addToast('error', `${label} failed`, `Reverted on Ethereum · ${hash}`);
    return false;
  }

  async function onAction(key: string) {
    if (!walletClient || !address) return;
    playClickSound();
    setBusy(key);
    try {
      if (key === 'approve') {
        const data = encodeFunctionData({ abi: wcnAbi, functionName: 'setApprovalForAll', args: [BRIDGE_L2_ADDRESS, true] });
        const hash = await walletClient.writeContract({
          address: OPTIMISM_PORTAL_ADDRESS, abi: optimismPortalAbi, functionName: 'depositTransaction',
          args: [WCN_ADDRESS, 0n, 120_000n, false, data], value: 0n,
        });
        if (await settled(hash, 'Approval')) {
          if (job) patchJob(job.id, { approveHash: hash });
          else addJob(newJob({ account: address, recipient: address, approveHash: hash }));
          addToast('success', 'Approval confirmed on Ethereum');
        }
      } else if (key.startsWith('bridge:')) {
        const ref = key.slice('bridge:'.length);
        let j = job;
        if (!j) {
          j = newJob({ account: address, recipient: address, approveSkipped: !!approved });
          addJob(j);
        }
        const preview = ref.startsWith('p');
        const batch: Batch | undefined = preview
          ? (() => { const pb = previewBatches[Number(ref.slice(1))]; return pb ? { ...pb, index: j!.batches.length } : undefined; })()
          : j.batches.find((x) => x.index === Number(ref));
        if (!batch) return;
        const ids = batch.tokenIds.map((t) => BigInt(t));
        const eth = BigInt(batch.ethAmount);
        const data = encodeFunctionData({ abi: bridgeL2Abi, functionName: 'bridge', args: [ids, address] });
        // Real bridge() L2 cost ~139k + ~14.4k/token; pad but never exceed MegaETH's 1M cap.
        const need = 180_000n + 18_000n * BigInt(ids.length);
        const gas = need > 1_000_000n ? 1_000_000n : need;
        const hash = await walletClient.writeContract({
          address: OPTIMISM_PORTAL_ADDRESS, abi: optimismPortalAbi, functionName: 'depositTransaction',
          args: [BRIDGE_L2_ADDRESS, eth, gas, false, data], value: 0n,
        });
        if (await settled(hash, `Batch ${batch.index + 1} start`)) {
          const updated = { ...batch, bridgeHash: hash };
          const batches = preview ? [...j.batches, updated] : j.batches.map((x) => (x.index === batch.index ? updated : x));
          patchJob(j.id, { batches });
          addToast('success', `Batch ${batch.index + 1} force-included on Ethereum`);
        }
      } else if (key.startsWith('prove:') && job) {
        const i = Number(key.slice('prove:'.length));
        const hash = await proveBatch(job, i, walletClient);
        if (await settled(hash, `Batch ${i + 1} prove`)) {
          patchJob(job.id, { batches: job.batches.map((x) => (x.index === i ? { ...x, proveHash: hash } : x)) });
          addToast('success', `Batch ${i + 1} proved on Ethereum`);
        }
      } else if (key.startsWith('finalize:') && job) {
        const i = Number(key.slice('finalize:'.length));
        const hash = await finalizeBatch(job, i, walletClient);
        if (await settled(hash, `Batch ${i + 1} finalize`)) {
          patchJob(job.id, { batches: job.batches.map((x) => (x.index === i ? { ...x, finalizeHash: hash } : x)) });
          addToast('success', `Batch ${i + 1} finalized — coming home`);
        }
      }
    } catch (e) {
      if (hasUserRejection(e)) addToast('error', 'Rejected in wallet');
      else addToast('error', 'Transaction failed', (e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
    } finally {
      setBusy(null);
      refreshNow();
      if (address) {
        queryClient.invalidateQueries({ queryKey: ['netizens', address] });
        queryClient.invalidateQueries({ queryKey: ['home-netizens', address] });
        queryClient.invalidateQueries({ queryKey: ['l1-balance', address] });
        queryClient.invalidateQueries({ queryKey: ['l2-balance', address] });
      }
    }
  }

  const atRisk = atRiskIds.length;
  const homeCount = home.length;
  const bridgingCount = bridging.length;
  const allHome = atRisk === 0 && bridgingCount === 0 && homeCount > 0;
  // none home → red; some but not all → white; all home → gold.
  const homeClass = homeCount === 0 ? 'bridge__count--risk' : allHome ? 'bridge__count--home' : 'bridge__count--mid';
  const homeText = allHome ? `${homeCount} ${homeCount === 1 ? 'Netizen is' : 'Netizens are'} home` : `${homeCount} home`;

  // Ether: on L2 (at risk), swept-but-unfinalized (bridging), and the actual L1 balance (home).
  // Bridging = ETH committed to a started batch (bridge tx landed) that isn't home yet.
  // Keyed on bridgeHash (not bridgeL2) so it shows the instant Start lands; a reverted
  // bridge stays at-risk instead.
  let ethBridging = 0n;
  for (const b of job?.batches ?? []) {
    const eth = BigInt(b.ethAmount);
    if (eth !== 0n && b.bridgeHash && !b.derived?.bridgeReverted && b.derived?.withdrawal !== 'finalized') ethBridging += eth;
  }
  // At-risk = the un-bridged remainder (pendingEth), NOT the raw L2 balance — the moment a
  // batch starts its ETH leaves "at risk" even before the L2 deduction lands, so the badge
  // updates immediately instead of lingering until the next balance refetch.
  const ethAtRisk = pendingEth;

  const totalBatches = journey.batches.length;
  const doneBatches = journey.batches.filter((b) => b.finalize.status === 'done').length;
  const batchClass = doneBatches === totalBatches ? 'bridge__count--home' : 'bridge__count--mid';

  return (
    <div className="bridge">
      {/* Holdings */}
      <section className="bridge__panel">
        <div className="bridge__panel-head">
          <span className="bridge__panel-title">YOUR NETIZENS</span>
          {connected && !loadingTokens && (
            <span className="bridge__counts">
              {atRisk > 0 && <span className="bridge__count bridge__count--risk">{atRisk} at risk</span>}
              {bridgingCount > 0 && <span className="bridge__count bridge__count--mid">{bridgingCount} bridging</span>}
              <span className={`bridge__count ${homeClass}`}>{homeText}</span>
              {ethAtRisk > 0n && <span className="bridge__count bridge__count--risk">{formatWeiToEth(ethAtRisk)} Ether at risk</span>}
              {ethBridging > 0n && <span className="bridge__count bridge__count--mid">{formatWeiToEth(ethBridging)} Ether bridging</span>}
              <span className={`bridge__count ${ethAtRisk > 0n || ethBridging > 0n ? 'bridge__count--mid' : 'bridge__count--home'}`}>{formatWeiToEth(l1Eth)} Ether is home</span>
            </span>
          )}
        </div>
        {connected && (atRisk > 0 || bridgingCount > 0 || homeCount > 0) ? (
          <div className="bridge__grid">
            {allNetizens.map(({ id, state }) => <NetizenCard key={id.toString()} id={id} state={state} />)}
          </div>
        ) : (
          <div className="bridge__placeholder">
            {!connected && <p className="bridge__hint">Connect your account to see your Netizens.</p>}
            {connected && loadingTokens && <p className="bridge__hint">Scanning L2 for your Netizens…</p>}
            {connected && tokensError && <p className="bridge__hint bridge__hint--err">Could not load your Netizens. Check the L2 RPC.</p>}
            {connected && !loadingTokens && !tokensError && atRisk === 0 && bridgingCount === 0 && homeCount === 0 && (
              <p className="bridge__hint">You have no Netizens; you can still bridge Ether below.</p>
            )}
          </div>
        )}
      </section>

      {/* The journey home — one continuous approve + per-batch start/prove/finalize */}
      <section className="bridge__panel">
        <div className="bridge__panel-head">
          <span className="bridge__panel-title">BRING THEM HOME</span>
          {totalBatches > 1 && (
            <span className="bridge__counts">
              <span className={`bridge__count ${batchClass}`}>{doneBatches} / {totalBatches} batches complete</span>
            </span>
          )}
        </div>
        <div className="bridge__wbody">
          <BridgeSteps journey={journey} busy={busy} startBlockedLabel={startBlockedLabel} onAction={onAction} />
        </div>
      </section>
    </div>
  );
}
