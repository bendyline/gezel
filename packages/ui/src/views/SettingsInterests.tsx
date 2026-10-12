import { InterestTray } from '../components/InterestTray.js';
import { useInterests } from '../components/useInterests.js';

/**
 * Settings → General: what the person uses gezel for. The same keys the
 * welcome asks with; the choice orders the welcome's first projects, Make
 * something and the New Task and New Project galleries, and never hides
 * anything.
 */
export function SettingsInterests() {
  const interests = useInterests();
  return (
    <section className="settings-interests" style={{ marginBottom: '2rem' }}>
      <h3>What you use gezel for</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Pick any. What you pick comes first when gezel suggests work; everything else stays a click
        away.
      </p>
      {interests.loaded && (
        <InterestTray
          label="What you use gezel for"
          selected={interests.areas}
          onChange={(next) => void interests.save(next)}
          withHints
        />
      )}
    </section>
  );
}
