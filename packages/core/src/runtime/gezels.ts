import { assertSafeEntityId, isSafeEntityId } from '../entity-id.js';
import { parseGezelMarkdown, serializeGezelMarkdown } from '../markdown/gezel-md.js';
import { type Poppetje, PoppetjeSchema } from '../poppetje/schema.js';
import { initialPoppetjeForGezel, poppetjeFromSeed } from '../poppetje/seed.js';
import {
  type CreateGezelRequest,
  CreateGezelRequestSchema,
  RerollGezelPoppetjeRequestSchema,
} from '../schemas/api.js';
import {
  type GezelDetail,
  GezelDetailSchema,
  type GezelFrontmatter,
  GezelFrontmatterSchema,
  type GezelGender,
  type GezelSummary,
  GezelSummarySchema,
} from '../schemas/gezel.js';
import { pickRoleBasedName, slugifyEntityName } from './entities.js';
import { boundedText } from './files.js';
import type { PortableRepository } from './repository.js';

/** Template metadata is supplied by trusted catalog resolution, never the public create body. */
export type PortableCreateGezelInput = CreateGezelRequest & {
  templateId?: string;
  templateVersion?: string;
  frontmatter?: Partial<GezelFrontmatter>;
};

export function gezelRoot(id: string): string {
  assertSafeEntityId(id, 'gezel id');
  return `gezels/${id}`;
}
export function gezelWrites(
  repo: PortableRepository,
  input: PortableCreateGezelInput & { id: string; roleBasedName?: string; poppetje?: unknown },
): Map<string, Uint8Array> {
  const root = gezelRoot(input.id);
  const frontmatter = GezelFrontmatterSchema.parse({ ...input.frontmatter, ...input });
  const source = serializeGezelMarkdown({ frontmatter, sections: [], source: '' });
  const poppetje = PoppetjeSchema.parse(
    input.poppetje ?? initialPoppetjeForGezel(input.id, input.name, input.gender),
  );
  if (poppetje.key !== input.id) throw new Error('Poppetje key must match its gezel');
  return new Map([
    [`${root}/gezel.md`, boundedText(source)],
    [
      `${root}/about.md`,
      boundedText(
        input.about ??
          `You are a thoughtful ${input.role?.trim() || 'companion'}. Help the user with clear, practical answers.`,
      ),
    ],
    [`${root}/poppetje.json`, repo.json(poppetje)],
  ]);
}
export async function getGezel(repo: PortableRepository, id: string): Promise<GezelDetail | null> {
  const root = gezelRoot(id);
  const source = await repo.text(`${root}/gezel.md`);
  if (source === null) return null;
  const parsed = parseGezelMarkdown(source);
  if (parsed.frontmatter.id && parsed.frontmatter.id !== id)
    throw new Error('Gezel identity does not match its directory');
  const poppetje = await resolvePoppetje(
    repo,
    id,
    parsed.frontmatter.name,
    parsed.frontmatter.gender,
  );
  const metadata = (await repo.list(root)).find((entry) => entry.name === 'gezel.md');
  return GezelDetailSchema.parse({
    ...parsed.frontmatter,
    id,
    parsed,
    about: (await repo.text(`${root}/about.md`)) ?? '',
    ...(poppetje ? { poppetje } : {}),
    updatedAt: new Date(metadata?.mtime ?? 0).toISOString(),
    toolsMd: null,
  });
}
export async function requireGezel(repo: PortableRepository, id: string): Promise<GezelDetail> {
  const gezel = await getGezel(repo, id);
  if (!gezel) throw new Error(`Gezel ${id} could not be found`);
  return gezel;
}
export async function listGezels(repo: PortableRepository): Promise<GezelSummary[]> {
  const gezels: GezelSummary[] = [];
  for (const entry of await repo.list('gezels')) {
    if (!entry.isDirectory || !isSafeEntityId(entry.name)) continue;
    const gezel = await repo.listed(`gezel ${entry.name}`, () => getGezel(repo, entry.name));
    if (gezel) gezels.push(GezelSummarySchema.parse(gezel));
  }
  return gezels.sort((a, b) => a.name.localeCompare(b.name));
}
export async function createGezel(
  repo: PortableRepository,
  raw: PortableCreateGezelInput,
): Promise<GezelDetail> {
  const input = CreateGezelRequestSchema.parse(raw);
  if (!input.name.trim()) throw new Error('A gezel name is required');
  const id = await repo.uniqueId('gezels', slugifyEntityName(input.name) || repo.createId());
  const taken = new Set(
    (await listGezels(repo)).flatMap((gezel) => (gezel.roleBasedName ? [gezel.roleBasedName] : [])),
  );
  await repo.transactions.commit(
    gezelWrites(repo, {
      ...input,
      templateId: raw.templateId,
      templateVersion: raw.templateVersion,
      frontmatter: raw.frontmatter,
      id,
      roleBasedName: pickRoleBasedName(input.role, taken),
    }),
    [],
    [`${gezelRoot(id)}/sessions`],
  );
  return (await getGezel(repo, id))!;
}
export async function updateGezelAbout(
  repo: PortableRepository,
  id: string,
  about: string,
): Promise<GezelDetail> {
  await requireGezel(repo, id);
  await repo.transactions.commit(new Map([[`${gezelRoot(id)}/about.md`, boundedText(about)]]));
  return (await getGezel(repo, id))!;
}
export async function updateGezelMarkdown(
  repo: PortableRepository,
  id: string,
  source: string,
): Promise<GezelDetail> {
  const before = await requireGezel(repo, id);
  const parsed = parseGezelMarkdown(source);
  if (parsed.frontmatter.id && parsed.frontmatter.id !== id)
    throw new Error('Renaming the gezel id is not supported');
  if (!parsed.frontmatter.name.trim()) throw new Error('A gezel name is required');
  parsed.frontmatter.name = parsed.frontmatter.name.trim();
  parsed.frontmatter.id = id;
  if (parsed.frontmatter.role !== before.role || !parsed.frontmatter.roleBasedName) {
    const taken = new Set(
      (await listGezels(repo))
        .filter((gezel) => gezel.id !== id)
        .flatMap((gezel) => (gezel.roleBasedName ? [gezel.roleBasedName] : [])),
    );
    parsed.frontmatter.roleBasedName = pickRoleBasedName(parsed.frontmatter.role, taken);
  }
  await repo.transactions.commit(
    new Map([[`${gezelRoot(id)}/gezel.md`, boundedText(serializeGezelMarkdown(parsed))]]),
  );
  return (await getGezel(repo, id))!;
}
export async function updateGezelSettings(
  repo: PortableRepository,
  id: string,
  patch: Partial<{ [K in keyof GezelFrontmatter]: GezelFrontmatter[K] | null }>,
): Promise<GezelDetail> {
  if (patch.id !== undefined && patch.id !== id)
    throw new Error('Renaming the gezel id is not supported');
  const before = await requireGezel(repo, id);
  const fields: Record<string, unknown> = { ...before.parsed.frontmatter, ...patch, id };
  for (const [key, value] of Object.entries(patch)) if (value === null) delete fields[key];
  const parsed = { ...before.parsed, frontmatter: GezelFrontmatterSchema.parse(fields) };
  return updateGezelMarkdown(repo, id, serializeGezelMarkdown(parsed));
}

