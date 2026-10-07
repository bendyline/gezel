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
