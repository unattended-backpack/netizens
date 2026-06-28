// deposit-exit.mjs
//
// Drive a multi-NFT exit entirely from Ethereum L1 via OP-Stack FORCED INCLUSION.
//
// It submits two deposit transactions through the OptimismPortal, back-to-back,
// from your EOA `X` (the address that holds the WCN on MegaETH), with pinned
// sequential L1 nonces so they are both pending on L1 and execute IN ORDER on L2:
//
//   Deposit A (nonce n)   : X -> WCN.setApprovalForAll(bridge, true)
//   Deposit B (nonce n+1) : X -> NetizenBridgeL2.bridge(tokenIds, l1Recipient)
//
// Why this works:
//   • An EOA calling the portal directly is NOT address-aliased, so both L2 txs
//     execute as X (msg.sender == X), satisfying the approval and the bridge's
//     `ownerOf == msg.sender` check.
//   • L1 nonce ordering (n before n+1) is preserved through deposit derivation,
//     so A (approve) always lands before B (bridge). One shared force-inclusion
//     window (~12h worst case) covers BOTH; you do not wait twice.
//   • The sequencer cannot include B without A, cannot reorder them, and cannot
//     stall past the sequencing window without producing an invalid L2 chain.
//
// After B executes on L2 it emits the L2->L1 message; finish the exit by proving
// + finalizing it with relay-nft.mjs (this script prints B's computed L2 tx hash).
//
// Requirements & caveats:
//   • X must be an EOA whose key you control (same address on both chains).
//     Smart-contract-wallet holders cannot use this path (they would be aliased).
//   • You only pay L1 gas. The L2 gas is prepaid via each deposit's gas limit; X
//     needs no MegaETH balance.
//   • The eventual L1 mint relay is bounded by the Osaka ~16.78M per-tx gas cap,
//     so keep the batch within the bridge's MAX_BATCH.
//
// Usage:
//   DEPLOYER_KEY=0x...        \  # X: holds WCN on MegaETH AND signs the L1 deposits
//   L1_RPC=https://...   \  # Ethereum mainnet RPC
//   BRIDGE_L2_ADDRESS=0x...          \  # deployed NetizenBridgeL2 address on MegaETH
//   TOKEN_IDS=1,2,3          \  # comma-separated WCN tokenIds to exit
//   [L1_RECIPIENT=0x...]     \  # L1 recipient of NFTs + ETH (default: X)
//   [BRIDGE_ETH_WEI=...]     \  # L2 ETH to bridge along (default: sweep full balance)
//   [SKIP_APPROVAL=1]        \  # skip Deposit A if the bridge is already approved
//   [GAS_L2_APPROVE=...] [GAS_L2_BRIDGE=...] \ # override L2 gas limits
//   [WAIT=1]                 \  # poll L2 (~3 min) for B's execution
//   node deposit-exit.mjs
//
// Node 18+ and viem >= 2.x.

import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { walletActionsL1, getL2TransactionHashes } from 'viem/op-stack'

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const DEPLOYER_KEY = required('DEPLOYER_KEY')
const L1_RPC       = required('L1_RPC')
const L2_RPC       = required('L2_RPC')
// getAddress validates format + checksum and normalizes lowercase input.
const BRIDGE_L2_ADDRESS = getAddress(required('BRIDGE_L2_ADDRESS'))

const WCN    = '0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44' // World Computer Netizens
const PORTAL = '0x7f82f57F0Dd546519324392e408b01fcC7D709e8' // OptimismPortal2

const TOKEN_IDS = parseTokenIds(required('TOKEN_IDS'))
const SKIP_APPROVAL = process.env.SKIP_APPROVAL === '1'
const WAIT = process.env.WAIT === '1'

function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}
function parseTokenIds(s) {
  const ids = s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => BigInt(x))
  if (ids.length === 0) throw new Error('TOKEN_IDS is empty')
  return ids
}

const account = privateKeyToAccount(DEPLOYER_KEY)
const L1_RECIPIENT = getAddress(process.env.L1_RECIPIENT ?? account.address)

const megaeth = defineChain({
  id: 4326,
  name: 'MegaETH',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [L2_RPC] } },
  contracts: { portal: { [mainnet.id]: { address: PORTAL } } },
  sourceId: mainnet.id,
})

const l1Public = createPublicClient({ chain: mainnet, transport: http(L1_RPC) })
const l1Wallet = createWalletClient({ account, chain: mainnet, transport: http(L1_RPC) }).extend(walletActionsL1())
const l2Public = createPublicClient({ chain: megaeth, transport: http(L2_RPC) })

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

// ─────────────────────────────────────────────────────────────────────────────
// ABIs / calldata
// ─────────────────────────────────────────────────────────────────────────────

const APPROVE_ABI = [{
  type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable',
  inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [],
}]
const BRIDGE_ABI = [{
  type: 'function', name: 'bridge', stateMutability: 'nonpayable',
  inputs: [{ name: 'tokenIds', type: 'uint256[]' }, { name: 'l1Recipient', type: 'address' }], outputs: [],
}]
const PORTAL_ABI = [{
  type: 'function', name: 'minimumGasLimit', stateMutability: 'view',
  inputs: [{ name: '_byteCount', type: 'uint64' }], outputs: [{ type: 'uint64' }],
}]

const approveData = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'setApprovalForAll', args: [BRIDGE_L2_ADDRESS, true] })
const bridgeData  = encodeFunctionData({ abi: BRIDGE_ABI, functionName: 'bridge', args: [TOKEN_IDS, L1_RECIPIENT] })

