import type { ConfigResponse } from '@bendyline/gezel-client';
import { Suspense, lazy } from 'react';
import {
  SettingCheck,
  SettingField,
  SettingsSection,
  settingHintId,
} from '../components/SettingsSection.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';

const loadRelevanceModelModule = () => import('../components/RelevanceModelCard.js');

const RelevanceModelCard = lazy(() =>
  loadRelevanceModelModule().then(({ RelevanceModelCard }) => ({ default: RelevanceModelCard })),
);

interface MemorySectionProps {
  config: ConfigResponse | null;
  onRetrievalChange: (
    patch: Omit<Partial<NonNullable<ConfigResponse['retrieval']>>, 'maxTokens'> & {
      maxTokens?: number | null;
    },
  ) => Promise<void>;
  onTaskReferencesChange: (enabled: boolean) => Promise<void>;
  onSummarizationChange: (
    patch: Partial<NonNullable<ConfigResponse['summarization']>>,
  ) => Promise<void>;
}

export function MemorySection({
  config,
  onRetrievalChange,
  onTaskReferencesChange,
  onSummarizationChange,
}: MemorySectionProps) {
  const retrievalMode =
    config?.retrieval?.mode ?? (config?.autoRecall?.enabled === false ? 'off' : 'balanced');
  const summarizeEnabled = config?.summarization?.enabled !== false;
  const retrievalBudget = config?.retrieval?.maxTokens;
  const minUserTurns = config?.summarization?.minUserTurns ?? 2;
  const idleHours = config?.summarization?.idleHours ?? 24;
  return (
    <SettingsSection
      id="settings-project-knowledge"
      title="Project knowledge & memory"
      hint="Ground relevant turns in indexed project files, artifacts, memories, and shared documents. Finished threads can also be distilled into project memory for future work."
    >
      <SettingField
        label="Indexed context per turn"
        hint={
          <>
            Higher settings provide more direct evidence. Lower settings preserve context space on
            memory-constrained models. Gezel can still call <code>search</code> when this is Off.
          </>
        }
      >
        <div
          className="gz-tray"
          role="radiogroup"
          onKeyDown={onRadioKeyDown}
          aria-label="Indexed context per turn"
        >
          {(['off', 'lean', 'balanced', 'deep'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
              role="radio"
              aria-checked={retrievalMode === mode}
              tabIndex={retrievalMode === mode ? 0 : -1}
              className={`gz-key${retrievalMode === mode ? ' gz-key-active' : ''}`}
              onClick={() => void onRetrievalChange({ mode })}
            >
              {mode[0]!.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
      </SettingField>

      <SettingField
        label="Optional token cap"
        controlId="settings-retrieval-token-cap"
        hint="Leave it empty to use the mode's own budget."
      >
        <div className="gz-setting-inline">
          <input
            id="settings-retrieval-token-cap"
            type="number"
            min={0}
            max={16000}
            aria-describedby={settingHintId('settings-retrieval-token-cap')}
            value={retrievalBudget ?? ''}
            placeholder="Mode default"
            onChange={(e) => {
              if (e.target.value === '') {
                void onRetrievalChange({ maxTokens: null });
                return;
              }
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 0) void onRetrievalChange({ maxTokens: v });
            }}
            disabled={retrievalMode === 'off'}
          />
          <span>tokens</span>
        </div>
      </SettingField>

      <Suspense fallback={null}>
        <RelevanceModelCard />
      </Suspense>

      <SettingCheck
        label="Look up references when a task starts"
        hint="A task started from a request searches your knowledge catalogs and shared documents for its subject once, and gives every step what it found."
        checked={config?.taskReferences?.enabled !== false}
        onChange={(checked) => void onTaskReferencesChange(checked)}
      />

      <SettingCheck
        label="Summarize threads into project memory"
        hint="Runs when a thread is archived, and on an hourly sweep for any thread that's been idle past the threshold. Short threads are skipped."
        checked={summarizeEnabled}
        onChange={(checked) => void onSummarizationChange({ enabled: checked })}
      />
      <SettingField label="When to summarize">
        <div className="gz-setting-row">
          <label className="gz-setting-inline">
            <span>Idle after</span>
            <input
              type="number"
              min={1}
              max={720}
              aria-label="Idle after (hours)"
              value={idleHours}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v) && v > 0) void onSummarizationChange({ idleHours: v });
              }}
              disabled={!summarizeEnabled}
            />
            <span>hours</span>
          </label>
          <label className="gz-setting-inline">
            <span>with at least</span>
            <input
              type="number"
              min={1}
              max={50}
              aria-label="Min user turns"
              value={minUserTurns}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(v) && v > 0) void onSummarizationChange({ minUserTurns: v });
              }}
              disabled={!summarizeEnabled}
            />
            <span>of your messages</span>
          </label>
        </div>
      </SettingField>
    </SettingsSection>
  );
}
