import type { MeesterStatusReport } from '@bendyline/gezel';
/**
 * The meester-written status headline when a fresh report exists (the
 * parent already applied the staleness decay), falling back to the
 * time-of-day greeting. With a CTA the headline itself is the click
 * target — one big affordance, not a separate link.
 */
export function HomeHeadline({
  statusReport,
  greeting,
  onCtaClick,
}: {
  statusReport: MeesterStatusReport | null;
  greeting: string;
  onCtaClick?: () => void;
}) {
  if (!statusReport) return <h1 className="home-workshop-headline">{greeting}.</h1>;
  if (statusReport.cta && onCtaClick) {
    return (
      <h1 className="home-workshop-headline">
        <button
          type="button"
          className="home-workshop-headline-cta"
          onClick={onCtaClick}
          title={statusReport.cta.label}
        >
          {statusReport.headline}
        </button>
      </h1>
    );
  }
  return <h1 className="home-workshop-headline">{statusReport.headline}</h1>;
}

export function HomeIntroDate({ now = new Date() }: { now?: Date }) {
  const hour = now.getHours();
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const time = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return (
    <div className="home-workshop-eyebrow">
      {weekday} {part} · {time}
    </div>
  );
}
