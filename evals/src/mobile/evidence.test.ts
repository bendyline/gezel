import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { ChatSession, Question } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { pickAutoAnswerChoice, workspaceFixtureAutoAnswerText } from '../auto-answer.ts';
import { MobileAutoAnswerer } from './auto-answer.ts';
import { MobileFeedbackMailbox } from './feedback.ts';
import {
  type MobileReport,
  type MobileTrial,
  mobileTrialFacts,
  writeMobileEvaluationReport,
} from './report.ts';

function trial(): MobileTrial {
  return {
    id: 'petshop',
    status: 'running',
    startedAt: '2026-09-20T00:00:00Z',
    snapshotAt: '2026-09-20T00:00:40Z',
    projectId: 'project',
    meesterId: 'meester',
    assertions: [],
    artifacts: [],
    inflight: [],
    initialGezelIds: ['meester'],
    gezels: [
      { id: 'meester', role: 'Meester' },
      { id: 'maker', role: 'Designer' },
    ],
    autoAnswers: [],
    sessions: [
      {
        id: 'session',
        version: 1,
        title: 'Fixture',
        providerName: 'apple-foundation-models',
        providerState: {},
        gezelId: 'maker',
        projectId: 'project',
        messages: [],
        createdAt: '2026-09-20T00:00:00Z',
        lastActivityAt: '2026-09-20T00:00:01Z',
      } as ChatSession,
    ],
  };
}
function report(t: MobileTrial): MobileReport {
  return {
    schemaVersion: 1,
    runId: 'evidence',
    suite: 'contract',
    startedAt: '2026-09-20T00:00:00Z',
    complete: true,
    identity: {},
    trials: [t],
    canonicalCoreCoverage: [],
  };
}
function question(id: string, prompt: string, choices: string[] = []): Question {
  return {
    id,
    prompt,
    choices,
    sessionId: 'session',
    gezelId: 'maker',
    projectId: 'project',
    createdAt: '2026-09-20T00:00:01Z',
  };
}
async function testHarness(fetch: (request: Request) => Promise<Response>) {
  const context = {
    globalThis: { __gezelMobileEvalClock: {} },
    window: { __GEZEL__: { baseUrl: 'http://native.invalid', token: 'test', fetch } },
    Request,
    TextDecoder,
    Uint8Array,
    btoa,
  };
  runInNewContext(
    await readFile(
      new URL('../../../packages/mobile/evals/mobile-product-eval.js', import.meta.url),
      'utf8',
    ),
    context,
  );
  return (
    context.globalThis as unknown as {
      __gezelMobileEval: {
        snapshotTrial(t: MobileTrial, files: boolean): Promise<void>;
        transformedRecordIsCorrect(value: unknown): boolean;
        sameJsonValue(left: unknown, right: unknown): boolean;
      };
    }
  ).__gezelMobileEval;
}

