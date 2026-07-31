import type { SuggestedWorkItem } from '@bendyline/gezel';
import { paramProjectProperty } from '@bendyline/gezel';
import type { SquisqAnnotatedSchema } from '@bendyline/squisq';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { GezelJsonEditor } from './GezelJsonEditor.js';

/**
 * The project's suggested recurring work ("night work"): craftbook runs
 * recommended by the roles on the roster and by the project type, shown
 * as opt-in rows the user can enable, pause, or hide. Rendered by
 * ProjectCrewRoster directly below the Boekwachter AI-indexing card —
 * the same "role present on the crew unlocks background work" idea, so
 * the rows deliberately share its card grammar.
 */
export function SuggestedNightWork({
  projectId,
  projectProperties,
  refreshKey,
  recentlyAddedGezelId,
}: {
  projectId: string;
  projectProperties?: Record<string, string>;
  /** Change to refetch (e.g. the roster membership signature). */
  refreshKey?: number | string;
  /** Flash still-virtual suggestions sponsored by this just-added gezel. */
  recentlyAddedGezelId?: string;
}) {
  const [items, setItems] = useState<SuggestedWorkItem[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paramFormKey, setParamFormKey] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await api.listSuggestedWork(projectId);
      setItems(res.items);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusyKey(key);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const enable = async (item: SuggestedWorkItem, params?: Record<string, string>) => {
    setParamFormKey(null);
    await act(item.key, async () => {
      await api.enableSuggestedWork(projectId, {
        key: item.key,
        ...(params ? { params } : {}),
      });
      const propertyWrites = propertyWritesFor(item, params);
      if (propertyWrites) await api.updateProject(projectId, { properties: propertyWrites });
    });
  };

  if (items === null) {
    return error ? <p className="error small suggested-work-error">{error}</p> : null;
  }
  const visible = items.filter((i) => i.state !== 'dismissed');
  const hidden = items.filter((i) => i.state === 'dismissed');
  if (items.length === 0) return null;

  return (
    <div className="suggested-work">
      {visible.map((item) => (
        <SuggestedWorkRow
          key={item.key}
          item={item}
          busy={busyKey === item.key}
          flash={
            item.state === 'suggested' &&
            item.source.kind === 'gezel-template' &&
            item.source.gezelId !== undefined &&
            item.source.gezelId === recentlyAddedGezelId
          }
          paramFormOpen={paramFormKey === item.key}
          projectProperties={projectProperties}
          onEnable={(params) => void enable(item, params)}
          onOpenParamForm={() => setParamFormKey(item.key)}
          onCloseParamForm={() => setParamFormKey(null)}
          onDisable={() => void act(item.key, () => api.disableSuggestedWork(projectId, item.key))}
          onDismiss={() =>
            void act(item.key, () => api.dismissSuggestedWork(projectId, item.key, true))
          }
        />
      ))}
      {hidden.length > 0 && (
        <div className="suggested-work-hidden">
          <button type="button" className="subtle small" onClick={() => setShowHidden((v) => !v)}>
            {showHidden
              ? 'Hide dismissed suggestions'
              : `${hidden.length} hidden suggestion${hidden.length === 1 ? '' : 's'}`}
          </button>
          {showHidden &&
            hidden.map((item) => (
              <div key={item.key} className="project-autonomous-role suggested-work-row">
                <div className="project-autonomous-role-copy">
                  <span className="project-autonomous-role-title">
                    {item.craftbookName ?? item.craftbookId}
                  </span>
                  <span className="muted small">Hidden from suggestions.</span>
                </div>
                <button
                  type="button"
                  className="subtle"
                  disabled={busyKey === item.key}
                  onClick={() =>
                    void act(item.key, () => api.dismissSuggestedWork(projectId, item.key, false))
                  }
                >
                  Suggest again
                </button>
              </div>
            ))}
        </div>
      )}
      {error && <p className="error small suggested-work-error">{error}</p>}
    </div>
  );
}

