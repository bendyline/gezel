import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCORECARD } from './index.js';

const id = '2026-11-11-windows-small-outcome-bare';
const run = SCORECARD.runs.find((entry) => entry.id === id)!;
const results = SCORECARD.results.filter((result) => result.runId === id);
const groups = results.flatMap((result) => result.taskMeasurements ?? []);
const sum = <T>(items: T[], value: (item: T) => number) =>
  items.reduce((total, item) => total + value(item), 0);

describe('published November Windows small-model round', () => {
  it('keeps every attempt, with infrastructure exclusions separate from model failures', () => {
    expect(run.scope).toBe('suite');
    expect(run.memoryCoverage).toBe('system-only');
    expect(run.provenance).toMatchObject({
      harnessCommit: '92437e37',
      gildeVersion: '0.3.8',
      count: 3,
      judgeModelId: 'anthropic-cli/claude-sonnet-5-5',
    });
    expect(results).toHaveLength(56);
    expect(new Set(results.map((result) => result.modelId)).size).toBe(14);
    const cells = results.flatMap((result) => result.cells);
    expect(cells).toHaveLength(14 * 43);
    expect(cells.every((cell) => cell.trials === 3)).toBe(true);
    expect(sum(cells, (cell) => cell.successes)).toBe(848);
    expect(sum(cells, (cell) => cell.nonModelFailures)).toBe(6);
  });

  it('separates power periods instead of pooling throttled speeds', () => {
    const trialsIn = (period: string) =>
      sum(
        groups.filter((group) => group.id === period),
        (group) => group.trials,
      );
    expect(sum(groups, (group) => group.trials)).toBe(1806);
    expect(trialsIn('silent-45w')).toBe(408);
    expect(trialsIn('turbo-77w')).toBe(1393);
    expect(trialsIn('battery-overlap')).toBe(5);
    const gemma = results.filter((result) => result.modelId.startsWith('gemma4-'));
    expect(
      gemma.every((result) => result.taskMeasurements!.every((g) => g.id === 'silent-45w')),
    ).toBe(true);
    const qwen9bCore = results.find(
      (result) => result.modelId === 'qwen3.5-9b-q4' && result.suiteId === 'core',
    )!;
    expect(qwen9bCore.taskMeasurements!.map((group) => [group.id, group.trials])).toEqual([
      ['silent-45w', 21],
      ['turbo-77w', 12],
    ]);
    expect(run.note).toContain('Granite 4.2 8B');
    expect(run.note).toContain('placed layers on the CPU in all 129 trials');
  });

  it('publishes Sonnet 5.5 reviews by rubric, never as one combined score', () => {
    expect(results.every((result) => result.judge === undefined)).toBe(true);
    const judgments = groups.flatMap((group) => group.judgments);
    expect(sum(judgments, (judge) => judge.artifacts)).toBe(724);
    expect(judgments.every((judge) => judge.judgeModel === 'anthropic-cli/claude-sonnet-5-5')).toBe(
      true,
    );
    expect(sum(groups, (group) => group.noArtifact)).toBe(74);
    expect(sum(groups, (group) => group.notApplicableReviews ?? 0)).toBe(1008);
    expect(sum(groups, (group) => group.excludedReviews)).toBe(0);
    const coreRubrics = results
      .filter((result) => result.suiteId === 'core')
      .flatMap((result) => result.taskMeasurements!.flatMap((group) => group.judgments))
      .map((judge) => judge.rubricId);
    expect(new Set(coreRubrics)).toEqual(new Set(['default-html-v1']));
  });

  it('ships matching downloads, verified hashes and working links', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const assets = resolve(root, 'docs/handboek/assets/scorecards', id);
    const read = (name: string) => JSON.parse(readFileSync(resolve(assets, name), 'utf8'));
    const published = read('scorecard.json');
    expect(published.runs).toEqual([run]);
    expect(published.results).toEqual(results);
    for (const file of read('manifest.json').files) {
      const content = readFileSync(resolve(root, file.path));
      expect(createHash('sha256').update(content).digest('hex'), file.path).toBe(file.sha256);
      expect(content.byteLength).toBe(file.bytes);
      if (!file.path.endsWith('.md')) continue;
      for (const [, link] of content.toString().matchAll(/\]\(([^)]+)\)/g)) {
        if (/^(https?:|#)/.test(link!)) continue;
        expect(existsSync(resolve(assets, link!)), `${file.path}: ${link}`).toBe(true);
      }
    }
    const note = readFileSync(
      resolve(root, 'docs/handboek/technical/scorecard-rounds', `${id}.md`),
      'utf8',
    );
    expect(note).toContain(`  - ${id}`);
    for (const [, link] of note.matchAll(/\]\(([^)]+)\)/g)) {
      expect(
        existsSync(resolve(root, 'docs/handboek/technical/scorecard-rounds', link!)),
        link,
      ).toBe(true);
    }
    const details = read('scorecard-details.json');
    expect(details.counts).toMatchObject({ recorded: 1806, judged: 724 });
    expect(details.newInferenceCalls).toBe(0);
    expect(details.trials).toHaveLength(1806);
  });
});
