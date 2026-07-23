import type { ChatManager } from '../chat/manager.js';

/**
 * ─ Skill bash → gezel JS translator ─────────────────────────────────
 *
 * Imported SKILL.md bodies often contain shell scriptlets that gezel
 * can't run directly. This module turns a *narrow, deterministically
 * safe* subset of those into gezel-sdk JS scripts that a craftbook step
 * can run via `onExit`. Everything risky is left as prose with an
 * advisory — arbitrary bash is NEVER auto-executed, and NEVER even sent
 * to the model for translation.
 *
 * Flow: extract fenced shell blocks → deterministic triage (pre-LLM) →
 * LLM translate the simple ones → validate the output statically →
 * confidence gate. The result is a *pending proposal* the user reviews
 * before anything is written to disk (see import-sync + the approve route).
 */

export interface ExtractedShellBlock {
  lang: string;
  code: string;
}

/** Pull fenced ```bash|sh|shell|zsh blocks out of a markdown body. */
export function extractShellBlocks(body: string): ExtractedShellBlock[] {
  const re = /```(bash|sh|shell|zsh)\b[^\n]*\n([\s\S]*?)```/gi;
  const out: ExtractedShellBlock[] = [];
  for (const m of body.matchAll(re)) {
    const code = (m[2] ?? '').trim();
    if (code) out.push({ lang: (m[1] ?? 'sh').toLowerCase(), code });
  }
  return out;
}

/** Commands we consider safe to translate (read-only / build / test). */
const SAFE_COMMAND_PREFIXES = [
  /^npm\b/,
  /^pnpm\b/,
  /^yarn\b/,
  /^npx\b/,
  /^node\b/,
  /^git\s+(status|log|diff|branch|rev-parse|show|remote)\b/,
  /^ls\b/,
  /^cat\b/,
  /^echo\b/,
  /^pwd\b/,
  /^which\b/,
  /^tsc\b/,
  /^vitest\b/,
  /^jest\b/,
  /^playwright\b/,
];

/** Anything matching these is never eligible, regardless of the command. */
const RISKY_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bsudo\b/,
  /\bwget\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bmv\b/,
  /\bgit\s+(push|reset|clean|checkout|rebase|commit)\b/,
];

/** Shell metacharacters that put a line out of scope for safe translation. */
const SHELL_META = /[|&;<>`$(){}]/;

/**
 * Classify a shell block. `simple` blocks (a few lines, each a single
 * known-safe command with no pipes/redirects/substitution) are eligible
 * for translation; everything else is `risky` and stays prose.
 */
export function triageShellBlock(code: string): 'simple' | 'risky' {
  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0 || lines.length > 5) return 'risky';
  for (const line of lines) {
    if (SHELL_META.test(line)) return 'risky';
    if (RISKY_PATTERNS.some((p) => p.test(line))) return 'risky';
    if (!SAFE_COMMAND_PREFIXES.some((p) => p.test(line))) return 'risky';
  }
  return 'simple';
}

/** Capabilities a translated script is allowed to declare. Never write/network. */
const SAFE_REQUIRES = new Set(['workspace.read', 'llm']);

const CONFIDENCE_FLOOR = 0.7;

/**
 * Statically validate a translated script body. Conservative on purpose:
 * the only import allowed is the SDK, no node builtins / child_process /
 * eval, must define `meta` + call `gezel.output`, and any declared
 * `requires` must be in the safe allowlist.
 */
export function validateScriptBody(body: string): boolean {
  if (!/from\s+['"]@bendyline\/gezel-sdk['"]/.test(body)) return false;
  if (!/export\s+const\s+meta\s*=\s*defineScript\(/.test(body)) return false;
  if (!/gezel\.output\(/.test(body)) return false;
  // Only the SDK may be imported.
  for (const m of body.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (m[1] !== '@bendyline/gezel-sdk') return false;
  }
  if (/\b(require|eval|child_process)\b|node:|process\.env\s*\[/.test(body)) return false;
  const reqMatch = body.match(/requires\s*:\s*\[([^\]]*)\]/);
  if (reqMatch) {
    const tokens = [...(reqMatch[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    if (!tokens.every((t) => SAFE_REQUIRES.has(t))) return false;
  }
  return true;
}

/** Parse the model's response into a `{ body, confidence }` pair, or null. */
export function parseTranslation(raw: string): { body: string; confidence: number } | null {
  const codeMatch = raw.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/i);
  if (!codeMatch) return null;
  const body = (codeMatch[1] ?? '').trim();
  if (!body) return null;
  const confMatch = raw.match(/CONFIDENCE\s*[:=]\s*(0?\.\d+|1(?:\.0+)?|0)/i);
  const confidence = confMatch ? Number(confMatch[1]) : 0;
  return { body, confidence };
}

function buildTranslationPrompt(skillName: string, scriptName: string, code: string): string {
  return [
    `You are translating a shell scriptlet from a project "skill" named "${skillName}" into a gezel JS (TypeScript) script.`,
    '',
    'The script MUST follow this exact shape and constraints:',
    '',
    "  import { defineScript, gezel } from '@bendyline/gezel-sdk';",
    '',
    '  export const meta = defineScript({',
    `    name: '${scriptName}',`,
    '    description: "<one sentence, at least 10 chars>",',
    '    inputs: {},',
    '    outputs: { summary: { type: "string", description: "..." } },',
    "    requires: ['workspace.read'],",
    '  });',
    '',
    '  async function main(): Promise<void> {',
    '    // Use ONLY gezel.mcp.call(...) to run work. The only tool you may call is',
    "    // run_package_script (npm/pnpm scripts): gezel.mcp.call('run_package_script', { script: 'test' }).",
    '    // You may use gezel.input, gezel.output, gezel.log. No filesystem, no network,',
    '    // no child_process, no other imports.',
    '    gezel.output({ summary: "..." });',
    '  }',
    '',
    '  await main();',
    '',
    'Rules:',
    "- requires may ONLY contain 'workspace.read' and/or 'llm'. Never workspace.write or network.",
    '- If the snippet cannot be faithfully and safely expressed with run_package_script alone,',
    '  do NOT invent behavior — respond with CONFIDENCE: 0 and an empty code block.',
    '',
    'Shell snippet to translate:',
    '```sh',
    code,
    '```',
    '',
    'Respond with a single fenced ```ts code block containing the script, then a line:',
    'CONFIDENCE: <number between 0 and 1>',
  ].join('\n');
}

/**
 * Translate one simple shell block to a gezel-sdk script. Returns null on
 * any failure (LLM error, unparseable output, validation failure, or
 * confidence below the floor) so the caller falls back to prose.
 */
export async function translateShellBlock(
  chat: ChatManager,
  skillName: string,
  scriptName: string,
  code: string,
): Promise<{ body: string; confidence: number } | null> {
  let raw: string;
  try {
    raw = await chat.oneShotCompletion(
      buildTranslationPrompt(skillName, scriptName, code),
      120_000,
      {
        useKlerk: true,
        jobLabel: `skill-translate · ${skillName}`,
      },
    );
  } catch {
    return null;
  }
  const parsed = parseTranslation(raw);
  if (!parsed) return null;
  if (parsed.confidence < CONFIDENCE_FLOOR) return null;
  if (!validateScriptBody(parsed.body)) return null;
  return parsed;
}
