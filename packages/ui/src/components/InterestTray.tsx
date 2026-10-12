import { type InterestAreaId, shippedInterestAreas } from '@bendyline/gezel';

/**
 * The interest-area keys: several can be pressed, none is required. The
 * welcome shows them as plain keys under the meester's question; Settings
 * shows each with its hint.
 */
export function InterestTray({
  selected,
  onChange,
  label,
  withHints = false,
}: {
  selected: readonly InterestAreaId[];
  onChange: (next: InterestAreaId[]) => void;
  label: string;
  withHints?: boolean;
}) {
  const toggle = (id: InterestAreaId) => {
    onChange(selected.includes(id) ? selected.filter((a) => a !== id) : [...selected, id]);
  };
  return (
    <div className="gz-tray interest-tray" role="group" aria-label={label}>
      {shippedInterestAreas().map((area) => {
        const on = selected.includes(area.id);
        return (
          <button
            key={area.id}
            type="button"
            aria-pressed={on}
            title={withHints ? undefined : area.hint}
            className={`gz-key interest-tray-key${withHints ? ' gz-key--stacked' : ''}${on ? ' gz-key-active' : ''}`}
            onClick={() => toggle(area.id)}
          >
            <span className="gz-key-label">{area.label}</span>
            {withHints && <span className="gz-key-hint">{area.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
