import {
  type GezelDetail,
  type GezelGender,
  inferGenderForName,
  pickRandomNameWithGender,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { resolveGildeTemplateForRole } from './ensure.js';

export type AutonomousRole = 'boekwachter';

const ROLE_DEFINITIONS: Record<
  AutonomousRole,
  { role: string; templateId: string; configKey: 'boekwachterGezelId' }
> = {
  boekwachter: {
    role: 'Boekwachter',
    templateId: 'boekwachter',
    configKey: 'boekwachterGezelId',
  },
};

function normalized(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Resolve the concrete gezel who performs an autonomous role for one
 * project. Project membership is the capability switch: the designated
 * install-wide gezel wins when present, then a project-local/shared gezel
 * whose role or source template matches can wear the same hat.
 *
 * Keeping this generic gives future night-shift roles one place to define
 * the "role present on the team → autonomous work enabled" convention.
 */
export async function resolveProjectAutonomousGezel(
  store: Store,
  projectId: string,
  role: AutonomousRole,
): Promise<GezelDetail | null> {
  const [project, config] = await Promise.all([
    store.getProject(projectId).catch(() => null),
    store.readConfig().catch(() => null),
  ]);
  if (!project) return null;

  const definition = ROLE_DEFINITIONS[role];
  const memberIds = Array.from(
    new Set([
      ...(project.gezelIds ?? []),
      ...(project.voormanGezelId ? [project.voormanGezelId] : []),
    ]),
  );
  if (memberIds.length === 0) return null;

  const members = (
    await Promise.all(memberIds.map((id) => store.getGezel(id).catch(() => null)))
  ).filter((gezel): gezel is GezelDetail => gezel !== null);
  const designatedId = config?.[definition.configKey];
  if (designatedId) {
    const designated = members.find((gezel) => gezel.id === designatedId);
    if (designated) return designated;
  }

  const roleKey = normalized(definition.role);
  const templateKey = normalized(definition.templateId);
  return (
    members.find(
      (gezel) => normalized(gezel.role) === roleKey || normalized(gezel.templateId) === templateKey,
    ) ?? null
  );
}

export function resolveProjectBoekwachter(
  store: Store,
  projectId: string,
): Promise<GezelDetail | null> {
  return resolveProjectAutonomousGezel(store, projectId, 'boekwachter');
}

/**
 * Create the canonical gilde Boekwachter and designate them install-wide.
 * This intentionally instantiates the shipped template rather than keeping
 * a second prompt copy in the service.
 */
export async function createFreshBoekwachter(
  store: Store,
  catalog: CatalogService,
  preferredName?: string,
): Promise<GezelDetail> {
  const resolved = await resolveGildeTemplateForRole(catalog, 'Boekwachter');
  if (!resolved || resolved.templateId !== ROLE_DEFINITIONS.boekwachter.templateId) {
    throw new Error('The canonical Boekwachter template is unavailable.');
  }

  let name: string;
  let gender: GezelGender;
  const chosen = preferredName?.trim();
  if (chosen) {
    name = chosen;
    gender = inferGenderForName(chosen);
  } else {
    const random = pickRandomNameWithGender();
    name = random.name;
    gender = random.gender;
  }

  const created = await store.createGezel({
    name,
    gender,
    role: resolved.role,
    about: resolved.about,
    templateId: resolved.templateId,
    templateVersion: resolved.templateVersion,
    ...(resolved.frontmatter ? { frontmatter: resolved.frontmatter } : {}),
  });
  await store.writeConfig({ boekwachterGezelId: created.id });
  return created;
}

/**
 * Ensure the install always has a real, prompt-backed Boekwachter. On the
 * migration from anonymous indexing, recruit the resolved gezel to
 * every existing project so current installs keep their former AI-indexing
 * behavior. From then on, users opt individual projects out by removing the
 * role from that project's roster.
 */
export async function ensureDefaultBoekwachter(
  store: Store,
  catalog: CatalogService,
  opts: { recruitProjectIds?: string[] } = {},
): Promise<GezelDetail> {
  const config = await store.readConfig();
  if (config.boekwachterGezelId) {
    const existing = await store.getGezel(config.boekwachterGezelId).catch(() => null);
    if (existing) return existing;
  }

  const roster = await store.listGezels().catch(() => []);
  const existingRole = roster.find(
    (gezel) =>
      normalized(gezel.role) === normalized(ROLE_DEFINITIONS.boekwachter.role) ||
      normalized(gezel.templateId) === normalized(ROLE_DEFINITIONS.boekwachter.templateId),
  );
  const ensured = existingRole
    ? await store.getGezel(existingRole.id)
    : await createFreshBoekwachter(store, catalog);
  if (!ensured) throw new Error('Failed to ensure the Boekwachter gezel.');
  if (existingRole) await store.writeConfig({ boekwachterGezelId: ensured.id });
  const projects = await store.listProjects().catch(() => []);
  const recruit =
    opts.recruitProjectIds === undefined
      ? projects
      : projects.filter((project) => opts.recruitProjectIds?.includes(project.id));
  await Promise.all(
    recruit.map((project) =>
      store.addGezelToProject(project.id, ensured.id, { source: 'manual' }).catch(() => ({
        added: false,
      })),
    ),
  );
  return ensured;
}

/**
 * Move the install-wide Boekwachter seat without silently changing which
 * projects have opted into the role: only rosters that contained the old
 * designation are transferred to the new one.
 */
export async function transferBoekwachterMembership(
  store: Store,
  previousGezelId: string | undefined,
  nextGezelId: string,
): Promise<void> {
  if (!previousGezelId || previousGezelId === nextGezelId) return;
  const projects = await store.listProjects().catch(() => []);
  await Promise.all(
    projects.map(async (project) => {
      if (!project.gezelIds?.includes(previousGezelId)) return;
      await store.removeGezelFromProject(project.id, previousGezelId, { source: 'manual' });
      await store.addGezelToProject(project.id, nextGezelId, { source: 'manual' });
    }),
  );
}
