import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/schemas/app-models.ts',
    'src/browser.ts',
    'src/paths.ts',
    'src/schemas/index.ts',
    'src/schemas/mobile-provider.ts',
    'src/mobile/inference.ts',
    'src/runtime/index.ts',
    // `./local-loop` — the local-model turn loop the daemon's providers and
    // the portable runtime share. Off the main entry so its classes have one
    // identity per consumer and the UI never bundles it.
    'src/local-loop/index.ts',
    'src/kokoro/index.ts',
    'src/poppetje/index.ts',
    'src/markdown/index.ts',
    // `./native` ships the llama-cpp backend probe + bundled-engine
    // discovery used by BOTH the Electron supervisor (pre-spawn) AND
    // the service (boot-time, covers system-service launches where the
    // supervisor isn't in the picture). Lives in core so the supervisor
    // can statically import it: importing from @bendyline/gezel-service
    // would force electron-builder's pnpm walker to copy the service's
    // ~100 transitive deps into app.asar, conflicting with the canonical
    // service-bundle tree under app.asar.unpacked. The probe has no
    // runtime deps (only Node built-ins).
    'src/native/index.ts',
    // `./checks` — pure deliverable-check predicates shared by the gate
    // engine (service), the script stdlib (re-bundled into the sandbox
    // via @bendyline/gezel-sdk/checks), and the eval harness. Must stay
    // dependency-free.
    'src/checks/index.ts',
    // Parser-backed, presentation-only SVG sanitizer shared by service,
    // catalog ingestion, and the UI's final rendering boundary.
    'src/svg/index.ts',
    // `./eval` — the in-app eval runner's contract. Kept off the main entry
    // so its schemas stay out of the UI's startup bundle (see src/eval/index.ts).
    'src/eval/index.ts',
    // `./queue-status` — `GET /api/queues` wire shapes. Off the main entry for
    // the same reason as `./eval`: the UI only needs the types, and a
    // re-export would ship the zod schemas twice in its startup bundle (once
    // in `browser.js`, once in `schemas/index.js` via the client).
    'src/schemas/queue-status.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Entries share most of their code: the schemas, and the local loop that
  // both `./local-loop` and `./runtime` run. Unsplit, every entry carried its
  // own copy, which put the published tarball at 3.36 MB (budget 2.6 MB) and
  // gave a consumer of two entries two copies of each class. Shared modules
  // now live in chunks every entry imports.
  splitting: true,
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
