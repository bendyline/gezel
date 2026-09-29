import {
  EVAL_JOB_MAX_TARGETS,
  type EvalCatalog,
  type EvalCatalogScenario,
  type EvalEnvironment,
  type EvalImageModelOption,
  type EvalJobSpec,
  type EvalRequirement,
  type EvalScenarioKind,
  type EvalTarget,
} from '@bendyline/gezel/eval';
import { useId, useMemo, useState } from 'react';
import {
  formatDuration,
  providerLabel,
  requirementGap,
  selectedScenarioIds,
  targetKey,
} from './format.js';

type Mode = 'suite' | 'pick';
type KindFilter = 'all' | EvalScenarioKind;

const COUNT_CHOICES = [
  { value: 1, hint: 'A spot check. Results show as counts, not rates.' },
  {
    value: 3,
    hint: 'The fewest trials that can support a pass rate — what the published scorecard uses.',
  },
  { value: 5, hint: 'Tighter numbers, for telling close models apart.' },
] as const;

const GENERALIST_CHOICES = [
  {
    value: undefined,
    label: 'Default',
    hint: 'Whatever this install would do: one gezel for hosted models, a crew for on-device ones.',
  },
  { value: 'on', label: 'On', hint: 'One gezel owns each task from start to finish.' },
  { value: 'off', label: 'Off', hint: 'Each step goes to the specialist its recipe names.' },
] as const;

const KIND_FILTERS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'scenario', label: 'Scenarios' },
  { value: 'craftbook', label: 'Recipes' },
  { value: 'craftbook-authoring', label: 'Recipe authoring' },
];

/** Hard cap on rendered rows in the picker; search narrows the rest. */
const PICKER_ROW_LIMIT = 150;

export interface RunPlannerProps {
  catalog: EvalCatalog;
  targets: EvalTarget[];
  imageModels: EvalImageModelOption[];
  environment: EvalEnvironment;
  /** A job is already running, so this one will queue behind it. */
  willQueue: boolean;
  onStart: (spec: EvalJobSpec) => Promise<void>;
}

function defaultTargetKeys(catalog: EvalCatalog, targets: EvalTarget[]): Set<string> {
  const available = targets.filter((t) => t.available);
  const pick =
    available.find((t) => t.isDefault && t.provider === catalog.defaultProvider) ??
    available.find((t) => t.isDefault && t.category === 'local-engine') ??
    available.find((t) => t.provider === catalog.defaultProvider) ??
    available.find((t) => t.category === 'local-engine') ??
    available[0];
  return new Set(pick ? [targetKey(pick)] : []);
}

