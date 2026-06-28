// relay-nft.mjs
//
// Relay an NFT-bridge message from MegaETH to Ethereum L1 across the canonical
// (OP-Stack) bridge: prove + finalize the L2->L1 withdrawal produced by a
// NetizenBridgeL2.bridge() transaction. Finalizing executes the portal
// withdrawal, which calls L1CrossDomainMessenger.relayMessage ->
// NetizenL1.finalizeBridge(to, tokenIds), minting the bridged tokens on L1.
//
// Every L2->L1 message rides the OptimismPortal2 fault-proof path (the same prove +
// finalize machinery the canonical bridge uses for ETH), so this is NOT instant: a
// state root covering your bridge tx must be proposed and pass the
// Kailua challenge window before prove, and the portal enforces a proof-maturity
// delay before finalize.
//
// Usage:
//   npm install            # (viem is already a dependency)
//   DEPLOYER_KEY=0x...   \  # L1 signer; pays gas. Any funded account may relay.
//   BRIDGE_TX_HASH=0x... \ # the bridge() tx hash on MegaETH
//   L1_RPC=https://... \
//   L2_RPC=https://mainnet.megaeth.com/rpc \
//   node relay-nft.mjs
//
// Requires Node 18+ (native fetch) and viem >= 2.x.
//
// NOTE: no key is hardcoded here. Never commit a private key.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  custom,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import {
  publicActionsL1,
  publicActionsL2,
  walletActionsL1,
  getWithdrawals,
} from 'viem/op-stack'

// ─────────────────────────────────────────────────────────────────────────────
// Config (env-driven; addresses verified on-chain for MegaETH mainnet)
// ─────────────────────────────────────────────────────────────────────────────

const DEPLOYER_KEY    = required('DEPLOYER_KEY')
const BRIDGE_TX_HASH  = required('BRIDGE_TX_HASH')      // bridge() tx hash on MegaETH
const L1_RPC          = required('L1_RPC')
const L2_RPC          = required('L2_RPC')

const MEGAETH_CHAIN_ID     = 4326
const PORTAL_ADDRESS       = '0x7f82f57F0Dd546519324392e408b01fcC7D709e8' // OptimismPortal2
const DISPUTE_GAME_FACTORY = '0x8546840adF796875cD9AAcc5B3B048f6B2c9D563' // Kailua-wrapped
const L1_STANDARD_BRIDGE   = '0x0CA3A2FBC3D770b578223FBB6b062fa875a2eE75'
// For reference / manual gas-bump retry of a failed relay (see footer):
const L1_CROSS_DOMAIN_MESSENGER = '0x6c7198250087b29A8040Ec63903Bc130f4831cC9'
const KAILUA_GAME_TYPE     = 1337

function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain definition + clients
// ─────────────────────────────────────────────────────────────────────────────

const megaeth = defineChain({
  id: MEGAETH_CHAIN_ID,
  name: 'MegaETH',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [L2_RPC] } },
  contracts: {
    portal:             { [mainnet.id]: { address: PORTAL_ADDRESS } },
    disputeGameFactory: { [mainnet.id]: { address: DISPUTE_GAME_FACTORY } },
    l1StandardBridge:   { [mainnet.id]: { address: L1_STANDARD_BRIDGE } },
  },
  sourceId: mainnet.id,
})

const account = privateKeyToAccount(DEPLOYER_KEY)

// MegaETH replaces eth_getProof with eth_getWithdrawalProof (same shape).
const l2Request = async ({ method, params }) => {
  const actualMethod = method === 'eth_getProof' ? 'eth_getWithdrawalProof' : method
  const res = await fetch(L2_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: actualMethod, params }),
  })
  const data = await res.json()
  if (data.error) {
    const err = new Error(data.error.message)
    err.code = data.error.code
    err.data = data.error.data
    throw err
  }
  return data.result
}

const l2Client = createPublicClient({
  chain: megaeth,
  transport: custom({ request: l2Request }),
}).extend(publicActionsL2())

const l1Public = createPublicClient({
  chain: mainnet,
  transport: http(L1_RPC),
}).extend(publicActionsL1())

const l1Wallet = createWalletClient({
  account,
  chain: mainnet,
  transport: http(L1_RPC),
}).extend(walletActionsL1())

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args)

