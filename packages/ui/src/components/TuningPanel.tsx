import type { ChatModelTuning, ProviderName } from '@bendyline/gezel';
import { CANONICAL_PROFILES, isKnownProfileId, resolveProfileChain } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GezelJsonEditor } from './GezelJsonEditor.js';
import { tuningSchemaForProvider } from './tuning-schemas/index.js';
import type { LocalSquisqSchema } from './tuning-schemas/types.js';

/**
 * Shared, scope-agnostic advanced tuning form. Both the per-gezel and
 * the install-wide editors mount this — they only differ in what
 * `inherited` they pass and what `onSave` does with the diff.
 *
 * The form is ALWAYS pre-filled with the merged effective values
 * (override on top of inherited). So when a user opens it, sliders and
 * toggles sit at the value the model is actually using — not blank,
 * not zero. They can see at a glance what's in effect.
 *
 * On save, we diff the current form against `inherited` (catalog +
 * any layers underneath this scope) and persist only the deltas. That
 * way the override stays sparse and tracks upstream catalog changes
 * gracefully — a user who set temperature back to the catalog default
 * implicitly clears their override on that field.
 */
export interface TuningPanelProps {
  /** Which provider's schema to render (picks the field set). */
  provider: ProviderName;
  /**
   * The current sparse override at THIS scope (the user's edits we
   * are managing here). `{}` or undefined = no override.
   */
  override?: ChatModelTuning;
  /**
   * Merged tuning UNDER this scope. For the gezel editor: catalog +
   * install-modelTuning. For the install editor: catalog alone. The
   * form shows `inherited + override` as the effective state; diffs
   * against `inherited` decide what to persist.
   */
  inherited?: ChatModelTuning;
  /** Save callback — receives the new sparse override (or null to clear it). */
  onSave: (nextOverride: ChatModelTuning | null) => Promise<void>;
  /**
   * Optional context label shown in the header (e.g. "this gezel" or
   * "every gezel using Gemma 4"). Drives the wording on the buttons
   * and summary rows.
   */
  scopeLabel?: string;
  /** Disable the form (e.g. while a parent is loading). */
  disabled?: boolean;
  /**
   * Active tuning-profile id (from gezel frontmatter `tuningProfile`).
   * When provided, renders a read-only header chip showing which profile
   * the resolver will apply — including fallback-chain resolution when
   * the requested id isn't directly implemented by the model.
   */
  tuningProfileId?: string;
}

