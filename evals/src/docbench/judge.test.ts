import type { BenchCaseOutcome, BenchTaskInfo } from '@bendyline/gezel/eval';
import { describe, expect, it } from 'vitest';
import {
  DOCBENCH_JUDGE_PROMPT_VERSION,
  type JudgeProvider,
  type JudgeRequest,
  isCurrentJudgement,
  judgeOutcome,
  matcherPrompt,
  matcherSchema,
  parseClaudeOutput,
  readMatch,
} from './judge.ts';

const matcherTask: BenchTaskInfo = {
  id: 'review-resume',
  family: 'review',
  label: 'Resume',
  description: '',
  trials: 1,
  scoring: { checks: 0.15, judge: 0.85 },
  judge: {
    rubricId: 'review-matcher@1',
    mode: 'matcher',
    matchWeight: 0.8,
    instructions: 'Match the findings.',
    axes: [{ id: 'helpfulness', label: 'Helpfulness', description: 'helps' }],
  },
  cases: [{ id: 'nurse', label: 'nurse' }],
};

const visionTask: BenchTaskInfo = {
  ...matcherTask,
  id: 'illustration-svg',
  family: 'visuals',
  judge: {
    rubricId: 'illustration-vision@1',
    mode: 'rubric',
    vision: true,
    instructions: 'Judge the picture.',
    axes: [{ id: 'subject', label: 'Subject', description: 'shows it' }],
  },
};

function outcome(overrides: Partial<BenchCaseOutcome>): BenchCaseOutcome {
  return {
    schemaVersion: 1,
    packVersion: '0.1.0',
    taskId: 'review-resume',
    caseId: 'nurse',
    trial: 0,
    seed: 1000,
    model: 'llama-cpp:m',
    contextWindow: 32768,
    usable: true,
    checks: [],
    artifact: null,
    judgeInput: {
      rubricId: 'review-matcher@1',
      context: '<document>Responsible for patient intake.</document>',
      answerKey: [
        { id: 'duty', quote: 'Responsible for patient intake.', issue: 'A duty.' },
        { id: 'quantify', issue: 'No number.' },
      ],
      items: [
        { id: 'f1', text: 'Quote: "Responsible for patient intake." Message: lead with a verb.' },
        { id: 'f2', text: 'Message: This is a correct sentence.' },
      ],
    },
    calls: [],
    error: null,
    notes: [],
    ms: 1,
    ...overrides,
  };
}

function fakeJudge(replies: Array<Record<string, unknown> | Error>): JudgeProvider & {
  requests: JudgeRequest[];
} {
  const requests: JudgeRequest[] = [];
  return {
    model: 'claude-opus-5-5',
    official: true,
    seesImages: true,
    requests,
    async ask(request) {
      requests.push(request);
      const reply = replies[requests.length - 1];
      if (!reply || reply instanceof Error) throw reply ?? new Error('no reply');
      return reply;
    },
  };
}

