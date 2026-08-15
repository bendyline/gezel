import {
  type GezelSummary,
  type ProjectTypeGezelRole,
  getProjectType,
  resolveProjectTypeId,
} from '@bendyline/gezel';
import type { PickerItem } from './components/Picker.js';

/**
 * Item construction and argument resolution for the TUI's `/gezel` command.
 *
 * Two jobs, both pure so they can be tested without a running daemon:
 *
 *  - {@link buildGezelPickerItems} turns the project roster plus the whole
 *    gilde role catalog into one sectioned list. The picker used to show only
 *    gezels already on the project, labelled with a bare role word — which
 *    left the Dutch-named roles (Boekwachter, Klerk, Ceremoniemeester)
 *    unexplained and gave no way to bring on a role the project lacks.
 *  - {@link resolveGezelArg} backs `/gezel <role or name>`, the "ensure" form:
 *    reuse a matching gezel when one exists, otherwise name the template to
 *    create from.
 */

/** The subset of a catalog gezel-template the picker needs. */
export interface GezelTemplateChoice {
  id: string;
  name: string;
  role: string;
  description: string;
}

export interface GezelPickerInputs {
  gezels: readonly GezelSummary[];
  templates: readonly GezelTemplateChoice[];
  /** Gezel ids already on the project (roster + voorman). */
  memberIds: readonly string[];
  /** Project record, for resolving the type that drives role affinity. */
  project?: {
    projectTypeId?: string | undefined;
    detectedProjectType?: { id: string } | undefined;
  };
  /** Render role-based names instead of given names (the TUI's `boring` mode). */
  roleBasedNameOnly?: boolean;
  /** Terminal width available for a hint before it is clipped. */
  hintWidth?: number;
}

/** `gezel:<id>` selects an existing gezel; `template:<id>` recruits a new one. */
export type GezelPickerValue = string;

export const GEZEL_VALUE_PREFIX = 'gezel:';
export const TEMPLATE_VALUE_PREFIX = 'template:';

/**
 * Role templates ordered by how central they are to an ordinary crew, most
 * core first. Used for the "Core roles" section and as the tiebreak inside the
 * project-type recommendations.
 *
 * Hand-ordered rather than derived: core's role registry knows which ids are
 * canonical but says nothing about their relative centrality, and the catalog
 * manifest carries no coreness field. Voorman leads because a project that
 * needs more hands needs someone to run them first — that is the escalation
 * the Builder's about.md tells it to offer.
 */
export const CORE_ROLE_ORDER: readonly string[] = [
  'voorman',
  'builder',
  'developer',
  'reviewer',
  'planner',
  'researcher',
  'designer',
  'copywriter',
  'meester',
  'image-generator',
  'video-generator',
];

const SECTION_IN_PROJECT = 'In this project';
const SECTION_RECOMMENDED = 'Recommended for this project';
const SECTION_OTHER_GEZELS = 'Your other gezels';
const SECTION_CORE = 'Core roles';
const SECTION_MORE = 'More roles';

const DEFAULT_HINT_WIDTH = 76;

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  return `${flat.slice(0, Math.max(1, width - 1)).trimEnd()}…`;
}

