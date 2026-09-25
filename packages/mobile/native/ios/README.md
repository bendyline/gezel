# iOS on-device providers

`GezelMobilePlugin` supports two explicitly selected providers. `llama-cpp` uses
the imported, selected GGUF; `apple-foundation-models` always uses
`SystemLanguageModel.default`. There is no provider fallback, cloud model, tool,
image, or structured-output path. FoundationModels is weak linked so the app
still starts on iOS 16.4–25 and reports the Apple provider unavailable.

The Apple adapter requires iOS 26 and checks the SDK's current availability on
each request. Reasons distinguish an ineligible device, disabled Apple
Intelligence, and a model not ready. The latter does **not** establish whether a
download is in progress. iOS manages model preparation; `prepareProvider` rejects
with `OS_MANAGED` and directs the person to Settings. See Apple's
[system model](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel)
and [model readiness](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason/modelnotready)
documentation.

Each generation creates a fresh role-preserving `Transcript` from persisted
messages. Apple admission is capped at 64 messages, 32 KiB UTF-8 input, 4096
context tokens, 1024 output tokens, 64 KiB output, and one minute. iOS 26.4+ uses
the SDK tokenizer with an output/formatting reserve; earlier versions use a
conservative byte-based admission estimate. History is rejected when too long,
never silently truncated. SDK stream snapshots must extend the prior prefix.
Cancellation requests cancel the Swift task, and the plugin remains busy until
`session.isResponding` becomes false. There is no SDK force-termination API; a
system operation that does not respond to cancellation keeps the shared gate
closed rather than allowing overlapping generation. iOS 26 streams expose no
terminal token count/stop reason, so normal completion reports `stop`; iOS 27
usage can identify the output-token cap. The SDK enforces the configured token
budget on both versions.

Both providers share one admission gate. Backgrounding, serious/critical thermal
state, and memory warnings cancel active work and release imported weights once
native work has stopped. Physical-device model admission compares the copied
file size plus a conservative reserve with `os_proc_available_memory()`. These
checks cannot guarantee an arbitrary GGUF will fit. Simulator processes do not
have an iOS dirty-memory allowance, so their separate developer path permits
only small test allocations. Simulator success is not physical-device memory,
thermal, battery, or model-quality validation.

The model inventory is limited to 100 entries and 1 MiB of metadata. Imports
validate a regular GGUF source, 4 GiB limit, free disk reserve, and actual copied
size. Removal renames a file to a tombstone, commits the inventory atomically,
then deletes it; startup recovery restores or discards that tombstone according
to the committed inventory. Removing a selected model clears selection without
choosing another model. No imported model path is accepted from JavaScript.

The shared `AppSmoke` scheme conditionally tests actual Apple streaming and
cancellation when the installed simulator/device reports support. Otherwise it
checks a reasoned unavailable result and verifies there is no fallback. It also
checks cross-provider serialization, llama generation, model release/removal,
and background availability. See [native test setup](../README.md) for fixture
generation and the dedicated-simulator command.
