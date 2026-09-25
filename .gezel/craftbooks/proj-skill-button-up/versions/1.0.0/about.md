Shepherd the local branch to a fully green state — install missing dependencies (pnpm deps:install), make lint pass (pnpm lint), then run every build and test (pnpm all), fixing whatever fails and re-running until all three pass back to back with no edits in between. If the branch has an open PR, also triages its failing GitHub CI checks and fixes them locally. Use when the user says "button up", "button it up", "get the branch green", or "make everything pass before I commit".

Take the current branch plus its uncommitted changes and leave it in a state
the user can commit with confidence: dependencies installed, lint clean, and
`pnpm all` (build, typecheck, lint, unit, published, e2e, bundle, coverage)
green. You find the failures, fix them at the root, and keep cycling until a
full pass needs no further edits.

If the branch has an open pull request, its GitHub CI is part of the job
too: every failing check must end up with a local fix.

**Origin does not matter.** Fix every failure a gate or check reports,
whoever caused it: this session, another session, the user, an earlier
commit, or `main`. "Pre-existing", "not introduced here", "was already
red", and "platform-only" describe a failure; none of them is a reason to
leave it failing. The only failures you may leave are the few that need a
decision only the user can make (see The loop), and you still diagnose
those as far as you can.

The gates, in order:

| Gate | Command | What it proves |
|---|---|---|
| PR | `gh pr checks` | the pushed branch's CI failures are understood and fixed locally |
| A | `pnpm deps:install` | `node_modules` matches the lockfile |
| B | `pnpm lint` | biome + every repo guard script (paths, module size, layer direction, patient-fetch, markdown links, NOTICE, audit) |
| C | `pnpm all` | the full validation chain in `validate:unlocked` plus coverage |

> Converted from `.claude/skills/button-up/SKILL.md` (skill "button-up").
> - 1 shell block(s) kept as prose (not statically convertible)
> - frontmatter keys not mapped: disable-model-invocation