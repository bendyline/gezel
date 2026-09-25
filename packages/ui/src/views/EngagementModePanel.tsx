export type EngagementMode = 'proactive' | 'scheduled' | 'reactive' | 'off';
export type WorkshopTempo = 'gezellig' | 'bedrijvig' | 'druk' | 'dolle-boel';

const TEMPOS: {
  id: WorkshopTempo;
  label: string;
  hint: string;
  description: string;
}[] = [
  {
    id: 'gezellig',
    label: 'Gezellig',
    hint: 'cozy',
    description:
      'Meester checks in rarely and warmly. 2-hour rapid cadence, 12-hour slow. Nudges sound like "no rush, let me know."',
  },
  {
    id: 'bedrijvig',
    label: 'Bedrijvig',
    hint: 'busy (default)',
    description:
      'The standard pace. 20-minute rapid cadence, 6-hour slow. Nudges are neutral and structured.',
  },
  {
    id: 'druk',
    label: 'Druk',
    hint: 'pressured',
    description:
      'Short gaps, direct tone. 8-minute rapid cadence, 1-hour slow. Meester expects a blocker-or-status answer.',
  },
  {
    id: 'dolle-boel',
    label: 'Dolle boel',
    hint: 'madhouse',
    description:
      "3-minute rapid cadence, 20-minute slow. Nudges arrive IN CAPS and end with 'this is fine 🔥'.",
  },
];

const ENGAGEMENT_MODES: {
  id: EngagementMode;
  label: string;
  description: string;
}[] = [
  {
    id: 'proactive',
    label: 'Proactive',
    description:
      'Default. All task work, scheduled triggers, proactive prompts, anti-stall nudges, voorman health checks, and cross-gezel messaging run.',
  },
  {
    id: 'scheduled',
    label: 'Tasks + Reactive',
    description:
      'Chat works, all active task work continues, and scheduled tasks still fire. No proactive nudges or cross-gezel messaging between gezellen.',
  },
  {
    id: 'reactive',
    label: 'Reactive only',
    description:
      'AI only responds to your direct chat messages. New task steps and scheduled jobs are paused; an in-flight turn can finish. No proactive nudges or cross-gezel messages.',
  },
  {
    id: 'off',
    label: 'Off',
    description:
      'AI is disabled. Chat is inactive and all background activity is paused. The current in-flight turn finishes; queued messages are canceled.',
  },
];

/**
 * Settings → Your Team → "AI engagement": the global activity switch
 * (`config.aiEngagementMode`) plus, while proactive, the workshop tempo
 * (`config.workshopTempo`) that paces the meester's and voormannen's check-ins.
 */
export function EngagementModePanel({
  mode,
  tempo,
  onChange,
  onTempoChange,
}: {
  mode: EngagementMode;
  tempo: WorkshopTempo;
  onChange: (mode: EngagementMode) => void | Promise<void>;
  onTempoChange: (tempo: WorkshopTempo) => void | Promise<void>;
}) {
  const current =
    ENGAGEMENT_MODES.find((m) => m.id === mode) ??
    (ENGAGEMENT_MODES[0] as (typeof ENGAGEMENT_MODES)[number]);
  const currentTempo = TEMPOS.find((t) => t.id === tempo) ?? (TEMPOS[1] as (typeof TEMPOS)[number]);
  return (
    <section className={`engagement-mode-panel engagement-mode-${mode}`}>
      <h3>AI engagement</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Global control over how much AI activity is allowed. Use this as a panic button when you
        want to conserve tokens or step away from the app.
      </p>
      <div
        className="engagement-mode-switch gz-tray gz-tray--described"
        role="radiogroup"
        aria-label="AI engagement"
      >
        {ENGAGEMENT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={mode === m.id}
            className={`gz-key${mode === m.id ? ' gz-key-active' : ''}`}
            onClick={() => void onChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="engagement-mode-description gz-tray-description">
        <strong>{current.label}</strong> — {current.description}
      </p>
      {mode === 'off' && (
        <div className="engagement-mode-banner" role="alert">
          AI is disabled. The chat composer is inactive and all background activity is paused.
        </div>
      )}
      {mode === 'proactive' && (
        <div className="workshop-tempo">
          <h4 className="workshop-tempo-heading">Tempo</h4>
          <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
            How frenetic the meester and voormannen feel. Adjusts check-in intervals and the tone of
            the meester's nudges.
          </p>
          <div
            className="workshop-tempo-switch gz-tray gz-tray--described"
            role="radiogroup"
            aria-label="Tempo"
          >
            {TEMPOS.map((t) => (
              <button
                key={t.id}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                role="radio"
                aria-checked={tempo === t.id}
                className={`gz-key gz-key--stacked${tempo === t.id ? ' gz-key-active' : ''}`}
                onClick={() => void onTempoChange(t.id)}
                title={t.hint}
              >
                <span className="workshop-tempo-pill-label">{t.label}</span>
                <span className="workshop-tempo-pill-hint">{t.hint}</span>
              </button>
            ))}
          </div>
          <p className="engagement-mode-description gz-tray-description">
            <strong>{currentTempo.label}</strong> — {currentTempo.description}
          </p>
        </div>
      )}
    </section>
  );
}
