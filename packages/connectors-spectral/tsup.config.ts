import { defineConfig } from 'tsup';

const prismaticLegalBanner = `/*!
 * Includes modified portions of prismatic-io/components, licensed under
 * Apache-2.0 and modified by Bendyline for off-platform use in Gezel.
 * See ../NOTICE.md and ../THIRD_PARTY_LICENSES/Apache-2.0.txt.
 */`;

export default defineConfig({
  entry: ['src/index.ts', 'src/run-action.ts'],
  format: ['cjs'],
  target: 'node18',
  // No `dts`. Nothing type-imports this package: the service resolves
  // `run-action` and SPAWNS it. Declaration emit would also have to name
  // types out of the vendored components' transitive axios, which is not
  // portable.
  clean: true,
  // Apache-2.0 section 4(b) requires the modified object-form files we ship
  // to carry a prominent change notice. Put it in every compiled entry point;
  // NOTICE.md carries the detailed per-component provenance.
  banner: { js: prismaticLegalBanner },
  // Bundle the vendored components + shims; keep spectral external (resolved
  // from this package's own node_modules at runtime).
  external: ['@prismatic-io/spectral'],
  // Dynamic import: this package is CJS (no `"type": "module"`), so a static
  // import of the ESM-only strip script is a `require` of an ES module.
  onSuccess: async () => {
    const { stripSourcemapCommentsFromBuild } = await import(
      '../../scripts/strip-sourcemap-comments.mjs'
    );
    await stripSourcemapCommentsFromBuild();
  },
});
