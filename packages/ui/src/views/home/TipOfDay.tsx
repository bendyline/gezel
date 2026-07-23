import { type ReactNode, useState } from 'react';
import { SproutGlyph } from './glyphs.js';
import type { HomeNavView } from './utils.js';

/**
 * Tip of the day — a gentle nudge to tend/grow your crew. Static pool for
 * v1; the inline action link routes into the relevant flow. `↻` cycles.
 */
const TIPS: ReadonlyArray<{ body: ReactNode; action: string; view: HomeNavView }> = [
  {
    body: (
      <>
        Most of getting great work out of a gezel is shaping its brief. Trim a gezel&rsquo;s
        standing orders and it&rsquo;ll stop over-explaining.
      </>
    ),
    action: 'Train a gezel',
    view: 'gezels',
  },
  {
    body: (
      <>
        Teach a gezel once and it sticks &mdash; stamp today&rsquo;s steps into a routine it can run
        on its own.
      </>
    ),
    action: 'Save a routine',
    view: 'scripts',
  },
  {
    body: (
      <>
        Your crew can grow with your work. A second specialist lets the first stay deep on one
        project.
      </>
    ),
    action: 'Hire a gezel',
    view: 'gezels',
  },
  {
    body: (
      <>
        Local models come first &mdash; cloud and the web are opt-in and <em>always marked</em>.
        Adjust your providers any time.
      </>
    ),
    action: 'Open settings',
    view: 'settings',
  },
  {
    body: (
      <>
        Hand the meester a half-baked idea and they&rsquo;ll shape it into something your crew can
        actually start on.
      </>
    ),
    action: 'See your projects',
    view: 'projects',
  },
];

export function TipOfDay({ onNavigate }: { onNavigate?: (view: HomeNavView) => void }) {
  const [i, setI] = useState(0);
  const tip = TIPS[i % TIPS.length]!;
  return (
    <div className="home-workshop-tip">
      <span className="home-workshop-tip-sprout">
        <SproutGlyph size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="home-workshop-tip-label-row">
          <span className="home-workshop-eyebrow home-workshop-tip-label">Tip of the day</span>
          <button
            type="button"
            className="home-workshop-tip-cycle"
            title="Another tip"
            aria-label="Show another tip"
            onClick={() => setI((v) => v + 1)}
          >
            ↻
          </button>
        </div>
        <div className="home-workshop-tip-body">
          {tip.body}{' '}
          <button
            type="button"
            className="home-workshop-tip-action"
            onClick={() => onNavigate?.(tip.view)}
          >
            {tip.action} →
          </button>
        </div>
      </div>
    </div>
  );
}