describe('native quality evidence and ordinary question parity', () => {
  it('compares every transcript value across native dictionary ordering while preserving arrays and exact content', async () => {
    const harness = await testHarness(async () => {
      throw new Error('No transport expected');
    });
    const before = [
      {
        id: 'user',
        role: 'user',
        content: 'Saved brief.',
        at: '2026-09-20T21:43:08Z',
        draftId: 'draft',
      },
      {
        id: 'assistant',
        role: 'assistant',
        content: 'Ready.',
        at: '2026-09-20T21:43:09Z',
        toolCalls: [{ name: 'read_file', success: true, argsFull: '{"path":"brief.md"}' }],
      },
    ];
    const after = JSON.parse(
      JSON.stringify(before, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    );
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
    expect(harness.sameJsonValue(before, after)).toBe(true);
    expect(harness.sameJsonValue(before, [...after].reverse())).toBe(false);
    for (const key of ['content', 'at', 'draftId']) {
      const changed = structuredClone(after);
      changed[0][key] = 'changed';
      expect(harness.sameJsonValue(before, changed)).toBe(false);
    }
    const nested = structuredClone(after);
    nested[1].toolCalls[0].success = false;
    expect(harness.sameJsonValue(before, nested)).toBe(false);
    const removed = structuredClone(after);
    delete removed[0].draftId;
    expect(harness.sameJsonValue(before, removed)).toBe(false);
  });

  it('uses desktop choices and fixture guidance exactly once, without responding to consent or foreign questions', async () => {
    const t = trial();
    const ordinary = question('ordinary', 'Which design?', [
      'Upload an image',
      'Create the artwork',
    ]);
    const fixture = question('fixture', 'Can you provide facts/incident-brief.md?');
    t.questions = [
      ordinary,
      fixture,
      question('download', 'Download the GGUF model?', ['Yes', 'No']),
      question('choice-consent', 'Which next step?', ['Install a model', 'Keep waiting']),
      question('privacy', 'Allow camera access?'),
      {
        ...question('intent', 'Allow tool call?'),
        intent: { kind: 'tool-permission' } as Question['intent'],
      },
      { ...question('foreign', 'Which design?'), sessionId: 'other' },
    ];
    const answerer = new MobileAutoAnswerer('meester');
    const planned = await answerer.plan(t);
    expect(planned.actions.map((a) => a.questionId)).toEqual(['ordinary', 'fixture']);
    expect(planned.actions[0]?.body).toEqual({
      selectedChoices: [pickAutoAnswerChoice(ordinary.choices!, ordinary.prompt)],
    });
    expect(planned.actions[1]?.body).toEqual({
      writeIn: workspaceFixtureAutoAnswerText(fixture.prompt),
    });
    expect((await answerer.plan(t)).actions).toEqual([]);
    t.inflight = [{ sessionId: 'session' }];
    await expect(answerer.plan(t)).rejects.toThrow('explicitly idle');
  });

  it('applies the original thirty-second inline delay only to the retained Meester front door', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2050-09-20T00:00:40Z'));
    try {
      const t = trial();
      t.sessions[0]!.gezelId = 'meester';
      t.sessions[0]!.projectId = 'default';
      t.sessions[0]!.messages = [
        {
          id: 'answer',
          role: 'assistant',
          content: 'Which colour should I choose?',
          at: '2026-09-20T00:00:20Z',
        },
      ];
      const answerer = new MobileAutoAnswerer('meester');
      expect((await answerer.plan(t)).actions).toEqual([]);
      t.sessions[0]!.messages[0]!.at = '2026-09-20T00:00:00Z';
      expect((await answerer.plan(t)).actions).toMatchObject([
        { kind: 'sendChatMessage', sessionId: 'session', gezelId: 'meester', projectId: 'default' },
      ]);
      expect((await answerer.plan(t)).actions).toEqual([]);
      t.sessions[0]!.messages[0]!.content = 'May I enable microphone access?';
      expect((await new MobileAutoAnswerer('meester').plan(t)).actions).toEqual([]);
      t.sessions[0]!.projectId = 'foreign-project';
      t.sessions[0]!.messages[0]!.content = 'Which colour?';
      expect((await new MobileAutoAnswerer('meester').plan(t)).actions).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('caches exact assistance receipts and derives roles, red flags, and actual intervention counts from native traces', async () => {
    const t = trial();
    t.questions = [question('q', 'Which design?', ['Create it'])];
    t.assistanceRequest = { id: 'request' };
    const mailbox = new MobileFeedbackMailbox();
    const receipt = await mailbox.process(report(t));
    expect(await mailbox.process(report(t))).toBe(receipt);
    expect(receipt).toMatchObject({
      requestId: 'request',
      assistance: { actions: [{ questionId: 'q' }] },
    });
    t.autoAnswers = [
      {
        atMs: 2000,
        kind: 'structured',
        gezel: 'maker',
        question: 'Which design?',
        chose: 'Create it',
      },
    ];
    t.sessions[0]!.messages = [
      {
        id: 'prose',
        role: 'assistant',
        at: '2026-09-20T00:00:01Z',
        content: `# Final report\n## Findings\n${'Missing file evidence. '.repeat(50)}\n## Conclusion\nNo file was written.`,
      },
    ];
    const facts = mobileTrialFacts(report(t), t, '/tmp/evidence');
    expect(facts.team).toEqual({
      totalGezelsCreated: 1,
      rolesCreated: ['Designer'],
      missingExpectedRoles: ['image-generator'],
    });
    expect(facts.toolUse.redFlags.some((f) => f.pattern === 'prose-as-deliverable')).toBe(true);
    expect(facts.autoAnswer).toEqual({
      total: 1,
      byKind: { structured: 1, inline: 0 },
      events: t.autoAnswers,
    });
    t.gezels!.push({ id: 'image', role: 'Image Generator' });
    expect(mobileTrialFacts(report(t), t, '/tmp/evidence').team.missingExpectedRoles).toEqual([]);
  });

  it('requires the exact script record and preserved numeric count, rejecting truthy or partial JSON', async () => {
    const harness = await testHarness(async () => {
      throw new Error('No transport expected');
    });
    const value = {
      version: 1,
      records: { 'repair-17': { item: 'lamp', status: 'repaired', count: 3 } },
    };
    expect(harness.transformedRecordIsCorrect(value)).toBe(true);
    for (const count of [undefined, 0, 2, '3', null])
      expect(
        harness.transformedRecordIsCorrect({
          ...value,
          records: { 'repair-17': { ...value.records['repair-17'], count } },
        }),
      ).toBe(false);
    expect(harness.transformedRecordIsCorrect({ text: 'repair-17 repaired lamp', count: 3 })).toBe(
      false,
    );
    expect(
      harness.transformedRecordIsCorrect({
        ...value,
        records: { ...value.records, unrelated: {} },
      }),
    ).toBe(false);
  });

  it('retains exact partial UTF-8 and binary files with original paths after provider failure and reports capture gaps', async () => {
    const t = trial();
    t.status = 'fail';
    t.error = 'Native context token admission failed';
    t.initialProjectIds = ['default'];
    const bytes = new Uint8Array([0, 255, 12, 128]);
    let failText = false;
    const harness = await testHarness(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/projects')
        return Response.json({
          projects: [
            { id: 'project', name: 'Created' },
            { id: 'default', name: 'Previous' },
          ],
        });
      if (url.pathname === '/api/gezels') return Response.json({ gezels: t.gezels });
      if (url.pathname === '/api/questions') return Response.json({ questions: [] });
      if (url.pathname === '/api/sessions/inflight') return Response.json({ inflight: [] });
      if (url.pathname === '/api/sessions') return Response.json({ sessions: t.sessions });
      if (url.pathname === '/api/sessions/session') return Response.json(t.sessions[0]);
      if (url.pathname.endsWith('/workspace'))
        return Response.json({
          files: [{ path: 'nested/partial.md' }, { path: 'bytes.bin' }],
          truncated: false,
        });
      if (url.pathname.endsWith('/artifacts'))
        return Response.json({ files: [], truncated: false });
      if (url.searchParams.get('path') === 'bytes.bin') return new Response(bytes);
      if (url.searchParams.get('path') === 'nested/partial.md')
        return new Response('Partial café\n', { status: failText ? 500 : 200 });
      throw new Error(`Unexpected request ${request.url}`);
    });
    await harness.snapshotTrial(t, true);
    expect(t.error).toBe('Native context token admission failed');
    expect(t.artifacts).toMatchObject([
      {
        projectId: 'project',
        area: 'workspace',
        path: 'nested/partial.md',
        content: 'Partial café\n',
      },
      { path: 'bytes.bin', content: null, bytesBase64: Buffer.from(bytes).toString('base64') },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'gezel-partial-evidence-'));
    try {
      await writeMobileEvaluationReport(report(t), directory);
      const files = await readdir(join(directory, t.id, 'artifacts'));
      const binaryName = files.find((f) => f.endsWith('bytes.bin'))!;
      expect(await readFile(join(directory, t.id, 'artifacts', binaryName))).toEqual(
        Buffer.from(bytes),
      );
      const retained = JSON.parse(await readFile(join(directory, t.id, 'trial.json'), 'utf8'));
      expect(retained.artifacts[0].path).toBe('nested/partial.md');
      failText = true;
      await expect(harness.snapshotTrial(t, true)).rejects.toThrow(
        'Incomplete native file evidence',
      );
      expect(t.artifacts[0]?.content).toBe('Partial café\n');
      expect(t.evidenceCaptureErrors).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
