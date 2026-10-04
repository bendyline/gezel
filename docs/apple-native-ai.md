# Apple-native AI on macOS

Investigation: 2026-10-04. Scope: desktop parity with Gezel's iOS Foundation
Models integration, and the suitability of Apple's native APIs as additional
local inference options. Includes implementation work and a repeatable live
probe. The new native release has not yet been built/published/pinned; this is
not a comparative model benchmark.

## Recommendation

Ship `apple-foundation-models` as an optional **Apple on-device AI** choice.
The native build/payload, readiness UI, and runtime hardening are now wired.
Its Swift generation and tool code is shared with iOS, and the desktop path
works on this Mac. This provides
a useful development host for mobile model behavior without requiring an iOS
build for every prompt or tool-schema change.

Keep MLX and llama.cpp for model selection, larger contexts, coding, and more
demanding agent work. Evaluate **Core AI** separately as a future engine for
downloadable models. Foundation Models is now also a session API usable by
other engines; using that API does not imply using Apple's system model.

## What was verified locally

The host reports macOS **27.0.1 (26A434)**, arm64, with Xcode selected at
`/Applications/Xcode.app` and Swift **6.4**. The existing
[helper build](../native/helpers/apple-fm/build.sh) compiled successfully and
its model-independent tool-schema self-test passed.

The running `SystemLanguageModel.default` reports:

| Property | Observed value |
| --- | --- |
| Availability | Available in the logged-in user's session |
| Context window | **8,192 tokens** |
| Native tool calling | Supported |
| Guided generation | Supported |
| Vision | Supported by the model; not exposed by Gezel's current adapter |
| Reasoning capability | Not advertised |
| Gezel output cap | 1,024 tokens, an adapter policy rather than an Apple model specification |

Capabilities were read directly from the installed macOS 27 SDK/runtime;
they are not claims about every eligible Mac or iPhone. Some Apple articles
still describe a 4K on-device context. Continue reading `contextSize` at
runtime and record it with results. Do not replace it with an OS-version table.
Apple documents both [runtime context discovery](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize)
and [model changes across OS releases](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel).

The new [live smoke probe](../native/helpers/apple-fm/smoke.ts) passed all nine
checks using the real TypeScript helper transport and shared Swift adapter:

| Check | Observed result |
| --- | --- |
| Availability | Ready; 8,192-token context |
| Token counting with tools | 26 tokens without the tool, 130 with it |
| Streaming text | 10 chunks; first chunk about 692 ms; completion about 838 ms; 65 input / 29 output tokens |
| Conversation replay | Recalled “orchid” from the supplied prior turns |
| Native tool round trip | Called `lookup_parcel` with `parcel: blue`, then returned the synthetic code 4729; about 993 ms total; 175 input / 17 output tokens |
| Terminal tool | One call, clean stop, no subsequent answer |
| Context admission | Rejected an oversized request with `CONTEXT_LIMIT` |
| Cancellation and reuse | Cancelled after streaming began; the next request completed |
| Desktop provider session | Real provider discovery, transcript replay and usage event; 91 input / 15 output tokens, 8,192 context |

These are single-run functional measurements with synthetic inputs. They do
not measure sustained throughput, energy use, peak system memory, task quality,
or relative performance against MLX/llama.cpp. The cancellation probe even
began with refusal-like prose about a benign story request; its pass checks
cancellation and recovery, not answer quality. No production project data or
real tool side effects were used. Focused tests passed: **18** helper/provider/
readiness tests, **54** Settings/component tests, **14** model API and machine
boundary tests, **18** client tests, and **26** native payload/manifest tests.
Core and client builds and service/UI typechecks passed. Shared Swift compiled
for Mac and iOS device/simulator; the binary preserves macOS 13.3's native
deployment floor, weak-links Foundation Models, and has no absolute rpath.
The repository-wide module-size check still fails on the existing
`packages/service/src/tasks/manager.ts` ceiling (4,875 lines vs 4,650); that
unrelated module was not edited here.

Reproduce from the repository root:

```sh
native/helpers/apple-fm/build.sh
bash native/helpers/apple-fm/check-mobile.sh
node scripts/run-with-dependency-lease.mjs --direct-node native/helpers/apple-fm/smoke.ts
```

The compiler and inference need access to normal Xcode caches and Apple's
system services; the successful runs here used the logged-in user outside
the agent's command sandbox. This is not a test of the macOS App Sandbox.

## Existing implementation and parity gaps

