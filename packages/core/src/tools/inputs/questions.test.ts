import { describe, expect, it } from 'vitest';
import { AskQuestionRequestSchema } from '../../schemas/api.js';
import { AskUserQuestionInputSchema } from './questions.js';

describe('permission request tool contract', () => {
  it('preserves the typed request across the MCP and HTTP schemas', () => {
    const request = AskUserQuestionInputSchema.parse({
      question: 'Save my deck',
      permissionRequest: 'workspace-write',
    });
    const wire = AskQuestionRequestSchema.parse({
      projectId: 'slides',
      gezelId: 'ada',
      sessionId: 's1',
      prompt: request.question,
      permissionRequest: request.permissionRequest,
    });
    expect(wire.permissionRequest).toBe('workspace-write');
  });
  it.each(['root', 'shell', 'all', { managedWorkspaceWritePolicy: 'allow' }])(
    'rejects unsupported permission requests: %j',
    (permissionRequest) => {
      expect(
        AskUserQuestionInputSchema.safeParse({ question: 'Grant access', permissionRequest })
          .success,
      ).toBe(false);
    },
  );
});
