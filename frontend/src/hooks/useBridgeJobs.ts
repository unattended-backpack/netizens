import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { type BridgeJob, loadJobs, saveJobs } from '../lib/jobs';
import { refreshJobStatus } from '../lib/bridgeActions';

const POLL_MS = 6_000;

/**
 * Owns the persisted bridge jobs (localStorage) and keeps active ones up to date by
 * polling chain state. Returning to the site later rehydrates jobs and resumes the
 * countdowns automatically.
 */
export function useBridgeJobs(account: Address | undefined) {
  const [jobs, setJobs] = useState<BridgeJob[]>(() => loadJobs());

  const addJob = useCallback((job: BridgeJob) => {
    const next = [job, ...loadJobs()];
    saveJobs(next);
    setJobs(next);
  }, []);

  const patchJob = useCallback((id: string, updates: Partial<BridgeJob>) => {
    const next = loadJobs().map((j) => (j.id === id ? { ...j, ...updates, updatedAt: Date.now() } : j));
    saveJobs(next);
    setJobs(next);
  }, []);

  const removeJob = useCallback((id: string) => {
    const next = loadJobs().filter((j) => j.id !== id);
    saveJobs(next);
    setJobs(next);
  }, []);

  const busy = useRef(false);
  const again = useRef(false);
  const refreshNow = useCallback(async () => {
    // A refresh requested while one is in flight (e.g. the post-action call landing during
    // the 6s poll) isn't dropped — it sets `again`, so the in-flight run loops once more with
    // fresh localStorage. That makes start/prove/finalize re-derive promptly instead of
    // waiting for the next poll tick, while staying bounded (at most one queued follow-up).
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    try {
      do {
        again.current = false;
        const active = loadJobs().filter((j) => !j.batches.every((b) => b.derived?.withdrawal === 'finalized'));
        for (const job of active) {
          const updates = await refreshJobStatus(job).catch(() => ({} as Partial<BridgeJob>));
          if (Object.keys(updates).length > 0) {
            const next = loadJobs().map((j) => (j.id === job.id ? { ...j, ...updates, updatedAt: Date.now() } : j));
            saveJobs(next);
            setJobs(next);
          }
        }
      } while (again.current);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    refreshNow();
    const iv = setInterval(refreshNow, POLL_MS);
    return () => clearInterval(iv);
  }, [refreshNow]);

  const mine = account ? jobs.filter((j) => j.account.toLowerCase() === account.toLowerCase()) : [];
  return { jobs: mine, addJob, patchJob, removeJob, refreshNow };
}
