import { useEffect, useState } from 'react'
import { useAccount, useConnect, useDisconnect, useEnsName } from 'wagmi'
import { useSoundEffects } from '../hooks/useSoundEffects'
import './ConnectButton.css'

const shortenAddress = (address: string) => {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function ConnectButton() {
  const { address, isConnected, isConnecting } = useAccount()
  const { connectors, connect } = useConnect()
  const { disconnect } = useDisconnect()
  const { playClickSound } = useSoundEffects()
  const [showModal, setShowModal] = useState(false)
  const [showAccountMenu, setShowAccountMenu] = useState(false)

  const { data: ensName } = useEnsName({ address })

  const injectedConnector = connectors.find((c) => c.id === 'injected')

  // Escape key handling for account menu
  useEffect(() => {
    if (!showAccountMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAccountMenu(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showAccountMenu]);

  // Escape key handling for connect modal
  useEffect(() => {
    if (!showModal) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowModal(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showModal]);

  const handleConnect = (connector: typeof connectors[number]) => {
    connect({ connector })
    setShowModal(false)
    playClickSound()
  }

  const handleDisconnect = () => {
    disconnect()
    setShowAccountMenu(false)
    playClickSound()
  }

  if (isConnecting) {
    return (
      <button className="connect-button connect-button--connecting" disabled>
        Connecting...
      </button>
    )
  }

  if (isConnected && address) {
    const displayName = ensName || shortenAddress(address)

    return (
      <div className="connect-button-wrapper">
        <button
          className="connect-button connect-button--connected"
          onClick={() => { setShowAccountMenu(!showAccountMenu); playClickSound(); }}
          aria-expanded={showAccountMenu}
          aria-haspopup="menu"
        >
          <span className="connect-button__address">{displayName}</span>
        </button>

        {showAccountMenu && (
          <>
            <div
              className="connect-button__overlay"
              onClick={() => setShowAccountMenu(false)}
              aria-hidden="true"
            />
            <div className="connect-button__menu" role="menu">
              <div className="connect-button__menu-address">
                {ensName && (
                  <span className="connect-button__menu-ens">{ensName}</span>
                )}
                <span className="connect-button__menu-hex">{shortenAddress(address)}</span>
              </div>
              <button
                className="connect-button__menu-item connect-button__menu-item--disconnect"
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="connect-button-wrapper">
      <button
        className="connect-button"
        onClick={() => { setShowModal(true); playClickSound(); }}
      >
        Connect Wallet
      </button>

      {showModal && (
        <>
          <div
            className="connect-modal__overlay"
            onClick={() => setShowModal(false)}
            aria-hidden="true"
          />
          <div
            className="connect-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-modal-title"
          >
            <h2 id="connect-modal-title" className="visually-hidden">Connect Wallet</h2>
            {/* <div className="connect-modal__header">
              <h3 className="connect-modal__title">Connect Wallet</h3>
              <button
                className="connect-modal__close"
                onClick={() => setShowModal(false)}
              >
                &times;
              </button>
            </div> */}
            <div className="connect-modal__options">
              {injectedConnector && (
                <button
                  className="connect-modal__option"
                  onClick={() => handleConnect(injectedConnector)}
                >
                  <span className="connect-modal__option-name">Browser Wallet</span>
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
