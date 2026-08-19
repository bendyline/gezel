const VSCODE_SOURCE_ID = 'vscode';

const VSCODE_CONTEXT_TAGS = [
  'environment_info',
  'workspace_info',
  'userMemory',
  'sessionMemory',
  'repoMemory',
  'context',
  'reminderInstructions',
] as const;

const VSCODE_USER_REQUEST = /<userRequest(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/userRequest\s*>/iu;

/**
 * Return the user-visible form of an external app's user-role message.
 *
 * VS Code's native Chat endpoint sends editor/environment scaffolding as
 * user-role XML-like envelopes. The complete envelope still goes to the
 * model and request diagnostics; the mirrored Gezel conversation should
 * show only the human's `<userRequest>`. Metadata-only pseudo-messages are
 * omitted. Unknown or malformed content is preserved verbatim so a future
 * VS Code envelope change cannot silently discard a real request.
 */
export function externalUserMessageForDisplay(sourceId: string, content: string): string | null {
  if (sourceId !== VSCODE_SOURCE_ID) return content;

  const request = VSCODE_USER_REQUEST.exec(content)?.[1]?.trim();
  if (request) return request;

  let remainder = content;
  for (const tag of VSCODE_CONTEXT_TAGS) {
    const block = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}\\s*>`, 'giu');
    remainder = remainder.replace(block, '');
  }
  return remainder.trim().length === 0 ? null : content;
}
