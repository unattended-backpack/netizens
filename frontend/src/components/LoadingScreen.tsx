import { SigilLogo } from './SigilLogo';
import './LoadingScreen.css';

type LoadingScreenProps = {
  isLoading: boolean;
};

export function LoadingScreen({ isLoading }: LoadingScreenProps) {
  if (!isLoading) return null;

  return (
    <div
      className="loading-screen"
      role="status"
      aria-busy="true"
      aria-label="Loading application"
    >
      <SigilLogo
        fill="var(--color-gold)"
        className="loading-screen__logo"
      />
    </div>
  );
}
