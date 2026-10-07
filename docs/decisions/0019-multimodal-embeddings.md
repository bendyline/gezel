# 0019 — Multimodal embeddings with EmbeddingGemma 2

Status: Accepted (2026-10)

## Context

Gezel could find a photo only by its file name, an AI-written caption, or
another photo. Workspace search ran CLIP ViT-B/32's vision tower for
image→image similarity, and its text tower was never wired, because CLIP's
text space sits far from the passages a person writes (a query scored 0.31
against its matching image and 0.95 against a caption). Knowledge catalogs
embedded text only; their images shipped for display. Video and audio were
not indexed at all.

Google's [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)
(Apache 2.0 with the Gemma Prohibited Use Policy) maps text, images, video and
audio into one 768-dimension space: a 270M text model with 170M vision and
300M audio encoders that load only when asked for. In a 2026-10-06 spike its
text quality on Gezel's own documents matched bge-small, a text query sat at
0.74 from its matching image (0.93 from the caption), and the Matryoshka
512-dimension prefix lost nothing measurable.

## Decision

One model, `embeddinggemma-2-512@1`, for every media surface and for catalogs
that want media:

- **Pinned q8 graphs.** `onnx-community/embeddinggemma-2-ONNX` at an exact
  revision, every file sha256-pinned: the text model (314 MB), the vision
  encoder (195 MB) and the audio encoder (340 MB, fetched only when a video or
  recording is first indexed). Google warns against float16 for this model;
  never pin an fp16 graph. The community conversion should be mirrored to a
  Bendyline-controlled repository before defaults depend on it staying put.
- **512 dimensions by prefix truncation.** The profile records
  `truncation: { method: 'prefix', sourceDimensions: 768 }`; one gezk function,
  `profileUnitVector`, keeps the first 512 values and re-normalizes, for
  passages, queries and media alike.
- **Centered sign bits.** The 512-entry center is the mean of 13,500 catalog
  chunks (|c| = 0.763). Stage-1 recall of the top 24 was 94.9% raw versus
  95.0% centered at 192 candidates on mixed corpora, and centering helps on
  narrow ones, so the profile keeps `centered-sign`.
- **Format 0.8, index schema 5.** Profiles gain `model.files` (every
  additional file the runtime loads, so the 314 MB of weights is verified, not
  only the 0.5 MB graph), `truncation` and `media`. Shard `chunks` gain
  `modality`, `asset_path`, `start_ms`/`end_ms` and per-asset attribution;
  media rows sort after a document's text chunks so text `chunk_uid`s match a
  text-only build. Video and audio become asset types (512 MiB a file, 8 GiB a
  catalog). The writer emits the **oldest** generation that can express a
  catalog, so a bge or e5 rebuild still opens in a 0.7 reader, while an old
  reader refuses a 0.8 catalog instead of silently dropping fields its
  strip-mode schemas do not know.
- **A separate media lane.** In this space a photo is further from its
  description than a passage is, so media rows rarely survive the text
  stage-1 cut. Readers score media rows exactly (`searchMedia`), and fusion
  keeps at most four per search and one per document. Media rows reach
  explicit search only, never per-turn injection.
- **Floors per modality.** `<profile>#image` 0.67, `#video` 0.66, `#audio`
  0.68 (text 0.735), measured by the media bench on COCO, MSR-VTT and ESC-50
  and each set a step above the lowest floor no off-topic prompt reached. A
  modality with no measured floor contributes no vector evidence: a nearest
  photo always exists, and media has no query words to be grounded in. The
  relevance model does not judge media rows.
- **Replace CLIP outright.** The workspace lane keys stored vectors on
  `embeddinggemma-2-512@1#image@<budget>`; schema v14 drops the CLIP table and
  the idle tier re-embeds. Media search defaults on, downloads only when the
  security policy allows app network, and the lane loads local files only, so
  an index pass never starts a download.
- **No sharp.** Gezel ships a throwing sharp stub. Images are decoded in pure
  JS and resized once, from the source dimensions, with PIL's antialiased
  bicubic kernel; the processor's own resize is switched off. Its sizing rule
  is not idempotent (re-applied to its own output it can add a block to one
  side), so sizing twice would both change the vectors and reach for sharp.
  Parity against the sharp-based reference is ≥ 0.9967 cosine at 280 vision
  tokens.
