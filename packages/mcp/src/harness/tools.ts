import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, sep } from 'node:path';
import {
  HARNESS_TOOL_DESCRIPTIONS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_QUALITIES,
  type RetrievalSource,
  type UnifiedSearchResult,
  isHarnessHiddenCatalog,
  parseKnowledgeUri,
} from '@bendyline/gezel';
import { GezelApiError, apiErrorMessage } from '@bendyline/gezel-client/node';
import { MEMORY_KINDS } from '@bendyline/gezel/runtime';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  absoluteForHit,
  absoluteFromApp,
  relativeInside,
  rootedPath,
  whereFilesMayBe,
} from './paths.js';
import {
  type HarnessBinding,
  type HarnessSession,
  HarnessUnavailableError,
  boundProjectId,
} from './session.js';

/** The project an unbound app's library, knowledge and image requests address. */
const UNBOUND_PROJECT = 'default';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const SEARCH_SCOPES = ['folder', 'library', 'memories', 'knowledge'] as const;
type SearchScope = (typeof SEARCH_SCOPES)[number];
/**
 * What a bare `search` covers. Knowledge catalogs are reference material
 * (the bundled Handboek documents Gezel itself), so an app asks for them by
 * name: in the experiment they took four of ten slots on every code question.
 */
const DEFAULT_SCOPES: readonly SearchScope[] = ['folder', 'library', 'memories'];
/** Beside the folder's own results, other corpora show only their strongest few. */
const MAX_SIDE_HITS = 3;
/** Docs follow the code, at most this many: they outranked the code they describe on most queries. */
const MAX_DOC_HITS = 3;
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
const DOC_BASENAMES = new Set(['package.json', 'package-lock.json', 'license', 'changelog']);

/** Prose and manifests, as opposed to code (tests count as code). */
export function isDocPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot) : '';
  return (
    DOC_EXTENSIONS.has(ext) ||
    DOC_BASENAMES.has(base) ||
    DOC_BASENAMES.has(base.slice(0, dot >= 0 ? dot : undefined)) ||
    normalized.startsWith('docs/') ||
    normalized.includes('/docs/')
  );
}
const FOLDER_SOURCES = new Set(['workspace', 'artifacts']);
const SCOPE_SOURCES: Record<SearchScope, readonly RetrievalSource[]> = {
  folder: ['workspace', 'artifacts'],
  library: ['shared'],
  memories: ['project-memory', 'user-memory'],
  knowledge: ['knowledge'],
};

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
};

export function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function failure(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }], isError: true };
}

/** What Gezel said, in words: the guard's hint, a route's message, or the client's summary. */
function gezelMessage(err: unknown): string {
  if (err instanceof HarnessUnavailableError) return err.message;
  if (err instanceof GezelApiError && err.details && typeof err.details === 'object') {
    const { hint } = err.details as { hint?: unknown };
    if (typeof hint === 'string' && hint.trim()) return hint;
  }
  return apiErrorMessage(err);
}

export async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return failure(gezelMessage(err));
  }
}

/** Corpora for a search, narrowed to what this binding and the person's settings allow. */
export function harnessSources(
  binding: HarnessBinding,
  scopes: readonly SearchScope[] | undefined,
): RetrievalSource[] {
  const bound = boundProjectId(binding) !== null;
  const memory = binding.info?.memory ?? 'off';
  const wanted = (scopes && scopes.length > 0 ? scopes : DEFAULT_SCOPES).flatMap(
    (scope) => SCOPE_SOURCES[scope],
  );
  return [...new Set(wanted)].filter((source) => {
    if (
      !bound &&
      (source === 'workspace' || source === 'artifacts' || source === 'project-memory')
    ) {
      return false;
    }
    if (memory === 'off' && (source === 'project-memory' || source === 'user-memory')) return false;
    return true;
  });
}

