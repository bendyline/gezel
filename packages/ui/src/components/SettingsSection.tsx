import { type ReactNode, useId } from 'react';

/**
 * The settings-page recipe (docs/ux.md → "Settings pages"). A section is a
 * serif heading with an optional one-line description and actions; its
 * content sits indented beneath it. Sections are separated by space and a
 * hairline, never by a box of their own.
 */
export function SettingsSection({
  id,
  title,
  hint,
  actions,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      id={id}
      className={['gz-settings-section', className].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
    >
      <header className="gz-settings-section-head">
        <div className="gz-settings-section-heading">
          <h3 id={titleId} className="gz-settings-section-title">
            {title}
          </h3>
          {hint && <p className="gz-settings-section-hint">{hint}</p>}
        </div>
        {actions && <div className="gz-settings-section-actions">{actions}</div>}
      </header>
      {children && <div className="gz-settings-section-body">{children}</div>}
    </section>
  );
}

/**
 * One setting: a label, its control, and a muted hint beneath. With
 * `controlId` the label names that control; without it the field is a named
 * group (a list of checkboxes, a picker that labels itself).
 */
export function SettingField({
  label,
  controlId,
  hint,
  children,
}: {
  label: ReactNode;
  controlId?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  if (controlId) {
    return (
      <div className="gz-setting">
        <label className="gz-setting-label" htmlFor={controlId}>
          {label}
        </label>
        {children}
        {hint && (
          <p id={settingHintId(controlId)} className="gz-setting-hint">
            {hint}
          </p>
        )}
      </div>
    );
  }
  return (
    <fieldset className="gz-setting">
      <legend className="gz-setting-label">{label}</legend>
      {children}
      {hint && <p className="gz-setting-hint">{hint}</p>}
    </fieldset>
  );
}

/** The id `SettingField` gives the hint of the control it labels. */
export function settingHintId(controlId: string): string {
  return `${controlId}-hint`;
}

/** An on/off setting: the checkbox leads, the hint aligns under the label. */
export function SettingCheck({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const hintId = settingHintId(id);
  return (
    <div className="gz-setting gz-setting-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label className="gz-setting-label" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <p id={hintId} className="gz-setting-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
