import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CraftbookDoc,
  CraftbookDocSchema,
  type CraftbookTestSpec,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  normalizeStepGate,
  parseCraftbookTestSpec,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLSETS } from './builtin-toolsets.js';
import {
  gstackAuthoringDir,
  readGstackWaveConfig,
  resolveGstackAuthoringGildeRoot,
} from './gstack-authoring.js';
import {
  type Overlay,
  OverlaySchema,
  applyOverlay,
  convertSnapshotSkill,
  mergeWaveIdentity,
} from './gstack-import.js';
import { CAREFUL_MODE, FREEZE_SCOPE } from './guardrail-books.js';

/**
 * Regen fidelity for the shipped skill conversions: authoring source and
 * generated payload ship atomically in Gilde, so a fresh deterministic
 * conversion must reproduce the configured version byte-for-byte.
 */

const authoringGildeRoot = resolveGstackAuthoringGildeRoot();
const authoringRoot = gstackAuthoringDir(authoringGildeRoot);
const dataRoot = join(authoringGildeRoot, 'data', 'craftbook-templates');
const snapshotRoot = join(authoringRoot, 'snapshots');
const evalRoot = join(authoringRoot, 'evals');
const wave = readGstackWaveConfig(authoringGildeRoot);
const WAVE = wave.books;
const VERSION = wave.version;
const RELEASED_AT = wave.releasedAt;
const GSTACK_BASED_ON = wave.basedOn;

interface ConvertedTextField {
  bookId: string;
  path: string;
  text: string;
}

interface TextRule {
  label: string;
  pattern: RegExp;
}

/**
 * Tokens supplied by the upstream host, not by a gezel session. Keep this
 * list deliberately lexical: ordinary prose can say "read the code", while
 * these spellings teach the model to call a tool or subprocess it cannot
 * have. The overlay should replace them with gezel-native workflow prose.
 */
