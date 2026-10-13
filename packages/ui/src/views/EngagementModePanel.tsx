import type { AIEngagementMode } from '@bendyline/gezel';
import { EngagementModeIcon } from '../components/EngagementModeIcon.js';
import { ENGAGEMENT_MODES } from '../components/engagement-modes.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
export type EngagementMode = AIEngagementMode;
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
    ENGAGEMENT_MODES.find((m) => m.mode === mode) ??
    (ENGAGEMENT_MODES[0] as (typeof ENGAGEMENT_MODES)[number]);
  const currentTempo = TEMPOS.find((t) => t.id === tempo) ?? (TEMPOS[1] as (typeof TEMPOS)[number]);
  return (
    <section className={`engagement-mode-panel engagement-mode-${mode}`}>
      <h3>AI engagement</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Choose how independently your crew works, from taking initiative together to waiting for
        your messages or pausing entirely.
      </p>
      <div
        className="engagement-mode-switch gz-tray gz-tray--described"
        role="radiogroup"
        onKeyDown={onRadioKeyDown}
        aria-label="AI engagement"
      >
        {ENGAGEMENT_MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={mode === m.mode}
            tabIndex={mode === m.mode ? 0 : -1}
            className={`gz-key${mode === m.mode ? ' gz-key-active' : ''}`}
            onClick={() => void onChange(m.mode)}
          >
            <EngagementModeIcon mode={m.mode} />
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
            onKeyDown={onRadioKeyDown}
            aria-label="Tempo"
          >
            {TEMPOS.map((t) => (
              <button
                key={t.id}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                role="radio"
                aria-checked={tempo === t.id}
                tabIndex={tempo === t.id ? 0 : -1}
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
