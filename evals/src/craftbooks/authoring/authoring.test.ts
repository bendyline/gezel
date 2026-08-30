import type { Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, getScenario, listScenarios } from '../../scenarios/index.ts';
import { ORDERS_CSV } from './author-linear.ts';
import { GATE_HEADING, SEEDED_POLISH_PROMPT, seededPromptStillPresent } from './edit-midtask.ts';
import { INVENTORY_JSON } from './gate-script.ts';
import {
  checkGateScriptSubstance,
  craftbookGateScriptRefs,
  isStepGated,
  parseJsonRecords,
  parseJsonValue,
  taskReferencesCraftbook,
  ungatedBuildStepIds,
} from './helpers.ts';
import { CRAFTBOOK_AUTHORING_SCENARIOS } from './index.ts';

/* ── anti-stub gate-script floor ─────────────────────────────────────── */

const STUB_ALWAYS_APPROVE = 'gezel.output(gateResult(true));';

const SUBSTANTIVE_GATE_SCRIPT = `import { gateResult, fileMinBytes, jsonValid } from '@bendyline/gezel-sdk/checks';
import { gezel } from '@bendyline/gezel-sdk';

const path = 'out/inventory-report.json';
const parses = await jsonValid(gezel.workspace, path);
const size = await fileMinBytes(gezel.workspace, path, 200);
if (!parses.ok || !size.ok) {
  gezel.output(gateResult(false, parses.detail ?? size.detail ?? 'report missing'));
} else {
  const report = JSON.parse(await gezel.workspace.read(path));
  const covered = Array.isArray(report.items) && report.items.length >= 10;
  gezel.output(gateResult(covered, covered ? undefined : 'report does not cover the inventory'));
}
`;

describe('checkGateScriptSubstance (anti-stub floor)', () => {
  it('rejects a bare always-approve stub', () => {
    const result = checkGateScriptSubstance(STUB_ALWAYS_APPROVE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too short/);
  });

  it('rejects an absent source', () => {
    expect(checkGateScriptSubstance(undefined).ok).toBe(false);
    expect(checkGateScriptSubstance('').ok).toBe(false);
  });

  it('rejects a long script that never imports the checks helpers', () => {
    const padded = `${'// filler comment to clear the length floor without substance\n'.repeat(6)}gezel.output(gateResult(true));`;
    const result = checkGateScriptSubstance(padded);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/@bendyline\/gezel-sdk\/checks/);
  });

  it('rejects a script missing the gateResult stamp', () => {
    const source = `import { fileMinBytes } from '@bendyline/gezel-sdk/checks';\n${'// long enough body of real-looking verification logic here\n'.repeat(4)}gezel.output({ decision: 'approve' });`;
    const result = checkGateScriptSubstance(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/gateResult/);
  });

  it('rejects a script missing the gezel.output stamp', () => {
    const source = `import { gateResult } from '@bendyline/gezel-sdk/checks';\n${'// long enough body of real-looking verification logic here\n'.repeat(4)}const r = gateResult(true);`;
    const result = checkGateScriptSubstance(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/gezel\.output/);
  });

  it('accepts a substantive checks-importing script', () => {
    expect(checkGateScriptSubstance(SUBSTANTIVE_GATE_SCRIPT)).toEqual({ ok: true });
  });
});

/* ── step / task graph helpers ───────────────────────────────────────── */

describe('step gating helpers', () => {
  it('isStepGated accepts a gate or an advanceWhen', () => {
    expect(isStepGated({})).toBe(false);
    expect(
      isStepGated({
        gate: { at: 'completion', checks: [{ kind: 'minBytes', file: 'a.md', bytes: 1 }] },
      }),
    ).toBe(true);
    expect(isStepGated({ advanceWhen: { file: 'a.md', minBytes: 1 } })).toBe(true);
  });

  it('ungatedBuildStepIds names only non-terminal ungated steps', () => {
    expect(
      ungatedBuildStepIds([
        { id: 'inspect', advanceWhen: { file: 'notes/anomalies.md', minBytes: 1 } },
        { id: 'clean' },
        { id: 'verify', terminal: true },
      ]),
    ).toEqual(['clean']);
  });

  it('craftbookGateScriptRefs filters to scope:"craftbook" refs across gate generations', () => {
    expect(craftbookGateScriptRefs({})).toEqual([]);
    expect(
      craftbookGateScriptRefs({
        gate: {
          at: 'completion',
          scripts: [
            { name: 'check-report', scope: 'craftbook' },
            { name: 'project-helper', scope: 'project' },
            { name: 'default-scope' },
          ],
        },
      }),
    ).toEqual([{ name: 'check-report', scope: 'craftbook' }]);
    // Legacy GateSpec never carries scripts.
    expect(
      craftbookGateScriptRefs({
        gate: { checks: [{ kind: 'minBytes', file: 'a.md', bytes: 1 }] },
      }),
    ).toEqual([]);
  });
});

