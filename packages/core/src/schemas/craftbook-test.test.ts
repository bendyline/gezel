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
      { service: 'alerts', requiredTools: ['list_alerts'] },
    ];
    const result = parseCraftbookTestSpec(spec);
    expect(result.ok).toBe(true);
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
