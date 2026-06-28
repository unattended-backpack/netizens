import { createPublicClient, custom, http } from 'viem';
import { publicActionsL1, publicActionsL2 } from 'viem/op-stack';
import { L1_RPC_URL, L2_RPC_URL, L2_STANDARD_GETPROOF, l1Chain, megaeth } from '../constants/bridge';

/** Ethereum L1 reader, extended with OP-Stack actions (withdrawal status, etc.). */
export const l1Public = createPublicClient({
  chain: l1Chain,
  transport: http(L1_RPC_URL),
}).extend(publicActionsL1());

/**
 * MegaETH L2 reader. Real MegaETH replaces `eth_getProof` with `eth_getWithdrawalProof`
 * (same shape) for withdrawal proofs, so we rewrite that one method — exactly as the
 * relay-nft.mjs script does. The local anvil fork speaks standard `eth_getProof`, so the
 * rewrite is skipped when VITE_L2_USE_GETPROOF=true. Everything else passes through.
 */
const l2Transport = custom({
  async request({ method, params }) {
    const actualMethod = method === 'eth_getProof' && !L2_STANDARD_GETPROOF ? 'eth_getWithdrawalProof' : method;
    const res = await fetch(L2_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: actualMethod, params }),
    });
    const data = await res.json();
    if (data.error) {
      const err = new Error(data.error.message) as Error & { code?: number; data?: unknown };
      err.code = data.error.code;
      err.data = data.error.data;
      throw err;
    }
    return data.result;
  },
});

export const l2Public = createPublicClient({
  chain: megaeth,
  transport: l2Transport,
}).extend(publicActionsL2());
