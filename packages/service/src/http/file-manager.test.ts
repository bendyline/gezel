import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile }));

const { fileManagerLaunch, revealInFileManager } = await import('./file-manager.js');

describe('fileManagerLaunch', () => {
  it('opens a folder with each platform file manager', () => {
    expect(fileManagerLaunch('C:\\Docs', {}, 'win32')).toEqual({
      cmd: 'explorer',
      args: ['C:\\Docs'],
    });
    expect(fileManagerLaunch('/Users/a/Docs', {}, 'darwin')).toEqual({
      cmd: 'open',
      args: ['/Users/a/Docs'],
    });
    expect(fileManagerLaunch('/home/a/Docs', {}, 'linux')).toEqual({
      cmd: 'xdg-open',
      args: ['/home/a/Docs'],
    });
  });

  it('highlights a file in its folder where the platform can', () => {
    expect(fileManagerLaunch('C:\\Docs\\a.md', { select: true }, 'win32').args).toEqual([
      '/select,',
      'C:\\Docs\\a.md',
    ]);
    expect(fileManagerLaunch('/Users/a/a.md', { select: true }, 'darwin').args).toEqual([
      '-R',
      '/Users/a/a.md',
    ]);
    expect(fileManagerLaunch('/home/a/Docs/a.md', { select: true }, 'linux').args).toEqual([
      '/home/a/Docs',
    ]);
  });
});

describe('revealInFileManager', () => {
  beforeEach(() => execFile.mockReset());

  it('never launches the file manager hidden', () => {
    revealInFileManager('/some/dir');
    expect(execFile).toHaveBeenCalledTimes(1);
    const options = execFile.mock.calls[0]?.[2];
    expect(typeof options).toBe('function');
  });
});
