# Gezel Transformers.js image stub

This private workspace package intentionally occupies the `sharp` dependency
slot used by Transformers.js.

Gezel uses Transformers.js for text embeddings and Kokoro text-to-speech.
Transformers.js nevertheless imports Sharp unconditionally from its Node
bundle, even when no vision pipeline is used. Shipping native Sharp would also
ship libvips and its dependency set for an image path Gezel does not expose.

The stub lets text and audio modules load normally. Any future call into
Transformers.js image processing fails immediately with
`GEZEL_TRANSFORMERS_IMAGE_UNSUPPORTED`. If Gezel adds a Transformers.js vision
feature, replace this package with a reviewed image runtime and remove the
packaging guard that verifies the stub.
