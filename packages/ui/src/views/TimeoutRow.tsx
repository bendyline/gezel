/**
 * Single editable timeout row shared by provider settings. Keeping this small
 * primitive separate lets Settings use it without eagerly importing a full
 * engine-management panel.
 */
export function TimeoutRow({
  label,
  unit,
  help,
  value,
  onChange,
  configValue,
  onSave,
}: {
  label: string;
  unit: 'seconds' | 'minutes';
  help: string;
  value: string;
  onChange: (next: string) => void;
  configValue: number | undefined;
  onSave: () => void;
}) {
  const persistedDraft = configValue ? String(configValue) : '';
  return (
    <div style={{ marginTop: '0.6rem' }}>
      <div style={{ fontSize: '0.85rem', marginBottom: '0.2rem' }}>
        <strong>{label}</strong> <span className="muted small">({unit})</span>
      </div>
      <p className="muted small" style={{ margin: '0 0 0.3rem 0' }}>
        {help}
      </p>
      <div className="new-row">
        <input
          type="number"
          min={1}
          placeholder="default"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={onSave} disabled={value.trim() === persistedDraft}>
          Save
        </button>
      </div>
    </div>
  );
}
