# World Computer Netizens — MegaETH → Ethereum NFT bridge

Trustlessly move **World Computer Netizens (WCN)** NFTs off MegaETH and onto
Ethereum L1 over the **canonical (OP-Stack) bridge** — no third-party custodian or
oracle. A holder approves the L2 bridge, burns their NFT(s) on MegaETH, and a
cross-domain message mints the *same* tokenIds against a known contract on Ethereum.

## How it works

```
MegaETH (L2)                                   Ethereum (L1)
─────────────                                  ─────────────
holder.approve(NetizenBridgeL2)
holder.bridge([ids], l1Recipient)
  • require ownerOf(id) == msg.sender          (anti-griefing)
  • WCN.burn(id)                               (irreversible)
  • L2CrossDomainMessenger.sendMessage(
        NetizenL1, finalizeBridge(to, ids))
                 │
                 ▼  (MessagePassed → OptimismPortal2 withdrawal)
        prove + finalize  ───────────────────► L1CrossDomainMessenger.relayMessage
        (relay-nft.mjs, after the                 • NetizenL1.finalizeBridge(to, ids)
         Kailua challenge window)                   - require msg.sender == L1CDM
                                                     - require xDomainMessageSender == NetizenBridgeL2
                                                     - for id: if !exists → _mint(to, id)
```

**Timing:** burn→mint is *not* instant. Because it's an L2→L1 message it rides the
fault-proof path — a state root covering your bridge tx must be proposed and clear
the Kailua challenge window, then the portal enforces a proof-maturity delay. The
`scripts/relay-nft.mjs` helper drives the prove + finalize.

## On-chain addresses (verified)

| Role | Address | Chain |
|---|---|---|
| WCN NFT (EIP-1167 clone → impl `0xaf8f…6a75`) | `0x3fD43a658915A7Ce5ae0A2E48f72B9fCE7bA0C44` | MegaETH (4326) |
| L2CrossDomainMessenger (predeploy) | `0x4200000000000000000000000000000000000007` | MegaETH |
| L1CrossDomainMessenger | `0x6C7198250087B29A8040eC63903Bc130f4831Cc9` | Ethereum |
| OptimismPortal2 | `0x7f82f57F0Dd546519324392e408b01fcC7D709e8` | Ethereum |
| DisputeGameFactory (Kailua, gameType 1337) | `0x8546840adF796875cD9AAcc5B3B048f6B2c9D563` | Ethereum |

## Contracts

Foundry project under `contracts/`, dependency-managed with **Soldeer** (no npm):
**Solady** (ERC721, Ownable, ReentrancyGuard, LibString) + forge-std. Run `forge`
from `contracts/` (or `forge --root contracts ...`).

- **`contracts/src/NetizenBridgeL2.sol`** — deployed on MegaETH. `bridge(tokenIds, l1Recipient)`
  (and a `bridge(tokenIds)` overload defaulting to the caller), both **payable**.
  Burns each token (caller must own it and have approved the bridge), then sends one
  cross-domain message with a batch-sized gas budget — and any `msg.value` rides that
  same message. `ReentrancyGuard`; **ownerless** (no admin functions, nothing to pause)
  and non-upgradeable. `MAX_BATCH = 400` (fits the 380-max holder in one batch).
- **`contracts/src/NetizenL1.sol`** — deployed on Ethereum; the "known L1 address".
  Solady ERC721 mirroring WCN (`name`/`symbol`/`tokenURI` via the origin's immutable
  IPFS CID, `maxSupply` 4520) + Solady `Ownable` (for `setL2Bridge`/`setBaseURI`).
  `finalizeBridge` (payable) is callable only through the canonical messenger with the
  trusted L2 bridge as cross-domain sender. **No public/owner mint** — supply is purely
  a function of verified L2 burns.

### Bridging ETH alongside the NFTs

