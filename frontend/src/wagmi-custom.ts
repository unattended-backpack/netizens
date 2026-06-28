import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { L1_RPC_URL, l1Chain } from './constants/bridge'

// L1 chain comes from constants/bridge: real mainnet, or the localnet anvil fork at a
// dev chainId (VITE_L1_CHAIN_ID) so a wallet can add it as a custom network.
export const config = createConfig({
  chains: [l1Chain],
  connectors: [
    injected(),
  ],
  transports: {
    [l1Chain.id]: http(L1_RPC_URL, { batch: { wait: 16 } }),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
