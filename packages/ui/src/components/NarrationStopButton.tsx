import { useEffect, useState, useSyncExternalStore } from 'react';
import { useHeaderDensity } from './header-density.js';
import { chatNarrationQueue } from './narration-queue.js';

/**
 * How long the key outlives the voice. The queue is briefly idle between two
 * sentences of a streaming reply and while a turn starts its next tool call;
 * without this the key would blink in and out of the titlebar, shoving the
 * pills beside it each time.
 */
const LINGER_MS = 1_200;

/**
 * The titlebar's stop key for chat narration, present only while a gezel is
 * being read aloud. It stops the voice and the rest of that turn; the next
 * turn is narrated as usual, and turning narration off stays in Settings.
 */
export function NarrationStopButton() {
  const active = useSyncExternalStore(
    chatNarrationQueue.subscribe,
    () => chatNarrationQueue.active,
  );
  const [shown, setShown] = useState(active);
  const density = useHeaderDensity();

  useEffect(() => {
    if (active) {
      setShown(true);
      return;
    }
    const timer = window.setTimeout(() => setShown(false), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!shown) return null;
  return (
    <button
      type="button"
      className="narration-stop"
      data-speaking={active ? 'true' : 'false'}
      onClick={() => {
        chatNarrationQueue.stop();
        setShown(false);
      }}
      title="Stop narration"
      aria-label="Stop narration"
    >
      <SpeakingGlyph />
      {density === 'full' && <span className="narration-stop-label">Stop narration</span>}
    </button>
  );
}

function SpeakingGlyph() {
  return (
    <svg
      className="narration-stop-icon"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 7.75h2.75L10 4.5v11l-3.75-3.25H3.5z" />
      <path
        className="narration-stop-wave narration-stop-wave-near"
        d="M12.75 7.6a3.4 3.4 0 0 1 0 4.8"
      />
      <path
        className="narration-stop-wave narration-stop-wave-far"
        d="M14.9 5.5a6.4 6.4 0 0 1 0 9"
      />
    </svg>
  );
}