`bridge()` is payable: the ETH a user sends rides the **same** cross-domain message
as the NFTs, so it's one withdrawal and **one** prove+finalize (no second
withdrawal). On L1 the portal releases that ETH to `NetizenL1.finalizeBridge`, which
force-delivers it to `l1Recipient` **after** minting via Solady's
`SafeTransferLib.forceSafeTransferETH` — even a hostile contract recipient cannot
reject it, so the ETH transfer can never revert or brick the mints.
Via the forced-inclusion path, deposit L2-gas is prepaid, so a user can sweep their
**entire** L2 ETH balance (`deposit-exit.mjs` defaults to the full balance).

### Key safety properties

- **Idempotent finalize (skip-if-exists, `_mint` not `_safeMint`).** A duplicate or
  replayed tokenId is skipped, never reverted, and a recipient contract's
  `onERC721Received` can't revert/reenter. Since L2 burns are irreversible, this
  prevents one bad id from bricking — and losing — a whole relayed batch.
- **Dual cross-domain auth.** `finalizeBridge` requires both `msg.sender ==
  L1CrossDomainMessenger` and `xDomainMessageSender == NetizenBridgeL2`.
- **Anti-griefing.** L2 requires `ownerOf(id) == msg.sender`, so a `setApprovalForAll`
  approval can't be used by anyone else to burn your tokens.
- **Recoverable relay.** If the inner L1 mint ever runs out of gas it lands in the
  messenger's `failedMessages` and can be re-relayed with more gas — not lost.

## Deploy

Configuration lives in `.env.maintainer` (public defaults, committed) and `.env`
(secrets / local overrides, gitignored); the `Makefile` loads both. Copy
`.env.example` to `.env` and fill in `DEPLOYER_KEY`, `L1_RPC`, `L2_RPC` — and, for
verification, `ETHERSCAN_API_KEY` / `L2_VERIFIER_URL`. First time, fetch deps with
`cd contracts && forge soldeer install` (or `make build`).

```bash
make deploy-l1     # 1) Ethereum: deploy the L1 mirror (logs its address)
                   #    → set NETIZEN_L1_ADDRESS=0x<NetizenL1> in .env
make deploy-l2     # 2) MegaETH: deploy the ownerless bridge pointing at NetizenL1
                   #    → set BRIDGE_L2_ADDRESS=0x<NetizenBridgeL2> in .env
make wire-l1       # 3) Ethereum: bind the L2 bridge on L1 (one-time; self-verifies on-chain)
make verify        # 4) verify both contracts on their explorers
```

`OWNER` (L1 only) defaults to the deployer. For deterministic, frontrun-resistant
vanity addresses, set `NETIZEN_L1_SALT` / `BRIDGE_L2_SALT` to deployer-permissioned
CreateX salts (first 20 bytes == deployer); omit them for a plain CREATE deploy.
`NetizenBridgeL2` is ownerless; consider transferring `NetizenL1`'s owner to a multisig.

## Bridge a token (user)

1. On MegaETH: `WCN.approve(NetizenBridgeL2, tokenId)` (or `setApprovalForAll`).
2. On MegaETH: `NetizenBridgeL2.bridge([tokenId], l1Recipient)`. The NFT is burned.
3. Relay to L1 once the challenge window has elapsed:

   ```bash
   DEPLOYER_KEY=0x... L1_RPC=https://... L2_RPC=https://mainnet.megaeth.com/rpc \
   BRIDGE_TX_HASH=0x<the bridge() tx hash on MegaETH> \
     node scripts/relay-nft.mjs
   ```

   `relay-nft.mjs` proves + finalizes the message; finalizing executes the mint on
   `NetizenL1`. Anyone can run the relay — it just pays L1 gas.

## Test

```bash
cd contracts && forge test -vv      # Soldeer deps: forge soldeer install (first time)
```