export function TuningPanel({
  provider,
  override,
  inherited,
  onSave,
  scopeLabel = 'this scope',
  disabled,
  tuningProfileId,
}: TuningPanelProps) {
  const baseSchema = useMemo(() => tuningSchemaForProvider(provider), [provider]);
  // Decorate the schema's leaf descriptions with the inherited default
  // for each field, so users see e.g. "Default: 1.0 (catalog)". The
  // schema is otherwise static; this is the one place we splice in
  // per-model context.
  const schema = useMemo(
    () => decorateSchemaWithDefaults(baseSchema, inherited ?? {}),
    [baseSchema, inherited],
  );

  const merged = useMemo(() => deepMerge(inherited ?? {}, override ?? {}), [inherited, override]);
  const [draft, setDraft] = useState<ChatModelTuning>(merged);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the underlying scope swaps (e.g. user picks a
  // different default model — inherited changes, so what we show
  // should follow).
  useEffect(() => {
    setDraft(merged);
  }, [merged]);

  const handleChange = useCallback((next: unknown) => {
    setDraft((next as ChatModelTuning) ?? {});
  }, []);

  // Compute the override we'd actually persist by diffing the current
  // draft against `inherited`. Empty diff → null (clears the override).
  const computedOverride = useMemo(
    () => diffAgainstInherited(draft, inherited ?? {}),
    [draft, inherited],
  );

  const hasOverride = computedOverride !== null;
  const overrideSummary = useMemo(
    () => (computedOverride ? summarizeTuning(computedOverride) : '(none)'),
    [computedOverride],
  );
  const effectiveSummary = useMemo(() => summarizeTuning(draft) || '(provider defaults)', [draft]);
  const inheritedSummary = useMemo(
    () => summarizeTuning(inherited ?? {}) || '(provider defaults)',
    [inherited],
  );

  // Profile resolution mirrors the runtime: the gezel picks `tuningProfileId`;
  // the resolver walks the canonical fallback chain against the model's
  // declared profiles. Chip shows the resolved id (which may differ from
  // the requested one when fallback hit), or undefined when nothing
  // matched and the request fell through to base tuning.
  const resolvedProfileId = useMemo(() => {
    if (!tuningProfileId) return undefined;
    const available = Object.keys(inherited?.profiles ?? {});
    return resolveProfileChain(tuningProfileId, available);
  }, [tuningProfileId, inherited]);

  const profileChip = useMemo(() => {
    if (!tuningProfileId) return null;
    if (resolvedProfileId) {
      const label = isKnownProfileId(resolvedProfileId)
        ? CANONICAL_PROFILES[resolvedProfileId].label
        : resolvedProfileId;
      const fellBack = resolvedProfileId !== tuningProfileId;
      const requestedLabel = isKnownProfileId(tuningProfileId)
        ? CANONICAL_PROFILES[tuningProfileId].label
        : tuningProfileId;
      return fellBack
        ? `${label} (fallback from ${requestedLabel} — model doesn't define it)`
        : label;
    }
    return `${tuningProfileId} (not defined on this model — base tuning applies)`;
  }, [tuningProfileId, resolvedProfileId]);

  const persist = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(computedOverride);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [computedOverride, onSave]);

  const resetToDefaults = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(null);
      setDraft(inherited ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [inherited, onSave]);

  return (
    <div className="tuning-panel">
      <div
        className="tuning-panel-summary small"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
          marginBottom: '0.5rem',
        }}
      >
        {profileChip && (
          <div>
            <strong>Active voice:</strong> <span className="muted">{profileChip}</span>
          </div>
        )}
        <div>
          <strong>Effective now:</strong> <span className="muted">{effectiveSummary}</span>
        </div>
        <div>
          <strong>Inherited default:</strong> <span className="muted">{inheritedSummary}</span>
        </div>
        <div>
          <strong>Your override for {scopeLabel}:</strong>{' '}
          <span className={hasOverride ? '' : 'muted'}>{overrideSummary}</span>
        </div>
      </div>
      <GezelJsonEditor schema={schema} value={draft} onChange={handleChange} density="compact" />
      <div className="tuning-panel-actions" style={{ marginTop: '0.5rem' }}>
        <button type="button" onClick={persist} disabled={disabled || saving}>
          {saving
            ? 'Saving…'
            : hasOverride
              ? `Save override for ${scopeLabel}`
              : 'Save (no override)'}
        </button>
        {override && Object.keys(override).length > 0 && (
          <button
            type="button"
            onClick={resetToDefaults}
            disabled={disabled || saving}
            className="muted"
            style={{ marginLeft: '0.5rem' }}
          >
            Reset to inherited defaults
          </button>
        )}
      </div>
      {error && (
        <div className="tuning-panel-error small error" style={{ marginTop: '0.25rem' }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers

/**
 * Deep merge — right wins per leaf, objects merge recursively, arrays
 * and primitives replace. Matches the resolver's merge semantics so
 * the form's "effective" view is identical to what the runtime
 * computes.
 */
function deepMerge<T extends Record<string, unknown>>(a: T, b: Partial<T>): T {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Compute the sparse override that, when merged with `inherited`,
 * yields `draft`. Returns null when the diff is empty (draft equals
 * inherited).
 */
function diffAgainstInherited(
  draft: Record<string, unknown>,
  inherited: Record<string, unknown>,
): ChatModelTuning | null {
  const out = diffObject(draft, inherited);
  if (out === null) return null;
  return out as ChatModelTuning;
}

function diffObject(
  draft: Record<string, unknown>,
  inherited: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let hasContent = false;
  for (const [key, value] of Object.entries(draft)) {
    const inh = inherited[key];
    if (value === undefined || value === null) {
      // The user cleared a field that inheritance had set — that IS
      // an explicit override (null/undefined ≠ inherited value).
      if (inh !== undefined && inh !== null) {
        // Skip: we can't represent "explicitly unset" in a sparse
        // override. The form treats blank as "inherit" — the inverse
        // (force-blank an inherited value) requires a dedicated UI
        // affordance. For now we silently inherit.
      }
      continue;
    }
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof inh === 'object' &&
      inh !== null &&
      !Array.isArray(inh)
    ) {
      const nested = diffObject(value as Record<string, unknown>, inh as Record<string, unknown>);
      if (nested !== null) {
        out[key] = nested;
        hasContent = true;
      }
    } else if (!valuesEqual(value, inh)) {
      out[key] = value;
      hasContent = true;
    }
  }
  return hasContent ? out : null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Walk a SquisqAnnotatedSchema and append "Default: <value>" to each
 * leaf's description where `defaults` has a value at that path.
 * Returns a new schema; doesn't mutate the input.
 */
function decorateSchemaWithDefaults(
  schema: LocalSquisqSchema,
  defaults: Record<string, unknown>,
): LocalSquisqSchema {
  return decorateNode(schema, defaults);
}

function decorateNode(node: LocalSquisqSchema, defaultsAtThisLevel: unknown): LocalSquisqSchema {
  const out: LocalSquisqSchema = { ...node };
  if (out.properties) {
    const newProps: Record<string, LocalSquisqSchema> = {};
    for (const [key, child] of Object.entries(out.properties)) {
      const childDefault =
        defaultsAtThisLevel && typeof defaultsAtThisLevel === 'object'
          ? (defaultsAtThisLevel as Record<string, unknown>)[key]
          : undefined;
      newProps[key] = decorateNode(child, childDefault);
    }
    out.properties = newProps;
  }
  // Leaf annotation — append a "Default: …" suffix when a value is
  // available. Skip for objects (their children carry the actual
  // values).
  if (out.type !== 'object' && defaultsAtThisLevel !== undefined && defaultsAtThisLevel !== null) {
    const display = formatDefault(defaultsAtThisLevel);
    if (display !== null) {
      const base = out.description ?? '';
      out.description = base ? `${base}\n\nDefault: ${display}` : `Default: ${display}`;
    }
  }
  return out;
}

function formatDefault(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value;
  return null;
}

/**
 * Compact one-line summary of a tuning block. Used in the summary
 * rows above the editor so users can compare "effective" vs
 * "inherited" vs "your override" at a glance.
 */
function summarizeTuning(t: ChatModelTuning): string {
  const parts: string[] = [];
  if (t.sampling) {
    const s = t.sampling;
    const bits: string[] = [];
    if (s.temperature !== undefined) bits.push(`temp ${s.temperature}`);
    if (s.topP !== undefined) bits.push(`top_p ${s.topP}`);
    if (s.topK !== undefined) bits.push(`top_k ${s.topK}`);
    if (s.minP !== undefined) bits.push(`min_p ${s.minP}`);
    if (s.maxTokens !== undefined) bits.push(`max ${s.maxTokens}`);
    if (s.seed !== undefined) bits.push(`seed ${s.seed}`);
    if (s.repetitionPenalty !== undefined) bits.push(`rep ${s.repetitionPenalty}`);
    if (s.frequencyPenalty !== undefined) bits.push(`freq ${s.frequencyPenalty}`);
    if (s.presencePenalty !== undefined) bits.push(`pres ${s.presencePenalty}`);
    if (bits.length > 0) parts.push(bits.join(', '));
  }
  if (t.reasoning) {
    const r = t.reasoning;
    if (r.effort) parts.push(`effort ${r.effort}`);
    if (r.thinkingBudget !== undefined) parts.push(`budget ${r.thinkingBudget}`);
    if (r.enableThinking === true) parts.push('thinking on');
    if (r.enableThinking === false) parts.push('thinking off');
  }
  if (t.output?.responseFormat && t.output.responseFormat !== 'text')
    parts.push(`format ${t.output.responseFormat}`);
  if (t.toolChoice) parts.push(`tools ${t.toolChoice}`);
  if (t.samplingWhenThinking && Object.keys(t.samplingWhenThinking).length > 0)
    parts.push('+thinking sampling');
  if (t.promptTags?.enableThinkingTag) parts.push(`tag ${t.promptTags.enableThinkingTag}`);
  return parts.join(' · ');
}
