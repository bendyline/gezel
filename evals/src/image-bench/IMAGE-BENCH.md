# Image bench

A fixed prompt suite rendered through every local image model the way a
person's request is, with checks cheap enough to run on every engine bump or
new catalog entry.

```bash
pnpm --filter @bendyline/gezel-evals run image-bench -- --suite smoke
pnpm --filter @bendyline/gezel-evals run image-bench -- --models moss-image-sft-q4 --seeds 42,7
```

## What it runs

One fresh trial daemon per model, from the built `packages/service/dist`, with
the model linked in from the eval cache (`~/.gezel-eval-cache`). Each image is a
`POST /api/image-gen/generate` carrying only the prompt, model and seed, so the
catalog's recommended steps and the provider's size, CFG, sampler and launch
flags all apply exactly as they do for a chat request. `--size` and `--steps`
override them for A/B runs. `--aspect` (`9:16`, `16:9`, …) and `--quality`
(`draft`, `standard`, `high`) render the way the direct image gezel's settings
do: the route resolves them to the model's own pixels, and the model's memory
estimate is priced at that tier. Run a model at its edge shapes before trusting
them: a non-square render at the trained area is where older models duplicate
their subject. `--prompt-file` sends rewritten prompt text while every score
stays against the original request.

The suite ([prompts.ts](prompts.ts)) is twelve plain-English prompts, one per
failure that shows up in use: a photographed object, a face, hands, a
landscape, counting and placement, a short sign, a poster with two lines of
text, watercolor and anime styles, a flat logo, food, and an app screen with a
reading. `smoke` is four of them. Never change a prompt's text: add an id.

## What it measures

| Per image | Source |
|---|---|
| wall seconds, steps, size | the route's response |
| text-encode, sampling, decode, weight-load seconds | sd-server's own log lines ([sd-log.ts](sd-log.ts)) |
| sanity flags: `black`, `blank`, `burned`, `noisy`, `wrong-size` | pixel statistics ([sanity.ts](sanity.ts)) |
| alignment: cosine to its prompt, rank among all suite prompts | EmbeddingGemma 2, the product's media-search encoder ([alignment.ts](alignment.ts)) |

| Per model | Source |
|---|---|
| cold seconds (first image, includes launch and the lazy weight load) and steady seconds per image | wall time |
| peak memory: the fall in `MemAvailable` from just before the engine starts | [memory.ts](memory.ts); counts what a unified-memory GPU allocates, which a resident set misses |
| the daemon's own estimate and verdict | `GET /api/image-gen/models/fit`, the figure the download page and the device ledger use |
| params memory, flash-attention and direct-convolution choices | sd-server's log |

`report-<label>.md` has one row per model; `report-<label>.html` puts every
image in a grid by prompt and model; `images.jsonl` and `models.jsonl` hold
everything, including the peak memory read after each image (a series that
keeps rising across images is a leak). `--rescore --runs-dir <dir>` scores a
finished run again, with alignment, a judge, or both, without rendering.

## Reading it

- **Sanity flags catch broken renders, not ugly ones.** A flag means look;
  no flag proves nothing about quality. There is no seam flag: brick walls,
  posters and app screens are full-span straight lines on both axes and were
  flagged as often as a tiled decode would be. The seam numbers stay in the
  stats. There is no blur flag either: an under-sampled render (4 steps on a
  30-step model) is smooth, and so is a clean render of a few shapes on
  white; neither the mean Laplacian nor the strongest edges told them apart.
- **Alignment catches the wrong subject, not wrong details.** An embedding
  does not read spelling or count objects, and it forgives blur: MOSS at 4
  steps, an unusable smear, scored like MOSS at 50. In the 2026-10 sweep
  every working model ranked its own prompt first on every render, with
  cosines between 0.745 and 0.80; the one broken model, Animagine at 512px,
  fell to 67% top-1 and 0.65. So watch the rank and the cosine together: a
  model whose cosine drops below about 0.7 is drawing something else.
- **Text, counting and anatomy need eyes, or a judge.** Look at the HTML
  grid. `--judge-url` adds a vision chat model that reads every image: whether
  it shows what was asked, the text it carries (spelling is then checked in
  code against the words the prompt requires), visible defects, and a 1-5
  score. Any OpenAI-compatible endpoint that takes image parts works: a bare
  `llama-server` with a vision projector, a daemon's `/v1`, or a cloud model.
  Small vision models transcribe far more reliably than they grade, so trust
  `text right` over the score. muse-glimmer needs
  `--judge-body '{"chat_template_kwargs":{"reasoning_strength":"low"}}'`; with
  its reasoning cut to zero it answers HTTP 500. That `llama-server` (v0.7.0,
  with the vision projector) stopped answering anything after about 50 image
  requests in every run, with one slot or four and with its prompt cache on or
  off, while the same images judged fine on a fresh server. Judge in passes of
  `--judge-max 40` and restart the server between them; `--rescore` resumes
  where the last pass stopped.
- **Memory is noisy by about a gigabyte**, and counts everything that loads
  during the run: a test suite or a chat model started beside the bench
  inflated three readings in the 2026-10 sweep by 2 to 17 GiB. Run on a quiet
  machine, compare peak to estimate as a ratio across several models, and
  never trust one reading.
- **View grids as JPEG.** A multi-megabyte PNG contact sheet can be
  palette-reduced by an image viewer or model input pipeline, which makes
  every render look posterized.
