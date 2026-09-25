import {
  type CraftbookTemplateManifest,
  paramFormSchema,
  unmetParamAlternatives,
} from '@bendyline/gezel';
import type { SquisqAnnotatedSchema } from '@bendyline/squisq';
import { useMemo, useState } from 'react';
import { GezelJsonEditor } from './GezelJsonEditor.js';
import { paramAlternativesMessage } from './composer-task-launch.js';
import { renderCraftbookCommand, seedableParamDefault } from './craftbook-command.js';

/**
 * Collect a craftbook's parameters via a squisq dynamic form (its
 * `JsonEditor`), then hand the stringified values back so the launcher
 * can render + stage the command. The form fields come ENTIRELY from the
 * craftbook's `paramSchema` (a squisq/JSON schema) — no hand-rolled
 * fields — minus the ones a person is never asked for (`askUser`), and
 * without a top-level "fill at least one of these" rule, which submit checks
 * instead. A live preview shows exactly what will be staged.
 *
 * Rendered inside a popover anchored to the clicked craftbook item; the
 * popover container itself lives in CommandsPanel.
 */
export function CraftbookParamForm({
  manifest,
  onSubmit,
  onCancel,
}: {
  manifest: CraftbookTemplateManifest;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const fullSchema = manifest.paramSchema as SquisqAnnotatedSchema | undefined;
  const schema = useMemo(
    () => paramFormSchema(manifest.paramSchema) as SquisqAnnotatedSchema | undefined,
    [manifest.paramSchema],
  );

  const [value, setValue] = useState<Record<string, unknown>>(() => seedDefaults(fullSchema));
  const [error, setError] = useState<string | null>(null);

  const stringified = useMemo(() => stringifyValues(value), [value]);
  const preview = useMemo(
    () => renderCraftbookCommand(manifest, stringified),
    [manifest, stringified],
  );

  const submit = () => {
    const missing = requiredMissing(schema, value);
    if (missing) {
      setError(`"${missing}" is required.`);
      return;
    }
    const unmet = unmetParamAlternatives(manifest.paramSchema, value);
    if (unmet) {
      setError(paramAlternativesMessage(manifest.paramSchema, unmet));
      return;
    }
    onSubmit(stringified);
  };

  return (
    <form
      className="craftbook-param-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="craftbook-param-form-title">{manifest.name}</div>
      {schema && (
        <GezelJsonEditor
          schema={schema}
          value={value}
          onChange={(next) => {
            setValue((next ?? {}) as Record<string, unknown>);
            setError(null);
          }}
          density="compact"
        />
      )}
      <div className="craftbook-param-form-preview">
        <code>{preview}</code>
      </div>
      {error && <p className="craftbook-param-form-error small">{error}</p>}
      <div className="craftbook-param-form-actions">
        <button type="button" className="subtle" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Stage command
        </button>
      </div>
    </form>
  );
}

function seedDefaults(schema: SquisqAnnotatedSchema | undefined): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { default?: unknown } | undefined>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    const seed = seedableParamDefault(def);
    if (seed !== undefined) out[key] = seed;
  }
  return out;
}

function requiredMissing(
  schema: SquisqAnnotatedSchema | undefined,
  value: Record<string, unknown>,
): string | null {
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    const v = value[key];
    if (v === undefined || v === null || v === '') return key;
  }
  return null;
}

/** Coerce squisq's value object to the `Record<string,string>` the CLI uses. */
function stringifyValues(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') out[key] = v ? 'true' : 'false';
    else if (typeof v === 'number') out[key] = String(v);
    else if (typeof v === 'string') out[key] = v;
    // objects/arrays aren't valid CLI params — skip silently
  }
  return out;
}
