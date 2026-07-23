import type { GezelDetail } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

interface FixedFunctionAboutPanelProps {
  gezel: GezelDetail;
  onUpdated: (gezel: GezelDetail) => void;
}

/**
 * Replacement for the about.md editor on fixed-function gezels.
 * These gezels have no system prompt — the chat path forwards the
 * user's message text straight to the named MCP tool and surfaces
 * the result. So instead of an editor we show:
 *
 *   - A "Forwards to: …" line naming the wired MCP tool.
 *   - The template's user-facing description.
 *   - A JSON textarea for editing the tool's `defaults` map (width,
 *     height, model, etc.). v1 keeps this as a plain JSON editor;
 *     a future revision can replace it with a schema-driven form
 *     once the service exposes a tool-schema lookup endpoint.
 */
export function FixedFunctionAboutPanel({ gezel, onUpdated }: FixedFunctionAboutPanelProps) {
  const ff = gezel.fixedFunction;
  const initial = ff?.defaults ? JSON.stringify(ff.defaults, null, 2) : '';
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Reset draft when a different gezel is selected. The textarea is
  // intentionally NOT auto-synced to subsequent prop updates from
  // an outer remount — once the user is editing, they own the
  // value until they click Save (or they navigate away). Out-of-
  // band defaults changes would only realistically come from the
  // user themselves anyway (via a second tab or the MCP tool).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional id-only dep
  useEffect(() => {
    setDraft(initial);
    setDirty(false);
    setError(null);
    setStatus(null);
  }, [gezel.id]);

  const save = useCallback(async () => {
    setError(null);
    setStatus(null);
    let parsed: Record<string, unknown> | null = null;
    if (draft.trim()) {
      try {
        const value = JSON.parse(draft);
        if (value === null || Array.isArray(value) || typeof value !== 'object') {
          throw new Error('defaults must be a JSON object');
        }
        parsed = value as Record<string, unknown>;
      } catch (err) {
        setError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
    }
    setBusy(true);
    try {
      const updated = await api.updateGezelFixedFunctionDefaults(gezel.id, {
        defaults: parsed && Object.keys(parsed).length > 0 ? parsed : null,
      });
      onUpdated(updated);
      setDirty(false);
      setStatus('Saved');
    } catch (err) {
      setError(`Save failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [draft, gezel.id, onUpdated]);

  if (!ff) {
    // Shouldn't render — the parent gates on `gezel.fixedFunction`.
    return null;
  }

  return (
    <div className="ff-about-panel">
      <div className="ff-about-summary">
        <div className="ff-about-row">
          <span className="ff-label">Forwards to</span>
          <code className="ff-tool-name">{ff.tool}</code>
          <span className="muted small">— no LLM is invoked</span>
        </div>
        <div className="ff-about-row">
          <span className="ff-label">Argument</span>
          <span>
            Your message text is passed as <code>{ff.promptKey}</code>.
          </span>
        </div>
        {gezel.description && <p className="muted">{gezel.description}</p>}
      </div>
      <div className="ff-defaults">
        <label className="ff-defaults-label" htmlFor={`ff-defaults-${gezel.id}`}>
          Default arguments
        </label>
        <p className="muted small ff-defaults-help">
          Merged into every call as JSON. Your message text on <code>{ff.promptKey}</code> always
          wins over a collision here. Common keys for <code>{ff.tool}</code>: <code>width</code>,{' '}
          <code>height</code>, <code>steps</code>, <code>model</code>, <code>negativePrompt</code>.
          Leave empty to forward only the prompt.
        </p>
        <textarea
          id={`ff-defaults-${gezel.id}`}
          className="ff-defaults-textarea"
          value={draft}
          spellCheck={false}
          rows={10}
          placeholder='{\n  "width": 1024,\n  "height": 1024\n}'
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
            setStatus(null);
          }}
          disabled={busy}
        />
        <div className="ff-defaults-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={busy || !dirty}
          >
            {busy ? 'Saving…' : 'Save defaults'}
          </button>
          {status && <span className="muted small">{status}</span>}
          {error && <span className="error small">{error}</span>}
        </div>
      </div>
    </div>
  );
}
