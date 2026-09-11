import { describe, expect, it } from 'vitest';
import {
  equivalentWorkspaceGrepArgs,
  renderExactToolCall,
  workspaceGrepResult,
} from './workspace-grep-result.js';

function resultText(result: ReturnType<typeof workspaceGrepResult>): string {
  return result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
}

describe('workspace grep result helpers', () => {
  it('translates artifact grep options into an exact workspace retry', () => {
    const args = equivalentWorkspaceGrepArgs('src', 'Needle', {
      contextLines: 9,
    });

    expect(args).toEqual({
      path: 'src',
      pattern: 'Needle',
      caseInsensitive: true,
      contextLines: 5,
      maxResults: 20,
    });
    expect(renderExactToolCall('grep_files', args)).toBe(
      'grep_files({"path":"src","pattern":"Needle","caseInsensitive":true,"contextLines":5,"maxResults":20})',
    );
  });

  it('formats count results with reroute and continuation guidance', () => {
    const result = workspaceGrepResult(
      { pattern: 'needle' },
      {
        mode: 'count',
        matches: [],
        files: [],
        count: 7,
        truncated: true,
        truncationReason: 'limit',
        nextCursor: 40,
        engine: 'ripgrep',
      },
      'Rerouted grep_artifact to grep_files.',
    );

    expect(result.structuredContent).toMatchObject({
      summary: 'at least 7 matching lines (engine=ripgrep).',
      query: 'needle',
      matches: [],
      count: 7,
      truncated: true,
      nextCursor: 40,
      truncationReason: 'limit',
      mode: 'count',
    });
    expect(resultText(result)).toContain('Rerouted grep_artifact to grep_files.');
    expect(resultText(result)).toContain('Continue with cursor=40');
  });

  it('formats file-only results as structured paths and readable text', () => {
    const result = workspaceGrepResult(
      { path: 'src', pattern: 'export' },
      {
        mode: 'files',
        matches: [],
        files: ['src/a.ts', 'src/b.ts'],
        count: 2,
        truncated: false,
        engine: 'javascript',
      },
    );

    expect(result.structuredContent).toMatchObject({
      summary: '2 matching files (engine=javascript).',
      matches: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      count: 2,
      mode: 'files',
    });
    expect(resultText(result)).toBe('2 matching files (engine=javascript)\nsrc/a.ts\nsrc/b.ts');
  });

  it('renders match context in grep-compatible line notation', () => {
    const result = workspaceGrepResult(
      { pattern: 'needle' },
      {
        mode: 'matches',
        matches: [
          {
            path: 'src/a.ts',
            line: 3,
            text: 'needle();',
            before: [{ line: 2, text: 'before();' }],
            after: [{ line: 4, text: 'after();' }],
          },
          { path: 'src/b.ts', line: 8, text: 'needle();' },
        ],
        files: [],
        count: 2,
        truncated: false,
        engine: 'ripgrep',
      },
    );

    expect(result.structuredContent).toMatchObject({
      summary: '2 matches (engine=ripgrep).',
      count: 2,
      mode: 'matches',
    });
    expect(resultText(result)).toContain(
      'src/a.ts-2-before();\nsrc/a.ts:3:needle();\nsrc/a.ts-4-after();\n--\nsrc/b.ts:8:needle();',
    );
  });
});
