import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Settings → People: the explicit biometric opt-in for face recognition,
 * with the honest costs up front (a ~250 MB one-time model download, local
 * processing only) and the data-erasure path ("turn off and erase") beside
 * the toggle rather than hidden. Mirrors GildeUpdatesCard's shape.
 */
export function FaceRecognitionCard() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wipeResult, setWipeResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const config = await api.getConfig();
        setEnabled(config.faceRecognition?.enabled === true);
      } catch {
        /* card still renders; the toggle just starts from default */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const saveEnabled = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setError(null);
      setWipeResult(null);
      try {
        await api.updateConfig({ faceRecognition: { enabled: next } });
      } catch (err) {
        setEnabled(previous);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [enabled],
  );

  const wipe = useCallback(async () => {
    setError(null);
    try {
      const result = await api.wipeFaceData();
      setEnabled(false);
      setConfirmWipe(false);
      setWipeResult(
        result.projects > 0
          ? `Face data erased across ${result.projects} project${result.projects === 1 ? '' : 's'}.`
          : 'No face data was stored.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h3>People in photos</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        When on, Gezel looks for faces in indexed photos and groups the same person across them, so
        you can name someone once and find them anywhere. Everything runs on this device — photos
        and face data never leave it. Turning this on downloads the face models once (about 260 MB).
      </p>
      <label className="debug-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => void saveEnabled(e.target.checked)}
        />
        <span>Recognize people in photos</span>
      </label>
      <div className="new-row" style={{ marginTop: '0.75rem' }}>
        <button type="button" className="danger" onClick={() => setConfirmWipe(true)}>
          Turn off and erase face data
        </button>
      </div>
      {wipeResult && <p className="muted small">{wipeResult}</p>}
      {error && <p className="error small">{error}</p>}
      <ConfirmDialog
        open={confirmWipe}
        title="Erase all face data?"
        message="Deletes every stored face signature, person, and name across all projects, and turns face recognition off. Photos themselves are not touched. This cannot be undone."
        confirmLabel="Erase face data"
        danger
        onConfirm={wipe}
        onCancel={() => setConfirmWipe(false)}
      />
    </section>
  );
}
