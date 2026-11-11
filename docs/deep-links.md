# `gezel://` links

gezel.com links into the desktop app. A reader on a craftbook or app page clicks
**Run this in Gezel** or **Open in Gezel**, the browser asks whether to open
Gezel, and the app opens that item's form. Hugging Face's **Use this model**
menu links a model page the same way.

## Targets

| Link | Opens |
| --- | --- |
| `gezel://app/<project-type-id>` | New Project on that type's form (`NewProjectDialog` with `initialTypeId`) |
| `gezel://craftbook/<craftbook-id>` | That craftbook's launch form, in the project new work goes to (`NewTaskDialog` with `initialCraftbookId`) |
| `gezel://docs/<article-id>` | That Handboek article in Knowledge |
| `gezel://model/huggingface/<owner>/<name>[?file=<path.gguf>]` | The review of that Hugging Face model (`ModelImportDialog`), which checks it before anything downloads. See [model-imports.md](model-imports.md) |
| `gezel://open`, or any gezel URL this build does not understand | Home |

The parser is `parseGezelDeepLink` in [core deep-links.ts](../packages/core/src/deep-links.ts).
Ids are lowercase catalog or article ids (`[a-z0-9][a-z0-9._-]*`, at most 128
characters). A model link names a Hugging Face repo instead (`owner/name`, the
Hub's own character set and case). A malformed id, an extra path segment, or an unknown target opens
Home rather than guessing. A newer site linking to a target an older app does
not know still brings the app forward.

## Rules

- **A link opens a form, never the work.** Nothing is created, run, installed
  or downloaded until the person submits the form, exactly as when Home's
  Make something opens it. Any page on the web can send a `gezel://` link, so
  no target may have an effect of its own.
- **A link carries no text.** Query strings are dropped. A page could otherwise
  prefill a request the person never wrote. The one exception is a model link's
  `file`: an identifier with a strict grammar (`isSafeGgufRepoPath`), not text,
  which the review shows and the person can change.
- **One dialog per burst.** Main keeps only the latest pending link and drops a
  repeat of the same target within two seconds.
- **Unknown ids fall back.** The dialogs already handle ids they do not offer:
  New Project lands on the gallery and New Task says the plan is not
  available in that project.

## How a link reaches the page

1. **Registration.**
   - macOS, Linux and the store packages declare the scheme through
     electron-builder's `protocols` (CFBundleURLTypes, the desktop entry's
     `x-scheme-handler/gezel`, and the APPX protocol extension).
   - The NSIS target writes no protocol keys, so `registerGezelUrlScheme` in
     [main.ts](../packages/app/src/main.ts) registers it per user with
     `app.setAsDefaultProtocolClient`. The uninstaller removes
     `HKCU\Software\Classes\gezel` for the account that runs it.
   - Development launches and test runs never register, since they would take
     the scheme away from an installed copy. Set `GEZEL_DEV_URL_SCHEME=1` to
     register a dev launch on purpose.
2. **Delivery to main.**
   - macOS sends `open-url`, which can arrive before ready on a cold launch.
   - Windows and Linux put the URL on the first-launch or second-instance
     command line, read by `findDeepLinkArguments`
     ([deep-link-args.ts](../packages/app/src/deep-link-args.ts)).
3. **Delivery to the page.**
   - Main parses the link, shows or recreates the window, and sends it on
     `gezel:deep-link` once the app page has loaded: never to the splash,
     and again after a reload.
   - The preload buffers the latest link until `onDeepLink` subscribes.
   - [DeepLinkHost](../packages/ui/src/components/DeepLinkHost.tsx) checks
     it again with `isGezelDeepLink` and opens the target, gated on the
     host's runtime capabilities.

## On the site

- `openInGezelHtml` ([site-open-in-gezel.ts](../packages/cli/src/site-open-in-gezel.ts))
  renders the button hidden. A small script shows it on computers only, since
  phones have no desktop app to open.
- A browser says nothing when no app takes a link. So if the page keeps focus
  for a few seconds after the click, the script shows "Nothing opened?" with a
  download link.
- The apps library inlines the script.
- The Handboek export writes it as `assets/open-in-gezel.js` and links it from
  any page that carries a button: craftbook and project-type pages, when the
  export has a `siteUrl`.
- Both exports leave the buttons out unless run with `--open-in-gezel`
  (`node scripts/export-handboek-site.mjs --open-in-gezel`). Turn it on once a
  desktop release that answers these links is out, so the site and its docs
  can still publish before then.

## Not yet

- **Phones.** The phone app registers no URL scheme. `@capacitor/app` is not a
  dependency, Android has no intent filter, and iOS has no
  `CFBundleURLTypes`.
- **Other targets.** Knowledge catalogs and catalog models have no target yet,
  because neither page can focus an item by id today. Models from Hugging Face
  do (`gezel://model/...`), because the review dialog needs no page behind it.