export function RunPlanner({
  catalog,
  targets,
  imageModels,
  environment,
  willQueue,
  onStart,
}: RunPlannerProps) {
  const ids = useId();
  const byId = useMemo(() => new Map(catalog.scenarios.map((s) => [s.id, s])), [catalog]);
  const [mode, setMode] = useState<Mode>('suite');
  const [suiteId, setSuiteId] = useState(catalog.defaultSuiteId);
  const [suiteSubset, setSuiteSubset] = useState<Set<string> | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [chosenTargets, setChosenTargets] = useState<Set<string>>(() =>
    defaultTargetKeys(catalog, targets),
  );
  const [count, setCount] = useState<number>(1);
  const [countStrict, setCountStrict] = useState(false);
  const [generalist, setGeneralist] = useState<'on' | 'off' | undefined>(undefined);
  const [imageModelId, setImageModelId] = useState<string>('');
  const [timeoutMinutes, setTimeoutMinutes] = useState('');
  const [skipPreflight, setSkipPreflight] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suite = catalog.suites.find((s) => s.id === suiteId);
  const spec: Pick<EvalJobSpec, 'suiteId' | 'scenarioIds'> =
    mode === 'suite'
      ? {
          suiteId,
          ...(suiteSubset && suite && suiteSubset.size < suite.scenarioIds.length
            ? { scenarioIds: suite.scenarioIds.filter((id) => suiteSubset.has(id)) }
            : {}),
        }
      : { scenarioIds: catalog.scenarios.filter((s) => picked.has(s.id)).map((s) => s.id) };
  const scenarioIds = selectedScenarioIds(spec, catalog);
  const scenarios = scenarioIds
    .map((id) => byId.get(id))
    .filter((s): s is EvalCatalogScenario => s !== undefined);
  const selectedTargets = targets.filter((t) => chosenTargets.has(targetKey(t)) && t.available);

  const trialsFor = (s: EvalCatalogScenario) =>
    countStrict ? count : Math.min(count, s.suggestedTrials ?? count);
  const trialsPerTarget = scenarios.reduce((sum, s) => sum + trialsFor(s), 0);
  const totalTrials = trialsPerTarget * selectedTargets.length;
  const timeoutMs =
    Number(timeoutMinutes) > 0 ? Math.round(Number(timeoutMinutes) * 60_000) : undefined;
  const worstCaseMs =
    scenarios.reduce((sum, s) => sum + (timeoutMs ?? s.timeoutMs) * trialsFor(s), 0) *
    selectedTargets.length;
  const cappedCount = scenarios.filter((s) => (s.suggestedTrials ?? count) < count).length;

  const needsImage = scenarios.some((s) => s.requires.includes('image-model'));
  const scenarioImageDefault = scenarios.find((s) => s.defaultImageModelId)?.defaultImageModelId;
  const effectiveImageModel =
    imageModelId ||
    (scenarioImageDefault && imageModels.some((m) => m.id === scenarioImageDefault)
      ? scenarioImageDefault
      : (imageModels[0]?.id ?? ''));

  const gaps = useMemo(() => {
    const satisfied = new Set(environment.satisfied);
    const out = new Map<EvalRequirement, string[]>();
    for (const s of scenarios) {
      for (const req of s.requires) {
        if (satisfied.has(req) && req !== 'network') continue;
        out.set(req, [...(out.get(req) ?? []), s.id]);
      }
    }
    return [...out.entries()];
  }, [scenarios, environment]);

  const pickerRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.scenarios.filter(
      (s) =>
        (kind === 'all' || s.kind === kind) &&
        (!q || s.id.includes(q) || s.description.toLowerCase().includes(q)),
    );
  }, [catalog, search, kind]);

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const localTargets = targets.filter(
    (t) => t.category === 'local-engine' || t.category === 'system-model',
  );
  const hostedTargets = targets.filter(
    (t) => t.category === 'cli-wrapper' || t.category === 'cloud-sdk',
  );

  const canStart = scenarios.length > 0 && selectedTargets.length > 0 && !submitting;

  const start = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onStart({
        ...spec,
        count,
        ...(countStrict && count > 1 ? { countStrict: true } : {}),
        targets: selectedTargets.map((t) => ({ provider: t.provider, modelId: t.modelId })),
        ...(needsImage && effectiveImageModel ? { imageModelId: effectiveImageModel } : {}),
        ...(generalist ? { generalistMode: generalist } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(skipPreflight ? { skipPreflight: true } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const renderTarget = (target: EvalTarget) => {
    const key = targetKey(target);
    const checked = chosenTargets.has(key) && target.available;
    const atLimit = !checked && chosenTargets.size >= EVAL_JOB_MAX_TARGETS;
    return (
      <li key={key} className={target.available ? undefined : 'bench-option-unavailable'}>
        <label className="bench-check-row">
          <input
            type="checkbox"
            checked={checked}
            disabled={!target.available || atLimit}
            onChange={() => setChosenTargets((prev) => toggle(prev, key))}
          />
          <span className="bench-check-main">
            <span className="bench-check-title">
              {target.label}
              {target.isDefault && <span className="bench-tag">default</span>}
            </span>
            <span className="bench-check-meta">
              {providerLabel(target.provider)}
              {target.label !== target.modelId && (
                <>
                  {' '}
                  · <code>{target.modelId}</code>
                </>
              )}
            </span>
            {!target.available && target.unavailableReason && (
              <span className="bench-check-note">{target.unavailableReason}</span>
            )}
          </span>
        </label>
      </li>
    );
  };

  return (
    <section className="bench-section bench-planner" aria-labelledby={`${ids}-heading`}>
      <h3 id={`${ids}-heading`}>Run an evaluation</h3>

      <div className="bench-field">
        <span className="bench-field-label" id={`${ids}-mode`}>
          What to run
        </span>
        <div className="gz-tray" role="radiogroup" aria-labelledby={`${ids}-mode`}>
          {(
            [
              ['suite', 'A suite'],
              ['pick', 'Pick scenarios'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
              role="radio"
              aria-checked={mode === value}
              className={`gz-key${mode === value ? ' gz-key-active' : ''}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'suite' && suite && (
          <div className="bench-suite">
            <select
              aria-label="Suite"
              value={suiteId}
              onChange={(e) => {
                setSuiteId(e.currentTarget.value);
                setSuiteSubset(null);
              }}
            >
              {catalog.suites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} — {s.scenarioIds.length} scenario{s.scenarioIds.length === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <p className="muted small bench-suite-description">{suite.description}</p>
            <details className="bench-disclosure">
              <summary>
                {suiteSubset && suiteSubset.size < suite.scenarioIds.length
                  ? `Running ${suiteSubset.size} of its ${suite.scenarioIds.length} scenarios`
                  : `Choose which of its ${suite.scenarioIds.length} scenarios to run`}
              </summary>
              <p className="muted small">
                A subset is useful for a quick check, but it is not a suite score.
              </p>
              <ul className="bench-check-list">
                {suite.scenarioIds.map((id) => {
                  const s = byId.get(id);
                  const on = suiteSubset ? suiteSubset.has(id) : true;
                  return (
                    <li key={id}>
                      <label className="bench-check-row">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setSuiteSubset((prev) => toggle(prev ?? new Set(suite.scenarioIds), id))
                          }
                        />
                        <ScenarioLabel id={id} scenario={s} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            </details>
          </div>
        )}

        {mode === 'pick' && (
          <div className="bench-picker">
            <div className="bench-picker-controls">
              <input
                type="search"
                placeholder="Search scenarios"
                aria-label="Search scenarios"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
              <div className="bench-kind-keys" role="radiogroup" aria-label="Kind of scenario">
                {KIND_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                    role="radio"
                    aria-checked={kind === f.value}
                    className={`gz-key${kind === f.value ? ' gz-key-active' : ''}`}
                    onClick={() => setKind(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <ul className="bench-check-list bench-check-list--scroll">
              {pickerRows.slice(0, PICKER_ROW_LIMIT).map((s) => (
                <li key={s.id}>
                  <label className="bench-check-row">
                    <input
                      type="checkbox"
                      checked={picked.has(s.id)}
                      onChange={() => setPicked((prev) => toggle(prev, s.id))}
                    />
                    <ScenarioLabel id={s.id} scenario={s} showDescription />
                  </label>
                </li>
              ))}
            </ul>
            <p className="muted small">
              {pickerRows.length > PICKER_ROW_LIMIT
                ? `Showing ${PICKER_ROW_LIMIT} of ${pickerRows.length} — search to narrow. `
                : ''}
              {picked.size} selected
              {picked.size > 0 && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setPicked(new Set())}
                  >
                    Clear
                  </button>
                </>
              )}
            </p>
          </div>
        )}
      </div>

      <div className="bench-field">
        <span className="bench-field-label">Models</span>
        {targets.length === 0 ? (
          <p className="muted small">
            No models to evaluate yet. Install a model for this computer, or connect a hosted
            provider, then come back.
          </p>
        ) : (
          <>
            {localTargets.length > 0 && (
              <>
                <h4 className="bench-group-heading">On this computer</h4>
                <ul className="bench-check-list">{localTargets.map(renderTarget)}</ul>
              </>
            )}
            {hostedTargets.length > 0 && (
              <>
                <h4 className="bench-group-heading">Hosted</h4>
                <ul className="bench-check-list">{hostedTargets.map(renderTarget)}</ul>
              </>
            )}
            <p className="muted small">
              Each model runs the whole selection in turn. On-device models run one at a time so
              results measure this computer, not contention.
            </p>
          </>
        )}
      </div>

      <div className="bench-field">
        <span className="bench-field-label" id={`${ids}-count`}>
          Trials per scenario
        </span>
        <div className="bench-described">
          <div
            className="gz-tray gz-tray--described"
            role="radiogroup"
            aria-labelledby={`${ids}-count`}
          >
            {COUNT_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                role="radio"
                aria-checked={count === choice.value}
                className={`gz-key${count === choice.value ? ' gz-key-active' : ''}`}
                onClick={() => setCount(choice.value)}
              >
                {choice.value}
              </button>
            ))}
          </div>
          <p className="gz-tray-description">
            <strong>
              {count} trial{count === 1 ? '' : 's'}
            </strong>{' '}
            — {COUNT_CHOICES.find((c) => c.value === count)?.hint}
          </p>
        </div>
        {count > 1 && cappedCount > 0 && (
          <label className="settings-toggle bench-inline-toggle">
            <input
              type="checkbox"
              checked={countStrict}
              onChange={(e) => setCountStrict(e.currentTarget.checked)}
            />
            <span>
              Repeat all {cappedCount} saturated scenario{cappedCount === 1 ? '' : 's'} too (they
              normally run once because models already pass them reliably)
            </span>
          </label>
        )}
      </div>

      <details className="bench-disclosure bench-advanced">
        <summary>More options</summary>
        <div className="bench-field">
          <span className="bench-field-label" id={`${ids}-generalist`}>
            Generalist mode
          </span>
          <div className="bench-described">
            <div
              className="gz-tray gz-tray--described"
              role="radiogroup"
              aria-labelledby={`${ids}-generalist`}
            >
              {GENERALIST_CHOICES.map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                  role="radio"
                  aria-checked={generalist === choice.value}
                  className={`gz-key${generalist === choice.value ? ' gz-key-active' : ''}`}
                  onClick={() => setGeneralist(choice.value)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="gz-tray-description">
              <strong>{GENERALIST_CHOICES.find((c) => c.value === generalist)?.label}</strong> —{' '}
              {GENERALIST_CHOICES.find((c) => c.value === generalist)?.hint}
            </p>
          </div>
        </div>

        {needsImage && (
          <div className="bench-field">
            <label className="bench-field-label" htmlFor={`${ids}-image`}>
              Image model
            </label>
            {imageModels.length > 0 ? (
              <select
                id={`${ids}-image`}
                value={effectiveImageModel}
                onChange={(e) => setImageModelId(e.currentTarget.value)}
              >
                {imageModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="muted small">No image model is installed.</p>
            )}
          </div>
        )}

        <div className="bench-field">
          <label className="bench-field-label" htmlFor={`${ids}-timeout`}>
            Time limit per trial
          </label>
          <div className="bench-inline">
            <input
              id={`${ids}-timeout`}
              type="number"
              min={1}
              max={1440}
              inputMode="numeric"
              placeholder="Scenario default"
              value={timeoutMinutes}
              onChange={(e) => setTimeoutMinutes(e.currentTarget.value)}
              className="bench-number"
            />
            <span className="muted small">minutes</span>
          </div>
          <p className="muted small">
            Leave empty to use each scenario's own limit, scaled to this computer's measured speed.
            A number here is used as-is for every trial.
          </p>
        </div>

        <label className="settings-toggle bench-inline-toggle">
          <input
            type="checkbox"
            checked={skipPreflight}
            onChange={(e) => setSkipPreflight(e.currentTarget.checked)}
          />
          <span>Skip the preflight check</span>
        </label>
        <p className="muted small">
          Before on-device runs, one short probe confirms the model loads, calls tools, and runs
          fast enough, and measures its speed so time limits fit this computer. A model that fails
          it is not run.
        </p>
      </details>

      <div className="bench-plan" aria-live="polite">
        {scenarios.length === 0 || selectedTargets.length === 0 ? (
          <p className="muted small">
            {scenarios.length === 0 ? 'Choose at least one scenario' : 'Choose at least one model'}{' '}
            to see the plan.
          </p>
        ) : (
          <>
            <p className="bench-plan-summary">
              <strong>
                {totalTrials} trial{totalTrials === 1 ? '' : 's'}
              </strong>{' '}
              — {scenarios.length} scenario{scenarios.length === 1 ? '' : 's'} ×{' '}
              {selectedTargets.length} model{selectedTargets.length === 1 ? '' : 's'}
              {count > 1 ? ` × up to ${count} trials` : ''}. At most {formatDuration(worstCaseMs)}{' '}
              if every trial runs to its limit; a trial still making progress may run up to twice as
              long.
            </p>
            {gaps.length > 0 && (
              <ul className="bench-gaps">
                {gaps.map(([req, scenarioIdsWithGap]) => (
                  <li key={req}>
                    <strong>{listNames(scenarioIdsWithGap)}</strong>{' '}
                    {requirementGap(req, scenarioIdsWithGap.length)}.
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {error && <p className="error small">{error}</p>}
      <div className="bench-actions">
        <button type="button" className="primary" disabled={!canStart} onClick={() => void start()}>
          {submitting ? 'Starting…' : willQueue ? 'Add to the queue' : 'Start evaluation'}
        </button>
        {willQueue && (
          <span className="muted small">It will start when the current run finishes.</span>
        )}
      </div>
    </section>
  );
}

function listNames(ids: string[]): string {
  if (ids.length <= 3) return ids.join(', ');
  return `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`;
}

function ScenarioLabel({
  id,
  scenario,
  showDescription = false,
}: {
  id: string;
  scenario: EvalCatalogScenario | undefined;
  showDescription?: boolean;
}) {
  return (
    <span className="bench-check-main">
      <span className="bench-check-title">
        <code>{id}</code>
        {scenario?.anchored && <span className="bench-tag">anchor</span>}
        {scenario?.requires
          .filter((r) => r !== 'embeddings')
          .map((r) => (
            <span key={r} className="bench-tag bench-tag--muted">
              {r === 'external-checkout' ? 'checkout' : r}
            </span>
          ))}
        {scenario && (
          <span className="bench-check-meta bench-check-limit">
            up to {formatDuration(scenario.timeoutMs)}
          </span>
        )}
      </span>
      {showDescription && scenario && (
        <span className="bench-check-note bench-clamp">{scenario.description}</span>
      )}
    </span>
  );
}
