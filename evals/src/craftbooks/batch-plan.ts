import type {
  CraftbookAuditResult,
  CraftbookEvalValidationScope,
  CraftbookTemplateSummary,
} from './types.ts';

export type CraftbookHarnessKind =
  | 'generic-file-gate'
  | 'html-playwright'
  | 'seeded-codebase'
  | 'seeded-data'
  | 'seeded-corpus'
  | 'fake-http'
  | 'fake-mcp'
  | 'fake-cli'
  | 'media-stub'
  | 'hook-runtime';

export interface CraftbookBatchPlanItem {
  craftbookId: string;
  name: string;
  score: number;
  evalStatus: string;
  validationScope: CraftbookEvalValidationScope;
  priority: number;
  harness: CraftbookHarnessKind[];
  simulatorIds: string[];
  reason: string;
}

export interface CraftbookBatchPlan {
  target: number;
  runnableNow: string[];
  items: CraftbookBatchPlanItem[];
  harnessCounts: Record<CraftbookHarnessKind, number>;
}

const HARNESS_KINDS: CraftbookHarnessKind[] = [
  'generic-file-gate',
  'html-playwright',
  'seeded-codebase',
  'seeded-data',
  'seeded-corpus',
  'fake-http',
  'fake-mcp',
  'fake-cli',
  'media-stub',
  'hook-runtime',
];

export function buildCraftbookBatchPlan(args: {
  templates: CraftbookTemplateSummary[];
  audits: CraftbookAuditResult[];
  target: number;
  /**
   * Declared task-class tags per craftbook (from each book's `test.json`).
   * When present for a book, they are the harness-selection truth; the
   * regex cascade below is only the fallback for books without tags.
   */
  tagsByCraftbookId?: ReadonlyMap<string, readonly string[]>;
}): CraftbookBatchPlan {
  const byTemplate = new Map(args.templates.map((template) => [template.id, template]));
  const runnableNow = args.audits
    .filter((audit) => audit.evalStatus === 'implemented' || audit.evalStatus === 'validated')
    .map((audit) => audit.craftbookId)
    .sort();
  const items = args.audits
    .map((audit) => {
      const template = byTemplate.get(audit.craftbookId);
      if (!template) return null;
      return planItem(template, audit, args.tagsByCraftbookId?.get(audit.craftbookId));
    })
    .filter((item): item is CraftbookBatchPlanItem => item !== null)
    .sort((a, b) => b.priority - a.priority || a.craftbookId.localeCompare(b.craftbookId))
    .slice(0, args.target);

  const harnessCounts = Object.fromEntries(HARNESS_KINDS.map((kind) => [kind, 0])) as Record<
    CraftbookHarnessKind,
    number
  >;
  for (const item of items) {
    for (const kind of item.harness) harnessCounts[kind]++;
  }
  return { target: args.target, runnableNow, items, harnessCounts };
}

function planItem(
  template: CraftbookTemplateSummary,
  audit: CraftbookAuditResult,
  declaredTags?: readonly string[],
): CraftbookBatchPlanItem {
  const text = [
    template.id,
    template.name,
    template.description ?? '',
    (template.triggers ?? []).join(' '),
    template.steps.map((step) => `${step.name} ${step.description ?? ''}`).join(' '),
  ]
    .join(' ')
    .toLowerCase();
  const harnessKinds = new Set(harnessFromTags(declaredTags) ?? inferHarness(text));
  // Hooks are a structural runtime surface, not a keyword. Keep this
  // classification available even when callers have not separately loaded
  // test.json tags (the unit/API path that wild-caught a zero hook plan).
  if ((template.hooks?.length ?? 0) > 0) harnessKinds.add('hook-runtime');
  const harness = [...harnessKinds].sort();
  const simulatorIds = inferSimulators(harness, template.id);
  const missingEval = audit.evalStatus === 'missing' ? 35 : audit.evalStatus === 'planned' ? 20 : 0;
  const validationGap =
    audit.evalStatus === 'implemented' ? 20 : audit.validationScope === 'artifact-only' ? 10 : 0;
  const qualityGap = Math.max(0, 110 - audit.score);
  const simulatorBoost = harness.some((kind) => kind.startsWith('fake-')) ? 10 : 0;
  // A hook is executable policy, so keep at least one hook-backed workflow in
  // the representative batch even when its static quality score is high.
  const hookBoost = harness.includes('hook-runtime') ? 10 : 0;
  const priority = missingEval + validationGap + qualityGap + simulatorBoost + hookBoost;
  return {
    craftbookId: template.id,
    name: template.name,
    score: audit.score,
    evalStatus: audit.evalStatus,
    validationScope: audit.validationScope,
    priority,
    harness,
    simulatorIds,
    reason: reasonFor(harness, audit),
  };
}

