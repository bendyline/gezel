import type { CraftbookSummary } from '@bendyline/gezel';
import { CLI_ENGAGEMENT_MODES } from '../engagement-mode.js';

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
  { name: 'mode', description: 'set AI activity: read-only through full play' },
  { name: 'model', description: 'switch engine and model' },
  { name: 'thread', description: 'switch the active chat thread' },
  { name: 'task', description: 'list and manage project tasks' },
  { name: 'start', description: 'start a task from a craftbook' },
  { name: 'continue', description: 'process due and active project tasks' },
  { name: 'nightshift', description: 'start, stop, or list night-shift work' },
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

export interface SlashWordwheelSuggestion {
  key: string;
  label: string;
  description: string;
  /** Value submitted when Enter chooses this suggestion. */
  submit: string;
  /** Value staged in the prompt when Tab completes this suggestion. */
  completion: string;
}

const NIGHT_SHIFT_SUBCOMMANDS = [
  { name: 'start', description: 'start a manual night shift now' },
  { name: 'stop', description: 'stop the current night shift' },
  { name: 'list', description: 'show current and upcoming night-shift work' },
] as const;

/**
 * Suggestions for the prompt's slash-command wordwheel. `/start ` changes
 * the wheel to the active project's craftbook inventory; `/mode ` and
 * `/nightshift ` change it to their finite action lists.
 */
export function suggestSlashWordwheel(
  input: string,
  craftbooks: ReadonlyArray<CraftbookSummary>,
): ReadonlyArray<SlashWordwheelSuggestion> {
  const modeMatch = input.match(/^\/mode\s+(.*)$/i);
  if (modeMatch) {
    const query = (modeMatch[1] ?? '').trim().toLowerCase();
    return CLI_ENGAGEMENT_MODES.filter((option) => option.name.startsWith(query)).map((option) => ({
      key: `mode:${option.name}`,
      label: `/mode ${option.name}`,
      description: option.description,
      submit: `/mode ${option.name}`,
      completion: `/mode ${option.name}`,
    }));
  }

  const nightShiftMatch = input.match(/^\/nightshift\s+(.*)$/i);
  if (nightShiftMatch) {
    const query = (nightShiftMatch[1] ?? '').trim().toLowerCase();
    return NIGHT_SHIFT_SUBCOMMANDS.filter((command) => command.name.startsWith(query)).map(
      (command) => ({
        key: `nightshift:${command.name}`,
        label: `/nightshift ${command.name}`,
        description: command.description,
        submit: `/nightshift ${command.name}`,
        completion: `/nightshift ${command.name}`,
      }),
    );
  }

  const startMatch = input.match(/^\/start\s+(.*)$/i);
  if (startMatch) {
    const query = (startMatch[1] ?? '').trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    return craftbooks
      .filter((book) => {
        const haystack = `${book.id} ${book.name} ${book.description ?? ''}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((left, right) => {
        const leftRank = craftbookMatchRank(left, query);
        const rightRank = craftbookMatchRank(right, query);
        return leftRank - rightRank || left.name.localeCompare(right.name);
      })
      .map((book) => ({
        key: `craftbook:${book.id}`,
        label: `/start ${book.id}`,
        description: `${book.name} · ${book.stepCount} ${book.stepCount === 1 ? 'step' : 'steps'} · ${book.source}`,
        submit: `/start ${book.id}`,
        completion: `/start ${book.id}`,
      }));
  }

  return suggestSlashCommands(input).map((command) => ({
    key: `command:${command.name}`,
    label: `/${command.name}`,
    description: command.description,
    submit: `/${command.name}`,
    completion: `/${command.name} `,
  }));
}

function craftbookMatchRank(book: CraftbookSummary, query: string): number {
  if (!query) return 2;
  const id = book.id.toLowerCase();
  const name = book.name.toLowerCase();
  if (id === query || name === query) return 0;
  if (id.startsWith(query) || name.startsWith(query)) return 1;
  return 2;
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
