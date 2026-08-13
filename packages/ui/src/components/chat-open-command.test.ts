import { describe, expect, it } from 'vitest';
import {
  type OpenChatReference,
  openChatSuggestions,
  parseOpenChatQuery,
  resolveOpenChatTarget,
} from './chat-open-command.js';

const recent: OpenChatReference[] = [
  {
    key: 'workspace:security/review-scope.md',
    kind: 'workspace',
    path: 'security/review-scope.md',
  },
  { key: 'artifact:report.md', kind: 'artifact', path: 'reports/report.md' },
];

describe('/open chat command', () => {
  it('recognizes only a single-line /open draft', () => {
    expect(parseOpenChatQuery('/open workspace')).toBe('workspace');
    expect(parseOpenChatQuery(' /OPEN   artifacts ')).toBe('artifacts');
    expect(parseOpenChatQuery('/open workspace\nand review it')).toBeNull();
    expect(parseOpenChatQuery('please /open workspace')).toBeNull();
  });

  it('offers the two folder keywords and filters recent file references', () => {
    expect(openChatSuggestions('', recent).map((item) => item.label)).toEqual([
      'workspace',
      'artifacts',
      'security/review-scope.md',
      'reports/report.md',
    ]);
    expect(openChatSuggestions('scope', recent).map((item) => item.label)).toEqual([
      'security/review-scope.md',
    ]);
  });

  it('resolves exact paths and unambiguous basenames', () => {
    expect(resolveOpenChatTarget('artifacts', recent)).toEqual({
      type: 'folder',
      folder: 'artifacts',
    });
    expect(resolveOpenChatTarget('review-scope.md', recent)).toEqual({
      type: 'reference',
      reference: recent[0],
    });
    expect(resolveOpenChatTarget('security', recent)).toBeNull();
  });
});
