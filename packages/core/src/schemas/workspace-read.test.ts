import { describe, expect, it } from 'vitest';
import {
  ReadWorkspaceFilesRequestSchema,
  WORKSPACE_READ_MAX_FILES,
  WORKSPACE_READ_MAX_RANGE_LINES,
  WorkspaceReadFileRequestSchema,
} from './api.js';

describe('workspace read schemas', () => {
  it('accepts an inclusive bounded range and an omitted continuation end', () => {
    expect(
      WorkspaceReadFileRequestSchema.parse({
        path: 'src/app.ts',
        startLine: 40,
        endLine: 80,
      }),
    ).toEqual({ path: 'src/app.ts', startLine: 40, endLine: 80 });
    expect(WorkspaceReadFileRequestSchema.parse({ path: 'src/app.ts', startLine: 81 })).toEqual({
      path: 'src/app.ts',
      startLine: 81,
    });
  });

  it('rejects reversed and oversized ranges at the shared boundary', () => {
    expect(
      WorkspaceReadFileRequestSchema.safeParse({
        path: 'src/app.ts',
        startLine: 20,
        endLine: 19,
      }).success,
    ).toBe(false);
    expect(
      WorkspaceReadFileRequestSchema.safeParse({
        path: 'src/app.ts',
        startLine: 1,
        endLine: WORKSPACE_READ_MAX_RANGE_LINES + 1,
      }).success,
    ).toBe(false);
  });

  it('bounds batch size', () => {
    const maximum = Array.from({ length: WORKSPACE_READ_MAX_FILES }, (_, index) => ({
      path: `src/file-${index}.ts`,
    }));
    expect(ReadWorkspaceFilesRequestSchema.safeParse({ files: maximum }).success).toBe(true);
    expect(
      ReadWorkspaceFilesRequestSchema.safeParse({
        files: [...maximum, { path: 'src/one-too-many.ts' }],
      }).success,
    ).toBe(false);
  });
});
