import { HAMMER_HEAD } from './EngagementModeIcon.js';

export function workChunksLabel(count: number): string {
  return `The model has sent ${count} chunk${count === 1 ? '' : 's'} of work since its last visible words. It's busy, not stuck.`;
}

/**
 * The live bubble's tally of engine chunks that carried nothing visible
 * (keepalives, bare framing, streamed tool arguments): the crew's hammer
 * with the count as its exponent. It reads as "work landed" where a bare
 * "(4)" read as a footnote.
 */
export function WorkChunksCount({ count }: { count: number }) {
  const label = workChunksLabel(count);
  return (
    <span className="msg-work-chunks" role="img" aria-label={label} title={label}>
      <svg
        className="msg-work-chunks-hammer"
        viewBox="-7.6 -6.6 15 15"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <g transform="rotate(-45)">
          <path
            d="M0 -0.3V7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path d={HAMMER_HEAD} transform="scale(-2 2)" />
        </g>
      </svg>
      <sup className="msg-work-chunks-count">{count}</sup>
    </span>
  );
}
