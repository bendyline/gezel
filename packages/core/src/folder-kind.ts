/**
 * What a folder a person added mostly holds. It picks the folder's crew when
 * the person adds it (the Boekwachter always, plus a lead suited to the kind)
 * and which night work fits it: proposed code fixes only for code.
 */
export const FOLDER_KINDS = ['pictures', 'documents', 'code', 'mixed'] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

/** Project property recording the kind, stamped when the folder's crew is recruited. */
export const FOLDER_KIND_PROPERTY = 'gezel.folderKind';

/**
 * When the crew was recruited for an added folder. Recruitment runs once, so
 * a gezel the person later removes from the folder is never re-added.
 */
export const CREW_RECRUITED_AT_PROPERTY = 'gezel.crewRecruitedAt';

export function folderKindOf(project: {
  properties?: Record<string, string>;
}): FolderKind | undefined {
  const value = project.properties?.[FOLDER_KIND_PROPERTY];
  return (FOLDER_KINDS as readonly string[]).includes(value ?? '')
    ? (value as FolderKind)
    : undefined;
}

/** Share of files at which a folder counts as mostly code: repositories carry docs and assets too. */
const CODE_SHARE = 0.3;
/** Share of files at which a folder counts as mostly one kind of content. */
const CONTENT_SHARE = 0.6;

/**
 * The kind of an added folder: a well-known Pictures or Documents folder is
 * that kind; a codebase (by detected project type or file mix) is code;
 * otherwise the file mix decides, and a folder with no clear majority is mixed.
 */
export function inferFolderKind(input: {
  /** `gezel.wellKnownKind`, when the folder is a well-known one. */
  wellKnownKind?: string | undefined;
  /** Whether the project's detected or chosen type is a coding type. */
  coding?: boolean;
  /** File counts by modality (the index's vocabulary: code, doc, text, image, video, …). */
  modalities?: Record<string, number> | null | undefined;
}): FolderKind {
  if (input.wellKnownKind === 'pictures') return 'pictures';
  if (input.wellKnownKind === 'documents') return 'documents';
  if (input.coding) return 'code';
  const counts = input.modalities ?? {};
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  if (total === 0) return 'mixed';
  const share = (...keys: string[]) => keys.reduce((n, k) => n + (counts[k] ?? 0), 0) / total;
  if (share('code') >= CODE_SHARE) return 'code';
  if (share('image', 'video') >= CONTENT_SHARE) return 'pictures';
  if (share('doc', 'text', 'email') >= CONTENT_SHARE) return 'documents';
  return 'mixed';
}

/**
 * Project property: `on` or `off` when the person explicitly chooses overnight
 * work. Unset means on for ordinary projects, off for the Default catch-all.
 * One switch: the nightly sweep, fix planning and the folder's armed night
 * work all stand down.
 */
export const NIGHT_WORK_PROPERTY = 'gezel.nightWork';

/** When resident night work was armed for an added folder; arming runs once. */
export const NIGHT_WORK_ARMED_AT_PROPERTY = 'gezel.nightWorkArmedAt';

export function projectNightWorkEnabled(project: {
  id: string;
  properties?: Record<string, string>;
}): boolean {
  const setting = project.properties?.[NIGHT_WORK_PROPERTY];
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return project.id !== 'default';
}

/**
 * What the crew does with a newly added folder overnight, in the person's
 * words: the lines under "Tonight your crew will…" on the add-folder sheet and
 * the onboarding cards. Only promises the nightly sweep keeps for every kind;
 * armed night books add their own lines.
 */
export function describeFolderNightWork(kind: FolderKind): string[] {
  const read = 'Read every file, so you and your crew can search it';
  switch (kind) {
    case 'pictures':
      return [read, 'Describe your photos, so you can find one by what is in it'];
    case 'documents':
      return [read, 'Summarize your documents'];
    case 'code':
      return [
        read,
        'Summarize and review the code',
        'Draft fixes for what it finds, for you to approve',
      ];
    case 'mixed':
      return [read, 'Summarize documents and describe photos'];
  }
}

/** The crew a folder of this kind gets, by role. */
export function folderCrewRoles(kind: FolderKind): string[] {
  return kind === 'code' ? ['Boekwachter', 'Builder'] : ['Boekwachter'];
}