const FOREIGN_HOST_RULES: TextRule[] = [
  { label: 'AskUserQuestion', pattern: /\bAskUserQuestion\b/g },
  { label: 'WebSearch', pattern: /\bWebSearch\b/g },
  { label: 'Grep', pattern: /\bGrep\b/g },
  { label: 'Glob', pattern: /\bGlob\b/g },
  { label: 'Read tool', pattern: /\bRead tool\b/g },
  { label: 'Write tool', pattern: /\bWrite tool\b/g },
  { label: 'Edit tool', pattern: /\bEdit tool\b/g },
  { label: 'Agent tool', pattern: /\bAgent tool\b/g },
  { label: 'ExitPlanMode', pattern: /\bExitPlanMode\b/g },
  { label: 'CLAUDE.md', pattern: /\bCLAUDE\.md\b/g },
  { label: '$B browser binary', pattern: /\$B\b/g },
  { label: '$D design binary', pattern: /\$D\b/g },
  { label: 'Codex subprocess/voice', pattern: /\bCodex\b/g },
  { label: 'Claude subagent', pattern: /\bClaude subagent\b/g },
  { label: 'Bash host tool', pattern: /\bBash\b/g },
  { label: 'shell code fence', pattern: /```(?:bash|sh|shell|zsh)\b/g },
];

/**
 * The importer writes one self-contained craftbook.json and does not copy
 * the source skill's companion directories. A surviving reference below is
 * therefore unresolvable after installation, even if that path existed in
 * the original project.
 */
const SOURCE_COMPANION_REFERENCE =
  /\b(?:sections|references|templates|scripts|bin)\/[A-Za-z0-9][A-Za-z0-9._/<>-]*/g;

/**
 * Source command names are not gezel commands: every imported book receives
 * the plain id in wave.json as its command. These additional upstream handoffs
 * were never imported at all. Any of them surviving conversion is a dead
 * workflow edge rather than useful guidance.
 */
const UNAVAILABLE_SLASH_COMMANDS = [
  ...WAVE.map((book) => book.source),
  'autoplan',
  'codex',
  'design-review',
  'document-release',
  'plan-design-review',
  'plan-eng-review',
  'qa',
  'ship',
  'unfreeze',
]
  .sort((a, b) => b.length - a.length)
  .map((command) => command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const UNRESOLVED_SLASH_COMMAND = new RegExp(
  `(?<![A-Za-z0-9_./:-])/(?:${UNAVAILABLE_SLASH_COMMANDS})(?![A-Za-z0-9_.-])`,
  'g',
);

function readOverlayFixture(source: string): Overlay {
  return OverlaySchema.parse(
    JSON.parse(readFileSync(join(authoringRoot, 'overlays', `${source}.json`), 'utf8')) as unknown,
  );
}

function committedPath(id: string, version: string): string {
  return join(dataRoot, id.slice(0, 2).toLowerCase(), id, 'versions', version, 'craftbook.json');
}

function committedBytes(id: string, version: string): string {
  return readFileSync(committedPath(id, version), 'utf8');
}

function committedTestPath(id: string, version: string): string {
  return join(dataRoot, id.slice(0, 2).toLowerCase(), id, 'versions', version, 'test.json');
}

function readEvalFixture(source: string): CraftbookTestSpec {
  const path = join(evalRoot, `${source}.json`);
  const parsed = parseCraftbookTestSpec(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!parsed.ok) throw new Error(`${source}: ${parsed.errors.join('\n')}`);
  return parsed.spec;
}

function freshConversion(book: (typeof WAVE)[number]): CraftbookDoc {
  const overlay = readOverlayFixture(book.source);
  const raw = readFileSync(join(snapshotRoot, book.source, 'SKILL.md'), 'utf8');
  return convertSnapshotSkill(book, raw, overlay, wave).doc;
}

function expandFreshDoc(doc: CraftbookDoc) {
  const expanded = craftbookFromDoc(doc, { now: RELEASED_AT });
  if (!expanded.ok) {
    throw new Error(`${doc.id ?? doc.name}:\n${formatCraftbookDocErrors(expanded.errors)}`);
  }
  return expanded.craftbook;
}

function convertedTextFields(bookId: string, doc: CraftbookDoc): ConvertedTextField[] {
  const fields: ConvertedTextField[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      fields.push({ bookId, path, text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      // `basedOn` is provenance, not executable/user-facing workflow prose.
      if (key === 'basedOn') continue;
      visit(entry, `${path}/${key}`);
    }
  };
  visit(doc, '');
  return fields;
}

function ruleOffenders(fields: ConvertedTextField[], rules: TextRule[]): string[] {
  const offenders: string[] = [];
  for (const field of fields) {
    for (const rule of rules) {
      const matches = [...field.text.matchAll(rule.pattern)];
      if (matches.length > 0) {
        offenders.push(`${field.bookId}${field.path}: ${rule.label} (${matches.length})`);
      }
    }
  }
  return offenders;
}

function referenceOffenders(fields: ConvertedTextField[]): string[] {
  const offenders: string[] = [];
  for (const field of fields) {
    for (const pattern of [SOURCE_COMPANION_REFERENCE, UNRESOLVED_SLASH_COMMAND]) {
      const counts = new Map<string, number>();
      for (const match of field.text.matchAll(pattern)) {
        counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      }
      for (const [reference, count] of counts) {
        offenders.push(`${field.bookId}${field.path}: ${reference} (${count})`);
      }
    }
  }
  return offenders;
}

describe('shipped skill conversions — regen fidelity', () => {
  for (const book of WAVE) {
    it(`${book.id}: generated bytes match the Gilde authoring source`, () => {
      const overlay = readOverlayFixture(book.source);
      if (overlay.frozen) return; // hand-owned — regen deliberately skips it
      const doc = freshConversion(book);
      expect(serializeCraftbookDoc(doc, 'json')).toBe(committedBytes(book.id, VERSION));
    });
  }

  it('fresh conversions credit gstack without leaking source branding into their content', () => {
    for (const book of WAVE) {
      const parsed = CraftbookDocSchema.parse(freshConversion(book));
      expect(parsed.basedOn).toEqual(GSTACK_BASED_ON);
      const { basedOn: _basedOn, ...content } = parsed;
      const contentBytes = JSON.stringify(content).toLowerCase();
      expect(contentBytes, `${book.id} names gstack outside basedOn`).not.toContain('gstack');
      expect(contentBytes, `${book.id} names gbrain`).not.toContain('gbrain');
      expect(contentBytes).not.toContain('converted from');
    }
  });

  it('all nine fresh conversions reject foreign host tools and subprocess instructions', () => {
    expect(WAVE).toHaveLength(9);
    const fields = WAVE.flatMap((book) => convertedTextFields(book.id, freshConversion(book)));
    expect(
      ruleOffenders(fields, FOREIGN_HOST_RULES),
      'replace upstream host tokens with gezel-native workflow prose or tools',
    ).toEqual([]);
  });

  it('all nine fresh conversions reject unresolved companion and slash-command references', () => {
    expect(WAVE).toHaveLength(9);
    const fields = WAVE.flatMap((book) => convertedTextFields(book.id, freshConversion(book)));
    expect(
      referenceOffenders(fields),
      'inline required guidance and replace source slash commands with real gezel workflow edges',
    ).toEqual([]);
  });

  it('all nine fresh conversions have bounded, role-routed, gated review workflows', () => {
    expect(WAVE).toHaveLength(9);
    for (const book of WAVE) {
      const runtime = expandFreshDoc(freshConversion(book));
      const byId = new Map(runtime.steps.map((step) => [step.id, step]));
      const nonterminal = runtime.steps.filter((step) => !step.terminal);

      expect(
        runtime.steps.every((step) => Boolean(step.suggestedRole)),
        `${book.id}: every step needs a role`,
      ).toBe(true);
      expect(
        nonterminal.every((step) => Boolean(step.gate)),
        `${book.id}: every working/review step needs a gate`,
      ).toBe(true);
      expect(
        nonterminal.every((step) => normalizeStepGate(step.gate!).maxAttempts > 0),
        `${book.id}: every gate needs a bounded retry budget`,
      ).toBe(true);
      expect(byId.get('evaluate')?.next).toBe('repair');
      expect(byId.get('repair')?.next).toBe('evaluate');
      expect(byId.get('finish')?.terminal).toBe(true);
      expect(byId.get('needs-user')?.terminal).toBe(true);
    }
  });

  it('all nine eval sources exercise their named workflow with runtime attribution', () => {
    for (const book of WAVE) {
      const overlay = readOverlayFixture(book.source);
      const workflow = overlay.workflow;
      expect(workflow, `${book.id}: curated workflow overlay`).toBeDefined();
      const spec = readEvalFixture(book.source);
      const deliverablePaths = (spec.success.deliverables ?? []).map(({ path }) => path);

      expect(spec.prompt, `${book.id}: prompt names the craftbook`).toMatch(
        new RegExp(`${book.id}|${book.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
      );
      expect(spec.setup.files.length, `${book.id}: self-contained fixture files`).toBeGreaterThan(
        0,
      );
      expect(
        spec.setup.worker,
        `${book.id}: real craftbook task, not a direct worker`,
      ).toBeUndefined();
      expect(
        spec.success.taskNotes?.requireCraftbookTask,
        `${book.id}: runtime task attribution`,
      ).toBe(true);
      expect(spec.success.taskGraph, `${book.id}: terminal runtime workflow proof`).toEqual({
        requireCraftbookTask: true,
        requireTerminalStep: true,
      });
      expect(deliverablePaths, `${book.id}: final workflow artifact is graded`).toContain(
        workflow!.review.artifactPath,
      );
      expect(spec.rubric.artifact.path).toBe(workflow!.review.artifactPath);

      if (book.id === 'browser-qa-audit') {
        expect(
          spec.setup.files.find(({ path }) => path === 'fixtures/signup.html')?.modelInput,
          'black-box browser fixture must be seeded without becoming model source input',
        ).toBe(false);
      }

      const committed = committedTestPath(book.id, VERSION);
      expect(readFileSync(committed, 'utf8')).toBe(`${JSON.stringify(spec, null, 2)}\n`);
    }
  });

  it('guardrail books match their writer definitions byte-for-byte', () => {
    for (const doc of [CAREFUL_MODE, FREEZE_SCOPE]) {
      const parsed = CraftbookDocSchema.parse(doc);
      expect(parsed.basedOn).toEqual(GSTACK_BASED_ON);
      expect(serializeCraftbookDoc(parsed, 'json')).toBe(
        committedBytes(parsed.id!, parsed.version!),
      );
    }
  });

  it('guardrail hooks cover the canonical workspace mutation tool names', () => {
    const carefulMatcher = new RegExp(CAREFUL_MODE.hooks?.[0]?.matcher ?? '');
    expect(carefulMatcher.test('delete_path')).toBe(true);
    expect(carefulMatcher.test('rm')).toBe(false);

    const freezeMatcher = new RegExp(FREEZE_SCOPE.hooks?.[0]?.matcher ?? '');
    const workspaceWrite = BUILTIN_TOOLSETS.find(({ id }) => id === 'workspace-fs-write');
    expect(workspaceWrite, 'workspace-fs-write toolset exists').toBeDefined();
    for (const tool of workspaceWrite?.tools ?? []) {
      expect(freezeMatcher.test(tool), `freeze hook covers ${tool}`).toBe(true);
    }
    for (const tool of [
      'npm_install',
      'run_package_script',
      'run_npx',
      'run_nodejs_script',
      'derive_file',
      'run_playwright_script',
      'run_installed_script',
      'extract_archive',
      'apply_project_type',
    ]) {
      expect(freezeMatcher.test(tool), `freeze hook covers ${tool}`).toBe(true);
    }

    const freezeScript = FREEZE_SCOPE.scripts?.['check-freeze'] ?? '';
    const carefulScript = CAREFUL_MODE.scripts?.['check-careful'] ?? '';
    for (const script of [carefulScript, freezeScript]) {
      expect(script).toContain("toolName: { type: 'string'");
      expect(script).toContain("args: { type: 'json'");
      expect(script).toContain("phase: { type: 'string'");
      expect(script).not.toContain('inputs: {}');
    }
    for (const argumentName of ['fromPath', 'toPath', 'dest', 'outputPath']) {
      expect(freezeScript, `freeze script inspects ${argumentName}`).toContain(argumentName);
    }
    expect(freezeScript).toContain('unboundedWriteTools');
    expect(freezeScript).toContain('can write undeclared paths');
    expect(FREEZE_SCOPE.description).toContain('built-in workspace mutation');
    expect(FREEZE_SCOPE.description).toContain('outside this hook contract');
  });
});