Unit tests cover burn+message, auth, anti-griefing, batch limits, ETH forwarding
(forced delivery), skip-if-exists idempotency, and tokenURI/metadata
parity. `test/ForkIntegration.t.sol` adds:
- `test_GasMeasurement_FinalizeBridge` — measures real per-token mint gas (no RPC
  needed). Latest (Solady): **~26.4k gas/token** marginal, so `PER_TOKEN_GAS=38k` is
  ~1.4× and `MAX_BATCH=400` fits under Osaka's ~16.78M per-tx cap (baseGas(380)≈15.4M).
- `test_ForkE2E_BridgeAndRelay` / `test_ForkE2E_SpecificHolder` — full bridge→relay→mint
  on real forked state (the relay is shortcut via the messenger); the specific-holder
  variant also asserts the on-chain withdrawal gasLimit fits the Osaka cap.
- `test_ForkE2E_RealProveFinalize` — the **most faithful** local test: runs the **real**
  `OptimismPortal2.proveWithdrawalTransaction` + `finalizeWithdrawalTransaction` on a
  forked L1 (real Merkle-proof verification, real `L1CrossDomainMessenger.relayMessage`,
  real `finalizeBridge`), fast-forwarding the 7d+3.5d dispute/proof delays with `vm.warp`.
  Only the dispute game (a `MockDisputeGame` injected via `vm.mockCall` on the factory)
  and the L2 state commitment (a synthetic single-leaf storage proof) are faked.

  All require `L1_FORK_RPC` + `L2_FORK_RPC`, otherwise skipped:
  ```bash
  cd contracts && L1_FORK_RPC=https://eth-rpc L2_FORK_RPC=https://mainnet.megaeth.com/rpc \
    forge test --mt test_ForkE2E -vv
  ```

## Local testing harness (localnet)

Two anvil forks (Ethereum L1 + MegaETH L2) with the contracts deployed, plus a
relayer that **simulates** OP's off-chain derivation/proof so the whole flow runs
locally with a fast-forward instead of the real ~12h inclusion + challenge windows.
The contracts don't gate on time, so "fast-forward" just means the relayer relays now.

The operational scripts live in `scripts/`; run them from the repo root (`localnet.sh`
`cd`s there itself). It writes two gitignored runtime files at the root: `.localnet.pids`
(the two anvil PIDs, used by `down`) and `deployments.local.json` (the freshly-deployed
localnet addresses + RPC URLs, consumed by the relayer, fixtures, and the frontend env).

```bash
L1_FORK_RPC=https://your-eth-rpc ./scripts/localnet.sh up   # boot forks, deploy, wire, seed NFTs
node scripts/localnet-relayer.mjs                           # derivation/proof simulator
# point the frontend at the two RPCs + deployments.local.json, then:
curl -X POST http://127.0.0.1:8547/fast-forward             # flush pending messages
./scripts/localnet.sh down                                  # stop
```

How the relayer fakes the off-chain parts (all via anvil cheats, contracts stay real):
- **Deposits L1→L2:** watches the real `OptimismPortal.TransactionDeposited`, decodes
  `(from,to,data)`, and replays on L2 as `from` via `anvil_impersonateAccount`
  (unaliased, exactly like real derivation of an EOA deposit).
- **Withdrawals L2→L1:** watches `L2CrossDomainMessenger.SentMessage` and relays
  through the **real** `L1CrossDomainMessenger.relayMessage` by impersonating the
  portal and pinning its `l2Sender` slot — skipping only the fault-proof gating.
- Per-message delays (`DEPOSIT_DELAY_MS`/`WITHDRAW_DELAY_MS`) + `POST /fast-forward`.

`setup-fixtures.mjs` seeds a known test EOA (anvil account #0) with real WCN tokenIds
on the L2 fork and funds it on both — import that key into the frontend wallet.
`deposit-exit.mjs` works unchanged against the L1 fork (it calls the real portal).

## Security notes

- `relay-nft.mjs` and the deploy scripts read the signer key from `DEPLOYER_KEY`;
  nothing is hardcoded. Keep it in `.env` (gitignored); never commit a private key.
- The bridge is one-directional (MegaETH → Ethereum) by design.
