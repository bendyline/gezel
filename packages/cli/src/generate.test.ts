import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { floatOpt, intOpt, resolvePromptText, saveArtifact } from './generate.js';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolvePromptText', () => {
  it('joins and trims inline prompt parts', async () => {
    await expect(
      resolvePromptText(['  paint', 'a', 'sunset  '], undefined, 'prompt'),
    ).resolves.toBe('paint a sunset');
  });

  it('reads and trims a UTF-8 prompt file', async () => {
    const root = await tempRoot('gezel-cli-prompt-');
    const file = join(root, 'prompt.txt');
    await writeFile(file, '\n  a prompt from disk  \n', 'utf8');

    await expect(resolvePromptText([], file, 'prompt')).resolves.toBe('a prompt from disk');
  });

  it('rejects supplying both inline text and a file', async () => {
    await expect(resolvePromptText(['inline'], 'prompt.txt', 'prompt')).rejects.toThrow(
      'provide either prompt text or --file, not both.',
    );
  });

  it('rejects missing, unreadable, and empty input with user-facing errors', async () => {
    const root = await tempRoot('gezel-cli-prompt-errors-');
    const empty = join(root, 'empty.txt');
    await writeFile(empty, '  \n', 'utf8');

    await expect(resolvePromptText([], undefined, 'text')).rejects.toThrow(
      'provide text text as the argument, or --file <path>.',
    );
    await expect(resolvePromptText([], join(root, 'missing.txt'), 'prompt')).rejects.toThrow(
      /could not read --file/,
    );
    await expect(resolvePromptText([], empty, 'prompt')).rejects.toThrow(
      `--file "${empty}" is empty.`,
    );
  });
});

describe('numeric options', () => {
  it('parses integer options and passes an omitted value through', () => {
    expect(intOpt('steps', undefined)).toBeUndefined();
    expect(intOpt('steps', '42')).toBe(42);
    expect(intOpt('seed', '-7')).toBe(-7);
  });

  it('rejects a non-integer option value', () => {
    expect(() => intOpt('steps', 'not-a-number')).toThrow(
      '--steps must be an integer (got "not-a-number").',
    );
  });

  it('parses floating-point options and passes an omitted value through', () => {
    expect(floatOpt('speed', undefined)).toBeUndefined();
    expect(floatOpt('speed', '1.25')).toBe(1.25);
    expect(floatOpt('speed', '-0.5')).toBe(-0.5);
  });

  it('rejects non-finite floating-point option values', () => {
    expect(() => floatOpt('speed', 'not-a-number')).toThrow(
      '--speed must be a number (got "not-a-number").',
    );
    expect(() => floatOpt('speed', 'Infinity')).toThrow(
      '--speed must be a number (got "Infinity").',
    );
  });
});

describe('saveArtifact', () => {
  it('fetches an artifacts-relative path and writes binary bytes under the artifact basename', async () => {
    const root = await tempRoot('gezel-cli-artifact-');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const bytes = new Uint8Array([0, 1, 2, 127, 255]);
    const fetchProjectArtifactBlob = vi.fn().mockResolvedValue(new Blob([bytes]));
    const client = { fetchProjectArtifactBlob } as unknown as GezelClient;

    const dest = await saveArtifact(
      client,
      'project-1',
      'artifacts/generated/nested/output.bin',
      undefined,
    );

    expect(fetchProjectArtifactBlob).toHaveBeenCalledWith(
      'project-1',
      'generated/nested/output.bin',
    );
    expect(dest).toBe(join(root, 'output.bin'));
    expect(await readFile(dest)).toEqual(Buffer.from(bytes));
  });

  it('creates parent directories for an explicit output path', async () => {
    const root = await tempRoot('gezel-cli-artifact-output-');
    const output = join(root, 'exports', 'media', 'renamed.dat');
    const fetchProjectArtifactBlob = vi.fn().mockResolvedValue(new Blob(['artifact bytes']));
    const client = { fetchProjectArtifactBlob } as unknown as GezelClient;

    const dest = await saveArtifact(client, 'project-2', 'result.dat', output);

    expect(fetchProjectArtifactBlob).toHaveBeenCalledWith('project-2', 'result.dat');
    expect(dest).toBe(output);
    expect(await readFile(output, 'utf8')).toBe('artifact bytes');
  });
});
