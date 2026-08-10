import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_READ_MAX_BATCH_RESULT_BYTES,
  WORKSPACE_READ_MAX_FILES,
  WORKSPACE_READ_MAX_SCAN_BYTES,
} from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkspaceFiles } from './read-files.js';

let workspaceDir: string;
let outsideDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'gezel-read-files-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'gezel-read-files-outside-'));
});

afterEach(async () => {
  await Promise.all([
    rm(workspaceDir, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ]);
});

describe('readWorkspaceFiles', () => {
  it('returns complete small files and preserves trailing-newline semantics', async () => {
    await writeFile(join(workspaceDir, 'small.txt'), 'one\ntwo\n');
    const response = await readWorkspaceFiles({
      workspaceDir,
      files: [{ path: 'small.txt' }],
    });

    expect(response.results).toEqual([
      {
        status: 'ok',
        path: 'small.txt',
        content: 'one\ntwo\n',
        startLine: 1,
        endLine: 2,
        linesReturned: 2,
        bytesReturned: 8,
        scannedBytes: 8,
        totalLines: 2,
        totalBytes: 8,
        eof: true,
        completeFile: true,
        hasMore: false,
        truncated: false,
      },
    ]);
    expect(response.totalBytesReturned).toBe(8);
    expect(response.totalScannedBytes).toBe(8);
  });

  it('reads inclusive ranges with absolute line metadata and normalizes CRLF', async () => {
    await writeFile(join(workspaceDir, 'range.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\n');
    const response = await readWorkspaceFiles({
      workspaceDir,
      files: [{ path: 'range.txt', startLine: 2, endLine: 3 }],
    });
    expect(response.results[0]).toMatchObject({
      status: 'ok',
      content: 'two\nthree',
      startLine: 2,
      endLine: 3,
      linesReturned: 2,
      eof: false,
      completeFile: false,
      hasMore: true,
      nextStartLine: 4,
      truncated: false,
    });
  });

  it('distinguishes an empty file from a range past EOF', async () => {
    await Promise.all([
      writeFile(join(workspaceDir, 'empty.txt'), ''),
      writeFile(join(workspaceDir, 'short.txt'), 'one\ntwo'),
    ]);
    const response = await readWorkspaceFiles({
      workspaceDir,
      files: [{ path: 'empty.txt' }, { path: 'short.txt', startLine: 3, endLine: 3 }],
    });
    expect(response.results[0]).toMatchObject({
      status: 'ok',
      content: '',
      totalLines: 0,
      completeFile: true,
    });
    expect(response.results[1]).toMatchObject({
      status: 'error',
      code: 'range-out-of-bounds',
      scannedBytes: 7,
    });
  });

  it('decodes a multibyte code point split across read chunks', async () => {
    const skipped = 'x'.repeat(65_535);
    await writeFile(join(workspaceDir, 'unicode.txt'), `${skipped}\n😀 target\nafter\n`);
    const response = await readWorkspaceFiles({
      workspaceDir,
      files: [{ path: 'unicode.txt', startLine: 2, endLine: 2 }],
    });
    expect(response.results[0]).toMatchObject({
      status: 'ok',
      content: '😀 target',
      startLine: 2,
      endLine: 2,
    });
  });

  it('rejects NUL data, invalid UTF-8, UTF-16, and an overlong requested line', async () => {
    await Promise.all([
      // Avoid the portable reserved-name fence for `NUL`; this fixture is
      // testing content classification, not Windows path handling.
      writeFile(join(workspaceDir, 'zero-byte.bin'), Buffer.from([0x61, 0, 0x62])),
      writeFile(join(workspaceDir, 'invalid.bin'), Buffer.from([0xc3, 0x28])),
      writeFile(join(workspaceDir, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x61, 0x00])),
      writeFile(join(workspaceDir, 'long.txt'), `${'x'.repeat(40_000)}\nnext\n`),
    ]);
    const response = await readWorkspaceFiles({
      workspaceDir,
      files: [
        { path: 'zero-byte.bin' },
        { path: 'invalid.bin' },
        { path: 'utf16.txt' },
        { path: 'long.txt', startLine: 1, endLine: 1 },
      ],
    });
    expect(
      response.results.map((result) => (result.status === 'error' ? result.code : 'ok')),
    ).toEqual(['binary-file', 'unsupported-encoding', 'unsupported-encoding', 'line-too-long']);
    const long = response.results[3];
    expect(long).toMatchObject({ status: 'error', code: 'line-too-long' });
    expect(long && 'nextStartLine' in long).toBe(false);
  });

  it('can read an early range from a large file and bounds scans for an unreachable range', async () => {
    const large = Buffer.alloc(WORKSPACE_READ_MAX_SCAN_BYTES + 1024, 0x61);
    large[3] = 0x0a;
    await writeFile(join(workspaceDir, 'large.txt'), large);

    const early = await readWorkspaceFiles({
      workspaceDir,
      files: [{ path: 'large.txt', startLine: 1, endLine: 1 }],
    });
    expect(early.results[0]).toMatchObject({
      status: 'ok',
      content: 'aaa',
      eof: false,
      hasMore: true,
    });

    const unreachable = await readWorkspaceFiles({
      workspaceDir,
      files: [{ path: 'large.txt', startLine: 3, endLine: 3 }],
    });
    expect(unreachable.results[0]).toMatchObject({
      status: 'error',
      code: 'scan-limit',
      scannedBytes: WORKSPACE_READ_MAX_SCAN_BYTES,
    });
  });

  it('does not scan a second chunk when the requested range ends at a chunk boundary', async () => {
    const firstChunk = `${'x'.repeat(65_532)}\nok\n`;
    expect(Buffer.byteLength(firstChunk)).toBe(64 * 1024);
    await writeFile(join(workspaceDir, 'boundary.txt'), `${firstChunk}${'later\n'.repeat(20_000)}`);

    const response = await readWorkspaceFiles({
      workspaceDir,
      files: [{ path: 'boundary.txt', startLine: 2, endLine: 2 }],
    });

    expect(response.results[0]).toMatchObject({
      status: 'ok',
      content: 'ok',
      startLine: 2,
      endLine: 2,
      scannedBytes: 64 * 1024,
      eof: false,
      hasMore: true,
      nextStartLine: 3,
    });
  });

  it('allocates output/line budgets fairly so the final batch item remains readable', async () => {
    const files = Array.from({ length: WORKSPACE_READ_MAX_FILES }, (_, index) => ({
      path: `file-${index}.txt`,
    }));
    await Promise.all(
      files.map((file, index) =>
        writeFile(
          join(workspaceDir, file.path),
          Array.from({ length: 150 }, (_, line) => `${index}-${line}-${'x'.repeat(40)}`).join('\n'),
        ),
      ),
    );

    const response = await readWorkspaceFiles({ workspaceDir, files });
    expect(response.results).toHaveLength(WORKSPACE_READ_MAX_FILES);
    expect(response.results.every((result) => result.status === 'ok')).toBe(true);
    expect(response.results.at(-1)).toMatchObject({ status: 'ok', startLine: 1 });
    expect(response.totalBytesReturned).toBeLessThanOrEqual(WORKSPACE_READ_MAX_BATCH_RESULT_BYTES);
    for (const result of response.results) {
      if (result.status !== 'ok') continue;
      expect(result.linesReturned).toBeGreaterThan(0);
      expect(result.linesReturned).toBeLessThanOrEqual(100);
      expect(result.truncated).toBe(true);
      expect(result.nextStartLine).toBe(result.endLine + 1);
    }
  });

  it('rejects traversal and outward symlinks while allowing contained paths and inward symlinks', async () => {
    await mkdir(join(workspaceDir, 'inside'), { recursive: true });
    await Promise.all([
      writeFile(join(workspaceDir, 'inside', 'ok.txt'), 'safe\n'),
      writeFile(join(outsideDir, 'secret.txt'), 'secret\n'),
    ]);
    if (process.platform !== 'win32') {
      await Promise.all([
        symlink(join(workspaceDir, 'inside', 'ok.txt'), join(workspaceDir, 'inward.txt')),
        symlink(join(outsideDir, 'secret.txt'), join(workspaceDir, 'outward.txt')),
      ]);
    }
    const requests = [
      { path: '../outside.txt' },
      { path: join(workspaceDir, 'inside', 'ok.txt') },
      ...(process.platform === 'win32' ? [] : [{ path: 'inward.txt' }, { path: 'outward.txt' }]),
    ];
    const response = await readWorkspaceFiles({ workspaceDir, files: requests });
    expect(response.results[0]).toMatchObject({ status: 'error', code: 'path-safety' });
    expect(response.results[1]).toMatchObject({ status: 'ok', content: 'safe\n' });
    if (process.platform !== 'win32') {
      expect(response.results[2]).toMatchObject({ status: 'ok', content: 'safe\n' });
      expect(response.results[3]).toMatchObject({ status: 'error', code: 'path-safety' });
    }
  });
});