| Area | Current implementation / remaining gap |
| --- | --- |
| Shared Apple adapter | [AppleFoundationProvider.swift](../native/runtime/ios/Sources/GezelRuntime/AppleFoundationProvider.swift) builds transcripts, counts tokens, budgets context, streams, cancels, and reports errors on both platforms. [AppleNativeTools.swift](../native/runtime/ios/Sources/GezelRuntime/AppleNativeTools.swift) builds native tool schemas. |
| Desktop transport | [Swift helper](../native/helpers/apple-fm/main.swift) uses JSON lines over stdio; [AppleFmHelper](../packages/service/src/providers/apple-foundation-models/helper.ts) routes requests, deltas, tool callbacks, cancellation, and token counts. |
| Desktop provider | [AppleFoundationModelsProvider](../packages/service/src/providers/apple-foundation-models/provider.ts) implements the existing chat provider contract, serializes turns, and executes tools through the session's MCP bridge. |
| Discovery and selection | The Electron supervisor resolves a development or bundled `gezel-apple-fm`. Headless daemons also resolve the verified native root. Config, model pickers, provider routing, and eval targets recognize the provider. Settings shows actual readiness through `/api/models/apple/status`, separately from passive executable presence, and offers Check again. |
| Shipping | The `apple-fm` helper is included in the native build matrix and required Mac payload. Its lane compiles the shared iOS adapter, runs self-tests, and uses the existing signing/notarization steps. A complete new native release and real trust-manifest pin are still required before Mac packaging. See the [helper README](../native/helpers/apple-fm/README.md). |
| Full parity | Sharing Swift code does not make the entire product path identical: desktop uses ChatManager/MCP; mobile uses the native runtime and its shared tool loop. Desktop can narrow tool descriptions and discard old text turns after a context refusal. Mobile host admission and lifecycle differ. |
| Capabilities | Mobile advertises `structuredOutput: false` and `images: false`; desktop marks this provider's vision as `never`. The shared request contains text turns only. Apple's guided output and macOS 27 images need deliberate protocol/API additions on both hosts. |
| Usage | Protocol 2 forwards OS 27 stream usage from the shared Swift adapter. Desktop prefers it over estimates, avoiding an extra tokenizer request and accounting for native tool traffic. OS 26 and responses with no usage snapshot (including some terminal tools) retain the estimate fallback. |
| Readiness lifecycle | Probes coalesce only while in flight, so an unavailable model can become ready without restarting Gezel. Readiness/token-count waits are bounded; stuck cancellation terminates the helper and allows recovery. Late messages from a retired helper cannot complete a new process's requests. |
| Shared error handling | The common Swift adapter now maps OS 27 language-model, system-model and session failures as well as OS 26 generation errors. Both desktop and iOS get the same actionable context, refusal, busy, unsupported and unavailable codes. |
| Mobile build artifacts | `build-native.yml` calls the reusable `mobile-native.yml` and requires both SDKs in tagged native releases, with the same version, checksums and provenance. Standalone mobile PR/manual builds remain available. App archives stay separate CI artifacts. Android includes llama.cpp and the existing `android-mlkit` adapter for Gemini Nano/AICore. AFM is Apple-only. See the [public SDK distribution review](../native/runtime/PUBLIC-DISTRIBUTION.md). |

The shared adapter also limits requests to 64 turns and 32,768 UTF-8 bytes,
and reserves 256 tokens beyond the requested response. These are Gezel
policies, independent of the model-reported context. Tool results can still
consume additional context during generation. Measure realistic Meester,
project, tool, and history footprints instead of judging fit from the user's
message alone.

## How to fit this into the desktop engine experience

Use the same provider id on mobile and desktop and retain explicit
`SystemLanguageModel.default` selection. Present a system-managed model with
readiness, context and supported features. It needs no Gezel model download,
quantization picker, GPU-layer slider, or Python runtime. Apple manages its
assets and residency, but its memory and compute still count against the Mac.

For the first release, keep the helper owned by the **per-user daemon**.
That matches the current ChatManager construction and the user-session path
verified here. The native engine pool currently includes only `llama-cpp`,
`mlx`, and `ds4`; AFM has its own provider queue with concurrency one.
Do not assume that the `_gezeld` machine service can use a logged-in user's
Apple Intelligence state. Service-account, logout, locked-screen, and
background behavior remain separate validation work. AFM's ownership exception
is recorded in [service boundaries](service-boundaries.md).

The diagnostic separates unsupported hardware, missing helper, unavailable
system model, and ready state using the framework's availability result.
Recheck after settings changes. Guardrail refusals, unsupported languages,
context overflow, and busy state are explicit outcomes. The Swift mappings
cover OS 27's `LanguageModelError`, `SystemLanguageModel.Error`, and session
errors alongside the earlier `LanguageModelSession.GenerationError`.

