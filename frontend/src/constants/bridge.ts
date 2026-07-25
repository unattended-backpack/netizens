import { type Abi, type Address, defineChain, getAddress, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';

/**
 * Bridge configuration. Defaults are the verified MegaETH mainnet / Ethereum L1
 * addresses; every value is overridable via VITE_* env so the same build can point
 * at the local anvil forks (the localnet) by swapping RPC URLs + addresses.
 */
function envAddr(key: string, fallback: string): Address {
  const v = (import.meta.env[key] as string | undefined)?.trim();
  return getAddress(v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : fallback);
}
function envStr(key: string, fallback: string): string {
  const v = (import.meta.env[key] as string | undefined)?.trim();
  return v && v.length > 0 ? v : fallback;
}

// ── Ethereum L1 ──────────────────────────────────────────────────────────────
export const OPTIMISM_PORTAL_ADDRESS = envAddr('VITE_OPTIMISM_PORTAL_ADDRESS', '0x7f82f57F0Dd546519324392e408b01fcC7D709e8');
export const L1_CROSS_DOMAIN_MESSENGER = envAddr('VITE_L1_CROSS_DOMAIN_MESSENGER', '0x6C7198250087B29A8040eC63903Bc130f4831Cc9');
export const DISPUTE_GAME_FACTORY = envAddr('VITE_DISPUTE_GAME_FACTORY', '0x8546840adF796875cD9AAcc5B3B048f6B2c9D563');
export const L1_STANDARD_BRIDGE = envAddr('VITE_L1_STANDARD_BRIDGE', '0x0CA3A2FBC3D770b578223FBB6b062fa875a2eE75');
/** NetizenL1 — the L1 mirror that mints bridged tokens. Set after deployment. */
export const NETIZEN_L1_ADDRESS = envAddr('VITE_NETIZEN_L1', '0x0000000000000000000000000000000000000000');

// ── MegaETH L2 ───────────────────────────────────────────────────────────────
export const WCN_ADDRESS = envAddr('VITE_NFT_CONTRACT_ADDRESS', '0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44');
/** NetizenBridgeL2 — the ownerless burn+message contract. Set after deployment. */
export const BRIDGE_L2_ADDRESS = envAddr('VITE_BRIDGE_L2', '0x0000000000000000000000000000000000000000');
export const L2_CROSS_DOMAIN_MESSENGER = '0x4200000000000000000000000000000000000007' as Address;
export const L2_MESSAGE_PASSER = '0x4200000000000000000000000000000000000016' as Address;

export const L2_CHAIN_ID = Number(envStr('VITE_L2_CHAIN_ID', '4326'));
export const L1_CHAIN_ID = Number(envStr('VITE_L1_CHAIN_ID', String(mainnet.id)));
export const KAILUA_GAME_TYPE = Number(envStr('VITE_KAILUA_GAME_TYPE', '1337'));

export const L1_RPC_URL = envStr('VITE_L1_RPC_URL', envStr('VITE_RPC_URL', 'https://ethereum-rpc.publicnode.com'));
export const L2_RPC_URL = envStr('VITE_L2_RPC_URL', 'https://mainnet.megaeth.com/rpc');

/**
 * Block-explorer base URLs (no trailing slash) for the header's contract links.
 * L1 defaults to Etherscan; set VITE_L2_EXPLORER to the L2 explorer. A link only
 * renders once its explorer base is set and the contract address is non-zero.
 */
export const L1_EXPLORER = envStr('VITE_L1_EXPLORER', 'https://etherscan.io');
export const L2_EXPLORER = envStr('VITE_L2_EXPLORER', '');

/**
 * Real MegaETH replaces `eth_getProof` with `eth_getWithdrawalProof`; the local anvil
 * L2 fork speaks the standard `eth_getProof`. Toggle which one the L2 client uses.
 */
export const L2_STANDARD_GETPROOF = envStr('VITE_L2_USE_GETPROOF', '') === 'true';

/**
 * Localnet mode — gates dev-only behavior (the fast-forward control button and the
 * relayer-replay tx-hash lookup). An explicit flag, NOT derived from any other config, so
 * it can never accidentally piggyback on something like the proof method and switch on in
 * production. Leave unset everywhere except the local anvil harness (localnet.sh sets it).
 */
export const IS_LOCALNET = envStr('VITE_IS_LOCALNET', '') === 'true';
/** Relayer control server (POST /fast-forward) — only used on the localnet. */
export const RELAYER_CONTROL = envStr('VITE_RELAYER_CONTROL', 'http://127.0.0.1:8547');

/**
 * L1 chain: real Ethereum mainnet, or — when VITE_L1_CHAIN_ID is set (the localnet anvil
 * fork runs at a dev chainId so wallets can add it as a custom network) — a custom chain.
 */
export const l1Chain = L1_CHAIN_ID === mainnet.id
  ? mainnet
  : defineChain({
      id: L1_CHAIN_ID,
      name: 'Localnet L1',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [L1_RPC_URL] } },
    });

