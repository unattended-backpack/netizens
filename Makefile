# Trustless one-directional NFT + ETH bridge for World Computer Netizens,
# moving tokens from (L2) onto Ethereum (L1) via the canonical bridge.
#
# Configuration is loaded from `.env.maintainer` and can be overridden by
# environment variables. See `.env.example` for every variable and its default.
#
# Usage:
#   make build           # Build the contracts.
#   make deploy-l1       # Deploy NetizenL1 on Ethereum.
#   make deploy-l2       # Deploy NetizenBridgeL2 on L2.
#   make wire-l1         # Point NetizenL1 at the L2 bridge (one-time).
#   make verify-l1       # Verify NetizenL1 on the L1 explorer.
#   make verify-l2       # Verify NetizenBridgeL2 on the L2 explorer.
#   make verify          # Verify both.
#   make build-frontend  # Build the frontend.
#   make help            # Show all commands.

# Load configuration from `.env.maintainer` if it exists.
-include .env.maintainer

# Load configuration from `.env` if it exists (overrides `.env.maintainer`).
-include .env

# The deploy/wire scripts read their inputs from the environment via `vm.env*`,
# so re-export everything sourced from `.env.maintainer` / `.env`.
export DEPLOYER_KEY OWNER
export NETIZEN_L1_SALT NETIZEN_L1_ADDRESS
export BRIDGE_L2_SALT BRIDGE_L2_ADDRESS

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

.PHONY: require-l1-rpc
require-l1-rpc:
	@test -n "$(L1_RPC)" || { echo "Error: L1_RPC is not set (define it in .env.maintainer or .env)."; exit 1; }

.PHONY: require-l2-rpc
require-l2-rpc:
	@test -n "$(L2_RPC)" || { echo "Error: L2_RPC is not set (define it in .env.maintainer or .env)."; exit 1; }

# ---------------------------------------------------------------------------
# Contracts
# ---------------------------------------------------------------------------

.PHONY: build
build:
	@echo "Building contracts ..."
	cd contracts && forge build
	@echo "Build complete."

.PHONY: deploy-l1
deploy-l1: require-l1-rpc
	@echo "Deploying NetizenL1 to Ethereum ..."
	cd contracts && forge script script/DeployL1.s.sol:DeployL1 \
		--rpc-url $(L1_RPC) --broadcast
	@echo "Deploy complete."

.PHONY: deploy-l2
deploy-l2: require-l2-rpc
	@echo "Deploying NetizenBridgeL2 to L2 ..."
	cd contracts && forge script script/DeployL2.s.sol:DeployL2 \
		--rpc-url $(L2_RPC) --broadcast
	@echo "Deploy complete."

.PHONY: wire-l1
wire-l1: require-l1-rpc
	@echo "Wiring NetizenL1 to the L2 bridge ..."
	cd contracts && forge script script/WireL1.s.sol:WireL1 \
		--rpc-url $(L1_RPC) --broadcast
	@echo "Wiring complete."

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

# Constructor args reconstructed for explorer verification. These MUST match the
# constants in contracts/script/DeployL1.s.sol and DeployL2.s.sol. (NetizenL1's
# name and symbol are hardcoded in the contract, so they are not constructor args.)
NFT_BASE_URI = ipfs://bafybeiabi7zjyuo7je4blxba6liprvhht6lcvk2psklin3woty4d4p4274/
L1_MESSENGER = 0x6C7198250087B29A8040eC63903Bc130f4831Cc9
L2_MESSENGER = 0x4200000000000000000000000000000000000007
WCN          = 0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44

# L1 uses Etherscan; L2 uses its own explorer — set L2_VERIFIER_URL.
L2_VERIFIER ?= blockscout

.PHONY: verify-l1
verify-l1:
	@test -n "$(ETHERSCAN_API_KEY)" || { echo "Error: ETHERSCAN_API_KEY is not set."; exit 1; }
	@test -n "$(NETIZEN_L1_ADDRESS)" || { echo "Error: NETIZEN_L1_ADDRESS is not set."; exit 1; }
	@echo "Verifying NetizenL1 on Ethereum ..."
	@owner="$(OWNER)"; \
	if [ -z "$$owner" ]; then \
		test -n "$(DEPLOYER_KEY)" || { echo "Error: set OWNER, or DEPLOYER_KEY to derive it."; exit 1; }; \
		owner=$$(cast wallet address $(DEPLOYER_KEY)); \
	fi; \
	args=$$(cast abi-encode "constructor(string,address,address)" \
		"$(NFT_BASE_URI)" $(L1_MESSENGER) $$owner); \
	cd contracts && forge verify-contract $(NETIZEN_L1_ADDRESS) src/NetizenL1.sol:NetizenL1 \
		--chain mainnet --etherscan-api-key $(ETHERSCAN_API_KEY) \
		--constructor-args $$args --watch
	@echo "Verification complete."

