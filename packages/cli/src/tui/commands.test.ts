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
    expect(suggestSlashCommands('/a').map((command) => command.name)).toEqual(['allow']);
    expect(suggestSlashCommands('/d').map((command) => command.name)).toEqual(['disallow', 'do']);
    expect(suggestSlashCommands('/m').map((command) => command.name)).toEqual(['mode', 'model']);
    expect(suggestSlashCommands('/th').map((command) => command.name)).toEqual(['thread']);
    expect(suggestSlashCommands('/st')).toEqual([]);
    expect(suggestSlashCommands('/n').map((command) => command.name)).toEqual(['nightshift']);
  });

  it('closes after the command or for ordinary input', () => {
    expect(suggestSlashCommands('/project ')).toEqual([]);
    expect(suggestSlashCommands('hello')).toEqual([]);
  });
});

describe('suggestSlashWordwheel', () => {
  it('keeps bare /do as a command that opens the picker', () => {
    expect(suggestSlashWordwheel('/do', CRAFTBOOKS)).toEqual([
      expect.objectContaining({ submit: '/do', label: '/do' }),
    ]);
  });

  it('switches to craftbooks after the /do space', () => {
    expect(suggestSlashWordwheel('/do ', CRAFTBOOKS).map((item) => item.submit)).toEqual([
      '/do code-review',
      '/do release-check',
    ]);
  });

  it('filters craftbooks by id, name, and description', () => {
    expect(suggestSlashWordwheel('/do rele', CRAFTBOOKS)[0]?.submit).toBe('/do release-check');
    expect(suggestSlashWordwheel('/do maintain', CRAFTBOOKS)[0]?.submit).toBe('/do code-review');
  });

  it('offers Night Shift subcommands after the command is completed', () => {
    expect(suggestSlashWordwheel('/nightshift ', CRAFTBOOKS).map((item) => item.submit)).toEqual([
      '/nightshift start',
      '/nightshift stop',
      '/nightshift list',
    ]);
    expect(suggestSlashWordwheel('/nightshift l', CRAFTBOOKS)[0]?.submit).toBe('/nightshift list');
  });

  it('offers the four engagement modes after /mode', () => {
    expect(suggestSlashWordwheel('/mode ', CRAFTBOOKS).map((item) => item.submit)).toEqual([
      '/mode read-only',
      '/mode reactive',
      '/mode reactive+tasks',
      '/mode full-play',
    ]);
    expect(suggestSlashWordwheel('/mode rea', CRAFTBOOKS).map((item) => item.submit)).toEqual([
      '/mode read-only',
      '/mode reactive',
      '/mode reactive+tasks',
    ]);
  });

  it('offers the model download subcommand after /model', () => {
    expect(suggestSlashWordwheel('/model ', CRAFTBOOKS)).toEqual([
      expect.objectContaining({
        submit: '/model download',
        description: 'choose and download a new on-device model',
      }),
    ]);
  });

  it('offers the project edit permission after /allow and /disallow', () => {
    expect(suggestSlashWordwheel('/allow ', CRAFTBOOKS).map((item) => item.submit)).toEqual([
      '/allow edits',
      '/allow codexedits',
      '/allow claudeedits',
    ]);
    expect(suggestSlashWordwheel('/disallow e', CRAFTBOOKS)).toEqual([
      expect.objectContaining({
        submit: '/disallow edits',
        description: 'make built-in tools and background work read-only',
      }),
    ]);
    expect(suggestSlashWordwheel('/allow c', CRAFTBOOKS)).toEqual([
      expect.objectContaining({
        submit: '/allow codexedits',
        description: 'let Codex sessions edit this project',
      }),
      expect.objectContaining({
        submit: '/allow claudeedits',
        description: 'let Claude sessions edit this project',
      }),
    ]);
    expect(suggestSlashWordwheel('/disallow cla', CRAFTBOOKS)).toEqual([
      expect.objectContaining({
        submit: '/disallow claudeedits',
        description: 'put Claude sessions in read-only plan mode',
      }),
    ]);
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