describe('applyOverlay', () => {
  const base: CraftbookDoc = CraftbookDocSchema.parse({
    id: 'gs-demo',
    name: 'Demo',
    plan: 'Original plan.',
    steps: [
      { id: 'a', name: 'A', next: 'b' },
      { id: 'b', name: 'B', terminal: true },
    ],
    scripts: { keeper: 'export const meta = 1;' },
  });

  it('rejects malformed or misspelled overlay fields before conversion', () => {
    expect(() => OverlaySchema.parse({ frozen: 'false' })).toThrow();
    expect(() => OverlaySchema.parse({ workfow: {} })).toThrow();
  });

  it('set replaces fields shallowly and planAppend extends the plan', () => {
    const out = applyOverlay(base, {
      set: { name: 'Renamed' },
      planAppend: 'Appended guidance.',
    });
    expect(out.name).toBe('Renamed');
    expect(out.plan).toBe('Original plan.\n\nAppended guidance.');
  });

  it('planAppend on a plan-less doc becomes the plan', () => {
    const { plan: _plan, ...noPlanRaw } = base;
    const noPlan = CraftbookDocSchema.parse(noPlanRaw);
    const out = applyOverlay(noPlan, { planAppend: 'Only guidance.' });
    expect(out.plan).toBe('Only guidance.');
  });

  it('version generation preserves catalog-owned identity metadata', () => {
    const book = {
      source: 'demo',
      id: 'gs-demo',
      name: 'Demo',
      description: 'A deterministic demo conversion.',
      tags: ['demo'],
    };
    const identity = mergeWaveIdentity(
      {
        role: 'general',
        logo: 'logo.webp',
        yankedVersions: ['1.0.0'],
        curatorNote: 'keep me',
      },
      book,
      base,
    );
    expect(identity).toMatchObject({
      id: book.id,
      name: book.name,
      role: 'general',
      logo: 'logo.webp',
      yankedVersions: ['1.0.0'],
      curatorNote: 'keep me',
    });
  });

  it('steps patch by id and null removes a step; scripts null removes an entry', () => {
    const out = applyOverlay(
      CraftbookDocSchema.parse({
        ...base,
        steps: [
          { id: 'a', name: 'A', next: 'b' },
          { id: 'b', name: 'B', next: 'c' },
          { id: 'c', name: 'C', terminal: true },
        ],
      }),
      {
        steps: { b: { prompt: 'patched' }, c: null },
        scripts: { keeper: null, added: 'export const meta = 2;' },
      },
    );
    expect(out.steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out.steps[1]!.prompt).toBe('patched');
    expect(Object.keys(out.scripts ?? {})).toEqual(['added']);
  });
});
