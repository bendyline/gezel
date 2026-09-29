/**
 * `@bendyline/gezel/eval` — the in-app eval runner's contract (harness
 * catalog, progress events, jobs, trials) and the scorecard-rule matrix.
 *
 * A subpath rather than the main barrel on purpose: core's schemas are
 * top-level zod calls a bundler cannot prove side-effect free, so anything
 * the main entry re-exports ships in the desktop UI's startup bundle. Only
 * the daemon, the harness, and the lazily loaded Benchmarks view need this.
 */
export * from './schemas.js';
export * from './results.js';
