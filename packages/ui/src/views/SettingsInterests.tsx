import { InterestPicker } from '../components/InterestPicker.js';
import { SettingsSection } from '../components/SettingsSection.js';
import { useInterests } from '../components/useInterests.js';

/**
 * Settings → General: what the person uses gezel for. The same checkboxes the
 * welcome asks with; the choice orders the welcome's first projects, Make
 * something and the New Task and New Project galleries, and never hides
 * anything.
 */
export function SettingsInterests() {
  const interests = useInterests();
  return (
    <SettingsSection
      id="settings-interests"
      className="settings-interests"
      title="What you use gezel for"
      hint="Pick any. What you pick comes first when gezel suggests work; everything else stays a click away."
    >
      {interests.loaded && (
        <InterestPicker
          label="What you use gezel for"
          selected={interests.areas}
          onChange={(next) => void interests.save(next)}
          withHints
        />
      )}
    </SettingsSection>
  );
}
