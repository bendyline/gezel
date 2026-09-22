# Gezel phonemizer stub

This private workspace package intentionally occupies the `phonemizer`
dependency slot that `kokoro-js` declares.

The real `phonemizer` embeds **eSpeak NG compiled to WebAssembly**. eSpeak NG is
GPL-3. Gezel is MIT and ships through the App Store and Google Play, where a
GPL-3 component in the binary is a licensing problem rather than a paperwork
one. The package's own metadata says Apache-2.0, which covers the JavaScript
wrapper and not the engine inside it, so the exposure is easy to miss.

Gezel does not need it. Kokoro consumes phoneme ids, and the daemon produces
those with the shared frontend in `@bendyline/gezel/kokoro`, reading the same
pronunciation dictionary the mobile voice pack carries. Synthesis then calls
`generate_from_ids`, which performs no text handling. See
`packages/service/src/providers/audio/kokoro-frontend.ts`.

Any call into this stub throws `GEZEL_PHONEMIZER_UNSUPPORTED`, so a future code
path that reaches for eSpeak fails loudly instead of quietly reintroducing the
dependency.

The same pattern, and the same reasoning about unused packaged weight, applies
to `packages/sharp-compat`.
