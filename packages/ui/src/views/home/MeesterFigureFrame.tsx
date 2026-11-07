import type { ReactNode } from 'react';
import { PersonLabel } from '../../components/PersonLabel.js';

/** The same shelf and label in the live Home and its saved startup view. */
export function MeesterFigureFrame({
  name,
  className,
  children,
}: { name: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `home-workshop-figure ${className}` : 'home-workshop-figure'}>
      {children}
      <div className="home-workshop-shelf" />
      {/* With names hidden the meester is already called "Meester". */}
      <PersonLabel
        variant="stacked"
        name={name}
        roleTitle={name.trim().toLowerCase() === 'meester' ? undefined : 'Meester'}
        className="home-workshop-figure-label"
      />
    </div>
  );
}
