import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, suggestSlashCommands } from './commands.js';

describe('suggestSlashCommands', () => {
  it('shows every command for the initial slash', () => {
    expect(suggestSlashCommands('/')).toEqual(SLASH_COMMANDS);
  });

  it('wordwheels by case-insensitive prefix', () => {
    expect(suggestSlashCommands('/C').map((command) => command.name)).toEqual([
      'cli',
      'chat',
      'clear',
    ]);
    expect(suggestSlashCommands('/pro').map((command) => command.name)).toEqual(['project']);
  });

  it('closes after the command or for ordinary input', () => {
    expect(suggestSlashCommands('/project ')).toEqual([]);
    expect(suggestSlashCommands('hello')).toEqual([]);
  });
});