/** Collection deployed at WCN_ADDRESS minted at L2 block ~0; used as a lower bound for log scans. */
export const WCN_DEPLOY_BLOCK = BigInt(envStr('VITE_WCN_DEPLOY_BLOCK', '0'));
/** Lower bound for scanning NetizenL1 (the L1 mirror) mint logs — the "home" holdings. */
export const NETIZEN_L1_DEPLOY_BLOCK = BigInt(envStr('VITE_NETIZEN_L1_DEPLOY_BLOCK', '0'));
/** Max block span per L1 eth_getLogs. Some RPCs (e.g. QuickNode) cap ~10k blocks and 413 above
 *  it, so the home scan is chunked into windows this size. */
export const L1_LOG_CHUNK = BigInt(envStr('VITE_L1_LOG_CHUNK', '9000'));
/** Max block span per L2 eth_getLogs. MegaETH serves wide ranges, so this is large — chunking
 *  mainly bounds the first full-history pass; incremental deltas are tiny. */
export const L2_LOG_CHUNK = BigInt(envStr('VITE_L2_LOG_CHUNK', '5000000'));

/**
 * Tokens per force-inclusion deposit. MegaETH caps a deposit at 1,000,000 L2 gas and
 * bridge() costs ~139k + ~14.4k/token, so the real ceiling is ~55. Production value 48
 * leaves headroom under the cap (48 tokens ≈ 830k L2 gas); override with
 * VITE_BRIDGE_BATCH_SIZE to exercise the multi-batch flow on a smaller holder.
 */
export const BRIDGE_BATCH_SIZE = Number(envStr('VITE_BRIDGE_BATCH_SIZE', '48'));

/**
 * MegaETH chain definition wired with the OP-Stack L1 contracts so viem's op-stack
 * actions (getWithdrawalStatus, buildProveWithdrawal, prove/finalize) work against it.
 */
export const megaeth = defineChain({
  id: L2_CHAIN_ID,
  name: 'MegaETH',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [L2_RPC_URL] } },
  contracts: {
    portal: { [L1_CHAIN_ID]: { address: OPTIMISM_PORTAL_ADDRESS } },
    disputeGameFactory: { [L1_CHAIN_ID]: { address: DISPUTE_GAME_FACTORY } },
    l1StandardBridge: { [L1_CHAIN_ID]: { address: L1_STANDARD_BRIDGE } },
  },
  sourceId: L1_CHAIN_ID,
});

// ── ABIs ─────────────────────────────────────────────────────────────────────

/** OptimismPortal — only depositTransaction (force inclusion). */
export const optimismPortalAbi = [
  {
    type: 'function',
    name: 'depositTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
      { name: '_gasLimit', type: 'uint64' },
      { name: '_isCreation', type: 'bool' },
      { name: '_data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** Minimal WCN (ERC721) surface we use. */
export const wcnAbi = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
] as const satisfies Abi;

/** NetizenBridgeL2.bridge(uint256[],address) — encoded as the deposit calldata. */
export const bridgeL2Abi = [
  { type: 'function', name: 'bridge', stateMutability: 'payable', inputs: [{ name: 'tokenIds', type: 'uint256[]' }, { name: 'l1Recipient', type: 'address' }], outputs: [] },
] as const satisfies Abi;

/** Event used to enumerate a holder's tokens and to detect L2 landing. */
export const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
/** Used to recover the tx hash of a pre-existing bridge approval. */
export const approvalForAllEvent = parseAbiItem('event ApprovalForAll(address indexed owner, address indexed operator, bool approved)');
/** Emitted by the L2ToL1MessagePasser when the bridge() message is enqueued. */
export const messagePassedEvent = parseAbiItem('event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)');

export function formatWeiToEth(wei: bigint, maxDecimals = 6): string {
  const whole = wei / 10n ** 18n;
  const rem = wei % 10n ** 18n;
  if (rem === 0n) return whole.toString();
  const dec = rem.toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '');
  return dec.length ? `${whole}.${dec}` : whole.toString();
}

export const BRIDGE_READY = BRIDGE_L2_ADDRESS !== '0x0000000000000000000000000000000000000000'
  && NETIZEN_L1_ADDRESS !== '0x0000000000000000000000000000000000000000';
