import { describe, expect, it } from 'vitest';
import {
  CRAFTBOOK_TEST_SCHEMA_VERSION,
  type CraftbookTestSpec,
  parseCraftbookTestSpec,
} from './craftbook-test.js';

function minimalSpec(): Record<string, unknown> {
  return {
    schemaVersion: CRAFTBOOK_TEST_SCHEMA_VERSION,
    title: 'Runbook smoke eval',
    objective: 'Measure whether the runbook craftbook produces a safe procedure.',
    tags: ['external'],
    prompt: 'Produce the on-call runbook for the webhook backlog.',
    setup: {
      projectName: 'Runbook eval',
      files: [{ path: 'source/brief.md', content: '# Brief' }],
    },
    success: {
      summary: 'runbook.md exists with rollback + escalation sections',
      deliverables: [
        {
          path: 'runbook.md',
          kind: 'markdown-report',
          minBytes: 800,
          checks: [{ kind: 'contains', file: 'runbook.md', pattern: 'Rollback' }],
        },
      ],
    },
    rubric: {
      artifact: { path: 'runbook.md', kind: 'markdown' },
      axes: [
        { name: 'safety', description: 'Steps are literal, reversible, and verified.' },
        { name: 'completeness', description: 'Rollback and escalation are both covered.' },
      ],
    },
  };
}

