import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback } from 'react';
import { api } from '../api.js';

export type GeneralistModeSetting = 'auto' | 'on' | 'off';

const CHOICES: ReadonlyArray<{ id: GeneralistModeSetting; label: string; title: string }> = [
  { id: 'auto', label: 'Automatic', title: 'On for cloud providers, off for on-device models.' },
  {
    id: 'on',
    label: 'On',
    title: 'Every task runs as one gezel in one conversation, whatever the model.',
  },
  {
    id: 'off',
    label: 'Off',
    title: 'Every task runs stepwise: a specialist per step, a fresh conversation per hand-off.',
  },
];

/**
 * Settings → Artificial Intelligence → "Run in generalist mode". A keys-in-
 * trays radiogroup (docs/ux.md) over `config.generalistMode`; the semantics
 * live in docs/generalist-mode.md. The choice is resolved per task at create,
 * so flipping it never disturbs a task already under way.
 */
export function GeneralistModeSection(props: {
  value: GeneralistModeSetting | undefined;
  onSaved: (config: ConfigResponse) => void;
  setStatus: (status: string) => void;
}) {
  const { value, onSaved, setStatus } = props;
  const save = useCallback(
    async (generalistMode: GeneralistModeSetting) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({ generalistMode });
        onSaved(res);
        setStatus(
          generalistMode === 'auto'
            ? 'generalist mode: automatic'
            : generalistMode === 'on'
              ? 'generalist mode ON — one gezel carries each task end to end'
              : 'generalist mode OFF — a specialist per step',
        );
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [onSaved, setStatus],
  );
  const selected = value ?? 'auto';
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h3>Run in generalist mode</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        One gezel carries a task from first step to last in a single conversation, still passing
        every step's checks. Automatic turns it on for cloud providers such as Claude, ChatGPT and
        Copilot, and off for models running on this device. Changing it never disturbs a task
        already under way.
      </p>
      <div
        className="gz-tray gz-tray--described"
        role="radiogroup"
        aria-label="Run in generalist mode"
      >
        {CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
            role="radio"
            aria-checked={selected === choice.id}
            className={`gz-key${selected === choice.id ? ' gz-key-active' : ''}`}
            onClick={() => void save(choice.id)}
            title={choice.title}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </section>
  );
}