describe('docbench judge', () => {
  it('names every answer-key issue and item in the prompt, and only their ids in the schema', () => {
    const input = outcome({}).judgeInput!;
    const prompt = matcherPrompt(matcherTask.judge!, input);
    expect(prompt).toContain('`duty` at "Responsible for patient intake."');
    expect(prompt).toContain('### `f2`');
    const schema = JSON.stringify(matcherSchema(matcherTask.judge!, input));
    expect(schema).toContain('"enum":["duty","quantify"]');
    expect(schema).toContain('"enum":["f1","f2"]');
  });

  it('counts a matcher verdict', () => {
    const counts = readMatch(
      {
        key: [
          { id: 'duty', found: true, by: ['f1'] },
          { id: 'quantify', found: false, by: [] },
        ],
        items: [
          { id: 'f1', label: 'valid' },
          { id: 'f2', label: 'trivial' },
        ],
      },
      outcome({}).judgeInput!,
    );
    expect(counts).toEqual({ found: 1, keyTotal: 2, valid: 1, trivial: 1, wrong: 0 });
  });

  it('counts findings and key issues by complexity when the task labels levels', () => {
    const input = {
      ...outcome({}).judgeInput!,
      answerKey: [
        { id: 'typo', quote: 'recieve', issue: 'Typo.', level: 'low' as const },
        { id: 'buried', issue: 'The decision is buried.', level: 'high' as const },
        { id: 'untagged', issue: 'No level given.' },
      ],
    };
    const raw = {
      key: [
        { id: 'typo', found: true, by: ['f1'] },
        { id: 'buried', found: true, by: ['f2'] },
        { id: 'untagged', found: false, by: [] },
      ],
      items: [
        { id: 'f1', label: 'valid', level: 'low' },
        { id: 'f2', label: 'valid', level: 'high' },
      ],
    };
    expect(readMatch(raw, input, true).levels).toEqual({
      low: { keyTotal: 1, found: 1, valid: 1 },
      medium: { keyTotal: 1, found: 0, valid: 0 },
      high: { keyTotal: 1, found: 1, valid: 1 },
    });
    const levelless = { ...raw, items: [{ id: 'f1', label: 'valid' }, raw.items[1]] };
    expect(() => readMatch(levelless, input, true)).toThrow(/f1/u);
    expect(JSON.stringify(matcherSchema({ ...matcherTask.judge!, levels: true }, input))).toContain(
      '"required":["id","label","level"]',
    );
  });

  it('asks again when a verdict leaves something unanswered, then records the failure', async () => {
    const incomplete = { key: [], items: [], helpfulness: 3, reasons: '' };
    const judge = fakeJudge([incomplete, incomplete]);
    const verdict = await judgeOutcome(outcome({}), matcherTask, { provider: judge });
    expect(judge.requests).toHaveLength(2);
    expect(verdict?.error).toMatch(/unanswered/u);
  });

  it('returns a complete matcher verdict stamped with its judge and prompt version', async () => {
    const judge = fakeJudge([
      new Error('busy'),
      {
        key: [
          { id: 'duty', found: true, by: ['f1'] },
          { id: 'quantify', found: false, by: [] },
        ],
        items: [
          { id: 'f1', label: 'valid' },
          { id: 'f2', label: 'trivial' },
        ],
        helpfulness: 4,
        reasons: 'Found the duty bullet; padded with a non-finding.',
      },
    ]);
    const verdict = await judgeOutcome(outcome({}), matcherTask, { provider: judge });
    expect(verdict).toMatchObject({
      rubricId: 'review-matcher@1',
      promptVersion: DOCBENCH_JUDGE_PROMPT_VERSION,
      judgeModel: 'claude-opus-5-5',
      official: true,
      axes: { helpfulness: 4 },
      match: { found: 1, keyTotal: 2, valid: 1, trivial: 1, wrong: 0 },
    });
    expect(isCurrentJudgement(verdict, judge, matcherTask.judge!)).toBe(true);
  });

  it('scores an empty review without asking, and skips unusable outcomes', async () => {
    const judge = fakeJudge([]);
    const empty = outcome({
      judgeInput: { ...outcome({}).judgeInput!, items: [] },
    });
    const verdict = await judgeOutcome(empty, matcherTask, { provider: judge });
    expect(judge.requests).toHaveLength(0);
    expect(verdict?.match).toEqual({ found: 0, keyTotal: 2, valid: 0, trivial: 0, wrong: 0 });
    expect(await judgeOutcome(outcome({ usable: false }), matcherTask, { provider: judge })).toBe(
      null,
    );
  });

  it('shows a picture judge the rendered picture', async () => {
    const judge = fakeJudge([{ subject: 7, reasons: 'clear' }]);
    const svg = outcome({
      taskId: 'illustration-svg',
      artifact: { kind: 'svg', content: '<svg viewBox="0 0 10 10"></svg>' },
      judgeInput: { rubricId: 'illustration-vision@1', context: 'Request: a cycle' },
    });
    const verdict = await judgeOutcome(svg, visionTask, {
      provider: judge,
      renderSvg: async () => '/tmp/picture.png',
    });
    expect(judge.requests[0]?.imagePath).toBe('/tmp/picture.png');
    expect(judge.requests[0]?.prompt).toContain('picture.png');
    expect(verdict?.axes).toEqual({ subject: 7 });
  });

  it("reads the Claude CLI's structured output and refuses an error result", () => {
    expect(
      parseClaudeOutput(JSON.stringify({ structured_output: { subject: 5, reasons: 'ok' } })),
    ).toEqual({ subject: 5, reasons: 'ok' });
    expect(parseClaudeOutput(JSON.stringify({ result: '{"subject":3,"reasons":""}' }))).toEqual({
      subject: 3,
      reasons: '',
    });
    expect(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'quota' }))).toThrow(
      /quota/u,
    );
  });
});
