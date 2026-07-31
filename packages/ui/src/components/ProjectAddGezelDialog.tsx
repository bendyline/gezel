import type {
  CatalogItemSummary,
  GezelGender,
  GezelSummary,
  ProjectDetail,
} from '@bendyline/gezel';
import {
  displayName,
  initialPoppetjeForGezel,
  pickRandomNameWithGender,
  poppetjeFromSeed,
} from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Poppetje } from '../poppetje/index.js';
import { Dialog } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';

type GezelTemplateItem = CatalogItemSummary & {
  manifest: Extract<CatalogItemSummary['manifest'], { kind: 'gezel-template' }>;
};

export interface ProjectTemplateGezelOptions {
  name: string;
  gender?: GezelGender;
  appearanceSeed?: number;
}

function freshAppearanceSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function isGezelTemplate(item: CatalogItemSummary): item is GezelTemplateItem {
  return item.manifest.kind === 'gezel-template';
}

function roleIdentity(value: string | undefined): string {
  return (value ?? '').toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '');
}

/**
 * Project-scoped crew picker.
 *
 * Existing gezels attach in one click. Catalog roles that do not have an
 * instance in the global roster open a small character step first, except in
 * boring mode where role identity is the whole point and the template is
 * created immediately.
 */
export function ProjectAddGezelDialog({
  open,
  project,
  gezels,
  roleBasedNameOnlyMode,
  onClose,
  onAddExisting,
  onCreateTemplate,
}: {
  open: boolean;
  project: ProjectDetail;
  gezels: GezelSummary[];
  roleBasedNameOnlyMode: boolean;
  onClose: () => void;
  onAddExisting: (gezelId: string) => Promise<void>;
  onCreateTemplate: (templateId: string, options: ProjectTemplateGezelOptions) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<GezelTemplateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<GezelTemplateItem | null>(null);
  const [name, setName] = useState('');
  const [gender, setGender] = useState<GezelGender | undefined>();
  const [appearanceSeed, setAppearanceSeed] = useState(freshAppearanceSeed);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedTemplate(null);
    void api
      .listCatalogItems('gezel-template')
      .then(({ items }) => {
        if (cancelled) return;
        const unique = new Map<string, GezelTemplateItem>();
        for (const item of items) {
          if (isGezelTemplate(item) && !unique.has(item.manifest.id)) {
            unique.set(item.manifest.id, item);
          }
        }
        setTemplates([...unique.values()]);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const assignedIds = useMemo(
    () =>
      new Set([
        ...(project.gezelIds ?? []),
        ...(project.voormanGezelId ? [project.voormanGezelId] : []),
      ]),
    [project.gezelIds, project.voormanGezelId],
  );
  const createdTemplateIds = useMemo(
    () => new Set(gezels.flatMap((gezel) => (gezel.templateId ? [gezel.templateId] : []))),
    [gezels],
  );
  const createdRoleIdentities = useMemo(
    () =>
      new Set(
        gezels.flatMap((gezel) =>
          [gezel.role, gezel.roleBasedName].map(roleIdentity).filter(Boolean),
        ),
      ),
    [gezels],
  );
  const availableGezels = useMemo(
    () =>
      gezels
        .filter((gezel) => !assignedIds.has(gezel.id) && gezel.scope !== 'project')
        .sort((a, b) =>
          displayName(a, roleBasedNameOnlyMode).localeCompare(
            displayName(b, roleBasedNameOnlyMode),
          ),
        ),
    [assignedIds, gezels, roleBasedNameOnlyMode],
  );
  const availableTemplates = useMemo(
    () =>
      templates
        .filter(
          (item) =>
            !createdTemplateIds.has(item.manifest.id) &&
            !createdRoleIdentities.has(roleIdentity(item.manifest.role)) &&
            !createdRoleIdentities.has(roleIdentity(item.manifest.name)),
        )
        .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
    [createdRoleIdentities, createdTemplateIds, templates],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGezels = useMemo(
    () =>
      normalizedQuery
        ? availableGezels.filter((gezel) =>
            [displayName(gezel, roleBasedNameOnlyMode), gezel.role ?? ''].some((value) =>
              value.toLocaleLowerCase().includes(normalizedQuery),
            ),
          )
        : availableGezels,
    [availableGezels, normalizedQuery, roleBasedNameOnlyMode],
  );
  const visibleTemplates = useMemo(
    () =>
      normalizedQuery
        ? availableTemplates.filter((item) =>
            [
              item.manifest.name,
              item.manifest.role,
              item.manifest.description,
              ...item.manifest.tags,
            ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
          )
        : availableTemplates,
    [availableTemplates, normalizedQuery],
  );

  const close = () => {
    if (!busy) onClose();
  };

  const addExisting = async (gezelId: string) => {
    setBusy(true);
    setError(null);
    try {
      await onAddExisting(gezelId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createTemplate = async (
    template: GezelTemplateItem,
    options: ProjectTemplateGezelOptions,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await onCreateTemplate(template.manifest.id, options);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chooseTemplate = (template: GezelTemplateItem) => {
    if (roleBasedNameOnlyMode) {
      void createTemplate(template, { name: template.manifest.name });
      return;
    }
    const picked = pickRandomNameWithGender();
    const suggestions = template.manifest.nameSuggestions ?? [];
    const suggestedName =
      suggestions.length > 0
        ? suggestions[Math.floor(Math.random() * suggestions.length)]
        : picked.name;
    setSelectedTemplate(template);
    setName(suggestedName ?? picked.name);
    setGender(picked.gender);
    setAppearanceSeed(freshAppearanceSeed());
    setError(null);
  };

  const preview =
    selectedTemplate && name.trim()
      ? poppetjeFromSeed(appearanceSeed, {
          key: `project-add-preview:${selectedTemplate.manifest.id}`,
          name: name.trim(),
          gender,
        })
      : null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="project-add-gezel-dialog">
          <Dialog.Title asChild>
            <h3>
              {selectedTemplate ? `Customize ${selectedTemplate.manifest.name}` : 'Add Gezel'}
            </h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            {selectedTemplate
              ? `Give this new ${selectedTemplate.manifest.role} a name and appearance before adding them to ${project.name}.`
              : `Choose someone from your workshop or add a new role to ${project.name}.`}
          </Dialog.Description>

          {error && <p className="error small project-add-gezel-error">{error}</p>}

          {selectedTemplate ? (
            <form
              className="project-add-gezel-customize"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                void createTemplate(selectedTemplate, {
                  name: name.trim(),
                  ...(gender ? { gender } : {}),
                  appearanceSeed,
                });
              }}
            >
              <div className="project-add-gezel-preview" aria-hidden="true">
                {preview && (
                  <Poppetje poppetje={preview} variant="full" size={150} grainStyle="wavy" />
                )}
              </div>
              <div className="project-add-gezel-customize-fields">
                <label>
                  Name
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <button
                  type="button"
                  className="subtle"
                  disabled={busy}
                  onClick={() => setAppearanceSeed(freshAppearanceSeed())}
                >
                  Reroll appearance
                </button>
                <p className="muted small">
                  Their role and working style come from the {selectedTemplate.manifest.name}{' '}
                  template.
                </p>
              </div>
              <Dialog.Actions>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelectedTemplate(null);
                    setError(null);
                  }}
                >
                  Back
                </button>
                <button type="submit" className="primary" disabled={busy || !name.trim()}>
                  {busy ? 'Adding…' : 'Add to project'}
                </button>
              </Dialog.Actions>
            </form>
          ) : (
            <>
              <label className="project-add-gezel-search">
                <span className="sr-only">Search gezels and roles</span>
                <input
                  type="text"
                  placeholder="Search gezels and roles…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={busy}
                />
              </label>

              <div className="project-add-gezel-options">
                <section aria-labelledby="project-add-existing-title">
                  <h4 id="project-add-existing-title">From your workshop</h4>
                  {visibleGezels.length > 0 ? (
                    <ul className="project-add-gezel-list">
                      {visibleGezels.map((gezel) => {
                        const rendered = displayName(gezel, roleBasedNameOnlyMode);
                        return (
                          <li key={gezel.id}>
                            <button
                              type="button"
                              className="project-add-gezel-option"
                              disabled={busy}
                              onClick={() => void addExisting(gezel.id)}
                            >
                              <GezelIcon
                                svg={gezel.icon ?? null}
                                poppetje={gezel.poppetje}
                                iconOverride={gezel.iconOverride}
                                name={rendered}
                                size={36}
                              />
                              <span className="project-add-gezel-option-copy">
                                <span className="project-add-gezel-option-name">{rendered}</span>
                                <span className="muted small">
                                  {gezel.role ?? 'Gezel'} · ready to add
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="muted small project-add-gezel-empty">
                      {availableGezels.length > 0
                        ? 'No workshop gezels match that search.'
                        : 'Every available gezel is already on this project.'}
                    </p>
                  )}
                </section>

                <section aria-labelledby="project-add-role-title">
                  <h4 id="project-add-role-title">Create a new role</h4>
                  {loading && <p className="muted small">Loading roles…</p>}
                  {!loading && visibleTemplates.length > 0 ? (
                    <ul className="project-add-gezel-list">
                      {visibleTemplates.map((template) => (
                        <li key={template.manifest.id}>
                          <button
                            type="button"
                            className="project-add-gezel-option"
                            disabled={busy}
                            onClick={() => chooseTemplate(template)}
                          >
                            <GezelIcon
                              poppetje={initialPoppetjeForGezel(
                                `project-role:${template.manifest.id}`,
                                template.manifest.name,
                              )}
                              name={template.manifest.name}
                              size={36}
                            />
                            <span className="project-add-gezel-option-copy">
                              <span className="project-add-gezel-option-name">
                                {template.manifest.name}
                              </span>
                              <span className="muted small">{template.manifest.description}</span>
                            </span>
                            <span className="gz-badge">New role</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    !loading && (
                      <p className="muted small project-add-gezel-empty">
                        {availableTemplates.length > 0
                          ? 'No new roles match that search.'
                          : 'Every role type already has a gezel.'}
                      </p>
                    )
                  )}
                </section>
              </div>

              <Dialog.Actions>
                <button type="button" onClick={close} disabled={busy}>
                  Cancel
                </button>
              </Dialog.Actions>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
