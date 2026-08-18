import type { ChatEventEnvelope, ChatSession } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  cliOpenReferencesFromEvent,
  cliOpenReferencesFromSession,
  rememberCliOpenReferences,
  resolveCliOpenTarget,
} from './open-command.js';

describe('CLI /open recent references', () => {
  it('collects successful workspace and generated-media tool paths', () => {
    const workspace = cliOpenReferencesFromEvent({
      sessionId: 'session-1',
      gezelId: 'gezel-1',
      projectId: 'project-1',
      event: {
        type: 'tool',
        name: 'read_file',
        durationMs: 4,
        success: true,
        path: 'security/review-scope.md',
      },
    });
    const media = cliOpenReferencesFromEvent({
      sessionId: 'session-1',
      gezelId: 'gezel-1',
      projectId: 'project-1',
      event: {
        type: 'tool',
        name: 'generate_image',
        durationMs: 4,
        success: true,
        images: [{ path: 'generated/map.png', mimeType: 'image/png' }],
      },
    });

    expect(workspace).toEqual([
      expect.objectContaining({
        kind: 'workspace',
        path: 'security/review-scope.md',
        projectId: 'project-1',
      }),
    ]);
    expect(media).toEqual([
      expect.objectContaining({ kind: 'artifact', path: 'generated/map.png' }),
    ]);
  });

  it('seeds an MRU from persisted artifact references and tool calls', () => {
    const session = {
      projectId: 'project-1',
      messages: [
        {
          role: 'assistant',
          content: 'See the report.',
          at: '2026-08-14T00:00:00.000Z',
          referencedArtifacts: ['reports/audit.md'],
          toolCalls: [
            {
              name: 'read_document',
              durationMs: 1,
              success: true,
              path: 'guidelines/security.md',
            },
          ],
        },
      ],
    } as Pick<ChatSession, 'projectId' | 'messages'>;

    expect(cliOpenReferencesFromSession(session).map((reference) => reference.path)).toEqual([
      'reports/audit.md',
      'guidelines/security.md',
    ]);
  });

  it('seeds an MRU from referencedFiles, keeping each entry its own kind', () => {
    const session = {
      projectId: 'project-1',
      messages: [
        {
          role: 'assistant',
          content: 'See the review.',
          at: '2026-08-14T00:00:00.000Z',
          referencedFiles: [
            { kind: 'artifact' as const, path: 'reports/pr-review.md' },
            { kind: 'workspace' as const, path: 'docs/API.md' },
          ],
          // Present alongside the current field on anything this daemon
          // wrote; the reader must not double-count it.
          referencedArtifacts: ['reports/pr-review.md'],
        },
      ],
    } as Pick<ChatSession, 'projectId' | 'messages'>;

    // Newest-first, so the last path named in the body leads the MRU.
    expect(
      cliOpenReferencesFromSession(session).map((reference) => [reference.kind, reference.path]),
    ).toEqual([
      ['workspace', 'docs/API.md'],
      ['artifact', 'reports/pr-review.md'],
    ]);
  });

  it('promotes repeated references and resolves exact paths or unique basenames', () => {
    const first = cliOpenReferencesFromEvent(toolEvent('docs/one/review.md'));
    const second = cliOpenReferencesFromEvent(toolEvent('docs/two/notes.md'));
    const recent = rememberCliOpenReferences(rememberCliOpenReferences([], first), [
      ...second,
      ...first,
    ]);

    expect(recent.map((reference) => reference.path)).toEqual([
      'docs/one/review.md',
      'docs/two/notes.md',
    ]);
    expect(resolveCliOpenTarget('review.md', recent)).toEqual({
      type: 'reference',
      reference: recent[0],
    });
    expect(resolveCliOpenTarget('docs/two/notes.md', recent)).toEqual({
      type: 'reference',
      reference: recent[1],
    });
    expect(resolveCliOpenTarget('workspace', recent)).toEqual({
      type: 'folder',
      folder: 'workspace',
    });
  });
});

function toolEvent(path: string): ChatEventEnvelope {
  return {
    sessionId: 'session-1',
    gezelId: 'gezel-1',
    projectId: 'project-1',
    event: { type: 'tool', name: 'read_file', durationMs: 1, success: true, path },
  };
}
