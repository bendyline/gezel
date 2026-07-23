# Native redistribution licenses

These are verbatim license texts for the native components distributed with
Gezel. `manifest.json` binds each inventory entry to the same tag and commit as
its `native/engines/<name>/VERSION` file. `pnpm check:notice` fails when the pin,
manifest, text files, or public `NOTICE.md` table drift apart.

When an engine pin changes, compare its upstream license and bundled-source
attributions at the new commit, replace the relevant text when necessary, and
update the manifest in the same change. A version bump is deliberately blocked
until someone performs that review.

CUDA variants also redistribute NVIDIA runtime libraries. Their build jobs copy
the CUDA Toolkit EULA supplied by the pinned toolkit into each CUDA native
artifact as `THIRD_PARTY_LICENSES/NVIDIA-CUDA-EULA.txt`; packaging fails if a
CUDA payload reaches the app without that file.

The llama.cpp bundles also carry OpenSSL 3 runtime libraries on the supported
build platforms. Their Apache-2.0 terms are part of the llama.cpp entry in the
manifest and travel with every native artifact.
