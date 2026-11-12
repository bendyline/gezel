import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import type { Plugin, PluginOption } from 'vite';

/**
 * React and React Compiler for every Vite and Vitest config that renders the
 * UI's components (the app, its embedded and Office builds, the phone build
 * and the test suite), so the code tests run is the code that ships.
 *
 * The compiler memoizes components and hooks it can prove follow the rules of
 * React, and leaves any function it cannot prove alone (`panicThreshold:
 * 'none'`). Each build writes `react-compiler-report.json` beside its output:
 * which functions compiled, and why the others did not.
 * scripts/check-react-compiler-coverage.mjs holds the files that must compile.
 */

/** UI source the compiler covers. Tests and test helpers are left as written. */
const COMPILED_SOURCE = /[\\/]packages[\\/]ui[\\/]src[\\/].+\.[jt]sx?$/;
const NOT_COMPILED = [/\.test\.[jt]sx?$/, /[\\/]test-utils[\\/]/, /[\\/]node_modules[\\/]/];

interface FunctionOutcome {
  fn: string;
  line?: number;
  reason?: string;
}

interface FileOutcome {
  compiled: FunctionOutcome[];
  skipped: FunctionOutcome[];
}

const outcomes = new Map<string, FileOutcome>();

function outcomeFor(filename: string): FileOutcome {
  let outcome = outcomes.get(filename);
  if (!outcome) {
    outcome = { compiled: [], skipped: [] };
    outcomes.set(filename, outcome);
  }
  return outcome;
}

type Loc = { start?: { line?: number } } | null | undefined;

interface CompilerEvent {
  kind: string;
  fnName?: string | null;
  fnLoc?: Loc;
  reason?: string;
  detail?: {
    reason?: string;
    description?: string | null;
    loc?: Loc;
    primaryLocation?: () => Loc;
    options?: { reason?: string };
  };
  data?: string;
}

function reasonOf(event: CompilerEvent): string {
  const detail = event.detail;
  const reason =
    event.reason ?? detail?.reason ?? detail?.options?.reason ?? event.data ?? event.kind;
  // Where in the function the compiler stopped, which is what a reader needs to fix it.
  let at: number | undefined;
  try {
    at = detail?.loc?.start?.line ?? detail?.primaryLocation?.()?.start?.line;
  } catch {
    at = undefined;
  }
  const described = detail?.description ? `${reason} (${detail.description})` : reason;
  return `${at ? `line ${at}: ` : ''}${described}`.slice(0, 400);
}

const logger = {
  logEvent(filename: string | null, event: CompilerEvent) {
    if (!filename) return;
    const fn = event.fnName ?? '(anonymous)';
    const line = event.fnLoc?.start?.line;
    if (event.kind === 'CompileSuccess') {
      outcomeFor(filename).compiled.push({ fn, line });
    } else if (
      event.kind === 'CompileError' ||
      event.kind === 'CompileSkip' ||
      event.kind === 'PipelineError'
    ) {
      outcomeFor(filename).skipped.push({ fn, line, reason: reasonOf(event) });
    }
  },
};

function compilerPreset() {
  const preset = reactCompilerPreset({ target: '19', panicThreshold: 'none', logger } as never);
  preset.rolldown.filter = {
    ...preset.rolldown.filter,
    id: { include: [COMPILED_SOURCE], exclude: NOT_COMPILED },
  } as typeof preset.rolldown.filter;
  // Compile for every environment, Vitest's included, so tests run compiled code.
  preset.rolldown.applyToEnvironmentHook = () => true;
  return preset;
}

function compilerReport(root: string): Plugin {
  let outDir = 'dist';
  let building = false;
  return {
    name: 'gezel-react-compiler-report',
    configResolved(config) {
      outDir = config.build.outDir;
      building = config.command === 'build' && !process.env.VITEST;
    },
    buildStart() {
      outcomes.clear();
    },
    closeBundle() {
      if (!building) return;
      const files: Record<string, FileOutcome> = {};
      let compiled = 0;
      let skipped = 0;
      for (const [filename, outcome] of [...outcomes].sort(([a], [b]) => a.localeCompare(b))) {
        files[relative(root, filename).replaceAll('\\', '/')] = outcome;
        compiled += outcome.compiled.length;
        skipped += outcome.skipped.length;
      }
      const target = resolve(root, outDir, 'react-compiler-report.json');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify({ compiled, skipped, files }, null, 2)}\n`);
    },
  };
}

/** `react()` plus React Compiler, and the compiler report on builds. */
export function reactWithCompiler(root: string): PluginOption[] {
  return [react(), babel({ presets: [compilerPreset()] }), compilerReport(root)];
}
