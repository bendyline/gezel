import {
  type ProjectSearchRequest,
  ProjectSearchRequestSchema,
  type ProjectSearchResponse,
  type SearchDocumentsRequest,
  SearchDocumentsRequestSchema,
  type SearchDocumentsResponse,
  type UnifiedSearchRequest,
  UnifiedSearchRequestSchema,
  type UnifiedSearchResponse,
  type UnifiedSearchResult,
} from '../schemas/api.js';
import type { Project } from '../schemas/project.js';
import { lexicalRelevance, pageSearchResults, scoreResult } from '../search-ranking.js';
import { isSharedLibraryProject } from '../shared-project.js';
import { validatePortablePath } from './files.js';
import { listGezels } from './gezels.js';
import { lexicalExcerpt, lexicalScore, lexicalTerms } from './lexical.js';
import { searchMemoryScope } from './memories.js';
import { type PortableFileArea, listFiles, readFile } from './project-files.js';
import { listProjects, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';
import { getSession, listSessions } from './sessions.js';

const MAX_SEARCH_FILES = 3000;
const MAX_SEARCH_TEXT = 16 * 1024 * 1024;
const TEXT_EXTENSION =
  /(?:\.(?:md|markdown|txt|text|csv|tsv|json|jsonl|yaml|yml|toml|xml|html?|css|[cm]?js|jsx|tsx?|py|rs|go|java|kt|swift|c|cc|cpp|h|sh|sql|ini|log|srt|vtt)|(?:^|\/)(?:README|LICENSE|Makefile))$/i;
interface Scan {
  results: UnifiedSearchResult[];
  files: number;
  chars: number;
  truncated: boolean;
  incomplete: boolean;
}
async function searchFiles(
  repo: PortableRepository,
  state: Scan,
  project: Project,
  area: PortableFileArea,
  terms: string[],
  namesOnly: boolean,
  pathPrefix?: string,
): Promise<void> {
  if (state.files >= MAX_SEARCH_FILES || state.chars >= MAX_SEARCH_TEXT) {
    state.truncated = true;
    return;
  }
  const listing = await listFiles(repo, area, project.id, '', true);
  state.truncated ||= listing.truncated;
  for (const entry of listing.entries) {
    if (entry.isDirectory || (pathPrefix && !entry.path.startsWith(pathPrefix))) continue;
    if (++state.files > MAX_SEARCH_FILES || state.chars >= MAX_SEARCH_TEXT) {
      state.truncated = true;
      break;
    }
    const nameScore = lexicalScore(terms, entry.path);
    let excerpt: ReturnType<typeof lexicalExcerpt> = null;
    let contentScore = 0;
    if (!namesOnly && TEXT_EXTENSION.test(entry.path)) {
      try {
        const text = await readFile(repo, area, project.id, entry.path);
        if (text !== null) {
          state.chars += text.length;
          if (state.chars > MAX_SEARCH_TEXT) {
            state.truncated = true;
            break;
          }
          contentScore = lexicalScore(terms, text);
          excerpt = lexicalExcerpt(terms, text);
        }
      } catch {
        // Binary/oversize/unreadable files do not become fabricated empty text.
        // Report incomplete source coverage while keeping valid hits usable.
        state.incomplete = true;
      }
    }
    const score = Math.max(nameScore, contentScore);
    if (!score) continue;
    const shared = area === 'documents' || isSharedLibraryProject(project);
    const kind = shared ? 'document' : excerpt ? 'content' : 'file';
    state.results.push({
      kind,
      id: `${shared ? 'documents' : `${project.id}/${area}`}/${entry.path}`,
      title: entry.name,
      subtitle: `${project.name} · ${entry.path}`,
      path: entry.path,
      ...(shared
        ? {}
        : {
            projectId: project.id,
            projectName: project.name,
            source: area as 'workspace' | 'artifacts',
          }),
      retrievalSource: shared ? 'shared' : (area as 'workspace' | 'artifacts'),
      ...(excerpt ?? {}),
      // The existing wire contract calls literal text hits `fts`; engine below
      // explicitly reports lexical source scans, never an SQLite/vector index.
      ...(excerpt ? { arm: 'fts' as const } : {}),
      ...scoreResult(kind, lexicalRelevance(score)),
    });
  }
}
const newScan = (): Scan => ({
  results: [],
  files: 0,
  chars: 0,
  truncated: false,
  incomplete: false,
});
function finish(state: Scan, limit: number, offset = 0): UnifiedSearchResponse {
  const page = pageSearchResults(state.results, { offset, limit });
  return {
    results: page.results,
    truncated: state.truncated || page.hasMore,
    ...(state.incomplete ? { sourcesIncomplete: true } : {}),
  };
}
export async function search(
  repo: PortableRepository,
  raw: UnifiedSearchRequest,
): Promise<UnifiedSearchResponse> {
  const input = UnifiedSearchRequestSchema.parse(raw);
  const terms = lexicalTerms(input.query);
  const state = newScan();
  if (!terms.length) return finish(state, input.maxResults ?? 30);
  const projects = await listProjects(repo);
  for (const project of projects) {
    const score = lexicalScore(terms, `${project.name} ${project.description ?? ''}`);
    if (score && !isSharedLibraryProject(project))
      state.results.push({
        kind: 'project',
        id: project.id,
        title: project.name,
        projectId: project.id,
        ...scoreResult('project', lexicalRelevance(score)),
      });
  }
  for (const gezel of await listGezels(repo)) {
    const score = lexicalScore(terms, `${gezel.name} ${gezel.role ?? ''}`);
    if (score)
      state.results.push({
        kind: 'gezel',
        id: gezel.id,
        title: gezel.name,
        gezelId: gezel.id,
        subtitle: gezel.role,
        ...scoreResult('gezel', lexicalRelevance(score)),
      });
  }
  for (const summary of await listSessions(repo)) {
    const project = projects.find((item) => item.id === summary.projectId);
    if (summary.archived || !project || project.archived) continue;
    if (++state.files > MAX_SEARCH_FILES || state.chars >= MAX_SEARCH_TEXT) {
      state.truncated = true;
      break;
    }
    const titleScore = lexicalScore(terms, summary.title);
    let contentScore = 0;
    let snippet: string | undefined;
    let line: number | undefined;
    if (input.mode !== 'names') {
      const session = await getSession(repo, summary.gezelId, summary.id);
      for (const [index, message] of (session?.messages ?? []).entries()) {
        state.chars += message.content.length;
        if (state.chars > MAX_SEARCH_TEXT) {
          state.truncated = true;
          break;
        }
        const score = lexicalScore(terms, message.content);
        if (score <= contentScore) continue;
        contentScore = score;
        snippet = lexicalExcerpt(terms, message.content)?.snippet;
        line = index + 1;
      }
    }
    const score = Math.max(titleScore, contentScore);
    if (score)
      state.results.push({
        kind: 'session',
        id: `session:${summary.id}`,
        title: summary.title,
        projectId: summary.projectId,
        projectName: project.name,
        gezelId: summary.gezelId,
        snippet,
        line,
        arm: 'fts',
        ...scoreResult('session', lexicalRelevance(score)),
      });
  }
  for (const project of projects) {
    if (project.archived) continue;
    for (const area of isSharedLibraryProject(project)
      ? (['documents'] as const)
      : (['workspace', 'artifacts'] as const))
      await searchFiles(repo, state, project, area, terms, input.mode === 'names');
  }
  return finish(state, input.maxResults ?? 30);
}
export async function searchProject(
  repo: PortableRepository,
  projectId: string,
  raw: ProjectSearchRequest,
): Promise<ProjectSearchResponse> {
  const input = ProjectSearchRequestSchema.parse(raw);
  if (input.pathPrefix) validatePortablePath(input.pathPrefix.replace(/\/$/, ''));
  const project = await requireProject(repo, projectId);
  const terms = lexicalTerms(input.query);
  const state = newScan();
  const includes = (source: NonNullable<typeof input.sources>[number]) =>
    !input.sources || input.sources.includes(source);
  if (includes('workspace'))
    await searchFiles(
      repo,
      state,
      project,
      isSharedLibraryProject(project) ? 'documents' : 'workspace',
      terms,
      false,
      input.pathPrefix,
    );
  if (includes('artifacts'))
    await searchFiles(repo, state, project, 'artifacts', terms, false, input.pathPrefix);
  if (input.includeShared !== false && includes('shared') && !isSharedLibraryProject(project)) {
    const library = (await listProjects(repo)).find(isSharedLibraryProject);
    if (library)
      await searchFiles(repo, state, library, 'documents', terms, false, input.pathPrefix);
  }
  if (!input.pathPrefix)
    for (const [scope, id, source] of [
      ['project', projectId, 'project-memory'],
      ...(input.gezelId ? [['gezel', input.gezelId, 'gezel-memory']] : []),
    ] as Array<['gezel' | 'project', string, 'gezel-memory' | 'project-memory']>) {
      if (!includes(source)) continue;
      const memories = await searchMemoryScope(repo, scope, id, input.query);
      state.truncated ||= memories.truncated;
      for (const [index, memory] of memories.results.entries())
        state.results.push({
          kind: 'memory',
          id: `${scope}/${id}/${memory.day}/${index}`,
          title: `${memory.day} · ${memory.kind}`,
          snippet: memory.text.slice(0, 600),
          projectId: scope === 'project' ? id : undefined,
          gezelId: scope === 'gezel' ? id : undefined,
          retrievalSource: source,
          arm: 'fts',
          ...scoreResult('memory', lexicalRelevance(memory.score)),
        });
    }
  if (input.sources?.includes('knowledge')) state.incomplete = true;
  return { ...finish(state, input.maxResults ?? 30, input.offset ?? 0), craftbooks: [] };
}
export async function searchDocuments(
  repo: PortableRepository,
  raw: SearchDocumentsRequest,
): Promise<SearchDocumentsResponse> {
  const input = SearchDocumentsRequestSchema.parse(raw);
  const library = (await listProjects(repo)).find(isSharedLibraryProject);
  if (!library) throw new Error('The shared library has not been initialized');
  const state = newScan();
  await searchFiles(repo, state, library, 'documents', lexicalTerms(input.q), false);
  const results = finish(state, input.maxResults ?? 30);
  return {
    results: results.results.map((hit) => ({
      path: hit.path!,
      lineStart: hit.line ?? 1,
      lineEnd: hit.lineEnd,
      snippet: hit.snippet ?? hit.path!,
      score: hit.relevance,
      source: 'fts',
      kind: 'source',
    })),
    engine: 'lexical',
    truncated: results.truncated,
    sourcesIncomplete: results.sourcesIncomplete,
  };
}
