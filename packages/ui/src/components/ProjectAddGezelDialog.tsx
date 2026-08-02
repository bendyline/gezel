import type {
  CatalogItemSummary,
  GezelGender,
  GezelSummary,
  ProjectDetail,
  ProjectTypeGezelRole,
} from '@bendyline/gezel';
import {
  displayName,
  getProjectType,
  initialPoppetjeForGezel,
  pickRandomNameWithGender,
  poppetjeFromSeed,
  resolveProjectTypeId,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Poppetje } from '../poppetje/index.js';
import { Dialog } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';

type GezelTemplateItem = CatalogItemSummary & {
  manifest: Extract<CatalogItemSummary['manifest'], { kind: 'gezel-template' }>;
};

type ProjectRoleAffinity = ProjectTypeGezelRole & {
  tier: 'default' | 'suggested';
  rank: number;
};

type SuggestedRoleOption =
  | { kind: 'existing'; gezel: GezelSummary; affinity: ProjectRoleAffinity }
  | { kind: 'template'; template: GezelTemplateItem; affinity: ProjectRoleAffinity };

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

function gezelMatchesQuery(
  gezel: GezelSummary,
  query: string,
  roleBasedNameOnlyMode: boolean,
): boolean {
  return [displayName(gezel, roleBasedNameOnlyMode), gezel.role ?? ''].some((value) =>
    value.toLocaleLowerCase().includes(query),
  );
}

