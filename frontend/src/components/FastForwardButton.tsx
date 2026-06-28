import { useState } from 'react';
import { IS_LOCALNET, RELAYER_CONTROL } from '../constants/bridge';
import { useToast } from '../contexts/ToastContext';
import './FastForwardButton.css';

/** Localnet-only dev control: tell the relayer to flush queues + skip the challenge window. */
export function FastForwardButton() {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  if (!IS_LOCALNET) return null;

  async function go() {
    setBusy(true);
    try {
      const r = await fetch(`${RELAYER_CONTROL}/fast-forward`, { method: 'POST' });
      const j = (await r.json()) as { pending?: number };
      addToast('success', 'Fast-forwarded the localnet', `${j.pending ?? 0} message(s) pending`);
    } catch (e) {
      addToast('error', 'Fast-forward failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className="fast-forward"
      onClick={go}
      disabled={busy}
      title="Localnet: flush the relayer + skip the challenge window"
    >
      {busy ? '…' : '⏩'}
    </button>
  );
}
