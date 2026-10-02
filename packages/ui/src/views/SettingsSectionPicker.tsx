import { Select } from '../primitives/index.js';

export interface SettingsPickerSection {
  id: string;
  label: string;
  /** Sits under a group heading in the wide list; indented here to match. */
  child?: boolean;
}

/**
 * The Settings section chooser for a compact layout. The wide layout lists
 * sections beside the form; at phone width that list became a short scrolling
 * box above it, which hid every section past the fourth. One dropdown names
 * the open section and reaches all of them. Both Settings views render it, and
 * the stylesheet shows it only in place of the compact list.
 */
export function SettingsSectionPicker({
  sections,
  value,
  onChange,
}: {
  sections: readonly SettingsPickerSection[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="settings-nav-picker">
      <Select.Root value={value} onValueChange={(next) => next && onChange(next)}>
        <Select.Trigger className="settings-nav-picker-trigger" aria-label="Settings section">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {sections.map((section) => (
            <Select.Item key={section.id} value={section.id} textValue={section.label}>
              {section.child ? (
                <span className="settings-nav-picker-child">{section.label}</span>
              ) : (
                section.label
              )}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </div>
  );
}
