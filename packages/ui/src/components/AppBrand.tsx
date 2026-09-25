import type { CSSProperties } from 'react';
import logotypeUrl from '../assets/gezellogotype.png';

export function AppBrand({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`app-header-brand${active ? ' active' : ''}`}
      onClick={onClick}
      title="Meester"
      aria-label="Meester home"
    >
      <span
        className="app-nav-home-logotype"
        role="img"
        aria-label="gezel"
        style={{ ['--gezel-logo-url' as string]: `url(${logotypeUrl})` } as CSSProperties}
      />
    </button>
  );
}
