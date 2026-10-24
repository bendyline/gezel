#!/usr/bin/env node
// Writes packages/mcp/src/harness/docblocks-tools.json: the schemas of the
// DocBlocks tools outside apps get through Gezel (HARNESS_DOCUMENT_TOOL_NAMES
// in core), read from the DocBlocks the service ships. The harness lists them
// at startup without starting DocBlocks. Run after bumping the DocBlocks pin
// (build core first); documents-snapshot.test.ts fails until you do.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromService = createRequire(join(repo, 'packages/service/package.json'));
const fromMcp = createRequire(join(repo, 'packages/mcp/package.json'));
const packageFile = fromService.resolve('@bendyline/docblocks-cli/package.json');
const { version } = JSON.parse(readFileSync(packageFile, 'utf8'));
const entry = join(dirname(packageFile), 'dist/bin.js');

const load = (specifier) => import(pathToFileURL(fromMcp.resolve(specifier)).href);
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await load('@modelcontextprotocol/sdk/client/stdio.js');
const { HARNESS_DOCUMENT_TOOL_NAMES } = await import(
  pathToFileURL(join(repo, 'packages/core/dist/index.js')).href
);

const client = new Client({ name: 'gezel-docblocks-snapshot', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'] }));
const { tools } = await client.listTools();
await client.close();

const picked = HARNESS_DOCUMENT_TOOL_NAMES.map((name) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`DocBlocks ${version} has no tool named ${name}.`);
  return {
    name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
});
const out = join(repo, 'packages/mcp/src/harness/docblocks-tools.json');
writeFileSync(out, `${JSON.stringify({ docblocksVersion: version, tools: picked }, null, 2)}\n`);
spawnSync(
  process.execPath,
  [join(repo, 'node_modules/@biomejs/biome/bin/biome'), 'format', '--write', out],
  {
    stdio: 'inherit',
  },
);
console.log(`Wrote ${picked.length} DocBlocks ${version} tool schemas to ${out}`);
