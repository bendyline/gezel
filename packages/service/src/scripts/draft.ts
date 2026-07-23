import type { ChatManager } from '../chat/manager.js';
import { readSdkTypes } from './sdk.js';
import { scaffoldScript } from './source.js';

/**
 * LLM-backed script drafting: "describe what this script should do" →
 * a complete TypeScript source. The prompt carries the real SDK
 * typings (same file Monaco gets) plus one exemplar, so drafts use the
 * actual API surface instead of hallucinated methods. Follows the
 * rewrite/generator.ts pattern.
 */
export async function draftScript(
  chat: ChatManager,
  opts: { name: string; description: string },
): Promise<string> {
  const types = await readSdkTypes();
  const sdkDts = types.files.map((f) => f.content).join('\n');
  const exemplar = scaffoldScript(
    'summarize-page',
    'Fetch a URL and summarize it in one paragraph.',
    'fetch-and-summarize',
  );

  const prompt = [
    'You write gezel automation scripts: small sandboxed TypeScript files that run when task phases start or finish.',
    '',
    '## Rules',
    `- The script MUST export a meta block: \`export const meta = defineScript({...})\` with name '${opts.name}', a description (min 10 chars), typed inputs/outputs, and a \`requires\` list naming every capability used.`,
    "- Capabilities: 'llm' for gezel.llm, 'network' for gezel.mcp.call/gezel.http, 'workspace.read'/'workspace.write' for gezel.fs, 'artifacts.*', 'documents.*', 'tasks.*' for gezel.task, 'memory.*', 'credential:<name>' for gezel.http.authed.",
    '- The script body runs top-level (ESM, top-level await is fine), reads `gezel.input`, and MUST call `gezel.output(...)` exactly once with an object matching the declared outputs.',
    '- Only erasable TypeScript syntax: NO enums, NO namespaces, NO parameter properties (the runtime strips types, it does not compile).',
    '- Import only from "@bendyline/gezel-sdk". No other imports, no Node built-ins.',
    '- Comment the non-obvious parts — the reader may not be a programmer.',
    '',
    '## The SDK (its exact typings)',
    '```typescript',
    sdkDts,
    '```',
    '',
    '## Example script',
    '```typescript',
    exemplar,
    '```',
    '',
    '## Task',
    `Write the complete source for a script named '${opts.name}' that does the following:`,
    '',
    opts.description.trim(),
    '',
    '## Output format',
    'Return ONLY the TypeScript source. No preamble, no explanation, no surrounding code fences.',
  ].join('\n');

  const raw = await chat.oneShotCompletion(prompt, 120_000, {
    useKlerk: true,
    jobLabel: `script-draft · ${opts.name}`,
  });
  const source = stripFences(raw).trim();
  if (!source.includes('defineScript') || !source.includes('export const meta')) {
    throw new Error('draft did not produce a valid script (missing meta block)');
  }
  return `${source}\n`;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:typescript|ts)?\n([\s\S]*?)\n```$/m.exec(trimmed);
  return fence?.[1] ?? trimmed;
}