- **System ffmpeg only.** Video and audio are cut by `GEZEL_FFMPEG`,
  `SQUISQ_FFMPEG` or `ffmpeg` on PATH, with argument arrays, no stdin, the
  `file` protocol only, a hard timeout and bounded output. Without one, those
  files are found by name and the Settings card says why.
- **Windows.** Video: 1 frame per second, at most 32 frames (about 30 s) per
  window, 140 vision tokens per frame. Audio: 16 kHz mono, 30-second windows.
  The processor config's `audio_seq_length: 280` (11.2 s) is a Gemma 4 chat
  cap the EmbeddingGemma 2 processor does not apply; the model card allows
  about 327 s per input, and speech starting 19 s into a 30 s window still
  dominated its vector (cosine 0.938 to the speech alone). One file yields at
  most 120 windows.

## Alternatives considered

- **Keep CLIP and add a text tower.** CLIP's text↔image gap (0.31 versus 0.95
  against captions) makes one ranked list of text and images impossible, and
  it has no audio or video.
- **Bundle ffmpeg.** Licensing and binary size for a lane most people use
  rarely; the system ffmpeg squisq already looks for is enough.
- **768 dimensions.** No measurable quality gain over 512 in the spike, and a
  third more storage and scan cost in every catalog.
- **fp32 graphs.** Four times the download for no retrieval gain at the bench
  scale.

## Consequences

- The default-on download grows from 88 MB (CLIP) to about 510 MB, plus
  340 MB on first video or audio work. Both are visible in Settings → Image
  recognition and gated on network policy.
- Retrieval (bench): text→photo R@1 0.80 and R@10 0.99 at 280 vision
  tokens (0.77 and 0.99 at 70); text→video R@1 0.85. Environmental sound
  searched by class name is weak (R@1 0.24, R@10 0.76) while speech scores
  well; a speech set is the bench's next addition.
- Cost (M5 Max CPU, q8, measured under load): about 2.1 s per photo at 280
  vision tokens, 0.46 s at 70, about 2 s per 30-second sound window and
  15–21 s per 30-second video window. An hour of video is roughly half an
  hour of CPU. All of it runs in the idle and Night Shift tiers, never on a
  chat turn.
- transformers.js moved from 3.8.1 to 4.3.1 (the first release with
  `embedding_gemma2`) and ORT to 1.30.0, with a release-age exception for
  4.3.1. kokoro-js is held on v4 by an override; its output matched for the
  first 2,000 samples and ended 600 samples shorter.
- q8 dynamic quantization may differ by CPU; catalog reproducibility for this
  profile is per platform until the cross-platform fixture diff says
  otherwise.
- Phones do not run transformers.js, so these catalogs are keyword-only there.

## Regression surface

- [gezk profiles/manifest tests](../../packages/gezk/src/schemas/) and the
  0.8 conformance fixture (`packages/knowledge/scripts/build-conformance.ts`):
  truncation, centered bits, media rows, the generation rule.
- [gezk-media.test.ts](../../packages/knowledge/src/gezk-media.test.ts) and
  [gezk-08.test.ts](../../packages/knowledge/src/gezk-08.test.ts): media rows,
  text chunk ids unchanged, the media lane, wrong-width queries refused.
- [image-pixels.test.ts](../../packages/service/src/memory/image-pixels.test.ts):
  the sizing rule, its non-idempotence, the bicubic kernel.
- [image-vectors.test.ts](../../packages/service/src/index-store/image-vectors.test.ts):
  the v14 drop, the budget-keyed identity, audio windows.
- [vector-floors.test.ts](../../packages/service/src/knowledge/vector-floors.test.ts):
  every registered profile has a measured floor.
- The media bench (`pnpm --filter @bendyline/gezel-evals run media-bench`) is
  the floor and cost record:
  [MEDIA-BENCH-2026-10-07.md](../../evals/src/retrieval-bench/MEDIA-BENCH-2026-10-07.md).