function SuggestedWorkRow({
  item,
  busy,
  flash,
  paramFormOpen,
  projectProperties,
  onEnable,
  onOpenParamForm,
  onCloseParamForm,
  onDisable,
  onDismiss,
}: {
  item: SuggestedWorkItem;
  busy: boolean;
  flash: boolean;
  paramFormOpen: boolean;
  projectProperties?: Record<string, string>;
  onEnable: (params?: Record<string, string>) => void;
  onOpenParamForm: () => void;
  onCloseParamForm: () => void;
  onDisable: () => void;
  onDismiss: () => void;
}) {
  const on = item.state === 'enabled';
  const hasParams = hasParamFields(item);
  const cadence =
    item.runMode === 'night-shift'
      ? 'Runs during the Night Shift window, at most once per night.'
      : `Runs on schedule (cron ${item.cron}, UTC).`;
  const sponsor =
    item.source.kind === 'gezel-template'
      ? item.source.gezelName
        ? `Suggested by ${item.source.gezelName}${item.source.role ? ` — ${item.source.role}` : ''}.`
        : `Suggested by the "${item.source.templateId}" role.`
      : `From the "${item.source.typeId}" project type.`;
  const stateNote = item.pendingQuestionId
    ? ' Awaiting approval — enabling here answers the pending question.'
    : item.orphaned
      ? ' The sponsoring role is no longer on this crew.'
      : '';

  return (
    <div
      className={`project-autonomous-role suggested-work-row${
        on ? ' project-autonomous-role-active' : ''
      }${flash ? ' timeline-focus-flash' : ''}`}
    >
      <span className="suggested-work-glyph" aria-hidden="true">
        {item.runMode === 'night-shift' ? <MoonGlyph /> : <ClockGlyph />}
      </span>
      <div className="project-autonomous-role-copy">
        <span className="project-autonomous-role-title">
          {item.craftbookName ?? item.craftbookId} {on ? 'on' : 'off'}
        </span>
        <span className="muted small">
          {item.reason ? `${item.reason} ` : ''}
          {cadence} {sponsor}
          {stateNote}
        </span>
        {paramFormOpen && (
          <SuggestedWorkParamForm
            item={item}
            projectProperties={projectProperties}
            onSubmit={onEnable}
            onCancel={onCloseParamForm}
          />
        )}
      </div>
      <div className="suggested-work-actions">
        {on ? (
          <button type="button" className="subtle" disabled={busy} onClick={onDisable}>
            {busy ? 'Updating…' : 'Pause'}
          </button>
        ) : (
          <button
            type="button"
            className="subtle"
            disabled={busy || paramFormOpen}
            onClick={() => (hasParams && item.state === 'suggested' ? onOpenParamForm() : onEnable())}
          >
            {busy ? 'Updating…' : item.state === 'paused' ? 'Resume' : 'Enable'}
          </button>
        )}
        {item.state === 'suggested' && (
          <button
            type="button"
            className="subtle small suggested-work-dismiss"
            disabled={busy}
            onClick={onDismiss}
            title="Don't suggest this for this project"
          >
            Don't suggest
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline param capture for a suggestion whose craftbook declares a
 * `paramSchema`. Fields seed from (1) the suggestion's own defaults and
 * (2) the project's shared properties for any `projectProperty`-annotated
 * param, so a designated language set once flows into every book that
 * asks for one.
 */
function SuggestedWorkParamForm({
  item,
  projectProperties,
  onSubmit,
  onCancel,
}: {
  item: SuggestedWorkItem;
  projectProperties?: Record<string, string>;
  onSubmit: (params: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const schema = item.paramSchema as SquisqAnnotatedSchema | undefined;
  const [value, setValue] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    const props = (schema?.properties ?? {}) as Record<string, { default?: unknown } | undefined>;
    for (const [key, def] of Object.entries(props)) {
      const propertyId = paramProjectProperty(def);
      const fromProperty = propertyId ? projectProperties?.[propertyId] : undefined;
      if (fromProperty !== undefined) out[key] = fromProperty;
      else if (item.params?.[key] !== undefined) out[key] = item.params[key];
      else if (def && def.default !== undefined) out[key] = def.default;
    }
    return out;
  });

  const stringified = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'boolean') out[key] = v ? 'true' : 'false';
      else if (typeof v === 'number') out[key] = String(v);
      else if (typeof v === 'string') out[key] = v;
    }
    return out;
  }, [value]);

  return (
    <form
      className="suggested-work-param-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(stringified);
      }}
    >
      {schema && (
        <GezelJsonEditor
          schema={schema}
          value={value}
          onChange={(next) => setValue((next ?? {}) as Record<string, unknown>)}
          density="compact"
        />
      )}
      <div className="suggested-work-param-actions">
        <button type="button" className="subtle" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Enable
        </button>
      </div>
    </form>
  );
}

function hasParamFields(item: SuggestedWorkItem): boolean {
  const props = (item.paramSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return Boolean(props && Object.keys(props).length > 0);
}

/**
 * Param values that map to project properties (via the `projectProperty`
 * annotation), to write back so the next book shares them. Null when the
 * schema annotates nothing.
 */
function propertyWritesFor(
  item: SuggestedWorkItem,
  params: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!params) return null;
  const props = (item.paramSchema?.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, def] of Object.entries(props)) {
    const propertyId = paramProjectProperty(def);
    const value = params[key];
    if (propertyId && value !== undefined && value !== '') out[propertyId] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function MoonGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-8.54-6.5A8.97 8.97 0 0 0 12 3z" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
