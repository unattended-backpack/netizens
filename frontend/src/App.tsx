import { ConnectButton } from './components/ConnectButton';
import { Bridge } from './components/Bridge';
import { SigilLogo } from './components/SigilLogo';
import { FastForwardButton } from './components/FastForwardButton';
import {
  L1_EXPLORER,
  L2_EXPLORER,
  NETIZEN_L1_ADDRESS,
  BRIDGE_L2_ADDRESS,
} from './constants/bridge';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** A contract name linked to its explorer, or plain text until it can resolve. */
function ContractLink({ label, explorer, address }: { label: string; explorer: string; address: string }) {
  if (!explorer || address === ZERO_ADDRESS) return <>{label}</>;
  return (
    <a href={`${explorer}/address/${address}`} target="_blank" rel="noopener noreferrer">{label}</a>
  );
}

function App() {
  return (
    <>
      <SigilLogo fill="var(--color-red)" className="background-logo" />
      <main className="app-content">
        <header className="app-content__header">
          <div className="app-content__brand">
            <a href="https://sigil.box" target="_blank" rel="noopener noreferrer">
              <SigilLogo fill="var(--color-gold)" className="app-content__logo" />
            </a>
            <span className="app-content__title">NETIZENS COME HOME</span>
          </div>
          <div className="app-content__actions">
            <FastForwardButton />
            <ConnectButton />
          </div>
        </header>

        <div className="app-content__row">
          <article className="app-content__section">
            Bring your World Computer Netizens and Ether home from the perfidious rabbitchain to Ethereum, the real World Computer. This application broadcasts everything using the canonical bridge to avoid giving any gas fees to the trustful L2. Netizens burn on L2 and mint on Ethereum; the full trip takes over a week (the challenge window), so this page remembers where each of your Netizens is and tells you exactly when to prove and finalize. The contracts are public and verifiable: <ContractLink label="NetizenL1" explorer={L1_EXPLORER} address={NETIZEN_L1_ADDRESS} /> on L1 and <ContractLink label="NetizenBridgeL2" explorer={L2_EXPLORER} address={BRIDGE_L2_ADDRESS} /> on L2.
          </article>
        </div>

        <div className="app-content__row">
          <article className="app-content__section" style={{ flex: 1 }}>
            <Bridge />
          </article>
        </div>
      </main>
    </>
  );
}

export default App;
