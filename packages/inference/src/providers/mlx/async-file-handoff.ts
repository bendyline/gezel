/**
 * A successful async handoff is the terminal action for this sender.
 * Role-typed `delegate_*` tools share `message_gezel`'s parked-delivery
 * contract: the recipient cannot start until this provider turn releases the
 * session. The provider executes the whole emitted tool-call batch before
 * checking this predicate, so one response can still fan out to several
 * recipients.
 */
export function isSuccessfulAsyncHandoff(toolName: string, output: string): boolean {
  return (
    !output.startsWith('ERROR:') &&
    (toolName === 'message_gezel' || toolName.startsWith('delegate_'))
  );
}

export function asyncHandoffClosing(count: number): string {
  return count === 1
    ? 'I sent the handoff and ended my turn so the recipient can use the provider queue. Their reply will arrive asynchronously.'
    : `I sent ${count} handoffs and ended my turn so the recipients can use the provider queue. Their replies will arrive asynchronously.`;
}

export function immediateFileWriteClosing(paths: string[]): string {
  const unique = [...new Set(paths.filter((path) => path.trim().length > 0))];
  if (unique.length === 0) return 'I wrote the requested file to the workspace.';
  if (unique.length === 1) return `I wrote \`${unique[0]}\` to the workspace.`;
  return `I wrote ${unique.map((path) => `\`${path}\``).join(', ')} to the workspace.`;
}
