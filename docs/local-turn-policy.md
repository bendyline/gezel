# Local turn recovery

llama.cpp and MLX share task classification, read provenance, repair tool surfaces,
recovery allowances, and history compaction. The common owners are
[constrained-turn.ts](../packages/service/src/providers/constrained-turn.ts),
[file-repair-policy.ts](../packages/service/src/providers/file-repair-policy.ts), and
[local-turn-policy.ts](../packages/service/src/providers/local-turn-policy.ts).
DS4 inherits the llama.cpp adapter.

Internal callers that know the file's state can attach `fileTurnIntent` to a
chat send or a cross-gezel message:

```ts
{
  kind: 'repair-file',
  path: 'src/controller.ts',
  readPaths: ['src/controller.ts', 'src/types.ts'],
  mutationPath: 'src/controller.ts',
  strategy: 'patch',
}
```

`create-file` requires only `path`. For repairs, `path` identifies the checked
file; an optional `mutationPath` identifies the file to change when that is known.
`readPaths` describes mandatory reads. `strategy: 'rewrite'` requests a complete
replacement after those reads. These hints narrow an available tool surface;
they never grant filesystem authority or authorize an unavailable tool.

Intent belongs to one send. The chat queue preserves it and keeps separately
annotated messages distinct when coalescing nudges. The remote adapter includes it
on the initial inference request; tool-result continuations carry their transcript
without reissuing a create instruction. No prompt or project file is persisted by
the machine inference endpoint. The evaluation feedback producers now supply
known creation/repair intent and explicit mutation targets directly.

Ordinary user messages retain a general-language fallback. A failing test or
acceptance check can trigger repair regardless of the speaker, prefix, or filename.
An incidental mention of `workspace/index.html` does not demand a write. A write
ordered after prerequisite reads does not trigger immediate-write mode. Text
salvage requires an identifiable output path; malformed HTML no longer defaults
to `index.html`.

A fresh `LocalTurnPolicy` owns each send's recovery counters. No-progress and
malformed-call correction each allow two retries; an identical malformed attempt
stops sooner. Partial-write continuation allows six attempts. Cancellation and
awake-time deadlines are checked before retries, after response decoding, and at
tool-execution boundaries. Invalid structured arguments are never replaced with
an executable empty argument object.

Compaction has one shared adapter contract: select conversational history after
all leading system bands, preserve the active turn and its tool results, and
attempt one synthesis at 70% context pressure (or on a backend-reported context
failure). Failed or empty synthesis spends the attempt. A late result after
cancellation cannot replace the transcript.

The adapters retain engine controls: request serialization, tool grammar, native
thinking switches, stream/watchdog handling, cache framing, and engine error
recovery. The existing detailed file-work orchestration still lives in the
provider loops; this change centralizes its shared predicates, surfaces, budgets,
and compaction rather than replacing both loops wholesale. Further extraction
should preserve these tested contracts.

[The backend contract suite](../packages/service/src/providers/local-recovery-contract.test.ts)
runs the same stalled-write, read/patch, failed-patch escalation, malformed-call,
unknown-tool, budget-exhaustion, and cancellation cases against both real provider
loops with mocked inference streams and tool boundaries. It includes multiple
filenames and ordinary paraphrases outside the original evaluation templates.
[Policy tests](../packages/service/src/providers/local-turn-policy.test.ts) additionally
exercise compaction and text salvage;
[queue tests](../packages/service/src/chat/manager-file-intent.test.ts) and the remote
route/session suites verify metadata transport. These are deterministic runtime
regressions, not measurements of live-model task success or GPU performance.