describe('taskReferencesCraftbook', () => {
  const baseTask = (overrides: Partial<Task>): Task =>
    ({
      projectId: 'p1',
      num: 1,
      ref: 'p1#1',
      title: 't',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'g1' },
      craftbook: {
        id: 'embedded-book',
        name: 'Embedded',
        steps: [{ id: 's1', name: 'S1', createdAt: 'x' }],
        entryStepId: 's1',
        createdAt: 'x',
        updatedAt: 'x',
      },
      createdAt: 'x',
      updatedAt: 'x',
      createdBy: { kind: 'gezel', gezelId: 'g1' },
      ...overrides,
    }) as Task;

  it('matches the embedded craftbook id', () => {
    expect(taskReferencesCraftbook(baseTask({}), 'embedded-book')).toBe(true);
  });

  it('matches a sourceCraftbookIds catalogId', () => {
    const task = baseTask({
      sourceCraftbookIds: [{ role: 'main', catalogId: 'seo-meta-pack' }],
    });
    expect(taskReferencesCraftbook(task, 'seo-meta-pack')).toBe(true);
  });

  it('rejects an unrelated craftbook id', () => {
    expect(taskReferencesCraftbook(baseTask({}), 'a11y-audit')).toBe(false);
  });
});

/* ── deliverable parsers ─────────────────────────────────────────────── */

describe('parseJsonRecords / parseJsonValue', () => {
  it('rejects missing / invalid / non-array / short payloads with reasons', () => {
    expect(parseJsonRecords(null, 'out/orders.json', 20)).toMatchObject({ ok: false });
    expect(parseJsonRecords('not json', 'out/orders.json', 20)).toMatchObject({ ok: false });
    expect(parseJsonRecords('{"a":1}', 'out/orders.json', 20)).toMatchObject({ ok: false });
    expect(parseJsonRecords('[1,2,3]', 'out/orders.json', 1)).toMatchObject({ ok: false });
    const short = JSON.stringify([{ id: 1 }]);
    expect(parseJsonRecords(short, 'out/orders.json', 20)).toMatchObject({ ok: false });
  });

  it('accepts a BOM-prefixed array of records', () => {
    const text = `\uFEFF${JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i })))}`;
    const result = parseJsonRecords(text, 'out/orders.json', 20);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toHaveLength(20);
  });

  it('parseJsonValue requires a structured payload', () => {
    expect(parseJsonValue(null, 'out/r.json').ok).toBe(false);
    expect(parseJsonValue('42', 'out/r.json').ok).toBe(false);
    expect(parseJsonValue('{"total": 3}', 'out/r.json').ok).toBe(true);
    expect(parseJsonValue('[]', 'out/r.json').ok).toBe(true);
  });
});

/* ── edit-midtask grading ────────────────────────────────────────────── */

describe('seededPromptStillPresent', () => {
  it('detects the seeded weak prompt verbatim (whitespace-trimmed)', () => {
    expect(seededPromptStillPresent([SEEDED_POLISH_PROMPT])).toBe(true);
    expect(seededPromptStillPresent([`  ${SEEDED_POLISH_PROMPT}\n`])).toBe(true);
  });

  it('passes once every step prompt was rewritten', () => {
    expect(
      seededPromptStillPresent([
        'Rewrite the brief so it ends with the required section heading.',
        undefined,
      ]),
    ).toBe(false);
    expect(seededPromptStillPresent([])).toBe(false);
  });

  it('the gate heading is never mentioned by the seeded prompts or the scenario prompt', () => {
    const scenario = CRAFTBOOK_AUTHORING_SCENARIOS['craftbook-edit-midtask'];
    expect(scenario).toBeDefined();
    const texts = [scenario!.prompt, ...(scenario!.evidenceTexts ?? []), SEEDED_POLISH_PROMPT];
    for (const text of texts) {
      expect(text).not.toContain(GATE_HEADING);
      expect(text.toLowerCase()).not.toContain('source register');
    }
  });
});

