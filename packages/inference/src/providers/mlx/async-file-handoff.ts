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

/**
 * The handoff results (core's `messageGezelText`, the MCP `delegate_*` tools)
 * name the recipient after a fixed lead-in and again as "<name>'s turn".
 * Requiring both means a reworded result, or a name holding a period, gives
 * no name rather than half of one.
 */
const HANDOFF_RECIPIENT =
  /(?:Accepted the (?:message|handoff) for|Dispatched the (?:message|handoff) to|An identical file handoff is already pending with) (.+?)(?= \(|[.;])[\s\S]*?\1's turn/;

/** The gezel a successful handoff result names, when it names one. */
export function asyncHandoffRecipient(output: string): string | undefined {
  return HANDOFF_RECIPIENT.exec(output.slice(0, 2_000))?.[1]?.trim() || undefined;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * The reply the person sees when the runtime ends a delegating turn, which the
 * model also reads back as its own last message. The tool result already told
 * the model to end its turn, so this line only says what happened. Each entry
 * is one handoff's recipient, or undefined when its result named nobody.
 */
export function asyncHandoffClosing(recipients: readonly (string | undefined)[]): string {
  const named = [...new Set(recipients.filter((name): name is string => Boolean(name)))];
  if (named.length > 0 && !recipients.includes(undefined)) {
    return named.length === 1
      ? `${named[0]} is on it. Their reply will appear here.`
      : `${joinNames(named)} are on it. Their replies will appear here.`;
  }
  return recipients.length > 1
    ? "I've passed this on. The replies will appear here."
    : "I've passed this on. The reply will appear here.";
}

export function immediateFileWriteClosing(paths: string[]): string {
  const unique = [...new Set(paths.filter((path) => path.trim().length > 0))];
  if (unique.length === 0) return 'I wrote the requested file to the workspace.';
  if (unique.length === 1) return `I wrote \`${unique[0]}\` to the workspace.`;
  return `I wrote ${unique.map((path) => `\`${path}\``).join(', ')} to the workspace.`;
}
