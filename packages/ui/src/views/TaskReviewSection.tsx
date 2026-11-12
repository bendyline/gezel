import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback } from 'react';
import { api } from '../api.js';
import { SettingsSection } from '../components/SettingsSection.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';

export type TaskReviewSetting = 'auto' | 'off';

const CHOICES: ReadonlyArray<{ id: TaskReviewSetting; label: string; description: string }> = [
  {
    id: 'auto',
    label: 'Automatic',
    description:
      'Reports, documents and specs get one more look before they are handed in, on models that were tested and did better work with it.',
  },
  {
    id: 'off',
    label: 'Off',
    description: 'Work is handed in as soon as it passes its checks.',
  },
];

function choiceFor(setting: TaskReviewSetting): (typeof CHOICES)[number] {
  return (
    CHOICES.find((choice) => choice.id === setting) ?? (CHOICES[0] as (typeof CHOICES)[number])
  );
}

/**
 * Settings → Artificial intelligence → "Check work before handing it in". A
 * described keys-in-trays radiogroup (docs/ux.md) over `config.taskReview`;
 * the rule it feeds is `resolveOutcomeReview` (core tasks/outcome-review.ts),
 * decided per task at create, so flipping it never disturbs a task already
 * under way.
 */
export function TaskReviewSection(props: {
  value: TaskReviewSetting | undefined;
  onSaved: (config: ConfigResponse) => void;
  setStatus: (status: string) => void;
}) {
  const { value, onSaved, setStatus } = props;
  const save = useCallback(
    async (taskReview: TaskReviewSetting) => {
      setStatus('Saving…');
      try {
        const res = await api.updateConfig({ taskReview });
        onSaved(res);
        const choice = choiceFor(taskReview);
        setStatus(`Checking work before handing it in is ${choice.label}. ${choice.description}`);
      } catch (err) {
        setStatus(`Could not save the setting: ${(err as Error).message}`);
      }
    },
    [onSaved, setStatus],
  );
  const selected = value ?? 'auto';
  const current = choiceFor(selected);
  return (
    <SettingsSection
      id="settings-task-review"
      title="Check work before handing it in"
      hint="Once a task's work passes its checks, the gezel reads it again against your request and fixes what it can show is wrong. It adds a minute or two."
    >
      <div>
        <div
          className="gz-tray gz-tray--described"
          role="radiogroup"
          onKeyDown={onRadioKeyDown}
          aria-label="Check work before handing it in"
        >
          {CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
              role="radio"
              aria-checked={selected === choice.id}
              tabIndex={selected === choice.id ? 0 : -1}
              className={`gz-key${selected === choice.id ? ' gz-key-active' : ''}`}
              onClick={() => void save(choice.id)}
              title={selected === choice.id ? undefined : choice.description}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p className="gz-tray-description" aria-live="polite">
          <strong>{current.label}</strong> — {current.description}
        </p>
      </div>
      <p className="gz-setting-hint">Changing it never disturbs a task already under way.</p>
    </SettingsSection>
  );
}
