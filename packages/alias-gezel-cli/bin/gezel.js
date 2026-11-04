#!/usr/bin/env node
// `gezel-cli` is the short npm name for @bendyline/gezel-cli, so
// `npx gezel-cli` and `npm install -g gezel-cli` work.
// This hands over to that package's own command, found through its
// manifest's `bin` rather than an exported path: versions published before
// these short names existed export no bin path, and the manifest is always
// exported. The target's launcher checks the Node version before it loads
// anything else.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const manifest = createRequire(import.meta.url).resolve('@bendyline/gezel-cli/package.json');
const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
await import(new URL(bin.gezel, pathToFileURL(manifest)).href);
