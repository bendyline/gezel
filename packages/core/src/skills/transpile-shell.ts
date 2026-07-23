/**
 * ─ Static shell→gezel-script transpiler ──────────────────────────────
 *
 * Deterministically converts a *very small* shell subset into a
 * sandboxed gezel-sdk script — no LLM anywhere. A block converts only
 * when EVERY effectful line maps; one unmappable line rejects the whole
 * block (the caller keeps it as prose). The output follows the exact
 * skeleton the LLM translator is instructed to produce, so both
 * producers pass the same `validateScriptBody` gate service-side.
 *
 * Supported line forms (everything else → null):
 *   npm|pnpm|yarn run <script>     → gezel.mcp.call('run_package_script')
 *   npm|pnpm|yarn test|start|build → same, bare lifecycle script
 *   cat <relative-path>            → gezel.fs.read
 *   ls [<relative-path>]           → gezel.fs.list
 *   echo <text>                    → gezel.log
 *   pwd | which <x> | # comment    → dropped (no-op in the sandbox)
 *
 * Deliberately unsupported: arguments after the script name (their
 * semantics vary per runner), `npx`/`node` (arbitrary execution), git
 * (no MCP tool in the translated-script contract), redirects/pipes/
 * substitution (callers should pre-triage with `triageShellBlock`, but
 * the transpiler independently rejects them).
 */

const RUN_SCRIPT = /^(?:npm|pnpm|yarn)\s+run\s+([a-z0-9:_.-]+)$/i;
const LIFECYCLE = /^(?:npm|pnpm|yarn)\s+(test|start|build)$/i;
const CAT = /^cat\s+(\S+)$/;
const LS = /^ls(?:\s+(\S+))?$/;
const ECHO = /^echo\s+(.+)$/;
const NOOP = /^(?:pwd|which\s+\S+)$/;
const SHELL_META = /[|&;<>`$(){}*?!\\]/;

interface Emitted {
  code: string;
  usesFs: boolean;
  effectful: boolean;
}

export function transpileShellBlock(code: string, scriptName: string): { body: string } | null {
  const emitted: Emitted[] = [];
  for (const rawLine of code.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const mapped = mapLine(line);
    if (mapped === null) return null;
    emitted.push(mapped);
  }
  const effectful = emitted.filter((e) => e.effectful);
  if (effectful.length === 0) return null;

  const usesFs = effectful.some((e) => e.usesFs);
  const requires = usesFs ? "['workspace.read']" : '[]';
  const body = [
    "import { defineScript, gezel } from '@bendyline/gezel-sdk';",
    '',
    'export const meta = defineScript({',
    `  name: '${scriptName}',`,
    "  description: 'Statically converted from a shell block in the source skill.',",
    '  inputs: {},',
    "  outputs: { summary: { type: 'string', description: 'What ran, in order.' } },",
    `  requires: ${requires},`,
    '});',
    '',
    'async function main(): Promise<void> {',
    '  const summary: string[] = [];',
    ...effectful.map((e) => `  ${e.code}`),
    "  gezel.output({ summary: summary.join('\\n') || 'ok' });",
    '}',
    '',
    'await main();',
    '',
  ].join('\n');
  return { body };
}

function mapLine(line: string): Emitted | null {
  if (NOOP.test(line)) return { code: '', usesFs: false, effectful: false };

  const run = RUN_SCRIPT.exec(line) ?? LIFECYCLE.exec(line);
  if (run) {
    const script = run[1]!.toLowerCase();
    return {
      code: `await gezel.mcp.call('run_package_script', { script: ${JSON.stringify(script)} }); summary.push(${JSON.stringify(`ran package script "${script}"`)});`,
      usesFs: false,
      effectful: true,
    };
  }

  const cat = CAT.exec(line);
  if (cat && isSafeRelativePath(cat[1]!)) {
    return {
      code: `summary.push(\`--- ${cat[1]!} ---\`); summary.push(await gezel.fs.read(${JSON.stringify(cat[1]!)}));`,
      usesFs: true,
      effectful: true,
    };
  }

  const ls = LS.exec(line);
  if (ls && (ls[1] === undefined || isSafeRelativePath(ls[1]))) {
    const target = ls[1] ?? '.';
    return {
      code: `summary.push((await gezel.fs.list(${JSON.stringify(target)})).join('\\n'));`,
      usesFs: true,
      effectful: true,
    };
  }

  const echo = ECHO.exec(line);
  if (echo && !SHELL_META.test(echo[1]!)) {
    const text = echo[1]!.replace(/^['"]|['"]$/g, '');
    return {
      code: `gezel.log(${JSON.stringify(text)}); summary.push(${JSON.stringify(text)});`,
      usesFs: false,
      effectful: true,
    };
  }

  return null;
}

function isSafeRelativePath(p: string): boolean {
  return (
    !p.startsWith('/') &&
    !p.startsWith('~') &&
    !p.includes('..') &&
    !SHELL_META.test(p) &&
    !p.includes(':')
  );
}
