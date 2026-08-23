import {
  type GezelDetail,
  type GezelGender,
  type RoleId,
  inferGenderForName,
  pickRandomNameWithGender,
  resolveRoleId,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { resolveGildeTemplateForRole } from './ensure.js';

export type AutonomousRole = 'boekwachter' | 'developer';

interface AutonomousRoleDefinition {
  role: string;
  templateId?: string;
  /** Install-wide designation, where the role has one. */
  configKey?: 'boekwachterGezelId';
  /**
   * Canonical role ids that also count as wearing this hat, matched through
   * core's role registry so free-form roles ("Senior Software Engineer") land
   * the same way they do everywhere else in the product.
   */
  roleIds?: readonly RoleId[];
}

const ROLE_DEFINITIONS: Record<AutonomousRole, AutonomousRoleDefinition> = {
  boekwachter: {
    role: 'Boekwachter',
    templateId: 'boekwachter',
    configKey: 'boekwachterGezelId',
  },
  // No install-wide designation and no single canonical template: a project
  // has whichever developer the user put on its crew, and "developer" is a
  // free-form role people spell a dozen ways. The registry does that matching
  // already — the same set the issue-fix dialog filters on.
  developer: {
    role: 'Developer',
    roleIds: ['developer', 'web-developer'],
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
  const acceptedRoleIds = new Set<RoleId>(definition.roleIds ?? []);
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
  const designatedId = definition.configKey ? config?.[definition.configKey] : undefined;
  if (designatedId) {
    const designated = members.find((gezel) => gezel.id === designatedId);
    if (designated) return designated;
  }

  const roleKey = normalized(definition.role);
  const templateKey = definition.templateId ? normalized(definition.templateId) : null;
  const matchesRoleId = (gezel: GezelDetail): boolean => {
    if (acceptedRoleIds.size === 0) return false;
    // `fixedFunction` gezels run a single scripted job and cannot take on
    // open-ended work, so they never satisfy an autonomous role.
    if (gezel.fixedFunction) return false;
    const id = resolveRoleId(gezel.role) ?? resolveRoleId(gezel.roleBasedName);
    return id !== null && acceptedRoleIds.has(id);
  };
  return (
    members.find(
      (gezel) =>
        normalized(gezel.role) === roleKey ||
        (templateKey !== null && normalized(gezel.templateId) === templateKey) ||
        matchesRoleId(gezel),
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
 * The developer on this project's crew, or null.
 *
 * Deliberately never recruits — unlike `ensureGezel({ jobTitle })`, which the
 * user-initiated paths use. Overnight bug fixing turns itself on from crew
 * composition, so conjuring the very gezel that unlocks it would make the
 * gate meaningless and start spending model time on a project the user never
 * staffed for it.
 */
export function resolveProjectDeveloper(
  store: Store,
  projectId: string,
): Promise<GezelDetail | null> {
  return resolveProjectAutonomousGezel(store, projectId, 'developer');
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
    if (existing) {
      // An install that already has the seat filled still needs the role
      // added to a project created after the fact (the shared library on an
      // upgrade). Only for explicitly named projects — the undefined case
      // stays a pure no-op, so an existing roster is never re-broadened.
      await recruitBoekwachterTo(store, existing.id, opts.recruitProjectIds);
      return existing;
    }
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
  await recruitBoekwachterTo(store, ensured.id, opts.recruitProjectIds, { allProjects: true });
  return ensured;
}

/**
 * Add the Boekwachter to project rosters. `projectIds` undefined means "every
 * project" only on a first ensure (`allProjects`); otherwise it means "none",
 * so a later call cannot quietly re-add a role the user removed.
 */
async function recruitBoekwachterTo(
  store: Store,
  gezelId: string,
  projectIds: string[] | undefined,
  opts: { allProjects?: boolean } = {},
): Promise<void> {
  if (projectIds === undefined && !opts.allProjects) return;
  const projects = await store.listProjects().catch(() => []);
  const recruit =
    projectIds === undefined ? projects : projects.filter((p) => projectIds.includes(p.id));
  await Promise.all(
    recruit.map((project) =>
      store.addGezelToProject(project.id, gezelId, { source: 'manual' }).catch(() => ({
        added: false,
      })),
    ),
  );
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
