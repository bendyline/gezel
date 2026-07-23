import type { ToolsetConfigField } from '@bendyline/gezel';
import { type FormEvent, useState } from 'react';

export interface ToolsetConfigFormValue {
  values: Record<string, string>;
  /** Only fields the user touched. `null` = clear existing; string = set. */
  secrets: Record<string, string | null>;
}

interface ToolsetConfigFormProps {
  fields: ToolsetConfigField[];
  initialValues?: Record<string, string>;
  /** Which secret fields already have a stored value. */
  initialSecretsPresent?: Record<string, boolean>;
  /** Mask strings (e.g. "****abcd") per secret field id. */
  initialSecretMasks?: Record<string, string>;
  /** Per-field list of ids the manifest no longer declares. */
  orphanedValueIds?: string[];
  orphanedSecretIds?: string[];
  submitLabel: string;
  busy?: boolean;
  onSubmit: (value: ToolsetConfigFormValue) => void | Promise<void>;
  onCancel: () => void;
}

export function ToolsetConfigForm({
  fields,
  initialValues = {},
  initialSecretsPresent = {},
  initialSecretMasks = {},
  orphanedValueIds = [],
  orphanedSecretIds = [],
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: ToolsetConfigFormProps) {
  const [values, setValues] = useState<Record<string, string>>({ ...initialValues });
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  // Secret fields start in "masked" mode; user clicks "Update" to enter a new value.
  const [editingSecret, setEditingSecret] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    for (const f of fields) {
      if (!f.required) continue;
      if (f.secret) {
        const incoming = secrets[f.id];
        const hasExisting = initialSecretsPresent[f.id];
        if (typeof incoming !== 'string' && !hasExisting && f.default === undefined) {
          setError(`${f.label} is required`);
          return;
        }
      } else {
        const v = values[f.id] ?? initialValues[f.id] ?? '';
        if (!v && f.default === undefined) {
          setError(`${f.label} is required`);
          return;
        }
      }
      if (f.pattern && !f.secret) {
        const v = values[f.id] ?? '';
        if (v && !new RegExp(f.pattern).test(v)) {
          setError(`${f.label} does not match the expected pattern`);
          return;
        }
      }
    }
    // Submit only fields the user actually changed (for values) + all secret
    // intents. The server merges values onto existing.
    const changedValues: Record<string, string> = {};
    for (const f of fields.filter((f) => !f.secret)) {
      const v = values[f.id];
      if (v !== undefined && v !== initialValues[f.id]) changedValues[f.id] = v;
    }
    await onSubmit({ values: changedValues, secrets });
  };

  return (
    <form className="toolset-config-form" onSubmit={handleSubmit}>
      {(orphanedValueIds.length > 0 || orphanedSecretIds.length > 0) && (
        <p className="muted small">
          Orphaned fields (manifest no longer declares them):{' '}
          {[...orphanedValueIds, ...orphanedSecretIds].join(', ')}
        </p>
      )}
      {fields.map((f) => (
        <div key={f.id} className="toolset-config-field">
          <label htmlFor={`field-${f.id}`}>
            <span>
              {f.label}
              {f.required && <span className="required">*</span>}
              {f.secret && <span className="muted small"> (secret)</span>}
            </span>
            {f.description && <span className="muted small">{f.description}</span>}
          </label>
          {renderInput(f, {
            values,
            setValues,
            secrets,
            setSecrets,
            editingSecret,
            setEditingSecret,
            initialSecretsPresent,
            initialSecretMasks,
            initialValues,
          })}
        </div>
      ))}
      {error && <p className="error small">{error}</p>}
      <div className="toolset-config-actions">
        <button type="button" className="home-link" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          {busy ? '…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

interface InputCtx {
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
  secrets: Record<string, string | null>;
  setSecrets: (v: Record<string, string | null>) => void;
  editingSecret: Record<string, boolean>;
  setEditingSecret: (v: Record<string, boolean>) => void;
  initialSecretsPresent: Record<string, boolean>;
  initialSecretMasks: Record<string, string>;
  initialValues: Record<string, string>;
}

function renderInput(f: ToolsetConfigField, ctx: InputCtx) {
  const id = `field-${f.id}`;

  if (f.secret) {
    const hasExisting = ctx.initialSecretsPresent[f.id];
    const editing = ctx.editingSecret[f.id] ?? !hasExisting;
    if (!editing) {
      return (
        <div className="toolset-config-secret-row">
          <code>{ctx.initialSecretMasks[f.id] ?? '****'}</code>
          <button
            type="button"
            className="home-link"
            onClick={() => ctx.setEditingSecret({ ...ctx.editingSecret, [f.id]: true })}
          >
            Update
          </button>
          <button
            type="button"
            className="home-link"
            onClick={() => ctx.setSecrets({ ...ctx.secrets, [f.id]: null })}
          >
            Clear
          </button>
          {ctx.secrets[f.id] === null && <span className="muted small">will clear on save</span>}
        </div>
      );
    }
    return (
      <input
        id={id}
        type="password"
        autoComplete="off"
        placeholder={f.placeholder ?? ''}
        value={typeof ctx.secrets[f.id] === 'string' ? (ctx.secrets[f.id] as string) : ''}
        onChange={(e) => ctx.setSecrets({ ...ctx.secrets, [f.id]: e.target.value })}
      />
    );
  }

  const value = ctx.values[f.id] ?? ctx.initialValues[f.id] ?? f.default ?? '';
  const onChange = (v: string) => ctx.setValues({ ...ctx.values, [f.id]: v });

  if (f.type === 'enum' && f.options) {
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {f.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (f.type === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === 'true'}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
      />
    );
  }
  if (f.multiline) {
    return (
      <textarea
        id={id}
        rows={6}
        placeholder={f.placeholder ?? ''}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      id={id}
      type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
      placeholder={f.placeholder ?? ''}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
