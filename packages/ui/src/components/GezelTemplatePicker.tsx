import type { CatalogItemSummary } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';

interface GezelTemplatePickerProps {
  gezelRole?: string;
  /**
   * Template id the gezel was originally created from. When present
   * and still resolvable in the catalog, this template is surfaced as
   * "Reset to original" — precedence over the role-based fallback.
   */
  gezelTemplateId?: string;
  /**
   * Called after the user picks a template. Receives the template's
   * about.md content; the caller decides how to apply it (persist +
   * remount the editor).
   */
  onApply: (templateId: string, about: string) => void | Promise<void>;
}

type TemplateSummary = Extract<CatalogItemSummary['manifest'], { kind: 'gezel-template' }>;

/**
 * Toolbar button + dialog for resetting a gezel's about.md to a
 * gilde template. Two paths: reset to the template the gezel was
 * originally created from (or that matches its role), or pick any
 * template from the catalog. Applying always replaces the editor
 * content and persists; the user can undo by editing back.
 */
export function GezelTemplatePicker({
  gezelRole,
  gezelTemplateId,
  onApply,
}: GezelTemplatePickerProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CatalogItemSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api
      .listCatalogItems('gezel-template')
      .then((res) => setItems(res.items))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [open]);

  // Templates filtered to gezel-template kind and sorted so the
  // "suggested" match (by templateId, then by role) floats to the top.
  // The role fallback helps existing gezels that predate templateId.
  const sortedItems = useMemo(() => {
    const templates = items.filter(
      (i): i is CatalogItemSummary & { manifest: TemplateSummary } =>
        i.manifest.kind === 'gezel-template',
    );
    const normalizedRole = gezelRole?.toLowerCase().trim();
    const suggestedId = gezelTemplateId
      ? templates.find((t) => t.manifest.id === gezelTemplateId)?.manifest.id
      : undefined;
    const roleMatchId =
      suggestedId ??
      (normalizedRole
        ? templates.find((t) => t.manifest.role.toLowerCase().trim() === normalizedRole)?.manifest
            .id
        : undefined);
    return templates
      .map((t) => ({
        item: t,
        isSuggested: t.manifest.id === roleMatchId,
        isOriginal: t.manifest.id === suggestedId,
      }))
      .sort((a, b) => {
        if (a.isSuggested !== b.isSuggested) return a.isSuggested ? -1 : 1;
        return a.item.manifest.name.localeCompare(b.item.manifest.name);
      });
  }, [items, gezelRole, gezelTemplateId]);

  const handleApply = useCallback(
    async (templateId: string) => {
      setApplying(templateId);
      setError(null);
      try {
        const detail = await api.getCatalogItem('gezel-template', templateId);
        const about = detail.about ?? '';
        if (!about.trim()) {
          setError('This template has no about.md content.');
          return;
        }
        await onApply(templateId, about);
        setOpen(false);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setApplying(null);
      }
    },
    [onApply],
  );

  return (
    <>
      <button
        type="button"
        className="ai-btn"
        onClick={() => setOpen(true)}
        title="Replace this gezel's about.md with a gilde template"
        aria-label="Use a template"
      >
        📇
      </button>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false);
            setError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gz-dialog-wide">
            <Dialog.Title asChild>
              <h3>Apply a template</h3>
            </Dialog.Title>
            <Dialog.Description className="muted small">
              Replace this gezel's <code>about.md</code> with a template from the gilde. Current
              content is overwritten — you can edit back to undo.
            </Dialog.Description>
            {loading && <p className="muted">Loading templates…</p>}
            {!loading && sortedItems.length === 0 && (
              <p className="muted">No gilde templates available.</p>
            )}
            {!loading && sortedItems.length > 0 && (
              <ul className="gezel-template-list">
                {sortedItems.map(({ item, isSuggested, isOriginal }) => {
                  const m = item.manifest as TemplateSummary;
                  const isApplyingThis = applying === m.id;
                  return (
                    <li key={m.id} className={isSuggested ? 'suggested' : undefined}>
                      <div className="gezel-template-head">
                        <strong>{m.name}</strong>
                        <span className="muted small">{m.role}</span>
                        {isSuggested && (
                          <span className="gezel-template-badge">
                            {isOriginal ? 'Original' : 'Matches role'}
                          </span>
                        )}
                      </div>
                      {m.description && <p className="muted small">{m.description}</p>}
                      <button
                        type="button"
                        onClick={() => void handleApply(m.id)}
                        disabled={applying !== null}
                      >
                        {isApplyingThis ? 'Applying…' : isSuggested ? 'Reset to this' : 'Use this'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && <p className="gz-dialog-error">{error}</p>}
            <Dialog.Actions>
              <button type="button" onClick={() => setOpen(false)} disabled={applying !== null}>
                Cancel
              </button>
            </Dialog.Actions>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