function renderHit(binding: HarnessBinding, hit: UnifiedSearchResult): string {
  const lines =
    hit.line !== undefined
      ? `:${hit.line}${hit.lineEnd && hit.lineEnd !== hit.line ? `-${hit.lineEnd}` : ''}`
      : '';
  const snippet = hit.snippet?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? '';
  if (hit.kind === 'memory') {
    const when = hit.memory ? ` (${hit.memory.day}, ${hit.memory.kind})` : '';
    return `- memory${when}: ${snippet || hit.title}`;
  }
  if (hit.retrievalSource === 'knowledge' || hit.uri?.startsWith('knowledge://')) {
    const where = hit.topicPath?.length ? ` [${hit.topicPath.join(' › ')}]` : '';
    return `- ${hit.uri ?? hit.title} — ${hit.title}${where}${snippet ? `\n  ${snippet}` : ''}`;
  }
  const abs = absoluteForHit(binding, hit);
  const label =
    abs ??
    (hit.projectName ? `${hit.projectName}: ${hit.path ?? hit.title}` : (hit.path ?? hit.title));
  const corpus = hit.retrievalSource === 'shared' ? ' [shared library]' : '';
  return `- ${label}${lines}${corpus}${snippet ? `\n  ${snippet}` : ''}`;
}

function isFolderHit(hit: UnifiedSearchResult): boolean {
  if (hit.retrievalSource) return FOLDER_SOURCES.has(hit.retrievalSource);
  return hit.source !== undefined && hit.kind !== 'memory';
}

const OVERVIEW_PREFIX = 'overview:';
const PROJECT_OVERVIEW_AREA = '::project';
/** Area summaries are long; two orient an app, more crowd out the code. */
const MAX_OVERVIEW_HITS = 2;

/** The area an index-written summary covers: its id is `overview:<project>:<area>` and it has no path. */
function overviewArea(hit: UnifiedSearchResult): string | null {
  if (!hit.projectId) return null;
  const prefix = `${OVERVIEW_PREFIX}${hit.projectId}:`;
  return hit.id.startsWith(prefix) ? hit.id.slice(prefix.length) : null;
}

function renderOverview(binding: HarnessBinding, hit: UnifiedSearchResult, area: string): string {
  const project = binding.info?.project;
  const workingDir = hit.projectId === project?.id ? project?.workingDir : undefined;
  const where =
    area === PROJECT_OVERVIEW_AREA
      ? (workingDir ?? hit.projectName ?? 'this project')
      : workingDir
        ? `${join(workingDir, area)}${sep}`
        : `${area}/`;
  const summary = hit.snippet?.replace(/\s+/g, ' ').trim().slice(0, 600) ?? '';
  return `- Overview of ${where} (Gezel's summary)${summary ? `\n  ${summary}` : ''}`;
}

/** `path:12-30, 88-95 — snippet`: one line per file, every matching range kept. */
function renderFileHit(binding: HarnessBinding, group: UnifiedSearchResult[]): string {
  const first = group[0]!;
  const ranges = [
    ...new Set(
      group
        .filter((h) => h.line !== undefined)
        .map((h) => (h.lineEnd && h.lineEnd !== h.line ? `${h.line}-${h.lineEnd}` : `${h.line}`)),
    ),
  ].slice(0, 4);
  const abs = absoluteForHit(binding, first);
  const label =
    abs ??
    (first.projectName
      ? `${first.projectName}: ${first.path ?? first.title}`
      : (first.path ?? first.title));
  const snippet = first.snippet?.replace(/\s+/g, ' ').trim().slice(0, 280) ?? '';
  return `- ${label}${ranges.length ? `:${ranges.join(', ')}` : ''}${snippet ? `\n  ${snippet}` : ''}`;
}

/**
 * Turn the daemon's fused ranking into what an app that reads code needs:
 * the folder's files first, one entry per file, then (when the app did not
 * ask for other corpora by name) only the strongest library, memory or
 * knowledge hits, so they never crowd the code off the page.
 */
