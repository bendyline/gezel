---
name: craftbook-simulator-builder
description: Build deterministic fake CLIs, MCP servers, HTTP fixtures, native-output stubs, and seeded datasets for craftbook evals. Use when a craftbook depends on external tools, third-party APIs, credentials, live data, or side effects that must be emulated inside the eval harness.
---

# Craftbook Simulator Builder

Use this skill when a craftbook cannot be evaluated honestly with static files alone.

## Simulator Choice

- **Seeded data files**: best for documents, CSVs, logs, images indexes, or reports. Inline small fixtures in the scenario file; use fixture directories only when data is large.
- **Project-local CLI**: best for scripts the model must call or generate against. Seed an executable fixture script in setup and assert its output from `successCheck`.
- **HTTP fixture server**: best for scrape/API craftbooks. Start it inside the scenario or success checker, bind loopback only, and keep responses deterministic.
- **MCP fixture server**: best when the craftbook’s value is tool routing. Expose the smallest fake tool surface that represents the external system.
- **Browser/Playwright fixture**: best for UI, forms, dashboards, games, and browser QA. Assert behavior, not only DOM words.

## Rules

1. Keep the simulator inside the trial. No real network, credentials, cloud services, or user machine state.
2. Make state transitions explicit. If the fake service can pass, fail, timeout, or return bad data, encode that as fixture mode and assert each mode in unit tests.
3. Give the model realistic affordances, not the answer. A fake API should look like the real class of API but must not leak the expected final output.
4. Record simulator plans in `evals/src/craftbooks/specs.ts` under `setup.simulators`.
5. Promote a simulator from `planned` to `implemented` only when the scenario uses it and tests cover the happy path plus at least one failure mode.

## Harness Pattern

- Seed simulator files in the scenario `setup`.
- Run or query the simulator from `successCheck`.
- Report one concrete failure at a time through the trial log and, when useful, `postSniffFeedback`.
- Snapshot outputs into the run directory through the existing eval runner; do not write separate ad hoc reports.

## Validation

Run focused tests before a local-model trial:

```sh
pnpm --filter @bendyline/gezel-evals test -- <scenario-or-simulator>
pnpm --filter @bendyline/gezel-evals run craftbook:coverage
```
