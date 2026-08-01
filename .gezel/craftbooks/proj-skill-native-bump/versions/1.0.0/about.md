Bump the pinned versions of gezel's native engine binaries (llama.cpp, sd-cpp, whisper.cpp, uv, ds4), push a build through CI, then fetch + eval the result. Use when the user says "update/bump the native binaries", "upgrade llama.cpp / the engines", "cut a native release", or names an engine to update.

Updates the upstream versions gezel pins for its native engines, drives a CI build, and validates the result: **pick versions → bump pins → build in CI → triage → fetch + eval.**

> Converted from `.claude\skills\native-bump\SKILL.md` (skill "native-bump").
> - 2 shell block(s) kept as prose (not statically convertible)