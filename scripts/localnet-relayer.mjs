// localnet-relayer.mjs
//
// Local OP-Stack "derivation + proof" SIMULATOR for the WCN bridge dev harness.
// It bridges messages between two anvil forks so a frontend can drive the full
// flow end-to-end, with a fast-forward control instead of real inclusion/proof
// delays. It is NOT the real sequencer/proposer — it fakes them via anvil cheats.
//
//   • Deposits (L1 -> L2): watches the real OptimismPortal `TransactionDeposited`
//     on the L1 fork, decodes (from, to, data, gas) and replays it on the L2 fork
//     as `from` via anvil_impersonateAccount. Since deposits from an EOA are
//     unaliased, this executes as the user X — exactly like real derivation.
//
//   • Withdrawals (L2 -> L1): watches the L2ToL1MessagePasser `MessagePassed` and,
//     instead of relaying, injects a dispute game on L1 (MockGameFactory.setGame)
//     committing to the L2 fork's REAL output root. The user then runs the REAL
//     proveWithdrawalTransaction + finalizeWithdrawalTransaction against the portal —
//     ETH forwarding, relayMessage and finalizeBridge all execute for real. Only the
//     Kailua proposer + the challenge window are faked.
//
//   • Delays: deposits get readyAt = now + delay. POST /fast-forward flushes pending
//     deposits AND advances L1 time past the proof-maturity + finality windows so the
//     user's Finalize is allowed (the frontend's "fast-forward" button).
//
//   • Logs the L1 relay gasUsed per token — handy alongside the forge gas test.
//
// Config: ./deployments.local.json (written by localnet.sh) + env overrides.
// Run after `./localnet.sh up`:  node localnet-relayer.mjs
//
// Node 18+ and viem >= 2.x.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import {
  createPublicClient, http, parseAbiItem,
  slice, hexToBigInt, toHex, getAddress, parseEther,
  keccak256, concat, encodeFunctionData,
} from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const cfg = loadConfig()
const DEPOSIT_DELAY_MS  = Number(process.env.DEPOSIT_DELAY_MS  ?? 0)
const WITHDRAW_DELAY_MS = Number(process.env.WITHDRAW_DELAY_MS ?? 0)
const CONTROL_PORT      = Number(process.env.CONTROL_PORT ?? 8547)
const POLL_MS           = Number(process.env.POLL_MS ?? 1500)

function loadConfig() {
  let file = {}
  const path = process.env.DEPLOYMENTS ?? './deployments.local.json'
  try { file = JSON.parse(readFileSync(path, 'utf8')) } catch { /* env-only is fine */ }
  const pick = (k, d) => process.env[k.toUpperCase()] ?? file[k] ?? d
  return {
    l1Rpc:       pick('l1Rpc', 'http://127.0.0.1:8545'),
    l2Rpc:       pick('l2Rpc', 'http://127.0.0.1:8546'),
    portal:      getAddress(pick('portal', '0x7f82f57F0Dd546519324392e408b01fcC7D709e8')),
    l1Messenger: getAddress(pick('l1Messenger', '0x6C7198250087B29A8040eC63903Bc130f4831Cc9')),
    l2Messenger: getAddress(pick('l2Messenger', '0x4200000000000000000000000000000000000007')),
    netizenL1:   file.netizenL1 ? getAddress(file.netizenL1) : null,
    bridgeL2:    file.bridgeL2 ? getAddress(file.bridgeL2) : null,
    mockGameFactory: (process.env.MOCKGAMEFACTORY ?? file.mockGameFactory)
      ? getAddress(process.env.MOCKGAMEFACTORY ?? file.mockGameFactory) : null,
    proofMaturity: 604800n, // refreshed from the portal in main()
  }
}

const l1 = createPublicClient({ transport: http(cfg.l1Rpc) })
const l2 = createPublicClient({ transport: http(cfg.l2Rpc) })

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

const DEPOSIT_EVENT = parseAbiItem('event TransactionDeposited(address indexed from, address indexed to, uint256 indexed version, bytes opaqueData)')
// bridge() on L2 emits MessagePassed; we don't relay it — we inject a dispute game on
// L1 committing to the L2 output root so the user can run the REAL prove + finalize.
const MESSAGE_PASSED    = parseAbiItem('event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)')
const L2_MESSAGE_PASSER = '0x4200000000000000000000000000000000000016'
const SET_GAME          = parseAbiItem('function setGame(bytes32 root, uint256 l2Block, uint64 createdAt, uint64 resolvedAt)')
const PROOF_MATURITY_FN = parseAbiItem('function proofMaturityDelaySeconds() view returns (uint256)')
const RELAYER_EOA       = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // anvil account #0 (pokes setGame)