/**
 * Map the declared test.json task-class tags onto planning harness kinds.
 * Returns null when no tag maps, so the caller can fall back to the
 * legacy regex inference (kept only for books with no/foreign tags).
 */
function harnessFromTags(tags?: readonly string[]): CraftbookHarnessKind[] | null {
  if (!tags || tags.length === 0) return null;
  const kinds = new Set<CraftbookHarnessKind>();
  for (const tag of tags) {
    switch (tag) {
      case 'html-game':
      case 'html-page':
        kinds.add('html-playwright');
        break;
      case 'code':
        kinds.add('seeded-codebase');
        break;
      case 'data':
        kinds.add('seeded-data');
        break;
      case 'corpus':
        kinds.add('seeded-corpus');
        break;
      case 'media':
        kinds.add('media-stub');
        break;
      case 'external':
        kinds.add('fake-http');
        kinds.add('fake-cli');
        break;
      case 'guardrail':
        kinds.add('hook-runtime');
        break;
      default:
        break;
    }
  }
  if (kinds.size === 0) return null;
  return [...kinds].sort();
}

function inferHarness(text: string): CraftbookHarnessKind[] {
  const kinds = new Set<CraftbookHarnessKind>();
  if (/\b(html|website|page|form|dashboard|game|browser|canvas|svg|pwa|component)\b/.test(text)) {
    kinds.add('html-playwright');
  }
  if (
    /\b(api|server|typescript|javascript|python|codebase|test|refactor|migration|sdk|cli|docker|graphql|grpc)\b/.test(
      text,
    )
  ) {
    kinds.add('seeded-codebase');
  }
  if (
    /\b(csv|spreadsheet|sql|dataset|data|ledger|export|etl|cohort|forecast|anomaly)\b/.test(text)
  ) {
    kinds.add('seeded-data');
  }
  if (
    /\b(research|report|brief|postmortem|docs|documentation|corpus|newsletter|digest|minutes|bibliography|citations?|knowledge[- ]base|article|copy|press|case study)\b/.test(
      text,
    )
  ) {
    kinds.add('seeded-corpus');
  }
  if (/\b(scrape|feed|price|market|web search|url|http|api source|rss)\b/.test(text)) {
    kinds.add('fake-http');
  }
  if (/\b(github|pull request|ci|check status|workflow|release|ship|deploy)\b/.test(text)) {
    kinds.add('fake-mcp');
    kinds.add('fake-cli');
  }
  if (
    /\b(image|photo|thumbnail|logo|icon|audio|voiceover|video|transcribe|subtitle|music)\b/.test(
      text,
    )
  ) {
    kinds.add('media-stub');
  }
  if (kinds.size === 0) kinds.add('generic-file-gate');
  return [...kinds].sort();
}

function inferSimulators(kinds: CraftbookHarnessKind[], id: string): string[] {
  const simulators = new Set<string>();
  for (const kind of kinds) {
    if (kind === 'fake-http') simulators.add(`${id}-fixture-http`);
    if (kind === 'fake-mcp') simulators.add(`${id}-fixture-mcp`);
    if (kind === 'fake-cli') simulators.add(`${id}-fixture-cli`);
    if (kind === 'media-stub') simulators.add(`${id}-media-fixtures`);
  }
  return [...simulators].sort();
}

function reasonFor(kinds: CraftbookHarnessKind[], audit: CraftbookAuditResult): string {
  const parts = [
    `${audit.evalStatus} eval`,
    `${audit.validationScope} workflow evidence`,
    `${audit.score}/110 quality`,
  ];
  if (kinds.includes('html-playwright')) parts.push('needs browser/runtime assertions');
  if (kinds.includes('seeded-codebase')) parts.push('needs seeded codebase plus executable gate');
  if (kinds.includes('seeded-data')) parts.push('needs fixture data plus property checks');
  if (kinds.includes('seeded-corpus')) parts.push('needs evidence corpus plus grounding checks');
  if (kinds.some((kind) => kind.startsWith('fake-')))
    parts.push('needs fake external tool/service');
  if (kinds.includes('media-stub')) parts.push('needs deterministic media fixtures or stubs');
  if (kinds.includes('hook-runtime'))
    parts.push('needs task attribution plus hook History evidence');
  return parts.join('; ');
}
