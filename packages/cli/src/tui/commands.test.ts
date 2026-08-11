import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMANDS,
  parseInput,
  suggestSlashCommands,
  suggestSlashWordwheel,
} from './commands.js';

const CRAFTBOOKS = [
  {
    id: 'release-check',
    name: 'Release Check',
    description: 'Validate a release before publishing.',
    source: 'bundled' as const,
    stepCount: 4,
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Review a change for correctness and maintainability.',
    source: 'project' as const,
    stepCount: 3,
  },
];

describe('suggestSlashCommands', () => {
  it('shows every command for the initial slash', () => {
    expect(suggestSlashCommands('/')).toEqual(SLASH_COMMANDS);
  });

  it('wordwheels by case-insensitive prefix', () => {
    expect(suggestSlashCommands('/C').map((command) => command.name)).toEqual([
      'continue',
      'cli',
      'chat',
      'clear',
    ]);
    expect(suggestSlashCommands('/pro').map((command) => command.name)).toEqual(['project']);
    expect(suggestSlashCommands('/m').map((command) => command.name)).toEqual(['model']);
    expect(suggestSlashCommands('/th').map((command) => command.name)).toEqual(['thread']);
    expect(suggestSlashCommands('/st').map((command) => command.name)).toEqual(['start']);
    expect(suggestSlashCommands('/n').map((command) => command.name)).toEqual(['nightshift']);
  });

  it('closes after the command or for ordinary input', () => {
    expect(suggestSlashCommands('/project ')).toEqual([]);
    expect(suggestSlashCommands('hello')).toEqual([]);
  });
});

describe('suggestSlashWordwheel', () => {
  it('keeps bare /start as a command that opens the picker', () => {
    expect(suggestSlashWordwheel('/start', CRAFTBOOKS)).toEqual([
      expect.objectContaining({ submit: '/start', label: '/start' }),
    ]);
  });

  it('switches to craftbooks after the /start space', () => {
    expect(suggestSlashWordwheel('/start ', CRAFTBOOKS).map((item) => item.submit)).toEqual([
      '/start code-review',
      '/start release-check',
    ]);
  });

  it('filters craftbooks by id, name, and description', () => {
    expect(suggestSlashWordwheel('/start rele', CRAFTBOOKS)[0]?.submit).toBe(
      '/start release-check',
    );
    expect(suggestSlashWordwheel('/start maintain', CRAFTBOOKS)[0]?.submit).toBe(
      '/start code-review',
    );
  });

  it('offers Night Shift subcommands after the command is completed', () => {
    expect(suggestSlashWordwheel('/nightshift ', CRAFTBOOKS).map((item) => item.submit)).toEqual([
      '/nightshift start',
      '/nightshift stop',
      '/nightshift list',
    ]);
    expect(suggestSlashWordwheel('/nightshift l', CRAFTBOOKS)[0]?.submit).toBe('/nightshift list');
  });
});

describe('parseInput', () => {
  it('distinguishes empty, chat, and CLI-mode input', () => {
    expect(parseInput('   ', false)).toEqual({ kind: 'empty' });
    expect(parseInput('  explain this  ', false)).toEqual({
      kind: 'prompt',
      text: 'explain this',
    });
    expect(parseInput('  pwd  ', true)).toEqual({ kind: 'shell', text: 'pwd' });
  });

  it('normalizes slash commands and preserves their arguments', () => {
    expect(parseInput(' /NiGhTsHiFt   start ', false)).toEqual({
      kind: 'command',
      name: 'nightshift',
      rest: 'start',
    });
    expect(parseInput('/', false)).toEqual({ kind: 'command', name: '', rest: '' });
  });

  it('recognizes explicit shell and tool forms in either mode', () => {
    expect(parseInput(' !  ls -la ', false)).toEqual({ kind: 'shell', text: 'ls -la' });
    expect(parseInput('@tools', true)).toEqual({ kind: 'tools' });
    expect(parseInput('@tool read_file {"path":"a b.md"}', false)).toEqual({
      kind: 'tool',
      name: 'read_file',
      argsJson: '{"path":"a b.md"}',
    });
    expect(parseInput('@tool list_files', false)).toEqual({
      kind: 'tool',
      name: 'list_files',
      argsJson: '',
    });
  });

  it('does not treat near-miss tool syntax as an invocation', () => {
    expect(parseInput('@Tools', false)).toEqual({ kind: 'prompt', text: '@Tools' });
    expect(parseInput('@tool', false)).toEqual({ kind: 'prompt', text: '@tool' });
  });
});