Keep context/history trimming visible. Keep tool authorization, execution,
durable records, and terminal-tool policy in the product host. OS 27's
`ToolCallingMode` may improve deterministic action requests, but it should be
capability-gated and tested against the OS 26 baseline. Apple lists these API
changes in [Foundation Models updates](https://developer.apple.com/documentation/updates/foundationmodels).

## Other Apple-native options

| Technology | Value for Gezel | Suggested treatment |
| --- | --- | --- |
| Foundation Models / system model | Offline language tasks, tool calls, guided extraction; best direct mobile parity | Ship the existing provider after release and lifecycle validation |
| Core AI | Bring separate models to Apple's CPU/GPU/Neural Engine runtime; model conversion and specialization required | Separate engine experiment after AFM parity |
| MLX through Foundation Models | `MLXLanguageModel` supplies a Foundation Models session backed by MLX | Possible shared Swift host later; does not itself imply Neural Engine execution |
| Private Cloud Compute | A distinct cloud model through the same session API, with stronger reasoning and larger context | Separate explicit cloud option if pursued; never implicit fallback from on-device AI |
| Speech | `SpeechAnalyzer` and transcription modules can support native audio workflows | Evaluate as an audio provider, with asset/language/lifecycle checks |
| Vision | OCR/barcode tools and image processing can support document extraction | Add through controlled tool/attachment paths; do not infer quality from a capability flag |
| Translation | Dedicated on-device translation, including a non-UI session for installed languages | Useful specialized operation with explicit language readiness |
| Image Playground | Native image-creation UI | Do not plan a headless image engine around `ImageCreator` on OS 27 |

Apple's [Core AI overview](https://developer.apple.com/documentation/coreai)
describes its `.aimodel` workflow and CPU/GPU/Neural Engine execution.
[Core AI with Foundation Models](https://developer.apple.com/documentation/foundationmodels/running-a-core-ai-model-in-a-foundation-models-session)
requires OS/Xcode 27 and an exported resource bundle, including the tokenizer.
It is not a direct loader for our existing GGUF or MLX model directories.
Model export presets, catalog distribution, compilation cache, cancellation,
and resource admission would all need integration. Hardware placement and
performance depend on the export and device; no Core AI model was converted
or benchmarked in this investigation.

The upstream [MLX Swift LM documentation](https://github.com/ml-explore/mlx-swift-lm/blob/main/README.md)
already describes its `MLXFoundationModels` bridge. This suggests a future
shared Swift session/tool surface for several Apple-platform engines, while
keeping each model's identity and capabilities explicit.

[Private Cloud Compute](https://developer.apple.com/documentation/foundationmodels/adding-server-side-intelligence-with-private-cloud-compute)
requires network access and a managed entitlement and has usage limits. It
does not meet the offline parity goal. No PCC requests were made here.

For specialized features, see Apple's
[SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer),
[multimodal prompting](https://developer.apple.com/documentation/foundationmodels/analyzing-images-with-multimodal-prompting),
and [TranslationSession](https://developer.apple.com/documentation/translation/translationsession).
The important image-generation constraint is explicit in Apple's current
[ImageCreator initializer documentation](https://developer.apple.com/documentation/imageplayground/imagecreator/init()):
it throws `notSupported` on OS 27+. Its native UI is a different integration
from a background image engine.

## Implementation and remaining release validation

1. **Text/tool engine and builds: implemented.** Native matrix/payload entries,
   Mac/iOS shared compilation, model-independent self-tests, protocol 2 usage,
   cancellation hardening, headless discovery and downloadable mobile SDK/app
   artifacts are in place. Still validate signed/notarized and App Store sandbox
   model access, cut/pin the complete native release, and confirm packaged
   discovery. Weak-linking preserves startup on older macOS; an older-OS launch
   was not exercised on this upgraded host.
2. **Readiness and capabilities: implemented.** Installed/ready states are
   separate, availability refreshes, Settings reports runtime context, the API
   reports OS/model capabilities, exact usage is used when present, and per-user
   ownership is documented. Model flags do not advertise image/guided requests
   that Gezel's adapter cannot yet carry.
3. **Establish product parity evidence.** Run the same small task corpus through
   desktop and physical iOS hosts: extraction, summarization, schema-heavy
   tools, multi-step dependencies, terminal tools, refusal/error handling,
   cancellation, and context pressure. Record the final rendered prompts,
   schemas, device/OS, model capabilities, and adapter revision. Simulator and
   desktop coverage do not replace iPhone thermal or foreground/background tests.
4. **Extend the shared adapter.** Add guided output and OS 27 attachments only
   with matching core protocol, host capability, and tool-authority changes.
5. **Compare engines before changing defaults.** Use realistic Gezel tasks with
   fixed grading, cold/warm latency, exact token counts, process plus system
   memory, energy, and sustained load. Test Core AI on one supported small
   exported model first, then compare against that model's MLX/GGUF variants
   where available. Compare the system model as a separate model, not an
   interchangeable backend for those weights.

Gezel already registers AFM in the desktop eval provider/target lists. Reuse
that harness for product tasks. Apple's
[evaluation tooling](https://developer.apple.com/documentation/foundationmodels/evaluating-prompts-to-measure-performance-and-improve-model-responses)
and Python SDK are useful supplementary prompt tools; the shared Swift
adapter remains the authoritative path for mobile/desktop integration parity.
