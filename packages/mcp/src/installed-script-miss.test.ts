import { describe, expect, it } from 'vitest';
import {
  installedScriptMissHint,
  isPathShapedScriptName,
  scriptFileCandidates,
} from './installed-script-miss.js';

describe('scriptFileCandidates', () => {
  it('maps a bare name onto the usual script locations, root first', () => {
    const candidates = scriptFileCandidates('clean_data');
    expect(candidates[0]).toBe('clean_data.mjs');
    expect(candidates).toContain('scripts/clean_data.mjs');
    expect(candidates).toContain('scripts/clean_data.ts');
  });

  it('does not double an extension and refuses path-shaped names', () => {
    expect(scriptFileCandidates('derive.mjs')).toContain('scripts/derive.mjs');
    expect(scriptFileCandidates('derive.mjs')).not.toContain('derive.mjs.mjs');
    expect(scriptFileCandidates('scripts/derive')).toEqual([]);
  });
});

describe('installedScriptMissHint', () => {
  it('names the exact run_nodejs_script call for a file the model wrote', () => {
    const hint = installedScriptMissHint({
      name: 'clean_data',
      written: 'scripts/clean_data.mjs',
      canRunFiles: true,
      canDerive: true,
    });
    expect(hint).toContain('run_nodejs_script({ path: "scripts/clean_data.mjs" })');
    expect(hint).toContain('will fail the same way');
  });

  it('never names a tool the session lacks', () => {
    const hint = installedScriptMissHint({
      name: 'clean_data',
      written: 'scripts/clean_data.mjs',
      canRunFiles: false,
      canDerive: false,
    });
    expect(hint).not.toContain('run_nodejs_script');
    expect(hint).not.toContain('derive_file');
    expect(hint).toContain('not an installed script');
  });

  it('names the path the model passed when the name is a file path', () => {
    expect(isPathShapedScriptName('derive_customers.mjs')).toBe(true);
    expect(isPathShapedScriptName('clean_data')).toBe(false);
    const hint = installedScriptMissHint({
      name: 'scripts/derive_customers.mjs',
      canRunFiles: true,
      canDerive: true,
      canWriteFiles: true,
    });
    expect(hint).toContain('looks like a file path');
    expect(hint).toContain('run_nodejs_script({ path: "scripts/derive_customers.mjs" })');
    expect(hint).not.toContain('derive_file');
  });

  // A harness repair turn keeps run_installed_script but not run_nodejs_script,
  // and this process only knows the session roster, so the hint must end on a
  // step every file-repair surface allows.
  it('always ends on a direct write when the session can write files', () => {
    const clamped = installedScriptMissHint({
      name: 'check_customers.mjs',
      canRunFiles: true,
      canDerive: false,
      canWriteFiles: true,
    });
    expect(clamped).toContain('If run_nodejs_script is not in your tool list this turn');
    expect(clamped).toContain('write_file');
    const writeOnly = installedScriptMissHint({
      name: 'check_customers.mjs',
      canRunFiles: false,
      canDerive: false,
      canWriteFiles: true,
    });
    expect(writeOnly).not.toContain('run_nodejs_script');
    expect(writeOnly).toContain('Write the output file directly with write_file instead.');
  });

  it('offers the available alternatives when no file matches', () => {
    const hint = installedScriptMissHint({
      name: 'derive',
      canRunFiles: false,
      canDerive: true,
    });
    expect(hint).toContain('derive_file');
    expect(hint).not.toContain('run_nodejs_script');
  });
});
