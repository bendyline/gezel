# 0020. Phones read chat photos with the OS first and a small vision model second

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

The chat composer's Take photo key exists so a person can ask about what they
are looking at, and phones are where that happens. Desktop already serves it:
a model that can see gets the pixels, and a text-only model gets a description
from the local Granite Vision reader (`resolve-turn-images.ts`). The phone had
neither. Its providers take text only (`images: z.literal(false)`), the
portable runtime had no reader, and an image reference in a phone message
failed the send while the runtime decoded the JPEG as text.

A phone also has hardware and system software a desktop reader does not:

- **Every phone** has an image classifier and a text recognizer in the OS:
  Vision (`VNClassifyImageRequest`, `VNRecognizeTextRequest`) on iOS, ML
  Kit's bundled labeler and Latin text recognizer on Android. They are
  instant (0.1–1 s) and need no download. They name what is in a picture and
  read its text, but they do not describe it.
- **Some phones** have a describer in the OS: Gemini Nano's image description
  (`genai-image-description`) on AICore phones, and from iOS 27 Foundation
  Models, which takes image attachments where `capabilities.contains(.vision)`.
- **Many phones** have neither describer. An iPhone 14 has no Apple
  Intelligence, and Nano is missing from most Android phones. Nano also
  refuses some ordinary photos at its own output policy check (a sleeping
  child, 2026-10-06).

## Decision

A phone reads each photo in tiers, and the model gets everything that ran:

1. **Labels and text from the OS, always.** `GezelVision.read` (app-owned
   plugin, `packages/mobile/native/{ios,android}`) runs the classifier and
   the text recognizer. Each platform keeps only labels its classifier is
   sure of: Apple's 90%-precision curve, ML Kit's 0.7 confidence.
2. **A description from the OS describer** where it is ready: Nano on
   Android, Foundation Models on iOS 27. Fetching Nano's image model is a
   Settings action (Settings → AI → Photos), never something a chat turn starts.
3. **A description from a small vision model** when the OS has no describer
   or its describer failed: Qwen 3.5 0.8B and its F16 projector (~755 MB),
   through a new bridge call, `gezel_llama_describe_image`. That call links
   llama.cpp's mtmd statically into `gezel-llama`, opens the projector beside
   the loaded model, and leaves the KV memory empty. The pair is pinned
   together in `packages/mobile/src/vision-model.ts`, since a projector fits
   only its own model. The projector is stored as an ordinary library entry,
   so the existing download verification and resume apply, and the chat model
   list hides it.

The portable runtime runs this as the first phase of the turn, inside the
turn's engine slot (`readTurnImages`), because tier 3 needs the engine. It
saves the result on the message as the desktop's `MessageImageDigest`,
rendered by the same core module (`recognition/digest.ts`), so later turns
replay the text instead of reading the photo again. When only labels and
text reached the model, or nothing did, the message carries a warning that
says so.

## Alternatives

- **An OS-agnostic small VLM only.** One code path, but it costs ~755 MB and
  2–3 s on every phone, including the ones whose OS already describes photos
  better, and it would replace instant OCR with a model reading text from
  pixels.
- **OS labels only.** Free, but "snow, people, sport" is not what a person
  asking "what is this?" needs, and on an iPhone 14 that would be the whole
  answer.
- **Native image input to the chat model.** None of the phone providers take
  images, and the llama.cpp chat path's prompt reuse is token-based; porting
  llama-server's multimodal chat into it is the expensive part. A separate
  describe call keeps every chat model working with photos.
- **EmbeddingGemma 2 similarity as a describer.** Rejected for the turn path
  in [ADR 0019](0019-multimodal-embeddings.md); an embedding is not something
  a text model can read.

## Consequences

- The mobile engine links mtmd. Shipping it needs a native release
  (`native-v0.1.49`); local development builds the bridge with
  `native/mobile/build-llama.py` and restages.
- A photo turn on a phone whose chat model is not the vision model reloads
  models twice (vision model, then chat model). Choosing Qwen 3.5 0.8B as the
  chat model avoids that.
- Nano's policy refusals fall through to tier 3, which describes them.
