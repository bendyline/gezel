For the engine smoke test, copy the generated `ios-fixture.gguf` from the pinned
native host contract build into this directory. It is a tiny synthetic model for
runtime contract checks, not a model quality benchmark. Without it, only the
generation smoke test skips; the lifecycle and bridge tests still run.
