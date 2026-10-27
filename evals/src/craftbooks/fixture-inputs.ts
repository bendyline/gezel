import type { LoadedCraftbookTestSpec } from './test-spec-loader.ts';

/**
 * Sidecar versions this correction was checked against. 1.0.5 (gilde 0.3.1)
 * changed only step prompts and shipped the 1.0.4 sidecar byte-for-byte.
 */
const CORRECTED_CODEMOD_SWEEP_VERSIONS = new Set(['1.0.4', '1.0.5']);

/**
 * Compatibility correction for the pinned codemod-sweep sidecar.
 * Its log helper is execution scaffolding, contains no rename targets, and
 * must stay byte-for-byte unchanged. Opening it is not part of the task.
 * Gilde should mark this fixture modelInput:false in its next sidecar version;
 * keep the correction here so the installed catalog need not be modified.
 * Version, content and invariant guards prevent exempting future source inputs.
 */
export function evalFixtureInputs({ craftbookId, version, spec }: LoadedCraftbookTestSpec) {
  return spec.setup.files?.map((file) =>
    craftbookId === 'codemod-sweep' &&
    CORRECTED_CODEMOD_SWEEP_VERSIONS.has(version) &&
    file.path === 'src/log.js' &&
    file.content ===
      'export const lines = [];\n\nexport function logLine(line) {\n  lines.push(line);\n}\n' &&
    file.modelInput === undefined &&
    (file.surface === undefined || file.surface === 'workspace') &&
    spec.success.unchangedFixtures?.includes(file.path)
      ? { ...file, modelInput: false }
      : file,
  );
}