describe('parseCraftbookTestSpec', () => {
  it('accepts a minimal valid spec and applies defaults', () => {
    const result = parseCraftbookTestSpec(minimalSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.mocks).toEqual([]);
      expect(result.spec.qualityFocus).toEqual([]);
      expect(result.spec.setup.files).toHaveLength(1);
    }
  });

  it('preserves hidden fixtures while ordinary fixtures remain model inputs by default', () => {
    const spec = minimalSpec();
    (spec.setup as { files: unknown[] }).files.push({
      path: 'fixtures/black-box.html',
      content: '<main>Browser-only fixture</main>',
      modelInput: false,
    });

    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.setup.files[0]?.modelInput).toBeUndefined();
      expect(result.spec.setup.files[1]?.modelInput).toBe(false);
    }
  });

  it('reuses the core gate-check vocabulary and the eval-only kinds', () => {
    const spec = minimalSpec();
    (spec.success as Record<string, unknown>).checks = [
      { kind: 'minBytes', file: 'runbook.md', bytes: 100 },
      { kind: 'nodeScriptPasses', script: 'checks/verify.mjs' },
      { kind: 'prometheusAlerts', file: 'alerts.yaml', minRules: 2 },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(true);
  });

  it('accepts runtime history expectations for workflow and hook evidence', () => {
    const spec = minimalSpec();
    (spec.success as Record<string, unknown>).history = [
      {
        kind: 'tool.gated',
        minEntries: 1,
        details: { craftbookId: 'careful-mode', decision: 'ask', tool: 'delete_path' },
      },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(true);
  });

  it('accepts task parameters, terminal proof, harness fixtures, and exact preservation gates', () => {
    const spec = minimalSpec();
    (spec.setup as Record<string, unknown>).craftbookParams = { language: 'Nederlands' };
    (spec.setup as { files: unknown[] }).files.push({
      path: 'tests/verify.mjs',
      content: 'process.exit(0);',
      surface: 'harness',
    });
    (spec.success as Record<string, unknown>).taskGraph = {
      requireCraftbookTask: true,
      requireTerminalStep: true,
    };
    (spec.success as Record<string, unknown>).unchangedFixtures = ['source/brief.md'];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(true);
  });

  it('accepts a hermetic MCP replacement for a scoped required toolset', () => {
    const spec = minimalSpec();
    (spec as { mocks?: unknown[] }).mocks = [
      {
        kind: 'mcp',
        id: 'playwright',
        description: 'Hermetic browser simulator.',
        toolsetId: '@playwright/mcp',
        tools: [
          {
            name: 'browser_navigate',
            description: 'Navigate the simulated browser.',
            resultTemplate: { ok: true },
          },
        ],
      },
    ];

    expect(parseCraftbookTestSpec(spec).ok).toBe(true);
  });

  it('rejects an unchanged fixture that is not seeded in the workspace', () => {
    const spec = minimalSpec();
    (spec.success as Record<string, unknown>).unchangedFixtures = ['source/missing.md'];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('not a seeded workspace file');
  });

  it('accepts forbidden History expectations and rejects inverted bounds', () => {
    const spec = minimalSpec();
    (spec.success as Record<string, unknown>).history = [
      { kind: 'tool.called', minEntries: 0, maxEntries: 0, details: { name: 'read_file' } },
    ];
    expect(parseCraftbookTestSpec(spec).ok).toBe(true);

    (spec.success as Record<string, unknown>).history = [
      { kind: 'tool.called', minEntries: 2, maxEntries: 1 },
    ];
    const invalid = parseCraftbookTestSpec(spec);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.join('\n')).toContain('minEntries');
  });

  it('rejects unknown keys in strict mode with a path-qualified error', () => {
    const spec = minimalSpec();
    (spec as Record<string, unknown>).nonsense = true;
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('nonsense');
  });

  it('tolerant mode strips unknown keys (root and nested) without mutating input', () => {
    const spec = minimalSpec();
    (spec as Record<string, unknown>).futureField = 'x';
    (spec.setup as Record<string, unknown>).futureSetupField = 'y';
    const result = parseCraftbookTestSpec(spec, { mode: 'tolerant' });
    expect(result.ok).toBe(true);
    // Caller's value is untouched.
    expect((spec as Record<string, unknown>).futureField).toBe('x');
    expect((spec.setup as Record<string, unknown>).futureSetupField).toBe('y');
  });

  it('tolerant mode accepts a NEWER schemaVersion; strict rejects it', () => {
    const spec = minimalSpec();
    spec.schemaVersion = CRAFTBOOK_TEST_SCHEMA_VERSION + 1;
    expect(parseCraftbookTestSpec(spec).ok).toBe(false);
    expect(parseCraftbookTestSpec(spec, { mode: 'tolerant' }).ok).toBe(true);
  });

  it('tolerant mode still fails on structural errors', () => {
    const spec = minimalSpec();
    delete (spec as Record<string, unknown>).rubric;
    const result = parseCraftbookTestSpec(spec, { mode: 'tolerant' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('rubric');
  });

  it('enforces the mock.<id> credential naming rule', () => {
    const spec = minimalSpec();
    spec.mocks = [
      {
        kind: 'http',
        id: 'issue-tracker',
        description: 'Fake issue tracker API',
        credential: { name: 'mock.wrong-name' },
        routes: [{ path: '/issues', body: { issues: [] } }],
      },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('mock.issue-tracker');
    }
  });

  it('rejects success.mocks referencing an undeclared service', () => {
    const spec = minimalSpec();
    (spec.success as Record<string, unknown>).mocks = [{ service: 'ghost', minRequests: 1 }];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('ghost');
  });

  it('accepts requiredTools naming declared tools on an mcp service', () => {
    const spec = minimalSpec();
    spec.mocks = [
      {
        kind: 'mcp',
        id: 'alerts',
        description: 'Fake alerting MCP',
        tools: [
          { name: 'list_alerts', description: 'List firing alerts' },
          { name: 'ack_alert', description: 'Acknowledge an alert' },
        ],
      },
    ];
    (spec.success as Record<string, unknown>).mocks = [
      {
        service: 'alerts',
        requiredTools: ['list_alerts'],
        toolCalls: { list_alerts: { minCalls: 2, maxCalls: 4 } },
      },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(true);
  });

  it('rejects an inverted per-tool MCP call budget', () => {
    const spec = minimalSpec();
    spec.mocks = [
      {
        kind: 'mcp',
        id: 'alerts',
        description: 'Fake alerting MCP',
        tools: [{ name: 'list_alerts', description: 'List firing alerts' }],
      },
    ];
    (spec.success as Record<string, unknown>).mocks = [
      { service: 'alerts', toolCalls: { list_alerts: { minCalls: 3, maxCalls: 2 } } },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('minCalls');
  });

  it('rejects requiredTools naming an undeclared tool', () => {
    const spec = minimalSpec();
    spec.mocks = [
      {
        kind: 'mcp',
        id: 'alerts',
        description: 'Fake alerting MCP',
        tools: [{ name: 'list_alerts', description: 'List firing alerts' }],
      },
    ];
    (spec.success as Record<string, unknown>).mocks = [
      { service: 'alerts', requiredTools: ['resolve_alert'] },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('undeclared tool "resolve_alert"');
    }
  });

  it('rejects requiredTools on a non-mcp service', () => {
    const spec = minimalSpec();
    spec.mocks = [{ kind: 'webhook', id: 'notify', description: 'Notification receiver' }];
    (spec.success as Record<string, unknown>).mocks = [
      { service: 'notify', requiredTools: ['list_alerts'] },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('requires an mcp service');
    }
  });

  it('round-trips a full spec with every mock kind', () => {
    const spec = minimalSpec();
    spec.mocks = [
      {
        kind: 'http',
        id: 'ci',
        description: 'Fake CI API',
        credential: { name: 'mock.ci', authScheme: 'bearer' },
        routes: [
          { method: 'GET', path: '/runs/:id', body: { status: 'green' } },
          { method: 'POST', path: '/deploys', status: 201, body: 'ok', latencyMs: 50 },
        ],
      },
      { kind: 'webhook', id: 'alerts', description: 'Alert receiver', path: '/hooks/alerts' },
      {
        kind: 'cli',
        id: 'fake-git',
        description: 'Fake git CLI',
        shim: { path: 'bin/fake-git.mjs', content: 'console.log("ok")' },
      },
      {
        kind: 'mcp',
        id: 'inventory',
        description: 'Fake inventory MCP',
        tools: [{ name: 'list_items', description: 'List items', resultTemplate: { items: [] } }],
      },
    ];
    (spec.success as Record<string, unknown>).mocks = [
      { service: 'ci', minRequests: 1, requiredPaths: ['^/runs/'] },
      { service: 'alerts', minRequests: 1 },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const typed: CraftbookTestSpec = result.spec;
      expect(typed.mocks).toHaveLength(4);
    }
  });
});