// Choose an L2 gas limit, but never below the portal's enforced minimum for the
// deposit's data size (else depositTransaction reverts on L1).
async function l2GasLimit(data, want) {
  const byteCount = BigInt((data.length - 2) / 2)
  const min = await l1Public.readContract({ address: PORTAL, abi: PORTAL_ABI, functionName: 'minimumGasLimit', args: [byteCount] })
  return want > min ? want : min
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const n = BigInt(TOKEN_IDS.length)
  log(`Exiting ${n} WCN token(s) from L1 via forced inclusion as ${account.address}`)
  log(`  tokenIds:     ${TOKEN_IDS.join(', ')}`)
  log(`  l1Recipient:  ${L1_RECIPIENT}`)
  log(`  bridge (L2):  ${BRIDGE_L2_ADDRESS}`)
  log(`  skipApproval: ${SKIP_APPROVAL}`)

  const approveGas = await l2GasLimit(approveData, BigInt(process.env.GAS_L2_APPROVE ?? 120_000))
  // Measured L2 cost of bridge(): ~27k/token (WCN clone burn) + ~600k for the
  // value-bearing sendMessage. 45k/token gives ~1.6x headroom; deposit L2-gas is
  // prepaid on L1 so an over-estimate is wasted, an under-estimate just reverts.
  const bridgeGas  = await l2GasLimit(bridgeData,  BigInt(process.env.GAS_L2_BRIDGE  ?? (600_000n + 45_000n * n)))

  // Pin sequential L1 nonces so A and B can both be pending yet ordered.
  let nonce = await l1Public.getTransactionCount({ address: account.address, blockTag: 'pending' })

  let hashA = null
  if (!SKIP_APPROVAL) {
    log(`Submitting Deposit A (approve) at L1 nonce ${nonce}, L2 gas ${approveGas}…`)
    hashA = await l1Wallet.depositTransaction({
      targetChain: megaeth,
      nonce,
      request: { to: WCN, value: 0n, data: approveData, gas: approveGas },
    })
    log(`  A L1 tx: ${hashA}`)
    nonce += 1
  } else {
    log('Skipping Deposit A (SKIP_APPROVAL=1) — assuming bridge already approved.')
  }

  // Bridge ETH alongside the NFTs: it rides the SAME cross-domain message (one
  // withdrawal, one finalization) and is delivered to l1Recipient on L1. Default
  // sweeps the caller's entire L2 balance; deposit L2-gas is prepaid on L1, so a
  // full sweep is safe (the L2 tx isn't charged gas from the balance). `value` is
  // the L2-sent amount; `mint` stays unset so NO ETH is taken from L1.
  const ethValue = process.env.BRIDGE_ETH_WEI
    ? BigInt(process.env.BRIDGE_ETH_WEI)
    : await l2Public.getBalance({ address: account.address })
  log(`Bridging ${ethValue} wei of L2 ETH alongside the NFTs (rides the same message)`)

  log(`Submitting Deposit B (bridge) at L1 nonce ${nonce}, L2 gas ${bridgeGas}…`)
  const hashB = await l1Wallet.depositTransaction({
    targetChain: megaeth,
    nonce,
    request: { to: BRIDGE_L2_ADDRESS, value: ethValue, data: bridgeData, gas: bridgeGas },
  })
  log(`  B L1 tx: ${hashB}`)

  // Both are now broadcast / pending on L1. Wait for L1 confirmations.
  log('Waiting for L1 confirmation of both deposits…')
  const [rcptA, rcptB] = await Promise.all([
    hashA ? l1Public.waitForTransactionReceipt({ hash: hashA }) : Promise.resolve(null),
    l1Public.waitForTransactionReceipt({ hash: hashB }),
  ])
  if (rcptA && rcptA.status !== 'success') throw new Error('Deposit A reverted on L1')
  if (rcptB.status !== 'success') throw new Error('Deposit B reverted on L1')

  // Compute the deterministic L2 tx hashes these deposits produce.
  const l2HashA = rcptA ? getL2TransactionHashes({ logs: rcptA.logs })[0] : null
  const l2HashB = getL2TransactionHashes({ logs: rcptB.logs })[0]

  log('Both deposits confirmed on L1 and queued for forced inclusion.')
  if (l2HashA) log(`  A will execute on MegaETH as L2 tx: ${l2HashA}`)
  log(`  B will execute on MegaETH as L2 tx: ${l2HashB}   <-- relay THIS one`)
  log('Order is guaranteed: A (approve) executes before B (bridge).')
  log('Normal inclusion is seconds–minutes; worst-case sequencing window is ~12h.')

  if (WAIT) {
    log('Polling MegaETH for Deposit B execution (up to ~3 min)…')
    const ok = await pollL2(l2HashB, 36, 5000)
    if (ok) log('Deposit B executed on MegaETH. The L2->L1 message is now in flight.')
    else log('Not yet seen on MegaETH — it will still be force-included. Re-check later.')
  }

  console.log('')
  log('NEXT: once Deposit B has executed on MegaETH, finish the exit with:')
  log(`  DEPLOYER_KEY=0x... L1_RPC=${L1_RPC} BRIDGE_TX_HASH=${l2HashB} node relay-nft.mjs`)
}

async function pollL2(hash, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await l2Public.getTransactionReceipt({ hash })
      if (r) {
        if (r.status !== 'success') throw new Error(`Deposit B L2 execution reverted (${hash})`)
        return true
      }
    } catch (e) {
      if (!/not be found|not found/i.test(String(e.message))) throw e
    }
    await new Promise((res) => setTimeout(res, delayMs))
  }
  return false
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
