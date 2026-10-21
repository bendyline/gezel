import {
  type CodebaseMapResponse,
  FOLDER_KIND_PROPERTY,
  createLogger,
  isCodingProject,
} from '@bendyline/gezel';

const log = createLogger('index');

export const CODEBASE_MAP_PATH = 'reports/codebase-map.md';
const SCRIPT_KEYS = ['test', 'typecheck', 'lint', 'eslint', 'build'];

export interface CodebaseMapDeps {
  store: {
    getProject(id: string): Promise<
      | (Parameters<typeof isCodingProject>[0] & {
          name?: string;
          properties?: Record<string, string>;
        })
      | null
    >;
    readProjectArtifact(id: string, path: string): Promise<string | null>;
    writeProjectArtifact(id: string, path: string, content: string): Promise<unknown>;
    readProjectWorkspaceFile(id: string, path: string): Promise<string | null>;
  };
  contentIndex: {
    codebaseMap(projectId: string): Promise<CodebaseMapResponse>;
  };
}

/**
 * Gezel's map of a code folder: what each folder is for and its key files,
 * the files everything else imports, and how to run the tests. Assembled from
 * the area pass's folder summaries and the import graph with no model, for
 * views, reports and the person to read. One stable file, rewritten only when
 * what it says changes.
 *
 * In the harness experiment (2026-10-21) the same map, put in CLAUDE.md, made
 * Claude Code about 40% faster on questions about an undocumented codebase;
 * Gezel still never writes it into the person's folder.
 */
export async function writeCodebaseMap(
  deps: CodebaseMapDeps,
  projectId: string,
  now: Date,
): Promise<string | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return null;
  const kind = project.properties?.[FOLDER_KIND_PROPERTY];
  if (kind !== 'code' && !(kind === undefined && isCodingProject(project))) return null;

  const map = await deps.contentIndex.codebaseMap(projectId);
  if (!map.indexed) return null;
  const scripts = await packageScripts(deps, projectId);
  const body = renderCodebaseMap(map, scripts);
  const previous = await deps.store
    .readProjectArtifact(projectId, CODEBASE_MAP_PATH)
    .catch(() => null);
  if (previous !== null && withoutHeader(previous) === body) return null;

  const title = project.name ? `${project.name}: codebase map` : 'Codebase map';
  const header = `# ${title}\n\nWritten by Gezel from its index of this folder on ${now.toISOString().slice(0, 10)}.\n`;
  await deps.store.writeProjectArtifact(projectId, CODEBASE_MAP_PATH, `${header}\n${body}`);
  log.info(`[index] ${projectId}: wrote ${CODEBASE_MAP_PATH}`);
  return CODEBASE_MAP_PATH;
}

/** The map below its title and date line. */
export function renderCodebaseMap(
  map: CodebaseMapResponse,
  scripts: Array<[string, string]> = [],
): string {
  const lines: string[] = [];
  if (map.architecture) lines.push(map.architecture.trim(), '');
  lines.push('## Where things live', '');
  for (const area of map.areas) {
    const label = area.path === '.' ? 'Files at the root' : `\`${area.path}/\``;
    lines.push(`${'  '.repeat(area.depth)}- ${label}: ${area.purpose}`);
  }
  if (map.loadBearing.length > 0) {
    lines.push('', '## Load-bearing files', '', 'What the rest of the code imports most.', '');
    for (const f of map.loadBearing) {
      lines.push(
        `- \`${f.path}\` (imported by ${f.importers})${f.purpose ? `: ${f.purpose}` : ''}`,
      );
    }
  }
  if (scripts.length > 0) {
    lines.push('', '## Commands', '');
    for (const [name, command] of scripts) lines.push(`- \`npm run ${name}\`: \`${command}\``);
  }
  return `${lines.join('\n')}\n`;
}

function withoutHeader(text: string): string {
  return text.replace(/^# .*\n\nWritten by Gezel .*\n\n/, '');
}

async function packageScripts(
  deps: CodebaseMapDeps,
  projectId: string,
): Promise<Array<[string, string]>> {
  const raw = await deps.store
    .readProjectWorkspaceFile(projectId, 'package.json')
    .catch(() => null);
  if (!raw) return [];
  try {
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return SCRIPT_KEYS.filter((k) => typeof scripts[k] === 'string').map((k) => [
      k,
      scripts[k] as string,
    ]);
  } catch {
    return [];
  }
}
