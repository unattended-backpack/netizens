#!/usr/bin/env bash
#
# Local dev harness for the WCN bridge: two anvil forks (Ethereum L1 + MegaETH L2)
# with the bridge contracts deployed and wired. Pair with localnet-relayer.mjs
# (simulates derivation + proof relay) and setup-fixtures.mjs (seeds test NFTs).
#
#   L1_FORK_RPC=https://your-eth-rpc ./scripts/localnet.sh up    # boot + deploy + wire
#   ./scripts/localnet.sh down                                   # stop both anvils
#
# Env:
#   L1_FORK_RPC   (required) Ethereum mainnet RPC to fork
#   L2_FORK_RPC   (default https://mainnet.megaeth.com/rpc) MegaETH RPC to fork
#   SKIP_FIXTURES set to 1 to skip seeding test NFTs
set -euo pipefail

# This script lives in scripts/. Run everything from the repo root so the relative
# contracts/, frontend/, deployments.local.json and .localnet.pids paths below resolve
# the same no matter where it's invoked from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

L1_PORT=8545
L2_PORT=8546
L1_URL="http://127.0.0.1:${L1_PORT}"
L2_URL="http://127.0.0.1:${L2_PORT}"
L2_FORK_RPC="${L2_FORK_RPC:-https://mainnet.megaeth.com/rpc}"
# Dev chainId for the L1 fork so a browser wallet can add it as a custom network
# (real mainnet chainId 1 can't be repointed at localhost in most wallets).
L1_CHAIN_ID="${L1_CHAIN_ID:-31337}"

# anvil dev account #0 (well-known key; deployer + bridge owner on the forks)
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# Known mainnet/MegaETH addresses (verified on-chain).
PORTAL="0x7f82f57F0Dd546519324392e408b01fcC7D709e8"
L1_MSG="0x6C7198250087B29A8040eC63903Bc130f4831Cc9"
L2_MSG="0x4200000000000000000000000000000000000007"
WCN="0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44"
DGF="0x8546840adF796875cD9AAcc5B3B048f6B2c9D563"  # Kailua DisputeGameFactory the portal points at

PIDS_FILE=".localnet.pids"

wait_rpc() {
  for _ in $(seq 1 60); do
    if cast chain-id --rpc-url "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "ERROR: RPC $1 did not come up" >&2; exit 1
}

addr_from_broadcast() {
  node -e "const j=JSON.parse(require('fs').readFileSync('$1','utf8'));const t=j.transactions.find(x=>x.transactionType==='CREATE'&&x.contractAddress);if(!t){console.error('no CREATE tx in $1');process.exit(1)}process.stdout.write(t.contractAddress)"
}

# Find the OptimismPortal storage slot holding the DisputeGameFactory address, so we
# can repoint it at our MockGameFactory via anvil_setStorageAt.
find_dgf_slot() {
  local target want v
  target=$(echo "${DGF#0x}" | tr 'A-F' 'a-f')
  want="0x$(printf '%064s' "$target" | tr ' ' '0')"
  for i in $(seq 0 160); do
    v=$(cast storage "$PORTAL" "$i" --rpc-url "$L1_URL" 2>/dev/null || echo "")
    if [ "$(echo "$v" | tr 'A-F' 'a-f')" = "$want" ]; then echo "$i"; return 0; fi
  done
  return 1
}

up() {
  [ -n "${L1_FORK_RPC:-}" ] || { echo "ERROR: set L1_FORK_RPC to an Ethereum mainnet RPC" >&2; exit 1; }
  if [ -f "$PIDS_FILE" ]; then echo "Already up (found $PIDS_FILE). Run './localnet.sh down' first." >&2; exit 1; fi

  echo ">> Booting anvil L1 fork (chain $L1_CHAIN_ID) on $L1_URL"
  setsid anvil --fork-url "$L1_FORK_RPC" --chain-id "$L1_CHAIN_ID" --port "$L1_PORT" >localnet-l1.log 2>&1 &
  echo $! >"$PIDS_FILE"
  echo ">> Booting anvil L2 fork (MegaETH, chain 4326) on $L2_URL"
  setsid anvil --fork-url "$L2_FORK_RPC" --chain-id 4326 --port "$L2_PORT" >localnet-l2.log 2>&1 &
  echo $! >>"$PIDS_FILE"

  wait_rpc "$L1_URL"; wait_rpc "$L2_URL"
  echo ">> Both forks up."
  deploy_all
}

