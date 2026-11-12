import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * React Compiler leaves alone any function it cannot prove safe, silently.
 * A refactor that adds a `try/finally` or an inline `import()` to a component
 * turns its memoization off with no error anywhere. This check reads the
 * report `packages/ui/scripts/vite-react.ts` writes on each build and fails
 * when a component that must stay memoized stops compiling.
 *
 * - `all`: every function the compiler looked at in the file compiled.
 * - a list: those named functions compiled (the file may hold others that do not yet).
 *
 * Grow this list as components are restructured to compile; never shrink it
 * to make a build pass. The floor catches a broad regression (a config change
 * that compiles nothing) and sits well below the measured count on purpose.
 */
export const MUST_COMPILE = Object.freeze({
  'src/App.tsx': 'all',
  'src/views/home/HomeWorkshop.tsx': 'all',
  'src/components/use-chat-events.ts': 'all',
  'src/poppetje/Poppetje.tsx': 'all',
  'src/components/GezelIcon.tsx': 'all',
  'src/components/WorkingNotes.tsx': 'all',
  'src/components/ResponsiveAppShell.tsx': 'all',
  'src/components/ProjectTimeline.tsx': 'all',
  'src/components/ProjectChat.tsx': ['ProjectChat', 'ProjectChatBody'],
  'src/components/Sidebar.tsx': 'all',
  'src/components/chat-bubbles.tsx': [
    'MessageBubbleView',
    'RenderedMarkdownView',
    'ToolActivityList',
    'ToolHistoryExpando',
    'ReasoningExpando',
    'LiveReasoning',
    'LiveToolArgs',
    'StreamingStatusLine',
    'useElapsedSeconds',
    'useWaitedSeconds',
  ],
  'src/primitives/': 'all',
});

/** Compiled functions across the app build, measured at 627 on 2026-11-11. */
export const MIN_COMPILED = 450;

export function evaluateCompilerCoverage(report, mustCompile = MUST_COMPILE, floor = MIN_COMPILED) {
  const failures = [];
  if (report.compiled < floor) {
    failures.push(`only ${report.compiled} functions compiled (floor ${floor})`);
  }
  for (const [target, rule] of Object.entries(mustCompile)) {
    const files = Object.entries(report.files).filter(([file]) =>
      target.endsWith('/') ? file.startsWith(target) : file === target,
    );
    if (files.length === 0) {
      failures.push(`${target}: not in the compiler report`);
      continue;
    }
    for (const [file, outcome] of files) {
      if (rule === 'all') {
        if (outcome.compiled.length === 0) failures.push(`${file}: nothing compiled`);
        for (const skipped of outcome.skipped) {
          failures.push(
            `${file}:${skipped.line ?? '?'} ${skipped.fn} not compiled: ${skipped.reason}`,
          );
        }
        continue;
      }
      const compiled = new Set(outcome.compiled.map((entry) => entry.fn));
      for (const name of rule) {
        if (!compiled.has(name)) {
          const why = outcome.skipped.find((entry) => entry.fn === name)?.reason;
          failures.push(`${file}: ${name} not compiled${why ? `: ${why}` : ''}`);
        }
      }
    }
  }
  return failures;
}

async function main() {
  const reportPath = path.resolve(process.argv[2] ?? 'packages/ui/dist/react-compiler-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const fully = Object.values(report.files).filter(
    (outcome) => outcome.skipped.length === 0 && outcome.compiled.length > 0,
  ).length;
  process.stdout.write(
    `React Compiler: ${report.compiled} functions compiled, ${report.skipped} left as written; ` +
      `${fully} of ${Object.keys(report.files).length} files fully compiled\n`,
  );
  const failures = evaluateCompilerCoverage(report);
  if (failures.length > 0) {
    process.stderr.write(
      `React Compiler coverage failed:\n- ${failures.join('\n- ')}\nMove the construct the compiler refused (try/finally, for await, import()) into a module-level helper, or fix the rule it names.\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
