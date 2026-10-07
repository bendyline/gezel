# Media bench — EmbeddingGemma 2, 2026-10-07

The `embeddinggemma-2-512@1` entries in
`packages/service/src/knowledge/vector-floors.ts` come from this record: the
text floor and the `#image`, `#video` and `#audio` floors that decide when a
photo, a video window or a sound window counts as vector evidence. The
decision itself is [ADR 0019](../../../docs/decisions/0019-multimodal-embeddings.md).

## Why

Nearest-neighbour search always returns some photo, and a media row has no
query words to be grounded in, so a media modality with no measured floor
contributes nothing (`floorFor` answers null and the row is dropped). The
floors had to be measured before media search could return anything by
meaning.

## Setup

- Model: `onnx-community/embeddinggemma-2-ONNX` at `daa72c51…`, q8 graphs,
  512-dimension prefix of the 768-dimension output, re-normalized.
- Path: the product's own encoders (`loadMediaEncoder`, ffmpeg segmentation,
  `profileUnitVector`) through `pnpm --filter @bendyline/gezel-evals run media-bench`.
- Corpora, downloaded at run time (never committed):
  - COCO Karpathy test split, first 300 images; query = the first of five
    human captions; one relevant image per query.
  - ESC-50, 4 clips per class × 50 classes (5-second environmental sounds);
    query = `the sound of <class>`; 4 relevant clips per query.
  - MSR-VTT test 1k-A, first 60 clips (10–30 s, one window each); query =
    the clip's caption.
- 20 off-topic prompts ([media/queries.ts](media/queries.ts)) scored against
  every corpus: an off-topic prompt that clears the floor would put a random
  picture in front of a person.
- Apple M5 Max, CPU. Timings were taken with other work running, so they
  are upper-ish bounds.

## Results

| Corpus | Items | R@1 | R@5 | R@10 | MRR | Cost |
|---|---|---|---|---|---|---|
| Photos, 280 vision tokens | 300 | 0.800 | 0.977 | 0.993 | 0.880 | 2.1 s / photo |
| Photos, 70 vision tokens | 300 | 0.767 | 0.980 | 0.993 | 0.860 | 0.46 s / photo |
| Video (1 fps, ≤ 32 frames, 140 tokens / frame) | 60 | 0.850 | 0.950 | 0.967 | 0.891 | 15–21 s / 30 s window |
| Sound (environmental) | 200 | 0.240 | 0.520 | 0.760 | 0.385 | 0.36 s / 5 s clip (~2 s / 30 s window) |

70 vision tokens cost a fifth of 280 and lose three points of R@1. The
default stays 280, the fidelity catalogs embed at, so a workspace photo and a
catalog photo answer one query on one scale; Settings offers the cheaper
levels.

Environmental sound searched by its class name is weak: the right class is
first a quarter of the time, and every clip sits in a narrow band of
cosines. Speech is not: in the daemon check below a speech query scored
0.729 against the JFK recording, against ~0.5 for everything unrelated. A
speech set belongs in the next run of this bench.

## Floors

Lowest floor at which no off-topic prompt reaches any item, and what it keeps:

| Modality | No off-topic from | Answers kept there | Chosen | Kept at chosen | Wrong items above, per query |
|---|---|---|---|---|---|
| Photo | 0.66 | 296 / 300 | **0.67** | 293 / 300 | 3.2 of 299 |
| Video | 0.65 | 54 / 60 | **0.66** | 54 / 60 | 0.9 of 59 |
| Sound | 0.66 | 49 / 50 | **0.68** | 47 / 50 | 58.8 of 196 |

Each chosen floor sits a step above the bench's pick, because the maximum
off-topic cosine grows with the size of the library and these corpora are
small. For sound the floor still admits many wrong clips; ranking and the
cap of four media rows per search do the rest.

## Text floor

The same profile's text floor (`embeddinggemma-2-512@1`, **0.735**) was
measured on the labelled knowledge-calibration queries
([knowledge-calibration/queries.ts](knowledge-calibration/queries.ts)), with
Handboek 1.2.2 and a 6,467-chunk Wikipedia Food & Drink sample re-embedded in
this profile:

| | min | median | max |
|---|---|---|---|
| Handboek answers (20) | 0.762 | 0.832 | 0.913 |
| Food answers (20) | 0.771 | 0.830 | 0.852 |
| Off-topic → Handboek (25) | 0.611 | 0.635 | 0.686 |
| Off-topic → Food (25) | 0.593 | 0.646 | 0.706 |
| A Handboek question's best Food chunk | 0.640 | 0.677 | 0.715 |

0.735 sits in the gap between the highest wrong-catalog match (0.715) and
the lowest answer (0.762). The scale is far less compressed than e5's.

## Daemon check

A `gezeld` built from the same tree indexed a folder of six photos, a speech
recording and an ocean clip, then answered `search_images` with floors off:

| Query | First result | Next best |
|---|---|---|
| a cat lying down | cats.jpg 0.681 | 0.603 |
| a dog | corgi.jpg 0.698 | 0.594 |
| a mountain lake | moraine-lake.png 0.711 | 0.571 |
| a shop receipt with prices | receipt.png 0.695 | 0.549 |
| people playing football | football-match.jpg 0.696 | 0.563 |
| a man giving a political speech | jfk.wav @ 0:00 0.729 | (only audio) |
| a sea turtle swimming | sea-turtle.mp4 @ 0:00 0.737 | (only video) |
| what is 17 times 23 | receipt.png 0.643 | 0.564 |
| how do I rotate a TLS certificate | moraine-lake.png 0.547 | 0.541 |

Every real match clears its chosen floor and neither off-topic prompt does.
Warm queries took 220–450 ms; the first, which loads the text model, 3.7 s.

## Audio windows

`processor_config.json` sets `audio_seq_length: 280` (11.2 s). That cap
belongs to the Gemma 4 chat processor; the EmbeddingGemma 2 processor does
not apply it, and the model card allows about 327 s per input. Speech placed
19 s into a 30-second window still dominated its vector (cosine 0.938 to the
speech alone), so windows stay 30 s.

## Rerunning

```bash
pnpm --filter @bendyline/gezel-evals run media-bench -- \
  --hf-cache ~/.gezel/engines/hf-cache --images 300 --budgets 280,70 \
  --audio-per-class 4 --videos 60
```

The datasets and every item's vector are cached under
`evals/.cache/media-bench/`, so a rerun with new prompts or a new floor grid
only re-scores. Delete the `vectors-*.json` files after a model or
preprocessing change.