function templateMatchesQuery(template: GezelTemplateItem, query: string): boolean {
  return [
    template.manifest.name,
    template.manifest.role,
    template.manifest.description,
    ...template.manifest.tags,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/**
 * Project-scoped crew picker.
 *
 * Existing gezels attach in one click. Catalog roles that do not have an
 * instance in the global roster open a small character step first, except in
 * boring mode where role identity is the whole point and the template is
 * created immediately. The effective project type's role affinity promotes
 * both existing people and uncreated role templates into one recommendation
 * section; detection remains advisory and never changes the crew by itself.
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
  const projectType = getProjectType(resolveProjectTypeId(project));

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
  const roleAffinities = useMemo(() => {
    const result = new Map<string, ProjectRoleAffinity>();
    let rank = 0;
    for (const role of projectType?.gezelRoles.default ?? []) {
      result.set(role.templateId, { ...role, tier: 'default', rank: rank++ });
    }
    for (const role of projectType?.gezelRoles.suggested ?? []) {
      if (!result.has(role.templateId)) {
        result.set(role.templateId, { ...role, tier: 'suggested', rank: rank++ });
      }
    }
    return result;
  }, [projectType]);
  const affinityByRoleIdentity = useMemo(() => {
    const result = new Map<string, ProjectRoleAffinity>();
    for (const template of templates) {
      const affinity = roleAffinities.get(template.manifest.id);
      if (!affinity) continue;
      for (const identity of [
        roleIdentity(template.manifest.role),
        roleIdentity(template.manifest.name),
      ]) {
        if (identity && !result.has(identity)) result.set(identity, affinity);
      }
    }
    return result;
  }, [roleAffinities, templates]);
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
  const affinityForGezel = useCallback(
    (gezel: GezelSummary): ProjectRoleAffinity | undefined => {
      if (gezel.templateId) {
        const templateAffinity = roleAffinities.get(gezel.templateId);
        if (templateAffinity) return templateAffinity;
      }
      for (const identity of [roleIdentity(gezel.role), roleIdentity(gezel.roleBasedName)]) {
        const roleAffinity = affinityByRoleIdentity.get(identity);
        if (roleAffinity) return roleAffinity;
      }
      return undefined;
    },
    [affinityByRoleIdentity, roleAffinities],
  );
  const suggestedOptions = useMemo(() => {
    const result: SuggestedRoleOption[] = [];
    for (const gezel of availableGezels) {
      const affinity = affinityForGezel(gezel);
      if (affinity) result.push({ kind: 'existing', gezel, affinity });
    }
    for (const template of availableTemplates) {
      const affinity = roleAffinities.get(template.manifest.id);
      if (affinity) result.push({ kind: 'template', template, affinity });
    }
    return result.sort(
      (a, b) =>
        a.affinity.rank - b.affinity.rank ||
        (a.kind === 'existing'
          ? displayName(a.gezel, roleBasedNameOnlyMode)
          : a.template.manifest.name
        ).localeCompare(
          b.kind === 'existing'
            ? displayName(b.gezel, roleBasedNameOnlyMode)
            : b.template.manifest.name,
        ),
    );
  }, [
    affinityForGezel,
    availableGezels,
    availableTemplates,
    roleAffinities,
    roleBasedNameOnlyMode,
  ]);
  const suggestedGezelIds = useMemo(
    () =>
      new Set(
        suggestedOptions.flatMap((option) => (option.kind === 'existing' ? [option.gezel.id] : [])),
      ),
    [suggestedOptions],
  );
  const suggestedTemplateIds = useMemo(
    () =>
      new Set(
        suggestedOptions.flatMap((option) =>
          option.kind === 'template' ? [option.template.manifest.id] : [],
        ),
      ),
    [suggestedOptions],
  );
  const otherAvailableGezels = useMemo(
    () => availableGezels.filter((gezel) => !suggestedGezelIds.has(gezel.id)),
    [availableGezels, suggestedGezelIds],
  );
  const otherAvailableTemplates = useMemo(
    () => availableTemplates.filter((template) => !suggestedTemplateIds.has(template.manifest.id)),
    [availableTemplates, suggestedTemplateIds],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSuggestedOptions = useMemo(
    () =>
      normalizedQuery
        ? suggestedOptions.filter((option) =>
            option.kind === 'existing'
              ? gezelMatchesQuery(option.gezel, normalizedQuery, roleBasedNameOnlyMode)
              : templateMatchesQuery(option.template, normalizedQuery),
          )
        : suggestedOptions,
    [normalizedQuery, roleBasedNameOnlyMode, suggestedOptions],
  );
  const visibleGezels = useMemo(
    () =>
      normalizedQuery
        ? otherAvailableGezels.filter((gezel) =>
            gezelMatchesQuery(gezel, normalizedQuery, roleBasedNameOnlyMode),
          )
        : otherAvailableGezels,
    [normalizedQuery, otherAvailableGezels, roleBasedNameOnlyMode],
  );
  const visibleTemplates = useMemo(
    () =>
      normalizedQuery
        ? otherAvailableTemplates.filter((item) => templateMatchesQuery(item, normalizedQuery))
        : otherAvailableTemplates,
    [normalizedQuery, otherAvailableTemplates],
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
                {visibleSuggestedOptions.length > 0 && (
                  <section
                    className="project-add-gezel-suggestions"
                    aria-labelledby="project-add-suggested-title"
                  >
                    <h4 id="project-add-suggested-title">Suggested for this project type</h4>
                    {projectType && (
                      <p className="muted small project-add-gezel-section-hint">
                        {projectType.label} projects often benefit from these roles.
                      </p>
                    )}
                    <ul className="project-add-gezel-list">
                      {visibleSuggestedOptions.map((option) => {
                        const badge =
                          option.affinity.tier === 'default' ? 'Core role' : 'Suggested';
                        if (option.kind === 'existing') {
                          const rendered = displayName(option.gezel, roleBasedNameOnlyMode);
                          return (
                            <li key={`existing:${option.gezel.id}`}>
                              <button
                                type="button"
                                className="project-add-gezel-option"
                                disabled={busy}
                                onClick={() => void addExisting(option.gezel.id)}
                              >
                                <GezelIcon
                                  svg={option.gezel.icon ?? null}
                                  poppetje={option.gezel.poppetje}
                                  iconOverride={option.gezel.iconOverride}
                                  name={rendered}
                                  size={36}
                                />
                                <span className="project-add-gezel-option-copy">
                                  <span className="project-add-gezel-option-name">{rendered}</span>
                                  <span className="muted small">
                                    {option.gezel.role ?? 'Gezel'} · {option.affinity.reason}
                                  </span>
                                </span>
                                <span className="gz-badge">{badge}</span>
                              </button>
                            </li>
                          );
                        }
                        return (
                          <li key={`template:${option.template.manifest.id}`}>
                            <button
                              type="button"
                              className="project-add-gezel-option"
                              disabled={busy}
                              onClick={() => chooseTemplate(option.template)}
                            >
                              <GezelIcon
                                poppetje={initialPoppetjeForGezel(
                                  `project-role:${option.template.manifest.id}`,
                                  option.template.manifest.name,
                                )}
                                name={option.template.manifest.name}
                                size={36}
                              />
                              <span className="project-add-gezel-option-copy">
                                <span className="project-add-gezel-option-name">
                                  {option.template.manifest.name}
                                </span>
                                <span className="muted small">{option.affinity.reason}</span>
                              </span>
                              <span className="gz-badge">{badge}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}

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
                      {otherAvailableGezels.length > 0
                        ? 'No workshop gezels match that search.'
                        : suggestedOptions.some((option) => option.kind === 'existing')
                          ? 'No other workshop gezels are available.'
                          : 'Every available gezel is already on this project.'}
                    </p>
                  )}
                </section>

                <section aria-labelledby="project-add-role-title">
                  <h4 id="project-add-role-title">Add a new gezel for a role</h4>
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
                        {otherAvailableTemplates.length > 0
                          ? 'No new roles match that search.'
                          : suggestedOptions.some((option) => option.kind === 'template')
                            ? 'No other role types are available.'
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