// ─────────────────────────────────────────────────────────────────────────────
// anvil helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sendAs(client, { from, to, data, value = 0n, gas }) {
  await client.request({ method: 'anvil_impersonateAccount', params: [from] })
  // Fund the value transfer + gas, but only if the account is short — don't clobber a real
  // balance, so the ETH-sweep cosmetic (balance -> ~0) stays correct. The first bridge batch
  // sweeps nearly the whole balance as `value`, so a flat top-up wouldn't leave room for gas.
  const [balHex, gpHex] = await Promise.all([
    client.request({ method: 'eth_getBalance', params: [from, 'latest'] }),
    client.request({ method: 'eth_gasPrice', params: [] }),
  ])
  const preBal = BigInt(balHex)
  const gasRoom = (gas ? BigInt(gas) : 2_000_000n) * BigInt(gpHex) * 3n
  if (preBal < value + gasRoom) await client.request({ method: 'anvil_setBalance', params: [from, toHex(value + gasRoom)] })
  const tx = { from, to, data, value: toHex(value) }
  if (gas) tx.gas = toHex(gas)
  const hash = await client.request({ method: 'eth_sendTransaction', params: [tx] })
  const receipt = await client.waitForTransactionReceipt({ hash })
  // Mainnet semantics: a deposit's L2 gas is prepaid, so only `value` should leave the
  // account. Reset to (preBal - value) so a full sweep reads as 0 — no relayer gas dust.
  await client.request({ method: 'anvil_setBalance', params: [from, toHex(preBal > value ? preBal - value : 0n)] })
  return receipt
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function replayDeposit({ args }) {
  const od = args.opaqueData
  const value = hexToBigInt(slice(od, 32, 64))
  const gas = hexToBigInt(slice(od, 64, 72))
  const isCreation = slice(od, 72, 73) !== '0x00'
  const data = od.length > 2 + 73 * 2 ? slice(od, 73) : '0x'
  if (isCreation) { log('  (skipping contract-creation deposit)'); return }
  log(`Deposit  L1->L2: ${args.from} -> ${args.to} (gas ${gas})`)
  const rcpt = await sendAs(l2, { from: args.from, to: args.to, data, value, gas })
  log(`  L2 replay ${rcpt.status} (tx ${rcpt.transactionHash})`)
}