export function arrangeSearchResults(
  binding: HarnessBinding,
  results: readonly UnifiedSearchResult[],
  opts: { maxResults: number; sideByName: boolean },
): { folder: string[]; docs: string[]; side: string[] } {
  const groups = new Map<string, UnifiedSearchResult[]>();
  const side: UnifiedSearchResult[] = [];
  // A photo or a moment of a video matched by meaning is noise beside code an
  // app can read (the experiment's PNGs answered text questions); it stays
  // when it is all the folder has. A match on a file's name is not media.
  const onlyMedia = results.every((hit) => !isFolderHit(hit) || hit.media !== undefined);
  let overviews = 0;
  for (const hit of results) {
    if (isHarnessHiddenCatalog(hit.catalogId) || isHarnessHiddenCatalog(hit.uri)) continue;
    if (!isFolderHit(hit)) {
      side.push(hit);
      continue;
    }
    if (hit.media && !onlyMedia) continue;
    if (overviewArea(hit) !== null && ++overviews > MAX_OVERVIEW_HITS) continue;
    const key = (hit.path ?? hit.id).replaceAll('\\', '/');
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }
  const all = [...groups.entries()];
  const code = all.filter(([path]) => !isDocPath(path));
  const docGroups = all.filter(([path]) => isDocPath(path));
  const folder = code.slice(0, opts.maxResults).map(([, group]) => {
    const area = overviewArea(group[0]!);
    return area === null ? renderFileHit(binding, group) : renderOverview(binding, group[0]!, area);
  });
  // With no code hit at all, the docs are the answer and get the whole page.
  const docs = docGroups
    .slice(0, folder.length === 0 ? opts.maxResults : MAX_DOC_HITS)
    .map(([, group]) => renderFileHit(binding, group));
  const anyFolder = folder.length + docs.length > 0;
  const keptSide = side
    .filter((hit) => opts.sideByName || !anyFolder || hit.tier === 'strong')
    .slice(0, opts.sideByName || !anyFolder ? opts.maxResults : MAX_SIDE_HITS)
    .map((hit) => renderHit(binding, hit));
  return { folder, docs, side: keptSide };
}

async function indexNote(session: HarnessSession, binding: HarnessBinding): Promise<string | null> {
  const id = boundProjectId(binding);
  if (!id) return null;
  const status = await session
    .run(binding, (api) => api.getProjectIndexStatus(id))
    .catch(() => null);
  if (!status) return null;
  if (status.state === 'indexing' || status.state === 'never') {
    return 'Gezel is still indexing this folder, so results may be incomplete. Use your own search meanwhile.';
  }
  if (status.state === 'disabled') {
    return 'Gezel does not index this folder (indexing is turned off for it), so only the library, memories and knowledge were searched.';
  }
  return null;
}

