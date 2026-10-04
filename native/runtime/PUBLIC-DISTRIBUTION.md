# Public mobile SDK distribution

Reviewed 2026-10-04 against the sources linked below. These packages are reusable
libraries for Gezel and other developers' apps. Publishing the SDK does not
publish a consuming app's source, store listing, provisioning profile, or keys.
It does publish Gezel's included Swift/Java runtime sources and native libraries.

## Contents and integration

`gezel-mobile-<version>-ios.tar.gz` contains a local Swift package: the shared
Apple Foundation Models adapter, model storage, and a static llama.cpp
XCFramework with device and simulator slices. Extract it and add the folder as
a package dependency in Xcode. Keep both Swift targets' privacy resource bundles.
Apple's framework and model weights are supplied by the OS, not redistributed
in this package. Availability still depends on device, OS and Apple Intelligence
readiness.

`gezel-mobile-<version>-android.tar.gz` contains a folder Maven repository.
Add its `maven/` folder as a repository and depend on
`com.bendyline.gezel:gezel-runtime:<version>`. Retain the POM and Gradle module
metadata: they resolve `gezel-llama` from the same repository and ML Kit / Kotlin
dependencies from Google's Maven repository and Maven Central. This includes
the `android-mlkit` adapter, not Gemini Nano weights or a repackaged Google SDK.
The published native engine currently targets arm64-v8a.

These packages exclude Gezel's web app, Capacitor, speech packs, test models,
APKs, AABs and Xcode app archives. They contain a file inventory, source commit,
engine provenance and license notices. Native release `SHA256SUMS` and build
attestations cover them alongside the desktop archives. Verify those against
the trusted release before using the SDK; its internal inventory alone is not
an authenticity guarantee.

## Signing and store submissions

The mobile SDKs are **unsigned libraries**. No signing secrets are passed to
the mobile workflow. Desktop Developer ID / Authenticode signing remains a
separate operation on desktop executables. Each consuming developer builds and
signs their own app using their own team, bundle ID and store credentials.
Android libraries use AARs; app signing applies to the resulting app package.
See [Android library distribution](https://developer.android.com/studio/projects/android-library)
and [Android app signing](https://developer.android.com/studio/publish/app-signing).

Apple explicitly supports public binary framework distribution through Swift
packages. An SDK producer signature, when used, establishes origin and update
continuity; it does not require sharing the producer's private key or using
that identity to sign the consuming app. See
[Apple's binary package distribution guide](https://developer.apple.com/documentation/xcode/distributing-binary-frameworks-as-swift-packages)
and [SDK signature requirements](https://developer.apple.com/support/third-party-SDK-requirements/).

Gezel and llama.cpp are not on Apple's current required-signature SDK list.
Capacitor is listed, but is a separate dependency and is not bundled here.
Consumers must preserve its applicable privacy/signature requirements; adding
or repackaging another listed SDK requires revisiting the release policy.

Both Swift targets include `PrivacyInfo.xcprivacy`. The runtime declares local
model-file metadata and elapsed-time measurement (including the linked llama
engine). Model storage declares metadata for sandbox/user-selected files and
free-space checks before imports/downloads. No tracking or collected data is
declared by these iOS libraries. The embedding app remains responsible for its
own behavior, other SDKs, privacy labels and final archive validation. See
[required-reason API declarations](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
and [approved reasons](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons).

## License and provider terms

Gezel, llama.cpp and ggml use MIT licenses, whose notices are included. MIT
permits public redistribution and use within proprietary apps while preserving
its notices. `THIRD_PARTY_LICENSES/` preserves the shared, commit-bound llama.cpp
notice inventory, including JSON, Unicode and optimized math dependencies.
That conservative inventory also names optional desktop backends; it does not
mean those backends are included in mobile builds. Android engine AARs carry the NDK and toolchain notices for
their bundled runtime libraries. An app's own source need not become public
because it uses these SDKs. Model weights have separate licenses and are not
included. The repository LICENSE and the package's LICENSE/NOTICE files are the
authoritative grants; this guide does not replace them. Preserve these notices
in the consuming app's third-party acknowledgements, including the texts outside
the Swift package resources / Android AARs.

Using ML Kit requires compliance with Google's API and ML Kit terms. The current
[GenAI additional terms](https://developers.google.com/ml-kit/genai-terms)
restrict clients directed at or likely accessed by people under 18, restrict
competing model/API products and model extraction, and prohibit production use
of services designated Preview/Experimental or similarly. Review the exact
Prompt API designation and intended app before a production release; a beta
dependency version alone is not a store approval. Safety and permitted-use
restrictions also apply. A general-audience app must resolve the age restriction
before enabling this adapter in production.

ML Kit processes inputs on-device but sends performance/utilization metrics to
Google; consumers must inform their users as required. Retain the dependency's
licenses and account for this behavior in the app's disclosures. See
[ML Kit Terms & Privacy](https://developers.google.com/ml-kit/terms).

Public SDK hosting is compatible with proprietary store apps; it is not blanket
App Store / Play approval or an exemption from provider terms. The coordinated
native workflow creates a draft. Store signing, device/provider qualification,
app submission and publication remain separate release decisions.
