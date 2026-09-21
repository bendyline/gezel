import { z } from 'zod';
import { type MemorySearchRequest, MemorySearchRequestSchema } from '../schemas/api.js';
import { boundedText } from './files.js';
import { gezelRoot, requireGezel } from './gezels.js';
import { lexicalScore, lexicalTerms } from './lexical.js';
import { type MemoryKind, formatMemoryBlock, parseMemoryDay } from './memory-markdown.js';
import { projectRoot, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';

export type PortableMemoryScope = 'gezel' | 'project';
export interface PortableMemoryHit {
  text: string;
  score: number;
  day: string;
  scope: PortableMemoryScope;
  id: string;
  kind: MemoryKind;
}
const ScopeSchema = z.enum(['gezel', 'project']);
export const PortableSaveMemorySchema = z
  .object({
    scope: ScopeSchema,
    id: z.string().min(1),
    text: z.string().trim().min(1).max(16000),
    kind: z.enum(['fact', 'decision', 'pref', 'status']).default('fact'),
  })
  .strict();
export type PortableSaveMemory = z.input<typeof PortableSaveMemorySchema>;
export function validateMemoryDay(day: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  )
    throw new Error('A valid YYYY-MM-DD memory day is required');
  return day;
}
async function root(
  repo: PortableRepository,
  scope: PortableMemoryScope,
  id: string,
  write = false,
): Promise<string> {
  ScopeSchema.parse(scope);
  if (scope === 'gezel') {
    await requireGezel(repo, id);
    return `${gezelRoot(id)}/memories`;
  }
  const project = await requireProject(repo, id);
  if (write && project.status === 'readonly') throw new Error('This project is read-only');
  return `${projectRoot(id)}/memories`;
}
export async function listMemoryDays(
  repo: PortableRepository,
  scope: PortableMemoryScope,
  id: string,
): Promise<string[]> {
  return (await repo.list(`${await root(repo, scope, id)}/daily`))
    .filter((entry) => !entry.isDirectory && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map((entry) => validateMemoryDay(entry.name.slice(0, -3)))
    .sort()
    .reverse();
}
export async function readMemoryDay(
  repo: PortableRepository,
  scope: PortableMemoryScope,
  id: string,
  day: string,
): Promise<string> {
  return (
    (await repo.text(`${await root(repo, scope, id)}/daily/${validateMemoryDay(day)}.md`)) ?? ''
  );
}
export async function updateMemoryDay(
  repo: PortableRepository,
  scope: PortableMemoryScope,
  id: string,
  day: string,
  content: string,
): Promise<{ ok: true; indexed: false }> {
  const path = `${await root(repo, scope, id, true)}/daily/${validateMemoryDay(day)}.md`;
  await repo.transactions.commit(new Map([[path, boundedText(content)]]));
  return { ok: true, indexed: false };
}
export async function readMemorySummary(
  repo: PortableRepository,
  scope: PortableMemoryScope,
  id: string,
): Promise<string> {
  return (await repo.text(`${await root(repo, scope, id)}/summary.md`)) ?? '';
}
export async function readMemoryLessons(repo: PortableRepository, id: string): Promise<string> {
  return (await repo.text(`${await root(repo, 'gezel', id)}/lessons.md`)) ?? '';
}
export async function writeMemoryLessons(
  repo: PortableRepository,
  id: string,
  content: string,
): Promise<void> {
  await repo.transactions.commit(
    new Map([[`${await root(repo, 'gezel', id, true)}/lessons.md`, boundedText(content)]]),
  );
}
export async function saveMemory(
  repo: PortableRepository,
  input: PortableSaveMemory,
): Promise<{ ok: true; status: 'saved' | 'duplicate'; indexed: false }> {
  const { scope, id, text, kind } = PortableSaveMemorySchema.parse(input);
  await root(repo, scope, id, true);
  const today = repo.now().slice(0, 10);
  const content = await readMemoryDay(repo, scope, id, today);
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (
    parseMemoryDay(content).some(
      (entry) => entry.kind === kind && normalize(entry.text) === normalize(text),
    )
  )
    return { ok: true, status: 'duplicate', indexed: false };
  await updateMemoryDay(
    repo,
    scope,
    id,
    today,
    content + formatMemoryBlock(repo.now().slice(11, 16), text, kind),
  );
  return { ok: true, status: 'saved', indexed: false };
}
export async function searchMemoryScope(
  repo: PortableRepository,
  scope: PortableMemoryScope,
  id: string,
  query: string,
): Promise<{ results: PortableMemoryHit[]; truncated: boolean }> {
  const terms = lexicalTerms(query);
  const days = await listMemoryDays(repo, scope, id);
  const results: PortableMemoryHit[] = [];
  let bytes = 0;
  let truncated = days.length > 365;
  for (const day of days.slice(0, 365)) {
    const content = await readMemoryDay(repo, scope, id, day);
    bytes += content.length;
    if (bytes > 4 * 1024 * 1024) {
      truncated = true;
      break;
    }
    for (const block of parseMemoryDay(content)) {
      const score = lexicalScore(terms, block.text);
      if (score > 0) results.push({ text: block.text, score, day, scope, id, kind: block.kind });
      if (results.length >= 1000) return { results, truncated: true };
    }
  }
  return { results, truncated };
}
export async function searchMemories(
  repo: PortableRepository,
  raw: MemorySearchRequest,
): Promise<{ results: PortableMemoryHit[]; mode: 'lexical'; truncated: boolean }> {
  const input = MemorySearchRequestSchema.parse(raw);
  const scopes = await Promise.all([
    searchMemoryScope(repo, 'gezel', input.gezelId, input.query),
    searchMemoryScope(repo, 'project', input.projectId, input.query),
  ]);
  const all = scopes
    .flatMap((scope) => scope.results)
    .sort((a, b) => b.score - a.score || b.day.localeCompare(a.day));
  return {
    results: all.slice(0, input.topK ?? 10),
    mode: 'lexical',
    truncated: scopes.some((scope) => scope.truncated) || all.length > (input.topK ?? 10),
  };
}
