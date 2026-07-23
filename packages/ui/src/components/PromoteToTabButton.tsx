import { useCallback } from 'react';
import type { RecentTabInput } from './recent-tabs.js';

interface PromoteToTabButtonProps {
  /**
   * The entity to promote. Mirrors the `gezel:open-tab` event payload —
   * project / gezel / document / task. Area tabs are not promotable
   * (they're already the top-level shell).
   */
  target: RecentTabInput;
  /**
   * Tooltip override. Default: "Open in own tab".
   */
  title?: string;
}

/**
 * Small icon button that hoists the current entity into its own
 * top-level tab. Lives on the right edge of an entity detail view's
 * inner tab row (visually under the hamburger). Idempotent —
 * `activateTab` collapses duplicates by key, so clicking from a view
 * that's already a top-level tab just re-activates the existing one.
 */
export function PromoteToTabButton({ target, title = 'Open in own tab' }: PromoteToTabButtonProps) {
  const onClick = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', {
        detail: { ...target, activate: true },
      }),
    );
  }, [target]);

  return (
    <button
      type="button"
      className="promote-to-tab-btn"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {/* Arch (∩) with an arrow rising up through its top — reads as
          "lift this out of its parent and into its own tab." Hand-rolled
          so we don't pull an icon dep just for this affordance. */}
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        {/* Tab/arch silhouette, open at the bottom. */}
        <path
          d="M2.5 14 V7.5 Q2.5 5 5 5 H11 Q13.5 5 13.5 7.5 V14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Upward arrow piercing through the top of the arch. */}
        <path
          d="M8 11 V1 M5 4 L8 1 L11 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