/** The same persisted struct and seed helpers used by the desktop manager. */
async function resolvePoppetje(
  repo: PortableRepository,
  id: string,
  name: string,
  gender?: GezelGender,
): Promise<Poppetje> {
  const path = `${gezelRoot(id)}/poppetje.json`;
  const raw = await repo.text(path);
  let existing: Poppetje | undefined;
  if (raw !== null) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const parsed = PoppetjeSchema.safeParse(json);
    if (parsed.success) existing = parsed.data;
  }
  if (existing?.key === id && existing.name === name) return existing;
  const resolved = existing
    ? { ...existing, key: id, name }
    : PoppetjeSchema.parse(initialPoppetjeForGezel(id, name, gender));
  await repo.transactions.commit(new Map([[path, repo.json(resolved)]]));
  return resolved;
}
export async function getGezelPoppetje(repo: PortableRepository, id: string): Promise<Poppetje> {
  return (await requireGezel(repo, id)).poppetje!;
}
export async function setGezelPoppetje(
  repo: PortableRepository,
  id: string,
  poppetje: Poppetje,
): Promise<Poppetje> {
  const validated = PoppetjeSchema.parse({ ...poppetje, key: id });
  await requireGezel(repo, id);
  await repo.transactions.commit(
    new Map([[`${gezelRoot(id)}/poppetje.json`, repo.json(validated)]]),
  );
  return validated;
}
export async function rerollGezelPoppetje(
  repo: PortableRepository,
  id: string,
  options: { seed?: number } = {},
): Promise<Poppetje> {
  const { seed } = RerollGezelPoppetjeRequestSchema.parse(options);
  const gezel = await requireGezel(repo, id);
  const poppetje = PoppetjeSchema.parse(
    poppetjeFromSeed(seed ?? Math.floor(Math.random() * 0x7fffffff), {
      key: id,
      name: gezel.name,
      gender: gezel.gender,
    }),
  );
  await repo.transactions.commit(
    new Map([[`${gezelRoot(id)}/poppetje.json`, repo.json(poppetje)]]),
  );
  return poppetje;
}
