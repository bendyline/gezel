import { type InterestAreaId, shippedInterestAreas } from '@bendyline/gezel';
import { useId } from 'react';

/**
 * The interest areas as checkbox cards: several can be ticked, none is
 * required. The welcome shows the bare labels under the meester's question;
 * Settings shows each with its hint.
 */
export function InterestPicker({
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
  const idPrefix = useId();
  const toggle = (id: InterestAreaId) => {
    onChange(selected.includes(id) ? selected.filter((a) => a !== id) : [...selected, id]);
  };
  return (
    <fieldset
      className={`gz-check-cards interest-picker${withHints ? ' interest-picker--hints' : ''}`}
      aria-label={label}
    >
      {shippedInterestAreas().map((area) => {
        const labelId = `${idPrefix}-${area.id}-label`;
        const hintId = `${idPrefix}-${area.id}-hint`;
        return (
          <label key={area.id} className="gz-check-card" title={withHints ? undefined : area.hint}>
            <input
              type="checkbox"
              checked={selected.includes(area.id)}
              onChange={() => toggle(area.id)}
              aria-labelledby={labelId}
              aria-describedby={withHints ? hintId : undefined}
            />
            <span className="gz-check-card-text">
              <span id={labelId} className="gz-check-card-label">
                {area.label}
              </span>
              {withHints && (
                <span id={hintId} className="gz-check-card-hint">
                  {area.hint}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
