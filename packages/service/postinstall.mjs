#!/usr/bin/env node
import { existsSync } from 'node:fs';

// Source checkouts can install before `pnpm build` has created dist/. Packed
// releases always contain this entry; defer to it when present and otherwise
// let the later build (and the repository root hook) handle the workspace.
const builtEntry = new URL('./dist/postinstall.js', import.meta.url);
if (existsSync(builtEntry)) await import(builtEntry.href);