async function assertPortalNotPaused() {
  const paused = await l1Public.readContract({
    address: PORTAL_ADDRESS,
    abi: [{ name: 'paused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }],
    functionName: 'paused',
  })
  if (paused) throw new Error('OptimismPortal2 is paused by the Guardian. Aborting.')
}

// Find the newest Kailua game whose state root covers the withdrawal block.
async function findOutput(withdrawalL2Block) {
  const gameCount = await l1Public.readContract({
    address: DISPUTE_GAME_FACTORY,
    abi: [{ name: 'gameCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'gameCount',
  })

  for (let i = gameCount - 1n; i >= 0n; i--) {
    const [gameType, , gameAddr] = await l1Public.readContract({
      address: DISPUTE_GAME_FACTORY,
      abi: [{ name: 'gameAtIndex', type: 'function', stateMutability: 'view',
              inputs: [{ type: 'uint256' }],
              outputs: [{ type: 'uint32' }, { type: 'uint64' }, { type: 'address' }] }],
      functionName: 'gameAtIndex',
      args: [i],
    })
    if (gameType !== KAILUA_GAME_TYPE) continue

    const l2Block = await l1Public.readContract({
      address: gameAddr,
      abi: [{ name: 'l2BlockNumber', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'l2BlockNumber',
    })
    if (l2Block < withdrawalL2Block) break // games advance in time; older ones can't cover

    const rootClaim = await l1Public.readContract({
      address: gameAddr,
      abi: [{ name: 'rootClaim', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }],
      functionName: 'rootClaim',
    })
    return { outputIndex: i, outputRoot: rootClaim, l2BlockNumber: l2Block }
  }
  throw new Error('No Kailua game covering the bridge tx yet. Try again later.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log(`Relaying bridge tx ${BRIDGE_TX_HASH}`)
  log('Fetching L2 receipt…')
  const receipt = await l2Client.getTransactionReceipt({ hash: BRIDGE_TX_HASH })
  if (!receipt) throw new Error(`L2 tx ${BRIDGE_TX_HASH} not found`)
  if (receipt.status !== 'success') throw new Error('bridge() tx did not succeed; nothing to relay')

  const withdrawals = getWithdrawals(receipt)
  if (withdrawals.length === 0) {
    throw new Error('No MessagePassed event in this tx — is it really a NetizenBridgeL2.bridge() tx?')
  }
  const [withdrawal] = withdrawals
  log(`Found cross-domain message (withdrawalHash ${withdrawal.withdrawalHash})`)

  await assertPortalNotPaused()

  const status = await l1Public.getWithdrawalStatus({ receipt, targetChain: megaeth })
  log(`Status: ${status}`)
  if (status === 'finalized') {
    log('Already finalized — the L1 mint has executed (or is replayable if its inner relay failed for gas).')
    return
  }

  // ── Prove ──────────────────────────────────────────────────────────────────
  if (status === 'waiting-to-prove') {
    throw new Error('No dispute game has proposed a state root covering this message yet. Try again later.')
  }
  if (status === 'ready-to-prove') {
    log('Building prove args (eth_getWithdrawalProof against MegaETH)…')
    const output = await findOutput(receipt.blockNumber)
    const proveArgs = await l2Client.buildProveWithdrawal({ output, withdrawal })

    log('Submitting proveWithdrawal on L1…')
    const proveHash = await l1Wallet.proveWithdrawal({ ...proveArgs, targetChain: megaeth })
    log(`  prove tx: ${proveHash}`)
    const proveReceipt = await l1Public.waitForTransactionReceipt({ hash: proveHash })
    if (proveReceipt.status !== 'success') throw new Error('proveWithdrawal reverted')
    log('  prove confirmed.')
  }

  // ── Finalize ─────────────────────────────────────────────────────────────
  const postProveStatus = await l1Public.getWithdrawalStatus({ receipt, targetChain: megaeth })
  log(`Status: ${postProveStatus}`)
  if (postProveStatus === 'waiting-to-finalize') {
    log('Waiting out the portal proof-maturity delay before finalize…')
    await l1Public.waitToFinalize({ withdrawalHash: withdrawal.withdrawalHash, targetChain: megaeth })
  }

  log('Submitting finalizeWithdrawal on L1 (this triggers relayMessage -> finalizeBridge)…')
  const finalizeHash = await l1Wallet.finalizeWithdrawal({ targetChain: megaeth, withdrawal })
  log(`  finalize tx: ${finalizeHash}`)
  const finalizeReceipt = await l1Public.waitForTransactionReceipt({ hash: finalizeHash })
  if (finalizeReceipt.status !== 'success') throw new Error('finalizeWithdrawal reverted')

  log('Done. The bridged Netizen(s) should now be minted on NetizenL1.')
  log('If the inner mint ran out of gas, the message lands in L1CrossDomainMessenger')
  log(`(${L1_CROSS_DOMAIN_MESSENGER}) failedMessages and can be replayed via relayMessage`)
  log('with a higher gas limit — the NFTs are not lost.')
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