/* ── fixtures ────────────────────────────────────────────────────────── */

describe('authoring fixtures', () => {
  it('orders.csv carries 30 data rows, exactly 2 malformed', () => {
    const lines = ORDERS_CSV.trim().split('\n');
    expect(lines).toHaveLength(31); // header + 30
    const dataRows = lines.slice(1).map((line) => line.split(','));
    for (const row of dataRows) expect(row).toHaveLength(6);
    const malformed = dataRows.filter((row) => {
      const qtyOk = /^\d+$/.test(row[3] ?? '');
      const [y, m, d] = (row[5] ?? '').split('-').map(Number);
      const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 0));
      const dateOk =
        date.getUTCFullYear() === y &&
        date.getUTCMonth() === (m ?? 0) - 1 &&
        date.getUTCDate() === d;
      return !qtyOk || !dateOk;
    });
    expect(malformed.map((row) => row[0])).toEqual(['ORD-1013', 'ORD-1022']);
  });

  it('inventory.json parses and carries the seeded anomalies', () => {
    const items = JSON.parse(INVENTORY_JSON) as Array<{ sku: string; qty: number }>;
    expect(items).toHaveLength(10);
    expect(items.filter((item) => item.qty <= 0).map((item) => item.sku)).toEqual([
      'SKU-330',
      'SKU-509',
      'SKU-815',
    ]);
  });
});

/* ── registration contract ───────────────────────────────────────────── */

describe('authoring scenario registration', () => {
  const AUTHORING_IDS = [
    'craftbook-author-linear',
    'craftbook-author-gate-script',
    'craftbook-edit-midtask',
    'craftbook-find-vs-create',
    'dev-craftbook-routing',
  ];

  it('exports exactly the selection + authoring scenarios', () => {
    expect(Object.keys(CRAFTBOOK_AUTHORING_SCENARIOS).sort()).toEqual([...AUTHORING_IDS].sort());
  });

  // These were opt-in until they became suite members. suites.test.ts
  // resolves membership through SCENARIOS[sid], not getScenario(), so a
  // scenario reachable only by name cannot join a suite — the map is now
  // spread into the main registry and eval:all grows by design.
  it('is part of SCENARIOS / listScenarios so the ids can carry suite membership', () => {
    for (const id of AUTHORING_IDS) {
      expect(
        SCENARIOS[id],
        `${id} must be in the main registry to be suite-eligible`,
      ).toBeDefined();
    }
    const listedIds = listScenarios().map((s) => s.id);
    for (const id of AUTHORING_IDS) {
      expect(listedIds).toContain(id);
    }
  });

  it('getScenario resolves authoring ids by name', () => {
    for (const id of AUTHORING_IDS) {
      expect(getScenario(id).id).toBe(id);
    }
    expect(() => getScenario('craftbook-author-nonexistent')).toThrow(/unknown scenario/);
  });

  it('every authoring scenario is a cost-capped, setup-driven scenario', () => {
    for (const scenario of Object.values(CRAFTBOOK_AUTHORING_SCENARIOS)) {
      expect(scenario.suggestedTrials).toBe(1);
      expect(scenario.skipInitialPrompt).toBe(true);
      expect(typeof scenario.setup).toBe('function');
    }
  });

  it('prompts stay format-blind: never name the document codec', () => {
    // Paths like `out/orders.json` are fine; the WORD "json"/"markdown"/
    // "yaml" outside a file path would leak the codec under test into the
    // prompt and contaminate the A/B.
    const codecWord = /(?<![.\w])(json|markdown|yaml)\b/i;
    for (const scenario of Object.values(CRAFTBOOK_AUTHORING_SCENARIOS)) {
      for (const text of [scenario.prompt, ...(scenario.evidenceTexts ?? [])]) {
        expect(
          codecWord.test(text),
          `${scenario.id} leaks a codec name: ${text.match(codecWord)?.[0]}`,
        ).toBe(false);
      }
    }
  });
});

describe('checkGateScriptSubstance — raw fs rejection', () => {
  it('rejects gate scripts that import raw fs instead of gezel.fs', () => {
    const source = [
      "import { gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';",
      "import { readFileSync, existsSync } from 'fs';",
      "import { gezel } from '@bendyline/gezel-sdk';",
      "const present = existsSync('out/report.json');",
      "gezel.output(gateResult(present, present ? 'ok' : 'missing'));",
    ].join('\n');
    const verdict = checkGateScriptSubstance(source);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('raw fs');
  });
});
