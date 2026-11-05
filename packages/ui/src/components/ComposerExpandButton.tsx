/** Chevrons pushing apart — the composer is about to take the window. */
function ExpandComposerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5 6.4 8 3.4l3 3M11 9.6l-3 3-3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The same chevrons closing back toward the bottom strip. */
function CollapseComposerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5 3.4l3 3 3-3M11 12.6l-3-3-3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The compose frame's size key. Chat's To line and the terminal's toolbar
 * both carry it, immediately before the compose-mode tabs, so the key to give
 * the room back sits on the same pixels whichever mode is up.
 */
export function ComposerExpandButton({
  expanded,
  onToggle,
  what,
  testId,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** What takes the window, for the label: "draft" in chat, "terminal" in terminal mode. */
  what: string;
  testId: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className ? `chat-composer-expand-btn ${className}` : 'chat-composer-expand-btn'}
      data-testid={testId}
      onClick={onToggle}
      aria-pressed={expanded}
      aria-label={expanded ? `Collapse the ${what}` : `Expand the ${what}`}
      title={
        expanded
          ? `Collapse the ${what} back to a few lines`
          : `Expand the ${what} to fill the chat window`
      }
    >
      {expanded ? <CollapseComposerIcon /> : <ExpandComposerIcon />}
    </button>
  );
}
