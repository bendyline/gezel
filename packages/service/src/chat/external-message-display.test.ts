import { describe, expect, it } from 'vitest';
import { externalUserMessageForDisplay } from './external-message-display.js';

describe('externalUserMessageForDisplay', () => {
  it('unwraps VS Code userRequest content and hides its injected context', () => {
    const content = `<context>
The current date is 2026-08-18.
</context>
<reminderInstructions>
Prefer the replace tool.
</reminderInstructions>
<userRequest>
Can you build a 3D flight simulator in a web page?
</userRequest>`;

    expect(externalUserMessageForDisplay('vscode', content)).toBe(
      'Can you build a 3D flight simulator in a web page?',
    );
  });

  it('omits VS Code metadata-only user-role messages', () => {
    const content = `<environment_info>Windows</environment_info>
<workspace_info>D:\\work\\game</workspace_info>
<userMemory>No saved preferences.</userMemory>
<sessionMemory>Empty.</sessionMemory>
<repoMemory>Empty.</repoMemory>`;

    expect(externalUserMessageForDisplay('vscode', content)).toBeNull();
  });

  it('preserves ordinary, unknown, and malformed content without guessing', () => {
    expect(externalUserMessageForDisplay('vscode', 'Please fix app.ts.')).toBe(
      'Please fix app.ts.',
    );
    expect(
      externalUserMessageForDisplay('vscode', '<futureEnvelope>Keep me</futureEnvelope>'),
    ).toBe('<futureEnvelope>Keep me</futureEnvelope>');
    expect(externalUserMessageForDisplay('vscode', '<userRequest>unfinished')).toBe(
      '<userRequest>unfinished',
    );
  });

  it("does not interpret another connected app's text as a VS Code envelope", () => {
    const content = '<userRequest>Literal XML from the user</userRequest>';
    expect(externalUserMessageForDisplay('pi', content)).toBe(content);
  });
});
