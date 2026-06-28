import { useState } from 'react';
import type { JourneyView, StepView, BatchView } from '../lib/jobs';
import './BridgeSteps.css';

const ACTIONS: { kind: string; num: number; label: string; emoji: string; desc: string; pick: (b: BatchView) => StepView }[] = [
  { kind: 'bridge', num: 2, label: 'Start', emoji: '🔥', desc: 'Burn a batch on L2; batch 1 also sweeps your ETH home.', pick: (b) => b.bridge },
  { kind: 'prove', num: 3, label: 'Prove', emoji: '📜', desc: "Submit each batch's withdrawal proof on Ethereum.", pick: (b) => b.prove },
  { kind: 'finalize', num: 4, label: 'Finalize', emoji: '🎉', desc: 'After the challenge window, mint on Ethereum + receive ETH.', pick: (b) => b.finalize },
];

const isStart = (key: string) => key === 'approve' || key.startsWith('bridge:');

export function BridgeSteps({
  journey,
  busy,
  startBlockedLabel,
  onAction,
  title,
}: {
  journey: JourneyView;
  busy: string | null;
  /** When non-null, the approve + start actions are blocked and show this reason. */
  startBlockedLabel: string | null;
  onAction: (key: string) => void;
  title?: string;
}) {
  const [inspectKey, setInspectKey] = useState<string | null>(null);
  const total = journey.batches.length;

  // Resolve the inspected cell from the CURRENT journey each render (so countdowns stay live).
  // A blocked reason only applies to an actionable (active/error) start cell — never to a
  // done/pending one (so completed cells still show their detail + historic tx hash).
  const blockable = (s: StepView) => s.status === 'active' || s.status === 'error';
  const info = (() => {
    if (!inspectKey) return null;
    if (inspectKey === 'approve') {
      return { label: 'Approve the bridge', step: journey.approve, blocked: blockable(journey.approve) ? startBlockedLabel : null };
    }
    const sep = inspectKey.indexOf(':');
    const kind = inspectKey.slice(0, sep);
    const ref = inspectKey.slice(sep + 1);
    const b = journey.batches.find((x) => x.ref === ref);
    if (!b) return null;
    const step = kind === 'bridge' ? b.bridge : kind === 'prove' ? b.prove : b.finalize;
    const action = kind === 'bridge' ? 'Start' : kind === 'prove' ? 'Prove' : 'Finalize';
    const blocked = kind === 'bridge' && blockable(step) ? startBlockedLabel : null;
    return { label: `Batch ${b.index + 1} · ${action}`, step, blocked };
  })();

  function cell(key: string, step: StepView, content: string | number, extraClass = '') {
    const blocked = isStart(key) ? startBlockedLabel : null;
    const actionable = (step.status === 'active' || step.status === 'error') && !blocked;
    const visual = blocked && (step.status === 'active' || step.status === 'error') ? 'locked' : step.status;
    return (
      <button
        key={key}
        type="button"
        className={`jcell jcell--${visual} ${extraClass}`}
        onMouseEnter={() => setInspectKey(key)}
        onFocus={() => setInspectKey(key)}
        onClick={() => {
          if (busy === key) return;
          if (actionable) onAction(key);
          else setInspectKey(key);
        }}
      >
        {busy === key ? '…' : content}
      </button>
    );
  }

  const a = journey.approve;
  const approveContent = busy === 'approve' ? '…' : a.status === 'done' ? '✓ Approved' : a.status === 'pending' ? 'Approving…' : a.status === 'active' ? 'Approve' : '—';

  return (
    <div className="journey">
      {title && <p className="journey__title">{title}</p>}
      <div className="jrow">
        <span className="jrow__head">
          <span className="jrow__num">1 · Approve</span>
          <span className="jrow__desc">Authorize the bridge to burn your Netizens.</span>
        </span>
        <div className="jrow__cells">{cell('approve', a, approveContent, 'jcell--wide')}</div>
      </div>

      {ACTIONS.map((row) => (
        <div className="jrow" key={row.kind}>
          <span className="jrow__head">
            <span className="jrow__num">{row.num} · {row.label}</span>
            <span className="jrow__desc">{row.desc}</span>
          </span>
          <div className="jrow__cells">
            {total > 0 ? (
              journey.batches.map((b) => {
                const step = row.pick(b);
                const key = `${row.kind}:${b.ref}`;
                const content =
                  step.status === 'done' ? '✓'
                    : step.status === 'error' ? '!'
                      : step.status === 'pending' || step.status === 'waiting' ? '⏳'
                        : row.emoji;
                return cell(key, step, content);
              })
            ) : (
              <span className="jcell jcell--locked" aria-hidden>—</span>
            )}
          </div>
        </div>
      ))}

      {/* Shared, fixed-height detail line — hover/focus any cell for status + full tx hash. */}
      <div className="journey__detail">
        {info ? (
          <>
            <span className="journey__detail-label">
              {info.label} — {info.blocked ?? info.step.detail}
            </span>
            {!info.blocked && info.step.hash && <span className="journey__detail-hash">{info.step.hash}</span>}
          </>
        ) : (
          <span className="journey__detail-hint">Hover over a step for its status.</span>
        )}
      </div>
    </div>
  );
}
