// setup-fixtures.mjs
//
// Seed the local MegaETH fork so a known test EOA holds real WCN tokens and is
// funded on both forks — ready to drive the bridge flow from a frontend.
//
// It impersonates the current owner of each target tokenId and transfers it to
// the test account (anvil's account #0 by default, whose key you import into the
// frontend wallet). Same address exists on both forks (same key), which the
// L1-forced-inclusion path requires.
//
// Run after `./localnet.sh up`:
//   node setup-fixtures.mjs                 # auto-pick 3 existing tokenIds
//   TOKEN_IDS=12,34,56 node setup-fixtures.mjs
//   TEST_ACCOUNT=0x... COUNT=5 node setup-fixtures.mjs
//
// Node 18+ and viem >= 2.x.

import { readFileSync } from 'node:fs'
import { createPublicClient, http, toHex, getAddress, parseEther, encodeFunctionData, parseAbiItem } from 'viem'

// anvil default account #0 (well-known dev key — import into the frontend wallet).
const ANVIL_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ANVIL_0_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const cfg = loadConfig()
const TEST_ACCOUNT = getAddress(process.env.TEST_ACCOUNT ?? ANVIL_0)
const COUNT = Number(process.env.COUNT ?? 3)
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT ?? 500)

function loadConfig() {
  let file = {}
  try { file = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? './deployments.local.json', 'utf8')) } catch {}
  const pick = (k, d) => process.env[k.toUpperCase()] ?? file[k] ?? d
  return {
    l1Rpc: pick('l1Rpc', 'http://127.0.0.1:8545'),
    l2Rpc: pick('l2Rpc', 'http://127.0.0.1:8546'),
    wcn:   getAddress(pick('wcn', '0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44')),
  }
}

const l1 = createPublicClient({ transport: http(cfg.l1Rpc) })
const l2 = createPublicClient({ transport: http(cfg.l2Rpc) })
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

const OWNER_OF      = parseAbiItem('function ownerOf(uint256) view returns (address)')
const TRANSFER_FROM = parseAbiItem('function transferFrom(address from, address to, uint256 tokenId)')

async function ownerOf(id) {
  try { return await l2.readContract({ address: cfg.wcn, abi: [OWNER_OF], functionName: 'ownerOf', args: [id] }) }
  catch { return null }
}

async function sendAs(from, to, data) {
  await l2.request({ method: 'anvil_impersonateAccount', params: [from] })
  await l2.request({ method: 'anvil_setBalance', params: [from, toHex(parseEther('10000'))] })
  const hash = await l2.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] })
  return l2.waitForTransactionReceipt({ hash })
}

async function main() {
  log(`Seeding fixtures on ${cfg.l2Rpc} for test account ${TEST_ACCOUNT}`)

  // Resolve target tokenIds.
  let ids
  if (process.env.TOKEN_IDS) {
    ids = process.env.TOKEN_IDS.split(',').map((x) => BigInt(x.trim()))
  } else {
    log(`Scanning tokenIds 1..${SCAN_LIMIT} for ${COUNT} that exist…`)
    ids = []
    for (let id = 1n; id <= BigInt(SCAN_LIMIT) && ids.length < COUNT; id++) {
      if (await ownerOf(id)) ids.push(id)
    }
    if (ids.length === 0) throw new Error('Found no existing WCN tokenIds to seed')
  }

  // Transfer each to the test account.
  for (const id of ids) {
    const owner = await ownerOf(id)
    if (!owner) { log(`  tokenId ${id}: does not exist, skipping`); continue }
    if (getAddress(owner) === TEST_ACCOUNT) { log(`  tokenId ${id}: already owned by test account`); continue }
    const data = encodeFunctionData({ abi: [TRANSFER_FROM], functionName: 'transferFrom', args: [getAddress(owner), TEST_ACCOUNT, id] })
    const rcpt = await sendAs(getAddress(owner), cfg.wcn, data)
    log(`  tokenId ${id}: ${owner} -> ${TEST_ACCOUNT} (${rcpt.status})`)
  }

  // Fund the test account on both forks (deposits/relays pay L1/L2 gas).
  for (const [name, client] of [['L1', l1], ['L2', l2]]) {
    await client.request({ method: 'anvil_setBalance', params: [TEST_ACCOUNT, toHex(parseEther('1000'))] })
    log(`  funded ${name} balance: 1000 ETH`)
  }

  console.log('')
  log(`Done. Test account ${TEST_ACCOUNT} holds tokenIds: ${ids.join(', ')}`)
  if (TEST_ACCOUNT === ANVIL_0) log(`Import this key into the frontend wallet: ${ANVIL_0_KEY}`)
  log('Now drive the flow (frontend, or deposit-exit.mjs pointed at the L1 fork).')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
