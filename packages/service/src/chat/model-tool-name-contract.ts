import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { TOOL_REGISTRY } from '@bendyline/gezel-mcp';
import { loadBuiltinToolContractsForLint } from '@bendyline/gezel-mcp/lint-contracts';
import fg from 'fast-glob';
import ts from 'typescript';
import { LOCAL_PREVIEW_BROWSER_TOOLS } from '../providers/mcp-wrappers/playwright-arg-validator.js';
import {
  type PromptToolContractFinding,
  formatPromptToolContractFinding,
  lintPromptToolContract,
} from './prompt-tool-contract.js';

export type ModelToolNameCorpusCategory =
  | 'tool-description'
  | 'prompt-source'
  | 'behavior-source'
  | 'craftbook-authoring'
  | 'generated-catalog'
  | 'eval-prompt'
  | 'example';

export interface ModelToolNameCorpusEntry {
  category: ModelToolNameCorpusCategory;
  source: string;
  line: number;
  text: string;
  /** Tools supplied only to this prompt/content item (toolset or project type). */
  declaredTools?: readonly string[];
  /** JSON pointer for structured catalog content. */
  jsonPointer?: string;
  /** Escaped newlines in JSON values are not physical source lines. */
  physicalLineOnly?: boolean;
}

export interface ModelToolNameContractFinding extends PromptToolContractFinding {
  category: ModelToolNameCorpusCategory;
  source: string;
  jsonPointer?: string;
}

export interface ModelToolNameContractReport {
  fileCount: number;
  entryCount: number;
  allowedToolCount: number;
  errors: ModelToolNameContractFinding[];
  /** Exact, version-bound debt in the immutable pinned gilde package. */
  pinnedDebt: ModelToolNameContractFinding[];
  pinnedDebtFingerprint?: {
    version: string;
    count: number;
    sha256: string;
    matchesWaiver: boolean;
  };
}

interface SourcePatternGroup {
  category: Exclude<ModelToolNameCorpusCategory, 'tool-description' | 'generated-catalog'>;
  patterns: string[];
}

/** Keep corpus identities stable across POSIX and Windows checkouts. */
export function normalizeModelToolCorpusSource(source: string): string {
  return source.replaceAll('\\', '/');
}

function relativeCorpusSource(rootDir: string, path: string): string {
  return normalizeModelToolCorpusSource(relative(rootDir, path));
}

const SOURCE_PATTERN_GROUPS: SourcePatternGroup[] = [
  {
    category: 'prompt-source',
    patterns: [
      'packages/mcp/src/**/*.ts',
      'packages/core/src/skills/to-craftbook.ts',
      'packages/service/src/chat/**/*.ts',
      'packages/service/src/fs/store.ts',
      'packages/service/src/prompts/**/*.ts',
      'packages/service/src/providers/tool-repeat-tracker.ts',
      'packages/service/src/providers/local-tool-call-salvage.ts',
      'packages/service/src/providers/ollama.ts',
      'packages/service/src/providers/llama-cpp/provider.ts',
      'packages/service/src/providers/mlx/provider.ts',
      'packages/service/src/providers/mcp-wrappers/**/*.ts',
    ],
  },
  {
    category: 'behavior-source',
    patterns: ['packages/service/src/model-profile/behaviors/**/*.ts'],
  },
  {
    category: 'craftbook-authoring',
    patterns: [
      'packages/catalog/scripts/**/*.ts',
      'packages/catalog/scripts/**/*.json',
      'packages/catalog/scripts/**/*.md',
      'packages/catalog/src/archetype.ts',
      'packages/catalog/src/gstack-authoring.ts',
      'packages/catalog/src/gstack-import.ts',
      'packages/catalog/src/guardrail-books.ts',
    ],
  },
  {
    category: 'eval-prompt',
    patterns: [
      'evals/src/scenarios/**/*.ts',
      'evals/src/craftbooks/**/*.ts',
      'evals/src/mock/**/*.ts',
    ],
  },
  {
    category: 'example',
    patterns: ['packages/mcp/**/*.md'],
  },
];

