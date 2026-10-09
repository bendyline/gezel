# Canonical redistribution terms

This directory holds license and notice texts for redistributed components
whose own distribution does not carry them. Packaging copies the directory into
every desktop legal bundle as `resources/licenses/standards/`, and attaches the
texts to the owning npm package's entry in `resources/licenses/npm/manifest.json`.

[`manifest.json`](manifest.json) records, for every text, where it came from and
its digest. Texts are verbatim; `normalized` names any change of encoding (byte
order mark, line endings, final newline) made so the file survives the
repository's `eol=lf` rule, and `sha256` is the digest of the stored file.

`npmPackages` binds an exact package version to the native binaries it carries
whose terms its `package.json` does not describe:

- **onnxruntime-node** declares MIT but publishes no license text. Its native
  runtime compiles in the libraries listed in ONNX Runtime's
  `ThirdPartyNotices.txt`, and its Windows build carries Microsoft's proprietary
  **DirectML** library (`DirectML.dll`) plus the **DirectX Shader Compiler**
  (`dxcompiler.dll`, `dxil.dll`), which is NCSA-licensed from v1.8.2502. On
  linux-x64 its install script also downloads ONNX Runtime's CUDA and TensorRT
  execution providers from NuGet; they are declared `optional` because no other
  host has them.
- **onnxruntime-web**'s WebAssembly builds compile in the same libraries at
  the ONNX Runtime commit its `__commit.txt` names, so they carry that commit's
  notices (for the current build, byte-identical to v1.30.0's).
  **@huggingface/transformers** 3.x copied one of those builds into its own
  dist; 4.x loads them from onnxruntime-web and carries none itself.

`installerBinaries` covers files a build tool adds to an installer outside any
npm package: electron-builder's `elevate.exe` in the Windows build.

`stage-third-party-licenses.mjs` scans every production package for the
binaries named by `LICENSED_BINARY_RULES` in
[`scripts/supplemental-licenses.mjs`](../../scripts/supplemental-licenses.mjs)
and fails when one is not covered here for the exact installed version.
`verify-packaged-licenses.mjs` fails a legal bundle whose package entry lacks a
text this manifest assigns to it. Upgrading one of these packages therefore
stops packaging until someone confirms which native builds the new version
carries and under which terms, and updates this directory.
