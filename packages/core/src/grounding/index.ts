/**
 * `./grounding` — the factual-writing citation check (see
 * docs/factual-writing.md): parse `[n]` markers and check each sentence's
 * names, dates, numbers and quotations against the evidence it was given.
 * Model-free and dependency-free, so an app can run it on every draft; off
 * the main entry so it does not pull in the rest of core.
 */
export * from './citations.js';
