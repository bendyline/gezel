import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolReceipt } from '@bendyline/gezel';
import type { ToolCallEvent } from '@bendyline/gezel-inference/internal/providers/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverableWrittenThisTurn } from '../chat/deliverable-gate.js';
import { isExactLocalSourceRead } from '../tasks/research-evidence-match.js';
import { normalizeCliToolEvent } from './cli-tool-event.js';

let dir: string;
let cwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cli-evidence-'));
  cwd = join(dir, 'workspace');
  await mkdir(cwd);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const event = (name: string, args: Record<string, unknown>, success = true): ToolCallEvent => ({
  name,
  args,
  argKeys: Object.keys(args),
  durationMs: 1,
  success,
});
const receipt = (call: ToolCallEvent) => ({
  ...buildToolReceipt({ ...call, startedAtMs: 0 }),
  path: typeof call.args?.path === 'string' ? call.args.path : undefined,
});

describe('CLI evidence used by runtime gates', () => {
  it('accepts a successful namespaced artifact checkpoint, retaining its native name', () => {
    const raw = {
      ...event('mcp__gezel__write_artifact', { path: 'tasks/1/scope.md' }),
      resultText: 'Wrote tasks/1/scope.md',
    };
    const call = normalizeCliToolEvent(raw, 'anthropic-cli', cwd);
    expect(call.providerToolName).toBe(raw.name);
    expect(deliverableWrittenThisTurn([receipt(call)], 'tasks/1/scope.md', true)).toBe(true);
    for (const rejected of [
      { ...raw, success: false },
      { ...raw, name: 'mcp__other__write_artifact' },
      { ...raw, resultText: 'Wrote tasks/1/scope.md to the project workspace.' },
    ]) {
      expect(
        deliverableWrittenThisTurn(
          [receipt(normalizeCliToolEvent(rejected, 'anthropic-cli', cwd))],
          'tasks/1/scope.md',
          true,
        ),
      ).toBe(false);
    }
  });

  it.each(['Write', 'Edit'])('records %s only for the actual workspace destination', (name) => {
    const call = normalizeCliToolEvent(
      event(name, { file_path: join(cwd, 'report.md') }),
      'anthropic-cli',
      cwd,
    );
    expect(call.args?.path).toBe('report.md');
    expect(deliverableWrittenThisTurn([receipt(call)], 'report.md')).toBe(true);
    const failed = { ...call, success: false };
    expect(deliverableWrittenThisTurn([receipt(failed)], 'report.md')).toBe(false);
    for (const file_path of [join(dir, 'report.md'), '../report.md']) {
      const outside = normalizeCliToolEvent(event(name, { file_path }), 'anthropic-cli', cwd);
      expect(deliverableWrittenThisTurn([receipt(outside)], 'report.md')).toBe(false);
    }
  });

  it('makes a native source read visible to research gates without crediting other files', () => {
    const call = normalizeCliToolEvent(
      event('Read', { file_path: join(cwd, 'source/brief.md') }),
      'anthropic-cli',
      cwd,
    );
    const read = { tool: call.name, path: call.args?.path as string };
    expect(isExactLocalSourceRead(read, 'source/brief.md')).toBe(true);
    expect(isExactLocalSourceRead(read, 'source/other.md')).toBe(false);
  });

  it('resolves workspace aliases and rejects a symlink escape even for a removed file', async () => {
    await symlink(cwd, join(dir, 'alias'), 'junction');
    await writeFile(join(cwd, 'report.md'), 'report');
    const alias = normalizeCliToolEvent(
      event('Read', { file_path: join(dir, 'alias/report.md') }),
      'anthropic-cli',
      cwd,
    );
    expect(alias.args?.path).toBe('report.md');
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'outside'), join(cwd, 'linked'), 'junction');
    const escaped = normalizeCliToolEvent(
      event('Write', { file_path: join(cwd, 'linked/new.md') }),
      'anthropic-cli',
      cwd,
    );
    expect(escaped.name).toBe('Write');
    expect(escaped.args?.path).toBeUndefined();
  });

  it('accepts native Codex patch evidence only in its workspace, never from a foreign MCP', () => {
    const raw = {
      ...event('apply_patch', { path: join(cwd, 'report.md'), diff: '+fixed' }),
      providerToolName: 'file_change',
    };
    const call = normalizeCliToolEvent(raw, 'codex-cli', cwd);
    expect(deliverableWrittenThisTurn([receipt(call)], 'report.md')).toBe(true);
    const outside = normalizeCliToolEvent(
      { ...raw, args: { ...raw.args, path: join(dir, 'report.md') } },
      'codex-cli',
      cwd,
    );
    expect(deliverableWrittenThisTurn([receipt(outside)], 'report.md')).toBe(false);
    const foreign = normalizeCliToolEvent(
      event('write_file', { server: 'other', path: 'report.md' }),
      'codex-cli',
      cwd,
    );
    expect(deliverableWrittenThisTurn([receipt(foreign)], 'report.md')).toBe(false);
  });

  it('leaves API events and unknown CLI tools unchanged', () => {
    const raw = event('Read', { file_path: 'report.md' });
    expect(normalizeCliToolEvent(raw, 'openai', cwd)).toBe(raw);
    expect(normalizeCliToolEvent(raw, 'anthropic-cli', undefined)).toBe(raw);
  });
});