# Deploy + wire + mock + env against ALREADY-RUNNING forks (used by `up`, or standalone
# via `./localnet.sh deploy` to re-run setup without re-forking).
deploy_all() {
  wait_rpc "$L1_URL"; wait_rpc "$L2_URL"
  export DEPLOYER_KEY="$ANVIL_KEY"
  export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

  # L2 fork height (recorded for reference). The frontend scans Transfer logs from
  # WCN_SCAN_FROM (default 0) so YOUR account's pre-fork tokens are found via the proxy.
  L2_FORK_BLOCK=$(cast block-number --rpc-url "$L2_URL")
  # L1 height before NetizenL1 deploys — the lower bound for scanning "home" mints.
  L1_FROM_BLOCK=$(cast block-number --rpc-url "$L1_URL")

  # Use your OWN account: the L2 fork already holds your real Netizens. Set FUND_ADDR to
  # your address and it gets gas on the L1 fork so you can sign the deposits yourself.
  if [ -n "${FUND_ADDR:-}" ]; then
    cast rpc anvil_setBalance "$FUND_ADDR" 0x21e19e0c9bab2400000 --rpc-url "$L1_URL" >/dev/null
    echo ">> Funded $FUND_ADDR with 10000 ETH on the L1 fork (sign with your own wallet — no key import)"
  fi

  echo ">> Deploying NetizenL1 on L1…"
  forge script contracts/script/DeployL1.s.sol:DeployL1 --root contracts --rpc-url "$L1_URL" --broadcast >/dev/null
  NETIZEN_L1=$(addr_from_broadcast "contracts/broadcast/DeployL1.s.sol/${L1_CHAIN_ID}/run-latest.json")
  echo "   NetizenL1 = $NETIZEN_L1"

  echo ">> Deploying NetizenBridgeL2 on L2…"
  NETIZEN_L1_ADDRESS="$NETIZEN_L1" forge script contracts/script/DeployL2.s.sol:DeployL2 --root contracts --rpc-url "$L2_URL" --broadcast >/dev/null
  BRIDGE_L2=$(addr_from_broadcast "contracts/broadcast/DeployL2.s.sol/4326/run-latest.json")
  echo "   NetizenBridgeL2 = $BRIDGE_L2"

  echo ">> Wiring NetizenL1.setL2Bridge…"
  NETIZEN_L1_ADDRESS="$NETIZEN_L1" BRIDGE_L2_ADDRESS="$BRIDGE_L2" forge script contracts/script/WireL1.s.sol:WireL1 --root contracts --rpc-url "$L1_URL" --broadcast >/dev/null

  echo ">> Deploying MockGameFactory + repointing the portal's DisputeGameFactory…"
  RGT=$(cast call "$PORTAL" "respectedGameType()(uint32)" --rpc-url "$L1_URL")
  MOCK_GF=$(forge create src/localnet/MockGameFactory.sol:MockGameFactory --root contracts \
    --rpc-url "$L1_URL" --private-key "$ANVIL_KEY" --broadcast --constructor-args "$RGT" \
    | grep -i "Deployed to:" | awk '{print $NF}')
  echo "   MockGameFactory = $MOCK_GF  (respectedGameType=$RGT)"
  DGF_SLOT=$(find_dgf_slot || true)
  if [ -n "$DGF_SLOT" ]; then
    MOCK_WORD=0x$(printf '%064s' "$(echo "${MOCK_GF#0x}" | tr 'A-F' 'a-f')" | tr ' ' '0')
    cast rpc anvil_setStorageAt "$PORTAL" "$(cast to-hex "$DGF_SLOT")" "$MOCK_WORD" --rpc-url "$L1_URL" >/dev/null
    echo "   portal.disputeGameFactory -> MockGameFactory (slot $DGF_SLOT)"
  else
    echo "   WARN: could not locate the portal's DisputeGameFactory slot — prove/finalize will not work" >&2
  fi

  node -e "require('fs').writeFileSync('deployments.local.json',JSON.stringify({l1Rpc:'$L1_URL',l2Rpc:'$L2_URL',l1ChainId:$L1_CHAIN_ID,l2ChainId:4326,portal:'$PORTAL',l1Messenger:'$L1_MSG',l2Messenger:'$L2_MSG',wcn:'$WCN',netizenL1:'$NETIZEN_L1',bridgeL2:'$BRIDGE_L2',mockGameFactory:'$MOCK_GF',l2ForkBlock:$L2_FORK_BLOCK},null,2)+'\n')"
  echo ">> Wrote deployments.local.json"

  # Write the frontend env so the UI points at the localnet with no manual editing.
  node -e "require('fs').writeFileSync('frontend/.env.local','VITE_L1_RPC_URL=$L1_URL\nVITE_L2_RPC_URL=$L2_URL\nVITE_L1_CHAIN_ID=$L1_CHAIN_ID\nVITE_L2_CHAIN_ID=4326\nVITE_L2_USE_GETPROOF=true\nVITE_IS_LOCALNET=true\nVITE_NETIZEN_L1=$NETIZEN_L1\nVITE_BRIDGE_L2=$BRIDGE_L2\nVITE_DISPUTE_GAME_FACTORY=$MOCK_GF\nVITE_NFT_CONTRACT_ADDRESS=$WCN\nVITE_OPTIMISM_PORTAL_ADDRESS=$PORTAL\nVITE_L1_CROSS_DOMAIN_MESSENGER=$L1_MSG\nVITE_WCN_DEPLOY_BLOCK=${WCN_SCAN_FROM:-0}\nVITE_NETIZEN_L1_DEPLOY_BLOCK=$L1_FROM_BLOCK\nVITE_RELAYER_CONTROL=http://127.0.0.1:8547\n')"
  echo ">> Wrote frontend/.env.local"

  if [ "${SKIP_FIXTURES:-0}" != "1" ]; then
    echo ">> Seeding test NFTs (setup-fixtures.mjs)…"
    node scripts/setup-fixtures.mjs
  fi

  cat <<EOF

================ localnet ready ================
  L1 fork:   $L1_URL   (chainId $L1_CHAIN_ID)
  L2 fork:   $L2_URL   (chainId 4326)
  NetizenL1:        $NETIZEN_L1
  NetizenBridgeL2:  $BRIDGE_L2
  MockGameFactory:  $MOCK_GF
  frontend env:     frontend/.env.local   (written)
  addresses + RPCs: deployments.local.json

Next:
  1) node scripts/localnet-relayer.mjs    # deposit replay + dispute-game injection + fast-forward
  2) wallet: add network RPC $L1_URL chainId $L1_CHAIN_ID, then connect YOUR account
     (your Netizens are already on the L2 fork). Low on L1 gas? re-run with FUND_ADDR=0xYou
  3) cd frontend && npm run dev   # picks up .env.local
  4) fast-forward the windows from the UI button, or: curl -X POST http://127.0.0.1:8547/fast-forward
  stop:  ./scripts/localnet.sh down

  Tip: after re-running 'up', clear your wallet's activity/nonce cache for this network.
================================================
EOF
}

down() {
  if [ ! -f "$PIDS_FILE" ]; then echo "Nothing to stop ($PIDS_FILE not found)."; exit 0; fi
  while read -r pid; do
    if kill "$pid" 2>/dev/null; then echo ">> stopped pid $pid"; fi
  done <"$PIDS_FILE"
  rm -f "$PIDS_FILE"
  echo ">> localnet down."
}

case "${1:-}" in
  up)     up ;;
  deploy) deploy_all ;;
  down)   down ;;
  *)      echo "usage: L1_FORK_RPC=... $0 up | $0 deploy | $0 down" >&2; exit 1 ;;
esac
