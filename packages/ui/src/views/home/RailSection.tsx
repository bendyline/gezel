import type { ReactNode } from 'react';

/**
 * Shared section chrome: an eyebrow label + optional mono hint, then the
 * section's content.
 */
export function RailSection({
  label,
  hint,
  children,
  testId,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Stable hook for e2e screenshots, e.g. `overview-architecture`. */
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      <div className="home-workshop-rail-head">
        <div className="home-workshop-eyebrow" style={{ whiteSpace: 'nowrap' }}>
          {label}
        </div>
        {hint && <div className="home-workshop-rail-hint">{hint}</div>}
      </div>
      {children}
    </section>
  );
}
