import { describe, expect, it } from 'vitest';
import { GEZELD_HELP, parseGezeldArgs } from './gezeld-args.js';

describe('parseGezeldArgs', () => {
  it('answers help and version without starting the daemon', () => {
    expect(parseGezeldArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseGezeldArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseGezeldArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseGezeldArgs(['-V'])).toEqual({ kind: 'version' });
    expect(parseGezeldArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it('lets help win over anything else on the line', () => {
    expect(parseGezeldArgs(['--version', '--help'])).toEqual({ kind: 'help' });
    expect(parseGezeldArgs(['--port', '8080', '-h'])).toEqual({ kind: 'help' });
  });

  it('starts the daemon for the argument hosts pass, and with none', () => {
    expect(parseGezeldArgs([])).toEqual({ kind: 'run', unrecognized: [] });
    expect(parseGezeldArgs(['--gezel-autostart-home=C:\\Users\\a b\\.gezel'])).toEqual({
      kind: 'run',
      unrecognized: [],
    });
  });

  it('still starts on arguments it does not know, and names them', () => {
    expect(parseGezeldArgs(['--port', '8080'])).toEqual({
      kind: 'run',
      unrecognized: ['--port', '8080'],
    });
  });
});

describe('GEZELD_HELP', () => {
  it('documents the variables that configure a hand-started daemon', () => {
    for (const name of ['GEZEL_HOME', 'GEZEL_PORT', 'GEZEL_LOG_LEVEL', 'GEZEL_DAEMON_LOG_FILE']) {
      expect(GEZELD_HELP).toContain(name);
    }
  });
});
