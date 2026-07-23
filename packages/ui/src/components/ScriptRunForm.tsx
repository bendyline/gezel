import type {
  RunScriptResponse,
  ScriptInputField,
  ScriptInputs,
  ScriptMeta,
} from '@bendyline/gezel';

/**
 * Shared building blocks for "run a script with inputs and show the
 * result" — used by both ScriptsView's detail pane and the script
 * editor's Test-run panel so the two surfaces can never drift.
 * (Extracted verbatim from ScriptsView.)
 */

export function buildDefaultInputs(meta: ScriptMeta): Record<string, unknown> {
  const initial: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(meta.inputs ?? {})) {
    const d = fieldDefault(field);
    if (d !== undefined) initial[name] = d;
  }
  return initial;
}

export function ScriptInputFields({
  inputs,
  values,
  onChange,
}: {
  inputs: ScriptInputs;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <>
      {Object.entries(inputs).map(([name, field]) => (
        <InputField
          key={name}
          name={name}
          field={field}
          value={values[name]}
          onChange={(v) => onChange({ ...values, [name]: v })}
        />
      ))}
    </>
  );
}

export function RunResult({ result, meta }: { result: RunScriptResponse; meta: ScriptMeta }) {
  return (
    <div className={`script-run-result script-run-result--${result.status}`}>
      <header>
        <strong>Run {result.runId.slice(0, 8)}</strong> — {result.status}
      </header>
      {result.error && <p className="script-run-result__error">{result.error}</p>}
      {result.output !== undefined && (
        <section>
          <h4>Output</h4>
          {meta.outputs ? (
            <table>
              <tbody>
                {Object.keys(meta.outputs).map((field) => {
                  const v = (result.output as Record<string, unknown> | undefined)?.[field];
                  return (
                    <tr key={field}>
                      <th>{field}</th>
                      <td>
                        <code>{formatValue(v)}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <pre>{JSON.stringify(result.output, null, 2)}</pre>
          )}
        </section>
      )}
      {result.callsSummary.length > 0 && (
        <section>
          <h4>What it did ({result.callsSummary.length} calls)</h4>
          <ol>
            {result.callsSummary.map((c, i) => (
              <li key={`${c.kind}-${i}`}>
                <code>{c.kind}</code> · {c.durationMs}ms
                {c.error ? <em> — {c.error}</em> : null}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

export function InputField({
  name,
  field,
  value,
  onChange,
}: {
  name: string;
  field: ScriptInputField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <span className="script-input__label">
      {name}
      {field.required ? <em> *</em> : null} — <small>{field.description}</small>
    </span>
  );
  switch (field.type) {
    case 'string':
      if (field.multiline) {
        return (
          <label>
            {label}
            <textarea
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => onChange(e.target.value)}
            />
          </label>
        );
      }
      return (
        <label>
          {label}
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            placeholder={field.pattern ? `pattern: ${field.pattern}` : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    case 'number':
      return (
        <label>
          {label}
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            min={field.min}
            max={field.max}
            step={field.integer ? 1 : 'any'}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(Number.isFinite(n) ? n : undefined);
            }}
          />
        </label>
      );
    case 'boolean':
      return (
        <label className="script-input__checkbox">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
      );
    case 'choice':
      return (
        <label>
          {label}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">— pick —</option>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label ?? o.value}
              </option>
            ))}
          </select>
        </label>
      );
    case 'ref':
      return (
        <label>
          {label}
          <input
            type="text"
            placeholder={`${field.kind} id`}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    case 'json':
      return (
        <label>
          {label}
          <textarea
            value={value === undefined ? '' : JSON.stringify(value, null, 2)}
            onChange={(e) => {
              const txt = e.target.value;
              if (!txt.trim()) {
                onChange(undefined);
                return;
              }
              try {
                onChange(JSON.parse(txt));
              } catch {
                onChange(txt);
              }
            }}
          />
        </label>
      );
  }
}

export function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function fieldDefault(field: ScriptInputField): unknown {
  switch (field.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'choice':
    case 'json':
      return field.default;
    case 'ref':
      return undefined;
  }
}