/** Lowercased comparison key for a role/name string; '' when absent. */
function roleIdentity(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function displayName(gezel: GezelSummary, roleBasedNameOnly: boolean): string {
  if (roleBasedNameOnly) return gezel.roleBasedName ?? gezel.role ?? gezel.id;
  return gezel.name;
}

/**
 * Role affinity for the project's type, `default` tier before `suggested`,
 * keyed by template id. Empty when the project has no resolved type — which is
 * why the folder scan behind `detectedProjectType` matters here.
 */
function affinityRanks(
  project: GezelPickerInputs['project'],
): Map<string, { rank: number; reason: string }> {
  const type = getProjectType(resolveProjectTypeId(project ?? {}));
  const out = new Map<string, { rank: number; reason: string }>();
  let rank = 0;
  const add = (role: ProjectTypeGezelRole): void => {
    if (!out.has(role.templateId)) out.set(role.templateId, { rank: rank++, reason: role.reason });
  };
  for (const role of type?.gezelRoles.default ?? []) add(role);
  for (const role of type?.gezelRoles.suggested ?? []) add(role);
  return out;
}

/**
 * Describe an existing gezel: its own description when it has one, else the
 * description of the template it came from, else its bare role. Keeps the
 * Dutch-named roles explained wherever they appear.
 */
function gezelHint(
  gezel: GezelSummary,
  templatesById: Map<string, GezelTemplateChoice>,
  roleBasedNameOnly: boolean,
): string {
  const role = roleBasedNameOnly ? undefined : (gezel.roleBasedName ?? gezel.role);
  const about =
    gezel.description ??
    (gezel.templateId ? templatesById.get(gezel.templateId)?.description : undefined);
  return [role, about].filter(Boolean).join(' · ');
}

/**
 * Build the sectioned `/gezel` list: gezels already on the project, then the
 * roles this project's type calls for, then the rest of the gilde ordered by
 * how core the role is.
 *
 * A template whose role is already filled by an existing gezel is dropped —
 * offering "Builder" as a new recruit next to the Builder already running the
 * project is the confusing case the desktop dialog avoids the same way.
 */
export function buildGezelPickerItems(inputs: GezelPickerInputs): PickerItem[] {
  const {
    gezels,
    templates,
    memberIds,
    project,
    roleBasedNameOnly = false,
    hintWidth = DEFAULT_HINT_WIDTH,
  } = inputs;

  const templatesById = new Map(templates.map((t) => [t.id, t]));
  const members = new Set(memberIds);
  const affinity = affinityRanks(project);

  const filledTemplateIds = new Set(gezels.flatMap((g) => (g.templateId ? [g.templateId] : [])));
  const filledRoleIdentities = new Set(
    gezels.flatMap((g) => [roleIdentity(g.role), roleIdentity(g.roleBasedName)].filter(Boolean)),
  );

  const coreRank = new Map(CORE_ROLE_ORDER.map((id, index) => [id, index]));
  const items: PickerItem[] = [];
  const push = (section: string, item: Omit<PickerItem, 'section'>): void => {
    items.push({ ...item, section });
  };

  const gezelItem = (gezel: GezelSummary): Omit<PickerItem, 'section'> => ({
    label: displayName(gezel, roleBasedNameOnly),
    value: `${GEZEL_VALUE_PREFIX}${gezel.id}`,
    hint: clip(gezelHint(gezel, templatesById, roleBasedNameOnly), hintWidth),
  });

  const templateItem = (
    template: GezelTemplateChoice,
    reason?: string,
  ): Omit<PickerItem, 'section'> => ({
    label: template.name,
    value: `${TEMPLATE_VALUE_PREFIX}${template.id}`,
    hint: clip(reason ?? template.description, hintWidth),
  });

  // 1. On the project already — selecting one switches to it.
  const onProject = gezels.filter((g) => members.has(g.id));
  for (const gezel of sortByName(onProject, roleBasedNameOnly)) {
    push(SECTION_IN_PROJECT, gezelItem(gezel));
  }

  // 2. What this project's type calls for. Existing gezels first: bringing one
  //    onto the roster is always cheaper than recruiting a duplicate.
  const offProject = gezels.filter((g) => !members.has(g.id));
  const affinityFor = (gezel: GezelSummary): { rank: number; reason: string } | undefined => {
    if (gezel.templateId && affinity.has(gezel.templateId)) return affinity.get(gezel.templateId);
    for (const [templateId, entry] of affinity) {
      const template = templatesById.get(templateId);
      if (!template) continue;
      if (
        roleIdentity(template.role) === roleIdentity(gezel.role) ||
        roleIdentity(template.name) === roleIdentity(gezel.roleBasedName)
      ) {
        return entry;
      }
    }
    return undefined;
  };

  const recommendedGezels = offProject
    .flatMap((gezel) => {
      const entry = affinityFor(gezel);
      return entry ? [{ gezel, entry }] : [];
    })
    .sort((a, b) => a.entry.rank - b.entry.rank);
  const recommendedGezelIds = new Set(recommendedGezels.map((r) => r.gezel.id));

  const availableTemplates = templates.filter(
    (template) =>
      !filledTemplateIds.has(template.id) &&
      !filledRoleIdentities.has(roleIdentity(template.role)) &&
      !filledRoleIdentities.has(roleIdentity(template.name)),
  );
  const recommendedTemplates = availableTemplates
    .flatMap((template) => {
      const entry = affinity.get(template.id);
      return entry ? [{ template, entry }] : [];
    })
    .sort((a, b) => a.entry.rank - b.entry.rank);
  const recommendedTemplateIds = new Set(recommendedTemplates.map((r) => r.template.id));

  for (const { gezel, entry } of recommendedGezels) {
    push(SECTION_RECOMMENDED, { ...gezelItem(gezel), hint: clip(entry.reason, hintWidth) });
  }
  for (const { template, entry } of recommendedTemplates) {
    push(SECTION_RECOMMENDED, templateItem(template, entry.reason));
  }

  // 3. Gezels that exist but belong to no part of this project's shape.
  for (const gezel of sortByName(
    offProject.filter((g) => !recommendedGezelIds.has(g.id)),
    roleBasedNameOnly,
  )) {
    push(SECTION_OTHER_GEZELS, gezelItem(gezel));
  }

  // 4. + 5. The rest of the gilde: core roles by centrality, then everything
  //    else alphabetically so the long tail stays findable.
  const remaining = availableTemplates.filter((t) => !recommendedTemplateIds.has(t.id));
  const core = remaining
    .filter((t) => coreRank.has(t.id))
    .sort((a, b) => (coreRank.get(a.id) ?? 0) - (coreRank.get(b.id) ?? 0));
  const more = remaining
    .filter((t) => !coreRank.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const template of core) push(SECTION_CORE, templateItem(template));
  for (const template of more) push(SECTION_MORE, templateItem(template));

  return items;
}

function sortByName(
  gezels: readonly GezelSummary[],
  roleBasedNameOnly: boolean,
): readonly GezelSummary[] {
  return [...gezels].sort((a, b) =>
    displayName(a, roleBasedNameOnly).localeCompare(displayName(b, roleBasedNameOnly)),
  );
}

export type GezelArgResolution =
  | { kind: 'gezel'; gezelId: string }
  | { kind: 'template'; templateId: string }
  | { kind: 'ambiguous'; labels: string[] }
  | { kind: 'unknown' };

/**
 * Resolve `/gezel <arg>` to something to switch to or recruit.
 *
 * Existing gezels win over templates at every match strength: `/gezel voorman`
 * on a project that already has one must land on that voorman rather than
 * recruit a second. Exact matches win over prefix matches, and an ambiguous
 * prefix reports its candidates instead of guessing.
 */
export function resolveGezelArg(
  arg: string,
  inputs: { gezels: readonly GezelSummary[]; templates: readonly GezelTemplateChoice[] },
): GezelArgResolution {
  const query = arg.trim().toLowerCase();
  if (!query) return { kind: 'unknown' };
  const { gezels, templates } = inputs;

  const gezelKeys = (g: GezelSummary): string[] =>
    [g.id, g.name, g.roleBasedName, g.role].map(roleIdentity).filter(Boolean);
  const templateKeys = (t: GezelTemplateChoice): string[] =>
    [t.id, t.role, t.name].map(roleIdentity).filter(Boolean);

  const exactGezel = gezels.find((g) => gezelKeys(g).includes(query));
  if (exactGezel) return { kind: 'gezel', gezelId: exactGezel.id };
  const exactTemplate = templates.find((t) => templateKeys(t).includes(query));
  if (exactTemplate) return { kind: 'template', templateId: exactTemplate.id };

  const prefixGezels = gezels.filter((g) => gezelKeys(g).some((k) => k.startsWith(query)));
  if (prefixGezels.length === 1) return { kind: 'gezel', gezelId: prefixGezels[0]!.id };
  if (prefixGezels.length > 1) {
    return { kind: 'ambiguous', labels: prefixGezels.map((g) => g.name) };
  }

  const prefixTemplates = templates.filter((t) => templateKeys(t).some((k) => k.startsWith(query)));
  if (prefixTemplates.length === 1) return { kind: 'template', templateId: prefixTemplates[0]!.id };
  if (prefixTemplates.length > 1) {
    return { kind: 'ambiguous', labels: prefixTemplates.map((t) => t.name) };
  }

  return { kind: 'unknown' };
}