const SOURCE_IGNORES = [
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/node_modules/**',
  '**/dist/**',
  '**/.import-cache/**',
  '**/.import-state/**',
  '**/gstack-skills/**',
  '**/gstack-personas/**',
  'packages/service/src/chat/model-tool-name-contract.ts',
  'packages/service/src/chat/prompt-tool-contract.ts',
  'packages/service/src/chat/role-tool-filter.ts',
];

/**
 * The exact 0.1.18 catalog pin retains historical versions that predate
 * canonical tool naming. Its content is
 * published from the separate gilde repo, so Gezel cannot edit it in place.
 * Keep a narrow occurrence budget for those immutable versions: newer 0.1.18
 * versions are clean, a new file/name occurrence still fails CI, and changing
 * the pin disables this waiver completely.
 */
const PINNED_GILDE_0_1_18_DEBT = {
  count: 153,
  // SHA-256 of sorted `relative-source|line|json-pointer|rule|tool`
  // occurrences. This makes the waiver exact without checking a 150-line
  // generated list into Gezel: a new, removed, renamed, or relocated
  // occurrence changes the digest and fails CI.
  sha256: '2eaeafed194f801cf6398a2f5b4a6fd390ef617340305d92d5953f23e0a4aae2',
} as const;

/**
 * Extract only runtime string/template bodies from TypeScript. This keeps the
 * corpus focused on text a model can actually see: comments, identifiers,
 * imports, and executable call sites are not prompt prose.
 */
export function extractModelFacingStringCorpus(args: {
  source: string;
  sourceText: string;
  category: ModelToolNameCorpusCategory;
}): ModelToolNameCorpusEntry[] {
  const scriptKind = args.source.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    args.source,
    args.sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const entries: ModelToolNameCorpusEntry[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteralLike(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = node.head.text;
      for (const span of node.templateSpans) {
        text += `__GEZEL_MODEL_TEXT_PLACEHOLDER__${span.literal.text}`;
      }
    }
    if (text) {
      entries.push({
        category: args.category,
        source: args.source,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

export function lintModelToolNameEntries(args: {
  entries: ReadonlyArray<ModelToolNameCorpusEntry>;
  allowedTools: ReadonlySet<string> | ReadonlyArray<string>;
}): ModelToolNameContractFinding[] {
  const findings: ModelToolNameContractFinding[] = [];
  const seen = new Set<string>();
  for (const entry of args.entries) {
    const entryTools = new Set(args.allowedTools);
    for (const tool of entry.declaredTools ?? []) entryTools.add(tool);
    const report = lintPromptToolContract({
      prompt: entry.text,
      availableTools: entryTools,
      toolDescription: entry.category === 'tool-description',
    });
    for (const finding of report.errors) {
      if (
        finding.rule !== 'legacy-tool-name' &&
        finding.rule !== 'removed-tool-name' &&
        finding.rule !== 'non-model-facing-tool-name' &&
        finding.rule !== 'unknown-tool-name'
      ) {
        continue;
      }
      const resolved = {
        ...finding,
        source: entry.source,
        category: entry.category,
        line: entry.physicalLineOnly ? entry.line : entry.line + finding.line - 1,
        ...(entry.jsonPointer ? { jsonPointer: entry.jsonPointer } : {}),
      };
      const key = `${resolved.source}:${resolved.jsonPointer ?? ''}:${resolved.line}:${resolved.rule}:${resolved.tool ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(resolved);
    }
  }
  return findings.sort(
    (a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

async function readCatalogToolsets(dataDir: string): Promise<Map<string, readonly string[]>> {
  const indexPath = resolve(dataDir, 'toolsets/index.json');
  const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
    entries?: Array<{ manifest?: { id?: string; tools?: Array<{ name?: string }> } }>;
  };
  const toolsets = new Map<string, readonly string[]>();
  for (const entry of parsed.entries ?? []) {
    const id = entry.manifest?.id;
    if (!id) continue;
    toolsets.set(
      id,
      (entry.manifest?.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    );
  }
  // This session-scoped integration is installed by the service rather than
  // the gilde npm catalog, but craftbooks declare it by the same toolset id.
  toolsets.set('microsoft-playwright-mcp', [...LOCAL_PREVIEW_BROWSER_TOOLS]);
  return toolsets;
}

async function gildePackageVersion(dataDir: string): Promise<string> {
  const packageJson = JSON.parse(await readFile(resolve(dataDir, '../package.json'), 'utf8')) as {
    version?: string;
  };
  return packageJson.version ?? 'unknown';
}

async function projectTypeToolsByGezelTemplate(
  dataDir: string,
): Promise<Map<string, readonly string[]>> {
  const index = JSON.parse(
    await readFile(resolve(dataDir, 'project-types/index.json'), 'utf8'),
  ) as {
    entries?: Array<{
      manifest?: { id?: string; version?: string; availableVersions?: string[] };
    }>;
  };
  const byTemplate = new Map<string, Set<string>>();
  for (const item of index.entries ?? []) {
    const id = item.manifest?.id;
    const version = item.manifest?.version;
    if (!id || !version) continue;
    for (const selectedVersion of item.manifest?.availableVersions ?? [version]) {
      const path = resolve(
        dataDir,
        'project-types',
        id.slice(0, 2),
        id,
        'versions',
        selectedVersion,
        'manifest.json',
      );
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        tools?: Array<{ name?: string }>;
        gezels?: Array<{ templateId?: string }>;
      };
      const tools = (manifest.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => Boolean(name));
      for (const gezel of manifest.gezels ?? []) {
        if (!gezel.templateId) continue;
        const declared = byTemplate.get(gezel.templateId) ?? new Set<string>();
        for (const tool of tools) declared.add(tool);
        byTemplate.set(gezel.templateId, declared);
      }
    }
  }
  return new Map([...byTemplate].map(([id, tools]) => [id, [...tools]]));
}

function partitionPinnedGildeDebt(args: {
  findings: ModelToolNameContractFinding[];
  gildeVersion: string;
}): {
  errors: ModelToolNameContractFinding[];
  pinnedDebt: ModelToolNameContractFinding[];
  fingerprint?: ModelToolNameContractReport['pinnedDebtFingerprint'];
} {
  if (args.gildeVersion !== '0.1.18') return { errors: args.findings, pinnedDebt: [] };
  const errors: ModelToolNameContractFinding[] = [];
  const candidates: Array<{ finding: ModelToolNameContractFinding; signature: string }> = [];
  for (const finding of args.findings) {
    const marker = '/@bendyline/gilde/data/';
    const normalizedSource = normalizeModelToolCorpusSource(finding.source);
    const markerIndex = normalizedSource.indexOf(marker);
    if (markerIndex < 0) {
      errors.push(finding);
      continue;
    }
    const relativeSource = normalizedSource.slice(markerIndex + marker.length);
    candidates.push({
      finding,
      signature: `${relativeSource}|${finding.line}|${finding.jsonPointer ?? ''}|${finding.rule}|${finding.tool ?? ''}`,
    });
  }
  const digest = createHash('sha256')
    .update(
      candidates
        .map((candidate) => candidate.signature)
        .sort()
        .join('\n'),
    )
    .digest('hex');
  const matchesWaiver =
    candidates.length === PINNED_GILDE_0_1_18_DEBT.count &&
    digest === PINNED_GILDE_0_1_18_DEBT.sha256;
  const fingerprint = {
    version: args.gildeVersion,
    count: candidates.length,
    sha256: digest,
    matchesWaiver,
  };
  if (!matchesWaiver) {
    return { errors: args.findings, pinnedDebt: [], fingerprint };
  }
  return { errors, pinnedDebt: candidates.map((candidate) => candidate.finding), fingerprint };
}

async function sourceEntries(
  rootDir: string,
  catalogToolNames: readonly string[],
): Promise<{
  entries: ModelToolNameCorpusEntry[];
  files: Set<string>;
}> {
  const entries: ModelToolNameCorpusEntry[] = [];
  const files = new Set<string>();
  for (const group of SOURCE_PATTERN_GROUPS) {
    const paths = await fg(group.patterns, {
      cwd: rootDir,
      absolute: true,
      onlyFiles: true,
      unique: true,
      ignore: SOURCE_IGNORES,
    });
    for (const path of paths.sort()) {
      const source = relativeCorpusSource(rootDir, path);
      const text = await readFile(path, 'utf8');
      files.add(source);
      const declaredTools = new Set<string>();
      if (
        source === 'packages/service/src/chat/manager.ts' ||
        source === 'packages/service/src/chat/instructions.ts' ||
        source === 'evals/src/scenarios/docblocks-theme-roundtrip.ts'
      ) {
        for (const tool of LOCAL_PREVIEW_BROWSER_TOOLS) declaredTools.add(tool);
      }
      if (
        source === 'packages/service/src/chat/manager.ts' ||
        source === 'packages/service/src/chat/instructions.ts'
      ) {
        for (const tool of catalogToolNames) declaredTools.add(tool);
      }
      if (source === 'evals/src/scenarios/tool-routing-browser.ts') {
        for (const tool of LOCAL_PREVIEW_BROWSER_TOOLS) declaredTools.add(tool);
      }
      if (source === 'evals/src/craftbooks/scenario.ts') {
        // This generic adapter executes craftbooks with arbitrary declared
        // catalog toolsets. Generated craftbook entries below are still
        // linted against their own exact declarations.
        for (const tool of catalogToolNames) declaredTools.add(tool);
      }
      if (source === 'evals/src/scenarios/schema-migration.ts') declaredTools.add('migrateUser');
      if (source === 'evals/src/scenarios/wikipedia-research-brief.ts') {
        declaredTools.add('search_wikipedia');
        declaredTools.add('read_wikipedia_sources');
      }
      if (path.endsWith('.ts') || path.endsWith('.tsx')) {
        entries.push(
          ...extractModelFacingStringCorpus({
            source,
            sourceText: text,
            category: group.category,
          }).map((entry) => ({ ...entry, declaredTools: [...declaredTools] })),
        );
      } else {
        entries.push({
          category: group.category,
          source,
          line: 1,
          text,
          declaredTools: [...declaredTools],
        });
      }
    }
  }
  return { entries, files };
}

async function generatedCatalogEntries(
  rootDir: string,
  dataDir: string,
  toolsets: ReadonlyMap<string, readonly string[]>,
): Promise<{
  entries: ModelToolNameCorpusEntry[];
  files: Set<string>;
  declaredTools: Set<string>;
}> {
  const entries: ModelToolNameCorpusEntry[] = [];
  const files = new Set<string>();
  const declaredTools = new Set<string>();
  const roleProjectTools = await projectTypeToolsByGezelTemplate(dataDir);
  const addMarkdown = async (
    path: string,
    declaredTools: readonly string[] = [],
  ): Promise<void> => {
    const source = relativeCorpusSource(rootDir, path);
    entries.push({
      category: 'generated-catalog',
      source,
      line: 1,
      text: await readFile(path, 'utf8'),
      declaredTools,
    });
    files.add(source);
  };
  const addJson = async (
    path: string,
    declaredForEntry: readonly string[] = [],
    optional = false,
  ): Promise<unknown | undefined> => {
    const source = relativeCorpusSource(rootDir, path);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    entries.push(
      ...extractModelFacingJsonStrings({
        source,
        sourceText: raw,
        value,
        declaredTools: declaredForEntry,
      }),
    );
    files.add(source);
    return value;
  };

  for (const kind of [
    'craftbook-templates',
    'gezel-templates',
    'project-types',
    'toolsets',
  ] as const) {
    const index = JSON.parse(await readFile(resolve(dataDir, `${kind}/index.json`), 'utf8')) as {
      entries?: Array<{
        manifest?: {
          id?: string;
          version?: string;
          availableVersions?: string[];
          tools?: Array<{ name?: string }>;
        };
      }>;
    };
    for (const item of index.entries ?? []) {
      const id = item.manifest?.id;
      const currentVersion = item.manifest?.version;
      if (!id || !currentVersion) continue;
      const itemDir = resolve(dataDir, kind, id.slice(0, 2), id);
      const currentDeclaredTools =
        kind === 'toolsets'
          ? (item.manifest?.tools ?? [])
              .map((tool) => tool.name)
              .filter((name): name is string => Boolean(name))
          : kind === 'gezel-templates'
            ? [...(roleProjectTools.get(id) ?? [])]
            : [];
      await addJson(resolve(itemDir, 'manifest.json'), currentDeclaredTools);
      const versions = item.manifest?.availableVersions?.length
        ? item.manifest.availableVersions
        : [currentVersion];
      for (const version of versions) {
        const versionDir = resolve(itemDir, 'versions', version);
        if (kind === 'craftbook-templates') {
          const craftbookPath = resolve(versionDir, 'craftbook.json');
          const raw = await readFile(craftbookPath, 'utf8');
          const craftbook = JSON.parse(raw) as {
            toolsets?: Array<{ toolsetId?: string }>;
          };
          const craftbookTools = Array.from(
            new Set(
              (craftbook.toolsets ?? []).flatMap((toolset) =>
                toolset.toolsetId ? [...(toolsets.get(toolset.toolsetId) ?? [])] : [],
              ),
            ),
          );
          entries.push(
            ...extractModelFacingJsonStrings({
              source: relativeCorpusSource(rootDir, craftbookPath),
              sourceText: raw,
              value: craftbook,
              declaredTools: craftbookTools,
            }),
          );
          files.add(relativeCorpusSource(rootDir, craftbookPath));
          await addJson(resolve(versionDir, 'test.json'), craftbookTools, true);
        } else if (kind === 'gezel-templates') {
          const roleTools = [...(roleProjectTools.get(id) ?? [])];
          await addJson(resolve(versionDir, 'manifest.json'), roleTools);
          await addMarkdown(resolve(versionDir, 'about.md'), roleTools);
        } else if (kind === 'project-types') {
          const manifestPath = resolve(versionDir, 'manifest.json');
          const raw = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(raw) as {
            tools?: Array<{ name?: string }>;
            aboutTemplate?: string;
            missionTemplate?: string;
          };
          const projectTools = (manifest.tools ?? [])
            .map((tool) => tool.name)
            .filter((name): name is string => Boolean(name));
          for (const tool of projectTools) declaredTools.add(tool);
          entries.push(
            ...extractModelFacingJsonStrings({
              source: relativeCorpusSource(rootDir, manifestPath),
              sourceText: raw,
              value: manifest,
              declaredTools: projectTools,
            }),
          );
          files.add(relativeCorpusSource(rootDir, manifestPath));
          for (const referenced of [manifest.aboutTemplate, manifest.missionTemplate]) {
            if (referenced) await addMarkdown(resolve(versionDir, referenced), projectTools);
          }
        } else {
          const manifestPath = resolve(versionDir, 'manifest.json');
          const versionRaw = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(versionRaw) as { tools?: Array<{ name?: string }> };
          const versionTools = (manifest?.tools ?? [])
            .map((tool) => tool.name)
            .filter((name): name is string => Boolean(name));
          const source = relativeCorpusSource(rootDir, manifestPath);
          entries.push(
            ...extractModelFacingJsonStrings({
              source,
              sourceText: versionRaw,
              value: manifest,
              declaredTools: versionTools,
            }),
          );
          files.add(source);
          for (const tool of versionTools) declaredTools.add(tool);
        }
      }
    }
  }
  return { entries, files, declaredTools };
}

const MODEL_FACING_JSON_KEYS = new Set([
  'about',
  'description',
  'instructions',
  'missionObjectives',
  'objective',
  'plan',
  'procedure',
  'prompt',
  'systemPrompt',
  'text',
  'userPrompt',
]);
const NON_MODEL_JSON_SUBTREES = new Set([
  'checks',
  'content',
  'files',
  'rubric',
  'scripts',
  'success',
  'workspaceSeed',
]);

function jsonPointerEscape(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function extractModelFacingJsonStrings(args: {
  source: string;
  sourceText: string;
  value: unknown;
  declaredTools?: readonly string[];
}): ModelToolNameCorpusEntry[] {
  const entries: ModelToolNameCorpusEntry[] = [];
  let searchFrom = 0;
  const visit = (value: unknown, pointer: string, key?: string): void => {
    if (key && NON_MODEL_JSON_SUBTREES.has(key)) return;
    if (typeof value === 'string') {
      const encoded = JSON.stringify(value);
      const position = args.sourceText.indexOf(encoded, searchFrom);
      if (position >= 0) searchFrom = position + encoded.length;
      const physicalLine =
        position >= 0 ? args.sourceText.slice(0, position).split('\n').length : 1;
      if (key === 'matcher') {
        const names = value.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
        entries.push({
          category: 'generated-catalog',
          source: args.source,
          line: physicalLine,
          text: names.map((name) => `Call \`${name}()\`.`).join('\n'),
          declaredTools: args.declaredTools,
          jsonPointer: pointer,
          physicalLineOnly: true,
        });
        return;
      }
      if (!key || !MODEL_FACING_JSON_KEYS.has(key)) return;
      entries.push({
        category: 'generated-catalog',
        source: args.source,
        line: physicalLine,
        text: value,
        declaredTools: args.declaredTools,
        jsonPointer: pointer,
        physicalLineOnly: true,
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pointer}/${index}`, key));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, `${pointer}/${jsonPointerEscape(childKey)}`, childKey);
    }
  };
  visit(args.value, '');
  return entries;
}

/**
 * Scan every owned model-facing corpus plus the exact pinned generated gilde
 * content. The final rendered-prompt matrix remains the authority for
 * per-session availability; this fast pass enforces registry spelling and
 * rejects tool-shaped names that no live built-in or installed catalog
 * toolset declares.
 */
export async function buildModelToolNameContract(args?: {
  rootDir?: string;
  dataDir?: string;
}): Promise<ModelToolNameContractReport> {
  const rootDir = args?.rootDir ?? repoRoot();
  const dataDir = args?.dataDir ?? gildeDataDir();
  const toolContracts = await loadBuiltinToolContractsForLint();
  const catalogToolsets = await readCatalogToolsets(dataDir);
  const catalogToolNames = Array.from(new Set([...catalogToolsets.values()].flat()));
  const allowedTools = new Set<string>(
    Object.values(TOOL_REGISTRY)
      .filter((entry) => entry.modelFacing)
      .map((entry) => entry.canonicalName),
  );
  const entries: ModelToolNameCorpusEntry[] = toolContracts.map((tool) => ({
    category: 'tool-description',
    source: `mcp-tool-description:${tool.name}`,
    line: 1,
    text: tool.description ?? '',
    declaredTools: [...LOCAL_PREVIEW_BROWSER_TOOLS],
  }));
  const files = new Set<string>();
  const source = await sourceEntries(rootDir, catalogToolNames);
  entries.push(...source.entries);
  for (const file of source.files) files.add(file);
  const generated = await generatedCatalogEntries(rootDir, dataDir, catalogToolsets);
  entries.push(...generated.entries);
  for (const file of generated.files) files.add(file);

  const declaredToolUniverse = new Set<string>();
  for (const entry of entries) {
    for (const tool of entry.declaredTools ?? []) declaredToolUniverse.add(tool);
  }

  const partitioned = partitionPinnedGildeDebt({
    findings: lintModelToolNameEntries({ entries, allowedTools }),
    gildeVersion: await gildePackageVersion(dataDir),
  });

  return {
    fileCount: files.size,
    entryCount: entries.length,
    allowedToolCount: new Set([...allowedTools, ...declaredToolUniverse]).size,
    errors: partitioned.errors,
    pinnedDebt: partitioned.pinnedDebt,
    ...(partitioned.fingerprint ? { pinnedDebtFingerprint: partitioned.fingerprint } : {}),
  };
}

export function formatModelToolNameFinding(finding: ModelToolNameContractFinding): string {
  const pointer = finding.jsonPointer ? ` ${finding.jsonPointer}` : '';
  return `${finding.source}:${finding.line}${pointer} [${finding.category}] ${formatPromptToolContractFinding(finding)}`;
}

async function main(): Promise<void> {
  const report = await buildModelToolNameContract();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Model tool-name contract: ${report.fileCount} files, ${report.entryCount} model-facing strings, ${report.allowedToolCount} declared tool names\n  pinned gilde migration debt: ${report.pinnedDebt.length} known occurrence(s); any new occurrence fails\n${
        report.pinnedDebtFingerprint
          ? `  pinned fingerprint: ${report.pinnedDebtFingerprint.count} / ${report.pinnedDebtFingerprint.sha256}${report.pinnedDebtFingerprint.matchesWaiver ? '' : ' (WAIVER MISMATCH)'}\n`
          : ''
      }`,
    );
    for (const finding of report.errors.slice(0, 200)) {
      process.stdout.write(`ERROR ${formatModelToolNameFinding(finding)}\n`);
    }
    if (report.errors.length > 200) {
      process.stdout.write(`... ${report.errors.length - 200} additional errors omitted\n`);
    }
    process.stdout.write(`${report.errors.length} error(s)\n`);
  }
  process.exitCode = report.errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
