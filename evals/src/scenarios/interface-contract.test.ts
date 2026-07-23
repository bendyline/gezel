import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INTERFACE_CONTRACT_PROMPT,
  REQUIRED_PIPELINE_FILES,
  interfaceContractScenario,
  normalizeRelativeTsImports,
  runInterfaceContractGateInDir,
} from './interface-contract.ts';

// ─────────────────────────────────────────────────────────────────────
// Reference three-file solution. Imports are deliberately EXTENSIONLESS
// (`from './types'`) — the most common model idiom and one Node
// type-stripping rejects — to prove the grader's import normalization
// makes the gate idiom-agnostic.

const TYPES_TS = `export interface EventRecord {
  kind: string;
  payload: unknown;
}

export interface Sink {
  handle(kind: string, payload: unknown): void;
}
`;

const PRODUCER_TS = `import type { EventRecord } from './types';

export function makeEvents(): EventRecord[] {
  return [
    { kind: 'click', payload: { x: 1, y: 2 } },
    { kind: 'click', payload: { x: 3, y: 4 } },
    { kind: 'scroll', payload: { delta: -120 } },
    { kind: 'click', payload: { x: 5, y: 6 } },
    { kind: 'keypress', payload: { key: 'Enter' } },
    { kind: 'scroll', payload: { delta: 80 } },
  ];
}
`;

const CONSUMER_TS = `import type { EventRecord, Sink } from './types';

export function consume(events: EventRecord[], sink: Sink): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    sink.handle(event.kind, event.payload);
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}
`;

// The coupled-coordination failure this scenario exists to measure: the
// consumer developer invented their own sink shape (`emit`) instead of
// honoring the shared contract. It type-checks against its OWN local
// interface, so only the runtime integration gate can catch it.
const MISMATCHED_CONSUMER_RUNTIME_TS = `import type { EventRecord } from './types';

interface LooseSink {
  emit(kind: string, payload: unknown): void;
}

export function consume(events: EventRecord[], sink: LooseSink): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    sink.emit(event.kind, event.payload);
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}
`;

// Same drift but typed against the SHARED Sink — tsc catches this one.
const MISMATCHED_CONSUMER_TSC_TS = `import type { EventRecord, Sink } from './types';

export function consume(events: EventRecord[], sink: Sink): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    sink.emit(event.kind, event.payload);
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}
`;

async function writeSolution(dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, path), content, 'utf8');
  }
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(`${tmpdir()}/interface-contract-test-`);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('interface-contract — normalizeRelativeTsImports', () => {
  const always = () => true;

  it('appends .ts to extensionless relative specifiers', () => {
    expect(normalizeRelativeTsImports("import type { A } from './types';", always)).toBe(
      "import type { A } from './types.ts';",
    );
    expect(normalizeRelativeTsImports('export { b } from "../lib/b";', always)).toBe(
      'export { b } from "../lib/b.ts";',
    );
  });

  it('rewrites .js-style specifiers to .ts (the tsc node16 idiom)', () => {
    expect(normalizeRelativeTsImports("import { a } from './types.js';", always)).toBe(
      "import { a } from './types.ts';",
    );
  });

  it('covers dynamic and side-effect imports', () => {
    expect(normalizeRelativeTsImports("const m = await import('./producer');", always)).toBe(
      "const m = await import('./producer.ts');",
    );
    expect(normalizeRelativeTsImports("import './setup';", always)).toBe("import './setup.ts';");
  });

  it('leaves .ts specifiers, bare specifiers, and non-TS targets alone', () => {
    expect(normalizeRelativeTsImports("import { a } from './types.ts';", always)).toBe(
      "import { a } from './types.ts';",
    );
    expect(normalizeRelativeTsImports("import { join } from 'node:path';", always)).toBe(
      "import { join } from 'node:path';",
    );
    expect(normalizeRelativeTsImports("import data from './data.json';", always)).toBe(
      "import data from './data.json';",
    );
    // No .ts file at the resolved path → untouched.
    expect(normalizeRelativeTsImports("import { a } from './helper.js';", () => false)).toBe(
      "import { a } from './helper.js';",
    );
  });
});

