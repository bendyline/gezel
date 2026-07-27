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
artifact as `THIRD_PARTY_LICENSES/NVIDIA-CUDA-EULA.txt`. NVIDIA's minimal CI
packages do not consistently install that file, so `native/cuda-eulas/` carries
official, version-matched fallbacks for every CUDA minor used by the workflow.
Packaging fails if a CUDA payload reaches the app without an EULA.

The llama.cpp bundles used to carry OpenSSL 3 runtime libraries copied from
whatever the build host happened to have, which is why an Apache-2.0 entry sat
under llama-cpp here. They are built with `-DLLAMA_OPENSSL=OFF` as of
native-v0.1.19, ship no OpenSSL, and the entry is gone. Node.js embeds its own
OpenSSL; that is covered by the Node.js row in `NOTICE.md`, not here.
