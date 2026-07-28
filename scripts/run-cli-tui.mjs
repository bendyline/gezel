#!/usr/bin/env node

// Set developer mode in-process so this launcher works in POSIX shells,
// cmd.exe, and PowerShell. The CLI resolves developer mode to ~/.gezel-dev.
process.env.GEZEL_DEV = '1';

await import('../packages/cli/dist/bin/gezel.js');
