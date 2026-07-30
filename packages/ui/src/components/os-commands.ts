/**
 * A small, curated primer of everyday command-line operations, written for
 * people who have never used a terminal. This is deliberately NOT a mirror of
 * anything discovered on disk — it's the fixed "here's how you get around"
 * card that sits beside the project's own scripts and craftbooks.
 *
 * Descriptions are plain English, no jargon: the reader is assumed to know
 * what a folder and a file are, and nothing else.
 *
 * Placeholders are written as quoted names (`cd "folder-name"`) rather than
 * angle brackets, because `<` and `>` are redirection operators in both
 * shells — a staged line the user runs before editing it should fail with a
 * readable "not found", not silently truncate a file.
 *
 * The terminal is a PowerShell session on Windows and bash everywhere else
 * (see `pickPlatformShell` in the service's persistent-shell), so the two
 * variants below are the two shells, not the three OSes — except where
 * revealing a folder in the desktop file manager differs on macOS vs Linux.
 */

export interface OsCommand {
  /** The exact line staged into the terminal input. */
  run: string;
  /** Plain-English, jargon-free explanation. */
  description: string;
}

export interface OsCommandGroup {
  title: string;
  items: OsCommand[];
}

function revealCommand(platform: string | undefined): OsCommand {
  if (platform === 'win32') {
    return { run: 'explorer .', description: 'Open this folder in File Explorer.' };
  }
  if (platform === 'darwin') {
    return { run: 'open .', description: 'Open this folder in Finder.' };
  }
  return { run: 'xdg-open .', description: 'Open this folder in your file manager.' };
}

function posixGroups(platform: string | undefined): OsCommandGroup[] {
  return [
    {
      title: 'Getting around',
      items: [
        { run: 'pwd', description: 'Show which folder you are in right now.' },
        { run: 'ls', description: 'List the files and folders here.' },
        {
          run: 'ls -la',
          description: 'List everything, hidden files included, with sizes and dates.',
        },
        { run: 'cd "folder-name"', description: 'Move into a folder.' },
        { run: 'cd ..', description: 'Go back up one folder.' },
        revealCommand(platform),
      ],
    },
    {
      title: 'Reading files',
      items: [
        { run: 'cat "file.txt"', description: 'Print a whole file to the screen.' },
        { run: 'head -n 20 "file.txt"', description: 'Show only the first 20 lines of a file.' },
        {
          run: 'tail -n 20 "file.txt"',
          description: 'Show only the last 20 lines — handy for logs.',
        },
      ],
    },
    {
      title: 'Making changes',
      items: [
        { run: 'mkdir "new-folder"', description: 'Create a new folder.' },
        { run: 'touch "notes.txt"', description: 'Create an empty file.' },
        { run: 'cp "file.txt" "copy.txt"', description: 'Copy a file.' },
        {
          run: 'mv "old-name.txt" "new-name.txt"',
          description: 'Rename a file, or move it elsewhere.',
        },
        { run: 'rm "file.txt"', description: 'Delete a file. There is no undo — be sure first.' },
      ],
    },
    {
      title: 'Finding things',
      items: [
        {
          run: 'grep -r "search text" .',
          description: 'Search every file here for a piece of text.',
        },
        {
          run: 'find . -name "*.md"',
          description: 'Find files by name, anywhere below this folder.',
        },
      ],
    },
    {
      title: 'Tracking your changes',
      items: [
        {
          run: 'git status',
          description: 'See what you have changed since the last saved version.',
        },
        { run: 'git diff', description: 'See the exact lines you changed.' },
        {
          run: 'git log --oneline -10',
          description: 'See the last ten saved versions, one per line.',
        },
        { run: 'git branch', description: 'List the branches and show which one you are on.' },
        { run: 'git pull', description: 'Bring in the latest changes from the shared copy.' },
      ],
    },
    {
      title: 'When you are stuck',
      items: [
        { run: 'clear', description: 'Wipe the screen clean and start fresh.' },
        {
          run: 'which node',
          description: 'Show where a tool is installed — or whether it is at all.',
        },
        { run: 'man ls', description: 'Read the manual for a command. Press q to leave it.' },
      ],
    },
  ];
}

function windowsGroups(platform: string | undefined): OsCommandGroup[] {
  return [
    {
      title: 'Getting around',
      items: [
        { run: 'pwd', description: 'Show which folder you are in right now.' },
        { run: 'ls', description: 'List the files and folders here.' },
        { run: 'ls -Force', description: 'List everything, hidden files included.' },
        { run: 'cd "folder-name"', description: 'Move into a folder.' },
        { run: 'cd ..', description: 'Go back up one folder.' },
        revealCommand(platform),
      ],
    },
    {
      title: 'Reading files',
      items: [
        { run: 'cat "file.txt"', description: 'Print a whole file to the screen.' },
        {
          run: 'Get-Content "file.txt" -TotalCount 20',
          description: 'Show only the first 20 lines of a file.',
        },
        {
          run: 'Get-Content "file.txt" -Tail 20',
          description: 'Show only the last 20 lines — handy for logs.',
        },
      ],
    },
    {
      title: 'Making changes',
      items: [
        { run: 'mkdir "new-folder"', description: 'Create a new folder.' },
        { run: 'New-Item -ItemType File "notes.txt"', description: 'Create an empty file.' },
        { run: 'Copy-Item "file.txt" "copy.txt"', description: 'Copy a file.' },
        {
          run: 'Move-Item "old-name.txt" "new-name.txt"',
          description: 'Rename a file, or move it elsewhere.',
        },
        {
          run: 'Remove-Item "file.txt"',
          description: 'Delete a file. There is no undo — be sure first.',
        },
      ],
    },
    {
      title: 'Finding things',
      items: [
        {
          run: 'Get-ChildItem -Recurse -File | Select-String -Pattern "search text"',
          description: 'Search every file here for a piece of text.',
        },
        {
          run: 'Get-ChildItem -Recurse -Filter "*.md"',
          description: 'Find files by name, anywhere below this folder.',
        },
      ],
    },
    {
      title: 'Tracking your changes',
      items: [
        {
          run: 'git status',
          description: 'See what you have changed since the last saved version.',
        },
        { run: 'git diff', description: 'See the exact lines you changed.' },
        {
          run: 'git log --oneline -10',
          description: 'See the last ten saved versions, one per line.',
        },
        { run: 'git branch', description: 'List the branches and show which one you are on.' },
        { run: 'git pull', description: 'Bring in the latest changes from the shared copy.' },
      ],
    },
    {
      title: 'When you are stuck',
      items: [
        { run: 'clear', description: 'Wipe the screen clean and start fresh.' },
        {
          run: 'Get-Command node',
          description: 'Show where a tool is installed — or whether it is at all.',
        },
        {
          run: 'Get-Help Get-ChildItem',
          description: 'Read the built-in help for a command.',
        },
      ],
    },
  ];
}

/**
 * The primer for the shell backing the terminal. `platform` is the service's
 * `process.platform` (from `/api/health` or the Electron preload bridge);
 * anything that isn't `win32` gets the bash set, which is the right default
 * when the platform hasn't resolved yet.
 */
export function osCommandGroups(platform: string | undefined): OsCommandGroup[] {
  return platform === 'win32' ? windowsGroups(platform) : posixGroups(platform);
}
