/**
 * Parse a line of TUI input into an intent. Chat mode treats bare text as a
 * prompt; CLI mode treats bare text as a shell command. Both modes honor the
 * explicit prefixes (`/command`, `!shell`, `@tool`, `@tools`) so you never
 * have to toggle modes for a one-off.
 */
export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; name: string; rest: string }
  | { kind: 'shell'; text: string }
  | { kind: 'tools' }
  | { kind: 'tool'; name: string; argsJson: string };

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMAND_WORDWHEEL_SIZE = 4;

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: 'help', description: 'show the command reference' },
  { name: 'project', description: 'switch active project' },
  { name: 'gezel', description: 'switch active gezel' },
  { name: 'task', description: 'set the active task' },
  { name: 'focus', description: 'send into another active chat' },
  { name: 'cli', description: 'make bare input run shell commands' },
  { name: 'chat', description: 'make bare input message your gezel' },
  { name: 'clear', description: 'clear the visible feed' },
  { name: 'quit', description: 'exit the TUI' },
];

/**
 * Return prefix matches while the user is typing a slash command. Once a
 * space is entered the command is complete and the wordwheel closes.
 */
export function suggestSlashCommands(input: string): ReadonlyArray<SlashCommand> {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

export function parseInput(raw: string, cliMode: boolean): ParsedInput {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };

  if (text.startsWith('/')) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    return { kind: 'command', name: (name ?? '').toLowerCase(), rest: rest.join(' ') };
  }

  if (text.startsWith('!')) return { kind: 'shell', text: text.slice(1).trim() };

  if (text === '@tools') return { kind: 'tools' };
  if (text.startsWith('@tool ')) {
    const after = text.slice('@tool '.length).trim();
    const sp = after.indexOf(' ');
    const name = sp === -1 ? after : after.slice(0, sp);
    const argsJson = sp === -1 ? '' : after.slice(sp + 1).trim();
    return { kind: 'tool', name, argsJson };
  }

  // In CLI mode a bare line is a shell command; in chat mode it's a prompt.
  return cliMode ? { kind: 'shell', text } : { kind: 'prompt', text };
}
