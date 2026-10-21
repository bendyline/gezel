import type { ReactNode } from 'react';

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
      <div className="home-workshop-figure-label">
        {name} <em>- Meester</em>
      </div>
    </div>
  );
}