.PHONY: verify-l2
verify-l2:
	@test -n "$(BRIDGE_L2_ADDRESS)" || { echo "Error: BRIDGE_L2_ADDRESS is not set."; exit 1; }
	@test -n "$(NETIZEN_L1_ADDRESS)" || { echo "Error: NETIZEN_L1_ADDRESS is not set (constructor arg)."; exit 1; }
	@test -n "$(L2_VERIFIER_URL)" || { echo "Error: L2_VERIFIER_URL is not set (L2 explorer verify API)."; exit 1; }
	@echo "Verifying NetizenBridgeL2 on L2 ..."
	@args=$$(cast abi-encode "constructor(address,address,address)" \
		$(WCN) $(L2_MESSENGER) $(NETIZEN_L1_ADDRESS)); \
	cd contracts && forge verify-contract $(BRIDGE_L2_ADDRESS) src/NetizenBridgeL2.sol:NetizenBridgeL2 \
		--verifier $(L2_VERIFIER) --verifier-url $(L2_VERIFIER_URL) \
		$(if $(L2_ETHERSCAN_API_KEY),--etherscan-api-key $(L2_ETHERSCAN_API_KEY),) \
		--constructor-args $$args --watch
	@echo "Verification complete."

.PHONY: verify
verify: verify-l1 verify-l2

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

.PHONY: build-frontend
build-frontend:
	@echo "Building frontend ..."
	cd frontend && npm run build
	@echo "Build complete."

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

.PHONY: help
help:
	@echo "World Computer Netizens Bridge"
	@echo ""
	@echo "Targets:"
	@echo "  build           Build the contracts."
	@echo "  deploy-l1       Deploy NetizenL1 on Ethereum."
	@echo "  deploy-l2       Deploy NetizenBridgeL2 on L2."
	@echo "  wire-l1         Point NetizenL1 at the L2 bridge (one-time)."
	@echo "  verify-l1       Verify NetizenL1 on the L1 explorer (Etherscan)."
	@echo "  verify-l2       Verify NetizenBridgeL2 on the L2 explorer."
	@echo "  verify          Verify both contracts."
	@echo "  build-frontend  Build the frontend."
	@echo "  help            Show this help message."
	@echo ""
	@echo "Workflow:"
	@echo "  1. make deploy-l1   (Ethereum: NetizenL1, l2Bridge unset)"
	@echo "  2. make deploy-l2   (L2:       NetizenBridgeL2, l1Target = NetizenL1)"
	@echo "  3. make wire-l1     (Ethereum: setL2Bridge, locks the wiring)"
	@echo ""
	@echo "Configuration:"
	@echo "  Variables are loaded from .env.maintainer / .env (see .env.example):"
	@echo "    L1_RPC               - Ethereum RPC endpoint (required)."
	@echo "    L2_RPC               - L2 RPC endpoint (required)."
	@echo "    DEPLOYER_KEY         - Deployer key (also NetizenL1 owner for wire-l1)."
	@echo "    OWNER                - NetizenL1 owner (optional; defaults to deployer)."
	@echo "    NETIZEN_L1_SALT      - CreateX vanity salt for NetizenL1 (optional)."
	@echo "    NETIZEN_L1_ADDRESS   - NetizenL1 address (input to deploy-l2 / wire-l1)."
	@echo "    BRIDGE_L2_SALT       - CreateX vanity salt for NetizenBridgeL2 (optional)."
	@echo "    BRIDGE_L2_ADDRESS    - NetizenBridgeL2 address (input to wire-l1 / verify)."
	@echo "    ETHERSCAN_API_KEY    - Etherscan API key (verify-l1)."
	@echo "    L2_VERIFIER          - L2 explorer verifier kind (default: blockscout)."
	@echo "    L2_VERIFIER_URL      - L2 explorer verify API URL (verify-l2)."
	@echo "    L2_ETHERSCAN_API_KEY - L2 explorer API key, if required (verify-l2)."

.DEFAULT_GOAL := help
