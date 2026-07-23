import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/paths.ts',
    'src/schemas/index.ts',
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
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
});