/** Register the harness profile's tools on an MCP server. */
export function registerHarnessTools(server: McpServer, session: HarnessSession): void {
  server.registerTool(
    'search',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.search,
      inputSchema: {
        query: z.string().min(1).max(400).describe('What to look for, in plain words.'),
        scopes: z
          .array(z.enum(SEARCH_SCOPES))
          .optional()
          .describe(
            'Which of folder, library, memories, knowledge to search. Default: folder, library and memories. Add knowledge for installed reference catalogs.',
          ),
        catalogs: z
          .array(z.string().min(1))
          .max(64)
          .optional()
          .describe('Search only these knowledge catalogs (ids from gezel_status).'),
        pathPrefix: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only files under this folder: an absolute path, or one relative to this folder.',
          ),
        maxResults: z.number().int().positive().max(50).optional().describe('Default 20.'),
        cursor: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe('From a previous truncated search.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind(args.pathPrefix);
        const scopes: readonly SearchScope[] = args.catalogs
          ? ['knowledge']
          : args.scopes?.length
            ? args.scopes
            : DEFAULT_SCOPES;
        const sources = harnessSources(binding, scopes);
        if (sources.length === 0) {
          return failure(
            'Nothing to search: this app is not working in a Gezel project and memories are off. Ask for the library or knowledge instead.',
          );
        }
        let pathPrefix: string | undefined;
        if (args.pathPrefix) {
          const workingDir = binding.info?.project?.workingDir;
          const rel = workingDir
            ? relativeInside(workingDir, absoluteFromApp(binding, args.pathPrefix))
            : null;
          if (rel === null)
            return failure(`pathPrefix must be inside ${whereFilesMayBe(binding)}.`);
          if (rel) pathPrefix = rel.endsWith('/') ? rel : `${rel}/`;
        }
        const catalogs = args.catalogs?.filter((id) => !isHarnessHiddenCatalog(id));
        if (args.catalogs && catalogs?.length === 0) {
          return failure('Those knowledge catalogs are not available to other apps.');
        }
        const maxResults = args.maxResults ?? 15;
        // Several chunks of one file collapse into one entry, so ask for more.
        const fetched = Math.min(100, maxResults * 3);
        const res = await session.run(binding, (api) =>
          api.toolSearch(boundProjectId(binding) ?? UNBOUND_PROJECT, {
            query: args.query,
            includeShared: sources.includes('shared'),
            sources,
            maxResults: fetched,
            ...(catalogs ? { catalogs } : {}),
            ...(pathPrefix ? { pathPrefix } : {}),
            ...(args.cursor ? { offset: args.cursor } : {}),
          }),
        );
        const { folder, docs, side } = arrangeSearchResults(binding, res.results, {
          maxResults,
          sideByName: Boolean(args.catalogs || args.scopes?.length),
        });
        const lines: string[] = [...folder];
        if (docs.length > 0) {
          if (lines.length > 0) lines.push('', 'Docs in this folder that discuss it:');
          lines.push(...docs);
        }
        if (side.length > 0) {
          if (lines.length > 0) lines.push('', 'Also relevant, outside this folder:');
          lines.push(...side);
        }
        const notes: string[] = [];
        if (folder.length + docs.length + side.length === 0) {
          const note = await indexNote(session, binding);
          notes.push(note ?? 'No results.');
        }
        if (res.sourcesIncomplete)
          notes.push('Some sources did not answer in time; results may be partial.');
        if (res.truncated && res.results.length >= fetched) {
          notes.push(
            `More results exist: call again with cursor ${(args.cursor ?? 0) + res.results.length}.`,
          );
        }
        return text([...lines, ...notes].join('\n'));
      }),
  );

  server.registerTool(
    'read_doc_as_markdown',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.read_doc_as_markdown,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('The document: an absolute path, or one relative to this folder.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind(isAbsolute(args.path) ? args.path : undefined);
        const where = rootedPath(binding, args.path);
        const id = boundProjectId(binding);
        if (where?.root === 'workspace' && id) {
          const res = await session.run(binding, (api) =>
            api.toolReadDocAsMarkdown(id, { path: where.rel }),
          );
          if (!res.found) {
            return failure(
              `Gezel could not convert ${where.abs} (unsupported format, or the conversion failed).`,
            );
          }
          return text(
            `${where.abs}${res.truncated ? ' (truncated)' : ''}\n---\n${res.markdown ?? ''}`,
          );
        }
        if (where?.root === 'library') {
          const res = await session.run(binding, (api) =>
            api.readDocument(where.rel, { as: 'markdown' }),
          );
          return text(`${where.abs}\n---\n${res.content}`);
        }
        return failure(
          `${absoluteFromApp(binding, args.path)} is outside ${whereFilesMayBe(binding)}.`,
        );
      }),
  );

  server.registerTool(
    'list_documents',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.list_documents,
      inputSchema: {
        path: z.string().min(1).optional().describe('A subfolder of the library to list.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind();
        const libraryDir = binding.info?.libraryDir;
        let sub: string | undefined;
        if (args.path) {
          const where = rootedPath(binding, args.path);
          sub = where?.root === 'library' ? where.rel : args.path.replaceAll('\\', '/');
        }
        const res = await session.run(binding, (api) => api.listDocuments(sub));
        if (res.files.length === 0) return text('The shared library is empty here.');
        const lines = res.files.map((f) => {
          const shown = libraryDir ? join(libraryDir, f.path) : f.path;
          return `- ${shown}${f.isDirectory ? '/' : ''}`;
        });
        return text(lines.join('\n'));
      }),
  );

  server.registerTool(
    'read_document',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.read_document,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'A library document (absolute, or relative to the library), or a knowledge:// address.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind();
        const knowledge = parseKnowledgeUri(args.path);
        if (knowledge && isHarnessHiddenCatalog(knowledge.catalogId)) {
          return failure(`${args.path} is not available to other apps.`);
        }
        if (knowledge?.fragment && 'chunk' in knowledge.fragment) {
          const chunk = knowledge.fragment.chunk;
          const passage = await session.run(binding, (api) =>
            api.readKnowledgePassage(knowledge.catalogId, knowledge.documentId, chunk),
          );
          const head = [
            `Source: ${passage.title} — ${args.path}`,
            ...(passage.headingPath.length ? [`Section: ${passage.headingPath.join(' › ')}`] : []),
            ...(passage.sourceUrl ? [`Origin: ${passage.sourceUrl}`] : []),
          ];
          return text(`${head.join('\n')}\n\n${passage.text}`);
        }
        if (knowledge) {
          const doc = await session.run(binding, (api) =>
            api.readKnowledgeDocument(knowledge.catalogId, knowledge.documentId),
          );
          const head = [
            `Source: ${doc.title} — ${args.path.split('#')[0]}`,
            ...(doc.sourceUrl ? [`Origin: ${doc.sourceUrl}`] : []),
          ];
          return text(`${head.join('\n')}\n\n${doc.markdown}`);
        }
        const where = rootedPath(binding, args.path);
        if (where && where.root !== 'library') {
          return failure(
            `${where.abs} is not in the shared library. Use read_doc_as_markdown for files in this folder.`,
          );
        }
        const rel = where?.rel ?? args.path.replaceAll('\\', '/');
        const res = await session.run(binding, (api) => api.readDocument(rel, { as: 'markdown' }));
        return text(res.content);
      }),
  );

  server.registerTool(
    'search_memory',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.search_memory,
      inputSchema: {
        query: z.string().min(1).max(400).describe('What to recall, in plain words.'),
        maxResults: z.number().int().positive().max(30).optional().describe('Default 10.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind();
        if (binding.info?.memory === 'off') {
          return failure('Memory is turned off for other apps in Gezel (Settings → Integrations).');
        }
        const sources = harnessSources(binding, ['memories']);
        const res = await session.run(binding, (api) =>
          api.toolSearch(boundProjectId(binding) ?? UNBOUND_PROJECT, {
            query: args.query,
            includeShared: false,
            sources,
            maxResults: args.maxResults ?? 10,
          }),
        );
        if (res.results.length === 0) return text('No saved memories match.');
        return text(res.results.map((hit) => renderHit(binding, hit)).join('\n'));
      }),
  );

  server.registerTool(
    'save_memory',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.save_memory,
      inputSchema: {
        text: z
          .string()
          .min(3)
          .max(2000)
          .describe('The fact, as one or two self-contained sentences.'),
        kind: z
          .enum(MEMORY_KINDS)
          .optional()
          .describe(
            'fact (default), decision, pref (a preference), status, correction, or example.',
          ),
      },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind();
        if (binding.info?.memory !== 'save') {
          return failure(
            'Saving memories is turned off for other apps in Gezel (Settings → Integrations).',
          );
        }
        const id = boundProjectId(binding);
        if (!id) {
          return failure(
            "This app isn't working in a Gezel project, so there is no project memory to save to.",
          );
        }
        const res = await session.run(binding, (api) =>
          api.saveMemory({ scope: 'project', id, text: args.text, kind: args.kind ?? 'fact' }),
        );
        return text(res.status === 'duplicate' ? 'Gezel already had that memory.' : 'Saved.');
      }),
  );

  server.registerTool(
    'describe_image',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.describe_image,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('The image: an absolute path, or one relative to this folder.'),
        mode: z
          .enum(['auto', 'describe', 'ocr', 'ui', 'extract'])
          .optional()
          .describe(
            'auto (default), describe, ocr (text in the image), ui (a screenshot), extract (needs schema).',
          ),
        schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('JSON Schema for extract mode.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind(isAbsolute(args.path) ? args.path : undefined);
        const image = await readAllowedImage(binding, args.path);
        if ('error' in image) return failure(image.error);
        const res = await session.run(binding, (api) =>
          api.describeImage(
            {
              data: image.data,
              mimeType: image.mimeType,
              mode: args.mode ?? 'auto',
              ...(args.schema ? { schema: args.schema } : {}),
            },
            { projectId: boundProjectId(binding) ?? UNBOUND_PROJECT },
          ),
        );
        const parts = [
          `${res.meta.format.toUpperCase()}${res.meta.width && res.meta.height ? ` ${res.meta.width}x${res.meta.height}` : ''}.`,
        ];
        if (res.description) parts.push('', res.description);
        if (res.ocrText) parts.push('', 'Text in the image:', res.ocrText);
        if (res.structured) parts.push('', JSON.stringify(res.structured.data, null, 2));
        if (res.status === 'static-only') {
          parts.push(
            '',
            'No description: Gezel has no image reader installed (Settings → Image recognition).',
          );
        } else if (res.status === 'failed') {
          parts.push(
            '',
            `Gezel could not read this image: ${res.failureReason ?? 'unknown error'}.`,
          );
        }
        return text(parts.join('\n'));
      }),
  );

  server.registerTool(
    'generate_image',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.generate_image,
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .describe('What the image should show, or the edit to make to inputImages.'),
        aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
        quality: z
          .enum(IMAGE_QUALITIES)
          .optional()
          .describe("'draft', 'standard' (default) or 'high'."),
        negativePrompt: z
          .string()
          .max(2000)
          .optional()
          .describe('Things to keep out of the image.'),
        inputImages: z
          .array(z.string().min(1))
          .max(4)
          .optional()
          .describe('Images to edit or combine: absolute paths, or paths relative to this folder.'),
      },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind();
        if (binding.info?.images === 'off') {
          return failure(
            'Image generation is turned off for other apps in Gezel (Settings → Integrations).',
          );
        }
        const inputs: Array<{ data: string; mimeType: string }> = [];
        for (const path of args.inputImages ?? []) {
          const image = await readAllowedImage(binding, path);
          if ('error' in image) return failure(image.error);
          inputs.push(image);
        }
        const res = await session.run(binding, (api) =>
          api.generateImage({
            prompt: args.prompt,
            projectId: boundProjectId(binding) ?? UNBOUND_PROJECT,
            inline: true,
            ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
            ...(args.quality ? { quality: args.quality } : {}),
            ...(args.negativePrompt ? { negativePrompt: args.negativePrompt } : {}),
            ...(inputs.length > 0 ? { inputImages: inputs } : {}),
          }),
        );
        const artifactsDir = binding.info?.artifactsDir;
        const saved = artifactsDir ? join(artifactsDir, res.artifactPath) : res.artifactPath;
        const content: CallToolResult['content'] = [];
        if (res.b64Png) content.push({ type: 'image', data: res.b64Png, mimeType: 'image/png' });
        content.push({
          type: 'text',
          text: `Saved to ${saved} (${res.meta.widthPx}x${res.meta.heightPx}, ${res.meta.model}). Copy it into the folder with your own file tools if it belongs there.`,
        });
        return { content };
      }),
  );

  server.registerTool(
    'gezel_status',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.gezel_status,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(async () => {
        const binding = await session.bind();
        const info = binding.info;
        const lines: string[] = [];
        if (info?.project) {
          lines.push(
            `Project: ${info.project.name}${info.project.workingDir ? ` (${info.project.workingDir})` : ''}${info.project.created ? ', added to Gezel just now' : ''}.`,
          );
          const status = await session
            .run(binding, (api) => api.getProjectIndexStatus(info.project!.id))
            .catch(() => null);
          if (status) lines.push(`Index: ${status.state}.`);
        } else {
          const why =
            info?.unboundReason === 'forbidden-root'
              ? 'Gezel never makes a project of this folder (it is too broad, like a home folder or a drive).'
              : info?.unboundReason === 'not-in-gezel'
                ? 'This folder is not in Gezel, and Gezel is set to add only folders the person adds themselves.'
                : 'This app has no folder for Gezel to look at.';
          lines.push(
            `No project. ${why} Search reaches the shared library, memories and knowledge.`,
          );
        }
        if (info?.libraryDir) lines.push(`Shared library: ${info.libraryDir}`);
        lines.push(
          `Memories: ${info?.memory === 'save' ? 'search and save' : info?.memory === 'read' ? 'search only' : 'off'}.`,
          `Images: ${info?.images === 'any' ? 'any image engine' : info?.images === 'local' ? 'on this computer only' : 'off'}.`,
        );
        const catalogs = await session
          .run(binding, (api) => api.listKnowledgeCatalogs())
          .then((r) => r.catalogs)
          .catch(() => []);
        const named = catalogs
          .filter((c) => c.enabled && !isHarnessHiddenCatalog(c.ref.catalogId))
          .map((c) => `${c.ref.catalogId}${c.name ? ` (${c.name})` : ''}`);
        lines.push(
          named.length > 0
            ? `Knowledge catalogs: ${named.join(', ')}.`
            : 'Knowledge catalogs: none.',
        );
        return text(lines.join('\n'));
      }),
  );
}

/** Read an image the app named, only from the bound folder, the library, or Gezel's artifacts. */
async function readAllowedImage(
  binding: HarnessBinding,
  path: string,
): Promise<{ data: string; mimeType: string } | { error: string }> {
  const where = rootedPath(binding, path);
  if (!where)
    return { error: `${absoluteFromApp(binding, path)} is outside ${whereFilesMayBe(binding)}.` };
  const mimeType = IMAGE_MIME[extname(where.abs).toLowerCase()];
  if (!mimeType)
    return {
      error: `${where.abs} is not an image Gezel can read (PNG, JPEG, WebP, GIF, BMP or HEIC).`,
    };
  const info = await stat(where.abs).catch(() => null);
  if (!info?.isFile()) return { error: `${where.abs} was not found.` };
  if (info.size > MAX_IMAGE_BYTES) return { error: `${where.abs} is larger than 20 MB.` };
  return { data: (await readFile(where.abs)).toString('base64'), mimeType };
}
