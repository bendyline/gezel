import type {
  CraftbookDoc,
  CraftbookTestDeliverable,
  CraftbookTestSpec,
  DeliverableKind,
} from '@bendyline/gezel';

interface OutputContract {
  path: string;
  artifact: boolean;
  minBytes?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mergeOutput(target: Map<string, OutputContract>, candidate: OutputContract): void {
  const current = target.get(candidate.path);
  target.set(candidate.path, {
    path: candidate.path,
    artifact: current?.artifact === true || candidate.artifact,
    ...(Math.max(current?.minBytes ?? 0, candidate.minBytes ?? 0) > 0
      ? { minBytes: Math.max(current?.minBytes ?? 0, candidate.minBytes ?? 0) }
      : {}),
  });
}

function collectGateOutputs(node: unknown, outputs: Map<string, OutputContract>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectGateOutputs(item, outputs);
    return;
  }
  const record = asRecord(node);
  if (!record) return;

  // A gate check has a discriminator. Script input objects can also contain
  // `file`, but those are execution parameters rather than declared outputs.
  if (typeof record.kind === 'string' && typeof record.file === 'string') {
    const bytes =
      record.kind === 'minBytes' && typeof record.bytes === 'number' ? record.bytes : undefined;
    mergeOutput(outputs, {
      path: record.file,
      artifact: record.artifact === true,
      ...(bytes !== undefined ? { minBytes: bytes } : {}),
    });
  }
  for (const value of Object.values(record)) collectGateOutputs(value, outputs);
}

function parameterValues(doc: CraftbookDoc, test: CraftbookTestSpec): Record<string, string> {
  const params: Record<string, string> = { workPath: '{{task.dir}}' };
  const schema = asRecord(doc.paramSchema);
  const properties = asRecord(schema?.properties);
  for (const [key, raw] of Object.entries(properties ?? {})) {
    const property = asRecord(raw);
    if (typeof property?.default === 'string') params[key] = property.default;
  }
  for (const [key, value] of Object.entries(test.setup.craftbookParams ?? {})) {
    params[key] = value;
  }
  return params;
}

function resolveParameters(path: string, params: Record<string, string>): string {
  let resolved = path;
  for (let pass = 0; pass < 6; pass++) {
    const next = resolved.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
      params[key] !== undefined ? params[key] : whole,
    );
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
}