describe('interface-contract — gate against real solutions (runs tsc + node)', () => {
  it('an empty workspace fails at the files stage', async () => {
    await withTmpDir(async (dir) => {
      const result = await runInterfaceContractGateInDir(dir);
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('files');
      expect(result.detail).toContain('src/types.ts');
    });
  });

  it('the reference three-file solution passes the full gate (tsc + node integration.mjs)', async () => {
    await withTmpDir(async (dir) => {
      await writeSolution(dir, {
        'src/types.ts': TYPES_TS,
        'src/producer.ts': PRODUCER_TS,
        'src/consumer.ts': CONSUMER_TS,
      });
      const result = await runInterfaceContractGateInDir(dir);
      expect(result.detail).not.toMatch(/error/i);
      expect(result.ok).toBe(true);
      expect(result.stage).toBe('pass');
      expect(result.detail).toMatch(/6 event\(s\) across 3 kind\(s\)/);
    });
  }, 120_000);

  it('a consumer expecting sink.emit (own local interface) fails the runtime integration with a relayed error', async () => {
    await withTmpDir(async (dir) => {
      await writeSolution(dir, {
        'src/types.ts': TYPES_TS,
        'src/producer.ts': PRODUCER_TS,
        'src/consumer.ts': MISMATCHED_CONSUMER_RUNTIME_TS,
      });
      const result = await runInterfaceContractGateInDir(dir);
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('integration');
      // The verbatim runtime error names the drifted method.
      expect(result.detail).toMatch(/emit/);
      expect(result.detail).toMatch(/consume\(events, sink\) threw/);
    });
  }, 120_000);

  it('a consumer calling sink.emit against the SHARED Sink fails tsc with the error relayed verbatim', async () => {
    await withTmpDir(async (dir) => {
      await writeSolution(dir, {
        'src/types.ts': TYPES_TS,
        'src/producer.ts': PRODUCER_TS,
        'src/consumer.ts': MISMATCHED_CONSUMER_TSC_TS,
      });
      const result = await runInterfaceContractGateInDir(dir);
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('tsc');
      expect(result.detail).toMatch(/error TS\d+/);
      expect(result.detail).toMatch(/emit/);
    });
  }, 120_000);

  it('a producer with too few kinds fails the integration with a relayed count', async () => {
    await withTmpDir(async (dir) => {
      await writeSolution(dir, {
        'src/types.ts': TYPES_TS,
        'src/producer.ts': PRODUCER_TS.replace(/kind: 'scroll'/g, "kind: 'click'").replace(
          /kind: 'keypress'/g,
          "kind: 'click'",
        ),
        'src/consumer.ts': CONSUMER_TS,
      });
      const result = await runInterfaceContractGateInDir(dir);
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('integration');
      expect(result.detail).toMatch(/1 distinct kind\(s\)/);
    });
  }, 120_000);
});

describe('interface-contract — grader-lint mirror (not registered in index.ts yet)', () => {
  for (const evidence of interfaceContractScenario.requiredPromptEvidence ?? []) {
    it(`required signal "${evidence.signal}" is satisfiable from the prompt`, () => {
      evidence.pattern.lastIndex = 0;
      expect(evidence.pattern.test(interfaceContractScenario.prompt.toLowerCase())).toBe(true);
    });
  }

  it('the prompt names all three pipeline file paths', () => {
    for (const p of REQUIRED_PIPELINE_FILES) {
      expect(INTERFACE_CONTRACT_PROMPT).toContain(p);
    }
  });

  it('the prompt states the acceptance gate and the delegation suggestion', () => {
    expect(INTERFACE_CONTRACT_PROMPT).toMatch(/tsc --noEmit/);
    expect(INTERFACE_CONTRACT_PROMPT).toMatch(/integration\.mjs/);
    expect(INTERFACE_CONTRACT_PROMPT).toMatch(/two developers/i);
  });
});

describe('gate handles type-only imports (smoke regression)', () => {
  it('value-syntax import of an interface passes — valid TS that type-stripping rejected', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = await mkdtemp(join(tmpdir(), 'iface-typeonly-'));
    try {
      await mkdir(join(tmp, 'src'), { recursive: true });
      await writeFile(
        join(tmp, 'src/types.ts'),
        'export interface EventRecord { kind: string; payload: unknown }\n' +
          'export interface Sink { handle(kind: string, payload: unknown): void }\n',
      );
      // The exact shape from the failed smoke trial: `import { EventRecord }`
      // (value syntax, no `type` keyword) of a type-only export.
      await writeFile(
        join(tmp, 'src/producer.ts'),
        "import { EventRecord } from './types.ts';\n" +
          'export function makeEvents(): EventRecord[] {\n' +
          '  return [\n' +
          "    { kind: 'click', payload: 1 },\n" +
          "    { kind: 'click', payload: 2 },\n" +
          "    { kind: 'view', payload: 3 },\n" +
          "    { kind: 'view', payload: 4 },\n" +
          "    { kind: 'click', payload: 5 },\n" +
          '  ];\n' +
          '}\n',
      );
      await writeFile(
        join(tmp, 'src/consumer.ts'),
        "import { EventRecord, Sink } from './types.ts';\n" +
          'export function consume(events: EventRecord[], sink: Sink): Record<string, number> {\n' +
          '  const counts: Record<string, number> = {};\n' +
          '  for (const e of events) {\n' +
          '    sink.handle(e.kind, e.payload);\n' +
          '    counts[e.kind] = (counts[e.kind] ?? 0) + 1;\n' +
          '  }\n' +
          '  return counts;\n' +
          '}\n',
      );
      const { runInterfaceContractGateInDir } = await import('./interface-contract.ts');
      const result = await runInterfaceContractGateInDir(tmp);
      expect(result.detail).not.toMatch(/does not provide an export/);
      expect(result).toMatchObject({ ok: true, stage: 'pass' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
