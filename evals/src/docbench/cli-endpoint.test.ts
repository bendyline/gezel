import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliEffort, flattenMessages, referenceModel, startCliEndpoint } from './cli-endpoint.ts';
import { contestantFor, runsOnDevice } from './runner.ts';

describe('reference model ids', () => {
  it('runs claude-* on the Claude CLI and codex-<model> on the Codex CLI', () => {
    expect(referenceModel('claude-opus-5-5')).toEqual({ cli: 'claude', model: 'claude-opus-5-5' });
    expect(referenceModel('codex-gpt-6.1-sol')).toEqual({ cli: 'codex', model: 'gpt-6.1-sol' });
  });

  it('leaves catalog models, gpt-oss included, to llama.cpp', () => {
    expect(referenceModel('gpt-oss-20b-q4')).toBeNull();
    expect(contestantFor('gpt-oss-20b-q4')).toEqual({ kind: 'llama-cpp' });
    expect(contestantFor('apple-foundation-models')).toEqual({ kind: 'apple' });
    expect(runsOnDevice('apple-foundation-models')).toBe(true);
    expect(runsOnDevice('claude-sonnet-5-5')).toBe(false);
  });
});

describe('cliEffort', () => {
  it('runs a request that asks for no reasoning at the lowest effort, and writing at medium', () => {
    expect(cliEffort('none')).toBe('low');
    expect(cliEffort(undefined)).toBe('medium');
  });
});

describe('flattenMessages', () => {
  it('keeps a single turn as it is', () => {
    expect(
      flattenMessages([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Summarize this.' },
      ]),
    ).toEqual({ system: 'Be brief.', prompt: 'Summarize this.' });
  });

  it('writes earlier turns out as a transcript before the last user message', () => {
    const { prompt } = flattenMessages([
      { role: 'system', content: 'Draw.' },
      { role: 'user', content: [{ type: 'text', text: 'A cat.' }] },
      { role: 'assistant', content: '<svg' },
      { role: 'user', content: 'That was cut off. Try again.' },
    ]);
    expect(prompt.indexOf('A cat.')).toBeLessThan(prompt.indexOf('<svg'));
    expect(prompt.endsWith('That was cut off. Try again.')).toBe(true);
  });

  it('refuses a conversation that does not end with the user', () => {
    expect(() => flattenMessages([{ role: 'assistant', content: 'Hi' }])).toThrow();
  });
});

describe('startCliEndpoint', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docbench-cli-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stand-in Claude CLI: prints the result shape `claude -p --output-format json` prints. */
  async function fakeClaude(body: string): Promise<string> {
    const bin = join(dir, 'claude');
    await writeFile(
      bin,
      `#!/bin/sh\ncat > "${join(dir, 'stdin.txt')}"\necho "$@" > "${join(dir, 'args.txt')}"\n${body}\n`,
    );
    await chmod(bin, 0o755);
    return bin;
  }

  it('serves the model list and answers a chat through the CLI', async () => {
    const claudeBin = await fakeClaude(
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"A tidy summary.","usage":{"input_tokens":10,"output_tokens":4}}'`,
    );
    const endpoint = await startCliEndpoint({
      modelId: 'claude-test-1',
      reference: { cli: 'claude', model: 'claude-test-1' },
      contextWindow: 32_768,
      claudeBin,
      codexBin: 'codex',
      callLog: join(dir, 'calls.jsonl'),
    });
    try {
      const models = (await (await fetch(`${endpoint.baseUrl}/models`)).json()) as {
        data: { id: string; context_window: number }[];
      };
      expect(models.data[0]).toMatchObject({ id: 'claude-test-1', context_window: 32_768 });

      const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-test-1',
          reasoning_effort: 'none',
          messages: [
            { role: 'system', content: 'Summarize.' },
            { role: 'user', content: 'The document.' },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        choices: { message: { content: string } }[];
        usage: { completion_tokens: number };
      };
      expect(body.choices[0]?.message.content).toBe('A tidy summary.');
      expect(body.usage.completion_tokens).toBe(4);
      expect(await readFile(join(dir, 'stdin.txt'), 'utf8')).toBe('The document.');
      const args = await readFile(join(dir, 'args.txt'), 'utf8');
      expect(args).toContain('--effort low');
      expect(args).toContain('--model claude-test-1');
      expect(await readFile(join(dir, 'calls.jsonl'), 'utf8')).toContain('"effort":"low"');
    } finally {
      await endpoint.close();
    }
  });

  it('reports a CLI failure as an endpoint failure, never as an empty reply', async () => {
    const claudeBin = await fakeClaude(
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"usage limit reached"}'; exit 1`,
    );
    const endpoint = await startCliEndpoint({
      modelId: 'claude-test-1',
      reference: { cli: 'claude', model: 'claude-test-1' },
      contextWindow: 32_768,
      claudeBin,
      codexBin: 'codex',
    });
    try {
      const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
      });
      expect(response.status).toBe(502);
    } finally {
      await endpoint.close();
    }
  });

  it('returns structured output as the reply text when a schema was asked for', async () => {
    const claudeBin = await fakeClaude(
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"slides":[]}}'`,
    );
    const endpoint = await startCliEndpoint({
      modelId: 'claude-test-1',
      reference: { cli: 'claude', model: 'claude-test-1' },
      contextWindow: 32_768,
      claudeBin,
      codexBin: 'codex',
    });
    try {
      const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Slides, please.' }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'deck', schema: { type: 'object' }, strict: true },
          },
        }),
      });
      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      expect(JSON.parse(body.choices[0]?.message.content ?? '')).toEqual({ slides: [] });
      expect(await readFile(join(dir, 'args.txt'), 'utf8')).toContain('--json-schema');
    } finally {
      await endpoint.close();
    }
  });
});
