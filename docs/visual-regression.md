# Browser visual regression

`pnpm test:e2e:visual` compares the rendered UI with reviewed PNG baselines.
The [visual workflow](../.github/workflows/visual-regression.yml) runs on pull
requests, pushes to main, and daily. A missing baseline, changed image, failed
content assertion, or clipped capture fails the job. Ordinary runs use
`updateSnapshots: 'none'`; they never approve their own output.

## Coverage

The [visual scenarios](../packages/app/e2e-visual/surfaces.spec.ts) currently
enforce 18 images across three Chromium projects:

| Surface | States | Sizes |
| --- | --- | --- |
| Handboek | Loaded welcome article, light and dark | 1440×900, 820×900, 390×844 |
| Chat composer | Typed draft, light and dark | All three |
| New Project | Starting-point gallery and General configuration | All three |

Phone tests use touch/mobile emulation and collapse the ordinary sidebar
before reading Handboek or composing. Captures cover the named component;
they do not certify the entire shell. Every captured component must fit in
the viewport. Handboek must have its selected navigation entry, article
heading, parsed prose, and decoded inline images before capture. Additional
[browser tests](../packages/app/e2e-web/handboek.spec.ts) hold the article
request open to exercise loading and verify navigation replaces the prose.

The broader `pnpm test:e2e:web:run` suite still provides behavioral assertions
and a diagnostic gallery. Its settings, engine, task, history, terminal,
document, and other screenshots are **not yet baseline comparisons**. Expand
the visual scenarios with stable data and explicit readiness checks when
promoting those areas. The image gate detects changes to reviewed states;
it cannot establish that every untested state is correct.

## Renderer and repeatability

Baselines live in [e2e-visual/snapshots](../packages/app/e2e-visual/snapshots/).
The canonical renderer is **macOS 26 ARM64**, with the Chromium revision
provided by the lockfile's Playwright (initial baselines: 1.61.1).
CI selects the explicit `macos-26` runner label, which GitHub documents as
[the standard ARM64 runner](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/).
Linux and Windows continue to run the portable behavioral suite; comparing
their font rasterization against macOS images is not supported. Adding a
platform requires its own reviewed baselines and a CI runner exercising them.

The real built UI and daemon run against temporary seeded homes with the
mock provider. Background scheduling is disabled. The browser fixes its
clock, random seed, locale, timezone, color profile, and animations, and
waits for fonts. Baselines use CSS-pixel scale; the diagnostic gallery retains
device-pixel scale. The comparison allows at most 100 differing pixels with
Playwright's 0.2 per-pixel color threshold. Do not increase this allowance to
hide changed layout or missing content. Existing volatile masks cover engine
and quota telemetry; the current component captures do not include those
regions. Product content must remain visible in the comparison.

## Running and reviewing changes

Build the workspace first. With the existing dependencies and Chromium
available, these commands do not install or update anything:

```bash
pnpm build
pnpm test:e2e:visual
pnpm test:e2e:visual -- --project=phone
```

If dependencies or Chromium are missing, follow the repository's explicit
dependency-install authorization policy. For an intentional UI change, on
the canonical renderer:

```bash
pnpm test:e2e:visual -- --project=phone --update-snapshots
pnpm test:e2e:visual -- --repeat-each=3
```

Inspect every changed PNG, including dark and phone variants, before
committing it alongside its source change. Check real article content,
readability, overflow, controls, and focus states. A stable loading screen
or a blank component is not an acceptable baseline. Keep readiness
assertions when updating images. Browser/OS/font upgrades also require
review; do not use CI to automatically replace the baseline tree.

Failures include expected/actual/diff images and traces in
`packages/app/visual-test-results/`, plus an HTML report in
`packages/app/visual-report/`. CI uploads those with the diagnostic gallery.
Both suites also write `packages/app/ux-screenshots/manifest.json` and
`INDEX.md`; run them sequentially when retaining that gallery. Phone and
tablet frames have distinct keys and filenames, so they cannot overwrite
desktop frames. Under the visual configuration, every `shot()` performs a
`toHaveScreenshot` assertion automatically. The manifest's `regression` flag
and the index badges distinguish baseline comparisons from gallery-only frames.
