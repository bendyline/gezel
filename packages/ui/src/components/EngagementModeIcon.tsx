import type { AIEngagementMode } from '@bendyline/gezel';

/** A fixed three-gezel constellation gains connections as independence grows. */
export function EngagementModeIcon({ mode }: { mode: AIEngagementMode }) {
  const working = mode === 'scheduled' || mode === 'proactive';
  return (
    <svg
      className={`app-engagement-mode-icon app-engagement-mode-icon-${mode}`}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {working && <path d="m10.5 8-4 7m7-7 4 7" />}
      {mode === 'proactive' && (
        <>
          <path d="M8 18h8" />
          <path
            d="m20 1.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"
            fill="currentColor"
            stroke="none"
          />
        </>
      )}
      {mode === 'reactive' && <path d="M2 5.5h5m-2-2 2 2-2 2" />}
      <circle cx="12" cy="5.5" r="2.5" fill={mode === 'off' ? 'none' : 'currentColor'} />
      <circle cx="5" cy="18" r="2.5" fill={working ? 'currentColor' : 'none'} />
      <circle cx="19" cy="18" r="2.5" fill={working ? 'currentColor' : 'none'} />
    </svg>
  );
}