async function injectGame({ args }) {
  if (!cfg.mockGameFactory) { log('  !! mockGameFactory not set (re-run ./localnet.sh up) — cannot inject game'); return }
  log(`Withdraw L2->L1: ${args.withdrawalHash} — injecting dispute game for real prove/finalize`)
  // Mine one L2 block so the game's L2 height is STRICTLY greater than the withdrawal's
  // block (viem's getGame filters on >). Then commit to the L2 fork's REAL output root
  // at that tip, so the portal accepts the user's getWithdrawalProof-based prove.
  await l2.request({ method: 'evm_mine', params: [] })
  const blk = await l2.getBlock({ blockTag: 'latest' })
  const proof = await l2.getProof({ address: L2_MESSAGE_PASSER, storageKeys: [], blockNumber: blk.number })
  const ZERO = '0x' + '0'.repeat(64)
  const outputRoot = keccak256(concat([ZERO, blk.stateRoot, proof.storageHash, blk.hash]))
  const l1ts = (await l1.getBlock({ blockTag: 'latest' })).timestamp
  const backdated = l1ts - 3600n // created/resolved in the past so prove + finality checks pass
  const data = encodeFunctionData({ abi: [SET_GAME], functionName: 'setGame', args: [outputRoot, blk.number, backdated, backdated] })
  const rcpt = await sendAs(l1, { from: RELAYER_EOA, to: cfg.mockGameFactory, data })
  log(`  game @ L2 #${blk.number} root ${outputRoot.slice(0, 18)}… (setGame ${rcpt.status})`)
  log('  -> Prove is now available. After proving, POST /fast-forward to clear the window, then Finalize.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Queues + poll loop
// ─────────────────────────────────────────────────────────────────────────────

const seen = new Set()
const depQ = []
const wdQ = []
const stats = { deposits: 0, withdrawals: 0 }

function enqueue(q, kind, log_, delay) {
  const key = `${log_.transactionHash}:${log_.logIndex}`
  if (seen.has(key)) return
  seen.add(key)
  q.push({ key, kind, args: log_.args, readyAt: Date.now() + delay })
  log(`Queued ${kind} ${key} (ready in ${delay}ms)`)
}

async function drain(q, handler) {
  while (q.length && q[0].readyAt <= Date.now()) {
    const item = q.shift()
    try { await handler(item) }
    catch (e) { log(`!! ${item.kind} ${item.key} failed: ${e.shortMessage ?? e.message}`) }
  }
}

let lastL1, lastL2
async function poll() {
  const tipL1 = await l1.getBlockNumber()
  if (tipL1 > lastL1) {
    const logs = await l1.getLogs({ address: cfg.portal, event: DEPOSIT_EVENT, fromBlock: lastL1 + 1n, toBlock: tipL1 })
    for (const l of logs) { enqueue(depQ, 'deposit', l, DEPOSIT_DELAY_MS); stats.deposits++ }
    lastL1 = tipL1
  }
  const tipL2 = await l2.getBlockNumber()
  if (tipL2 > lastL2) {
    const logs = await l2.getLogs({ address: L2_MESSAGE_PASSER, event: MESSAGE_PASSED, fromBlock: lastL2 + 1n, toBlock: tipL2 })
    for (const l of logs) { enqueue(wdQ, 'withdraw', l, WITHDRAW_DELAY_MS); stats.withdrawals++ }
    lastL2 = tipL2
  }
  await drain(depQ, replayDeposit) // deposits first (preserves approve-before-bridge order)
  await drain(wdQ, injectGame)
}

async function fastForward() {
  for (const i of depQ) i.readyAt = 0
  for (const i of wdQ) i.readyAt = 0
  // Advance L1 time past proof-maturity + dispute-game-finality so Finalize is allowed.
  const jump = Number(cfg.proofMaturity + 3600n)
  await l1.request({ method: 'evm_increaseTime', params: [jump] })
  await l1.request({ method: 'evm_mine', params: [] })
  log(`FAST-FORWARD: flushed pending deposits + advanced L1 time by ${jump}s (challenge window cleared)`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Control server (frontend hits POST /fast-forward)
// ─────────────────────────────────────────────────────────────────────────────

function startControlServer() {
  createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    if (req.method === 'POST' && req.url === '/fast-forward') {
      await fastForward(); await poll()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, pending: depQ.length + wdQ.length }))
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        pendingDeposits: depQ.length, pendingWithdrawals: wdQ.length, ...stats,
      }))
    }
    res.writeHead(404); res.end()
  }).listen(CONTROL_PORT, () => log(`Control server: http://127.0.0.1:${CONTROL_PORT}  (GET /status, POST /fast-forward)`))
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [id1, id2] = await Promise.all([l1.getChainId(), l2.getChainId()])
  log(`L1 fork ${cfg.l1Rpc} (chainId ${id1})  |  L2 fork ${cfg.l2Rpc} (chainId ${id2})`)
  log(`portal=${cfg.portal} l1Messenger=${cfg.l1Messenger} l2Messenger=${cfg.l2Messenger}`)
  if (cfg.netizenL1) log(`NetizenL1=${cfg.netizenL1}  NetizenBridgeL2=${cfg.bridgeL2}`)
  log(`delays: deposit=${DEPOSIT_DELAY_MS}ms withdraw=${WITHDRAW_DELAY_MS}ms (POST /fast-forward to flush)`)
  if (cfg.mockGameFactory) log(`MockGameFactory=${cfg.mockGameFactory}`)
  else log('WARN: mockGameFactory not configured — prove/finalize will not be injectable')

  try { cfg.proofMaturity = await l1.readContract({ address: cfg.portal, abi: [PROOF_MATURITY_FN], functionName: 'proofMaturityDelaySeconds' }) }
  catch { /* keep default */ }
  log(`proofMaturity=${cfg.proofMaturity}s (fast-forward jumps this + 1h)`)

  // Start from the current tip so we only relay messages created this session
  // (a mainnet fork has real historical TransactionDeposited logs to ignore).
  ;[lastL1, lastL2] = await Promise.all([l1.getBlockNumber(), l2.getBlockNumber()])
  startControlServer()
  log('Relayer running. Watching for deposits and withdrawals…')

  for (;;) {
    try { await poll() } catch (e) { log(`poll error: ${e.shortMessage ?? e.message}`) }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1) })
