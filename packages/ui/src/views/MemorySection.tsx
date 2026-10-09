import type { ConfigResponse } from '@bendyline/gezel-client';
import { Suspense, lazy } from 'react';

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
    <section style={{ marginTop: '2rem' }}>
      <h3>Project knowledge &amp; memory</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Ground relevant turns in indexed project files, artifacts, memories, and shared documents.
        Finished threads can also be distilled into project memory for future work.
      </p>

      <div style={{ marginBottom: '1.25rem' }}>
        <strong>Indexed context per turn</strong>
        <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
          Higher settings provide more direct evidence. Lower settings preserve context space on
          memory-constrained models. The gezel can still call <code>search</code> when this is Off.
        </p>
        <div
          className="gz-tray"
          role="radiogroup"
          aria-label="Indexed context per turn"
          style={{ marginTop: '0.5rem' }}
        >
          {(['off', 'lean', 'balanced', 'deep'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
              role="radio"
              aria-checked={retrievalMode === mode}
              className={`gz-key${retrievalMode === mode ? ' gz-key-active' : ''}`}
              onClick={() => void onRetrievalChange({ mode })}
            >
              {mode[0]!.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted small">Optional token cap</label>
          <input
            type="number"
            min={0}
            max={16000}
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
            style={{ width: '8rem' }}
            disabled={retrievalMode === 'off'}
          />
        </div>
      </div>

      <Suspense fallback={null}>
        <RelevanceModelCard />
      </Suspense>

      <div style={{ marginBottom: '1.25rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={config?.taskReferences?.enabled !== false}
            onChange={(e) => void onTaskReferencesChange(e.target.checked)}
          />
          <strong>Look up references when a task starts.</strong>
        </label>
        <p className="muted small" style={{ margin: '0.25rem 0 0 1.5rem' }}>
          A task started from a request searches your knowledge catalogs and shared documents for
          its subject once, and gives every step what it found.
        </p>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={summarizeEnabled}
            onChange={(e) => void onSummarizationChange({ enabled: e.target.checked })}
          />
          <strong>Summarize threads into project memory.</strong>
        </label>
        <p className="muted small" style={{ margin: '0.25rem 0 0 1.5rem' }}>
          Runs when a thread is archived, and on an hourly sweep for any thread that's been idle
          past the threshold. Short threads are skipped.
        </p>
        <div className="new-row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
          <label className="muted small">Idle after (hours)</label>
          <input
            type="number"
            min={1}
            max={720}
            value={idleHours}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) void onSummarizationChange({ idleHours: v });
            }}
            style={{ width: '5rem' }}
            disabled={!summarizeEnabled}
          />
          <label className="muted small" style={{ marginLeft: '1rem' }}>
            Min user turns
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={minUserTurns}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v > 0) void onSummarizationChange({ minUserTurns: v });
            }}
            style={{ width: '5rem' }}
            disabled={!summarizeEnabled}
          />
        </div>
      </div>
    </section>
  );
}
