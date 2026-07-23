import { type GezelDetail, type GezelSummary, pickRandomName } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';

const IMAGE_GENERATOR_TEMPLATE_ID = 'image-generator';
const IMAGE_GENERATOR_TOOL = 'generate_image';

/**
 * Card shown inside the image-generation settings tab. Detects whether
 * the user already has a fixed-function image-generator gezel and
 * either:
 *
 *   - Surfaces it (so they can click straight to its chat), or
 *   - Offers a one-click install of the `image-generator` template
 *     with the curated name suggestions inline.
 *
 * The button skips the generic gilde browser — the template id is
 * locked, so the dialog only collects a name. This is the natural
 * place to discover the feature: a user just configured an image
 * engine and now needs a way to *use* it from chat.
 */
export function ImageGeneratorGezelHint() {
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInstall, setShowInstall] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listGezels();
      setGezels(res.gezels);
    } catch {
      /* Surface a quiet failure — this hint is opportunistic. The
         existing gezel sidebar will surface load errors more
         prominently. */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The gezel sidebar broadcasts a `gezel:gezel-updated` event when
    // a new gezel is created or edited; listen so this card stays in
    // sync without polling.
    const handler = () => void refresh();
    window.addEventListener('gezel:gezel-updated', handler);
    return () => window.removeEventListener('gezel:gezel-updated', handler);
  }, [refresh]);

  const existing = useMemo(
    () => gezels.filter((g) => g.fixedFunction?.tool === IMAGE_GENERATOR_TOOL),
    [gezels],
  );

  const openGezelTab = useCallback((id: string) => {
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', {
        detail: { kind: 'gezel', id, activate: true },
      }),
    );
  }, []);

  const onCreated = useCallback(
    (created: GezelDetail) => {
      setShowInstall(false);
      void refresh();
      openGezelTab(created.id);
    },
    [refresh, openGezelTab],
  );

  if (loading) return null;

  return (
    <div className="ff-img-hint">
      {existing.length > 0 ? (
        <div className="ff-img-hint-have">
          <span className="muted small">Image-generator gezel</span>
          {existing.length === 1 ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => openGezelTab(existing[0]!.id)}
              title={`Open ${existing[0]!.name}`}
            >
              {existing[0]!.name}
            </button>
          ) : (
            <span>
              {existing.map((g, i) => (
                <span key={g.id}>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => openGezelTab(g.id)}
                    title={`Open ${g.name}`}
                  >
                    {g.name}
                  </button>
                  {i < existing.length - 1 && <span className="muted">, </span>}
                </span>
              ))}
            </span>
          )}
          <span className="muted small">— @-mention them in chat to generate.</span>
        </div>
      ) : (
        <div className="ff-img-hint-empty">
          <p className="muted small">
            Once an engine is set up, the easiest way to use it from chat is to add an{' '}
            <strong>image-generator gezel</strong>. They forward your @-mention text straight to{' '}
            <code>{IMAGE_GENERATOR_TOOL}</code> — no LLM in the middle.
          </p>
          <button type="button" className="primary" onClick={() => setShowInstall(true)}>
            Add an image-generator gezel
          </button>
        </div>
      )}
      <ImageGeneratorInstallDialog
        open={showInstall}
        onClose={() => setShowInstall(false)}
        onCreated={onCreated}
      />
    </div>
  );
}

/**
 * Focused install dialog locked to the `image-generator` template id.
 * Skips the gilde browser — the user has already implicitly chosen the
 * template by clicking "Add an image-generator gezel" in the image-
 * settings panel. Collects a name (seeded from the same shared random
 * pool the regular `New Gezel` dialog uses, with a 🎲 to re-roll) and
 * shows the template description.
 */
function ImageGeneratorInstallDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (gezel: GezelDetail) => void;
}) {
  const [name, setName] = useState(() => pickRandomName());
  const [description, setDescription] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  // Only load template details once. Closing + reopening reuses the
  // cached description; re-fetching adds latency for no benefit.
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    setLoadingTemplate(true);
    api
      .getCatalogItem('gezel-template', IMAGE_GENERATOR_TEMPLATE_ID)
      .then((detail) => {
        if (detail.manifest.kind !== 'gezel-template') return;
        setDescription(detail.manifest.description);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoadingTemplate(false));
  }, [open]);

  // Re-roll a fresh name each time the dialog opens so two installs
  // in a row don't propose the same name. Mirrors the regular New
  // Gezel dialog's reset.
  useEffect(() => {
    if (!open) return;
    setName(pickRandomName());
    setError(null);
    setBusy(false);
  }, [open]);

  const reroll = () => setName(pickRandomName());

  const submit = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createGezelFromTemplate(IMAGE_GENERATOR_TEMPLATE_ID, {
        name: name.trim(),
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [name, onCreated]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="template-picker-dialog">
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
            }}
          >
            <Dialog.Title asChild>
              <h3 style={{ margin: 0 }}>Add an image-generator gezel</h3>
            </Dialog.Title>
            <button type="button" className="home-link" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </header>
          <Dialog.Description className="muted small" style={{ margin: '0.25rem 0 0.5rem 0' }}>
            Forwards your @-mention text straight to <code>{IMAGE_GENERATOR_TOOL}</code>. No LLM is
            invoked.
          </Dialog.Description>
          {loadingTemplate && <p className="muted small">Loading template…</p>}
          {description && <p className="muted small">{description}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            style={{
              marginTop: '0.5rem',
              padding: '0.6rem',
              background: 'rgba(79, 125, 255, 0.06)',
              borderRadius: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span className="muted small" style={{ flexShrink: 0 }}>
                Name:
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="dice-btn"
                onClick={reroll}
                disabled={busy}
                title="Pick a random name"
                aria-label="Pick a random name"
              >
                🎲
              </button>
              <button type="submit" className="primary" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