/** Files whose existence/shape the craftbook itself uses to advance or pass. */
export function declaredWorkflowOutputs(
  doc: CraftbookDoc,
  test: CraftbookTestSpec,
): OutputContract[] {
  const outputs = new Map<string, OutputContract>();
  for (const step of doc.steps) {
    if (step.advanceWhen) {
      mergeOutput(outputs, {
        path: step.advanceWhen.file,
        artifact: step.advanceWhen.artifact === true,
        ...(step.advanceWhen.minBytes !== undefined ? { minBytes: step.advanceWhen.minBytes } : {}),
      });
    }
    collectGateOutputs(step.gate, outputs);
  }
  const params = parameterValues(doc, test);
  const resolved = new Map<string, OutputContract>();
  for (const output of outputs.values()) {
    const path = resolveParameters(output.path, params);
    mergeOutput(resolved, { ...output, path });
  }
  return [...resolved.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function deliverableKind(path: string): DeliverableKind {
  const lower = path.toLowerCase();
  if (/\.html?$/.test(lower)) return 'html-page';
  if (/\.md$/.test(lower)) return 'markdown-report';
  if (/\.json$/.test(lower)) return 'json';
  if (/\.ya?ml$/.test(lower)) return 'yaml-spec';
  if (/\.(?:[cm]?[jt]sx?)$/.test(lower)) return 'code-module';
  if (/\.(?:png|jpe?g|gif|webp|svg)$/.test(lower)) return 'image-set';
  if (/\.(?:mp3|wav|m4a|flac|ogg)$/.test(lower)) return 'audio-file';
  if (/\.(?:pptx|odp)$/.test(lower)) return 'slide-deck';
  if (/\.(?:csv|tsv|xlsx|parquet)$/.test(lower)) return 'data-file';
  return 'generic-file';
}

function rubricKind(path: string): CraftbookTestSpec['rubric']['artifact']['kind'] {
  const lower = path.toLowerCase();
  if (/\.html?$/.test(lower)) return 'html';
  if (/\.md$/.test(lower)) return 'markdown';
  if (/\.json$/.test(lower)) return 'json';
  if (/\.ya?ml$/.test(lower)) return 'yaml';
  if (/\.tsx?$/.test(lower)) return 'typescript';
  return 'text';
}

function userFacingPath(path: string): string {
  const taskPath = path.match(/^\{\{\s*task\.dir\s*\}\}\/(.+)$/);
  return taskPath ? `\`${taskPath[1]}\` in this task's artifact working folder` : `\`${path}\``;
}

function purposeDescription(doc: CraftbookDoc): string {
  // Generated gallery docs carry the user-facing purpose followed by the
  // compiler's workflow explanation. Repeating that whole explanation in the
  // kickoff and fixture bloats every medium-model prefill without adding task
  // facts; the craftbook steps already carry the sequence precisely.
  return (doc.description ?? doc.name).split(/\n\n(?:A gallery craftbook|Phases:)/, 1)[0]!.trim();
}

function localEvalBrief(doc: CraftbookDoc, outputs: readonly OutputContract[]): string {
  const steps = doc.steps
    .map((step, index) => `${index + 1}. ${step.name}${step.terminal ? ' (terminal)' : ''}`)
    .join('\n');
  const deliverables =
    outputs.length > 0
      ? outputs.map((output) => `- ${userFacingPath(output.path)}`).join('\n')
      : '- The concrete user-requested outputs named in the kickoff.';
  return `# ${doc.name} — local evaluation brief

This is a hermetic processability evaluation of the \`${doc.id}\` craftbook.
Do not contact real services, use real credentials, or fetch live data. Treat
the project fixtures and installed local simulators as authoritative. If a
dependency is intentionally unavailable, document an honest dry run instead
of claiming a real side effect.

## Request

${purposeDescription(doc)}

## Required workflow

${steps}

## Declared outputs

${deliverables}
`;
}

export interface RebuiltWorkflowSpec {
  spec: CraftbookTestSpec;
  outputs: OutputContract[];
}

/**
 * Rebuild a stale/freehand sidecar as an honest workflow-processability eval.
 * The craftbook's own gates remain the quality floor; the sidecar independently
 * proves its declared files exist and that the attributed task reached a real
 * terminal state. Existing local fixtures and mock definitions are retained.
 */
export function rebuildWorkflowTestSpec(
  doc: CraftbookDoc,
  original: CraftbookTestSpec,
): RebuiltWorkflowSpec {
  const outputs = declaredWorkflowOutputs(doc, original);
  const staticOutputs: CraftbookTestDeliverable[] = outputs.map((output) => ({
    path: output.path,
    kind: deliverableKind(output.path),
    ...(output.artifact ? { artifact: true } : {}),
    minBytes: Math.max(1, output.minBytes ?? 1),
  }));
  const deliverables = staticOutputs.length > 0 ? staticOutputs : original.success.deliverables;
  const primary = deliverables?.[0];
  const briefPath = 'source/craftbook-eval-brief.md';
  const existingFiles = original.setup.files.filter((file) => file.path !== briefPath);
  const outputList =
    outputs.length > 0
      ? outputs.map((output) => userFacingPath(output.path)).join(', ')
      : 'the concrete deliverables named in this request';
  const prompt = [
    `Use the \`${doc.id}\` (${doc.name}) craftbook for this self-contained local evaluation.`,
    `Open \`${briefPath}\` first, then follow the craftbook's actual steps and gates through its terminal step.`,
    `Complete this request: ${purposeDescription(doc)}`,
    `Produce ${outputList}.`,
    'Use only seeded project files and installed local simulators. Do not call a real external service, fetch live data, or claim an external side effect occurred; an explicit dry-run record is the correct result when a dependency is unavailable.',
  ].join(' ');

  const spec: CraftbookTestSpec = {
    ...original,
    mode: 'workflow',
    title: `${doc.name} workflow processability`,
    objective: `Prove that a medium local model can parse and execute the ${doc.name} craftbook, satisfy its declared runtime gates, and reach a terminal step using only local fixtures.`,
    prompt,
    setup: {
      ...original.setup,
      projectName: `${doc.name} Workflow Eval`,
      about: `A hermetic workflow evaluation for the ${doc.name} craftbook. No live dependency or external network is authorized.`,
      missionObjectives: `Run the ${doc.name} craftbook end to end, use the local evaluation brief and fixtures as truth, produce its declared outputs, and reach a terminal step without fabricating external effects.`,
      managedWorkspaceWritePolicy: 'allow',
      files: [{ path: briefPath, content: localEvalBrief(doc, outputs) }, ...existingFiles],
      worker: {
        name: 'Craftbook Runner',
        role: 'Workflow Operator',
        about:
          'Execute the assigned craftbook exactly. Read local fixtures, satisfy each runtime gate, record honest dry-run evidence for unavailable dependencies, and continue until a terminal step is active or the task is complete.',
      },
    },
    success: {
      summary: `The attributed ${doc.id} task satisfied its own gates, produced its declared outputs, and reached a terminal step without using external services.`,
      ...(deliverables && deliverables.length > 0 ? { deliverables } : {}),
      taskGraph: {
        requireCraftbookTask: true,
        requireTerminalStep: true,
      },
      // Hook-backed/generic books may have no static file contract. Retain
      // their auditable runtime expectations and sentinel invariants.
      ...(outputs.length === 0 && original.success.history
        ? { history: original.success.history }
        : {}),
      ...(outputs.length === 0 && original.success.unchangedFixtures
        ? { unchangedFixtures: original.success.unchangedFixtures }
        : {}),
      ...(outputs.length === 0 && original.success.mocks ? { mocks: original.success.mocks } : {}),
    },
    rubric: primary
      ? {
          artifact: { path: primary.path, kind: rubricKind(primary.path) },
          axes: [
            {
              name: 'workflow fidelity',
              description:
                'The result reflects the named craftbook sequence and its declared acceptance gates rather than a freehand substitute.',
            },
            {
              name: 'usefulness',
              description:
                'The deliverable is coherent, actionable, and suitable for the craftbook purpose stated in the local brief.',
            },
          ],
          contextNote:
            'Advisory only. Deterministic pass/fail comes from the craftbook runtime gates, deliverable existence, attribution, and terminal progress.',
        }
      : original.rubric,
    qualityFocus: [
      `real ${doc.id} craftbook task attribution`,
      'declared runtime gate satisfaction',
      'terminal workflow progress',
      'offline fixture and simulator discipline',
    ],
  };
  return { spec, outputs };
}
