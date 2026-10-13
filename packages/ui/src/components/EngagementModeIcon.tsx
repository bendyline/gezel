import type { AIEngagementMode } from '@bendyline/gezel';

interface BenchFigure {
  cx: number;
  cy: number;
  r: number;
  /** The body showing above the bench, hollowed beneath the head like a turned head set into it. */
  body: string;
}

const LEAD: BenchFigure = {
  cx: 12,
  cy: 6.5,
  r: 2.6,
  body: 'M9.3 13.1 9.79 9.09A3.4 3.4 0 0 0 14.21 9.09L14.7 13.1Z',
};
const LEFT: BenchFigure = {
  cx: 4.3,
  cy: 8.45,
  r: 2.25,
  body: 'M1.95 13.1 2.3 10.76A3.05 3.05 0 0 0 6.3 10.76L6.65 13.1Z',
};
const RIGHT: BenchFigure = {
  cx: 20,
  cy: 8.45,
  r: 2.25,
  body: 'M17.65 13.1 18 10.76A3.05 3.05 0 0 0 22 10.76L22.35 13.1Z',
};

// H-frame legs keep it a workbench; a plain table read as a desk or a meeting table.
const BENCH =
  'M1.6 13.9h20.8a.6.6 0 0 1 .6.6v1.2a.6.6 0 0 1-.6.6H1.6a.6.6 0 0 1-.6-.6v-1.2a.6.6 0 0 1 .6-.6Z' +
  'M3 16h2v5.6a.4.4 0 0 1-.4.4h-1.2a.4.4 0 0 1-.4-.4Z' +
  'M19 16h2v5.6a.4.4 0 0 1-.4.4h-1.2a.4.4 0 0 1-.4-.4Z' +
  'M4.5 19h15v1.4h-15Z';

// Flat face and rounded peen, drawn with the handle entering at the origin. A
// symmetric mallet raised behind a bench reads as a gavel; a hooked claw tilted
// over a neighbour reads as an axe.
const HAMMER_HEAD =
  'M-2.4 -2.4Q-2.4 -2.6 -2.2 -2.6H0.4L2 -2.25Q2.5 -2.15 2.5 -1.65V-1.15Q2.5 -0.65 2 -0.55L0.4 -0.2H-2.2Q-2.4 -0.2 -2.4 -0.4Z';

/**
 * The crew at the workbench: the bench empty with its hammer down, the lead
 * alone, the whole crew, then the lead raising the hammer unasked.
 */
export function EngagementModeIcon({ mode }: { mode: AIEngagementMode }) {
  const crew = mode === 'off' ? [] : mode === 'reactive' ? [LEAD] : [LEFT, LEAD, RIGHT];
  return (
    <svg
      className={`app-engagement-mode-icon app-engagement-mode-icon-${mode}`}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {crew.map((figure) => (
        <g key={figure.cx} stroke="none">
          <circle cx={figure.cx} cy={figure.cy} r={figure.r} />
          <path d={figure.body} />
        </g>
      ))}
      {mode === 'proactive' && (
        <>
          <path d="M13.6 11.4h2.2" fill="none" />
          <rect x="14.9" y="10.3" width="2.4" height="2.2" rx=".9" stroke="none" />
          <path d="M16.1 8.95V4.1" fill="none" />
          <path d={HAMMER_HEAD} transform="translate(16.1 3.9)" stroke="none" />
        </>
      )}
      {mode === 'off' && (
        <>
          <path d="m9.5 11.06 6 1.3" fill="none" />
          <path
            d={HAMMER_HEAD}
            transform="translate(9.5 11.06) rotate(-90) scale(.85)"
            stroke="none"
          />
        </>
      )}
      <path d={BENCH} stroke="none" />
    </svg>
  );
}
