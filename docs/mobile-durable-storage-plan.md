# Plan: phone work that outlives the app

Status: approved 2026-10-01, in progress. Revises the storage stance in [mobile-plan.md](mobile-plan.md) §7,
which keeps canonical data inside the app container.

## Problem

On a phone everything Gezel knows lives in the app's private sandbox:
- iOS: `Library/Application Support/Gezel/`
- Android: `files/gezel/`

Updating the app keeps it. **Deleting the app deletes all of it**: crew definitions, projects,
workspaces, artifacts, conversations. On iOS, a device or iCloud backup can bring the sandbox
back; on Android nothing can, because the app sets `allowBackup="false"`.

On the desktop, `~/.gezel/` is a folder the person owns: it outlives any install and they can open
it. The phone should give the same promise for the person's *work*, while still treating models
as a disposable cache.

## Principle: three tiers

| Tier | What | Where | Survives uninstall |
|---|---|---|---|
| **Work** | gezels (gezel.md, about.md, poppetje, memories), projects (project.json, documents, workspace, artifacts), the shared library, sent conversations | a **Gezel folder** the person can see | yes |
| **Device** | models, `models.json`, downloads, device settings (selected model, budgets, footprint), search indexes, transaction journals, in-flight turn state, credentials (Keychain/Keystore) | app sandbox | no, by design |
| **Linked** | folders the person grants (Files/Documents, Dropbox, OneDrive providers) and their photo library | wherever they already live; Gezel holds a grant, never a copy | yes (they were never ours) |

Three rules carry over from the desktop shared library ([documents-library.md](documents-library.md)):
- **Nothing derived goes into a user folder.** Indexes, thumbnails, shadow conversions and caches
  stay in the device tier and can be rebuilt.
- **Models never go into the Gezel folder.** A reinstall re-downloads them, and an uninstall must not
  leave gigabytes behind.
- **A linked folder is read-only unless the person says otherwise**, as on the desktop
  ([ADR 0015](decisions/0015-project-inference.md)).

## Where the Gezel folder lives

**iOS default: the app's iCloud Drive folder.** This is a public ubiquity container, which Files
shows as *iCloud Drive › Gezel*.
- Data stays in the person's iCloud account when the app is deleted.
- After a reinstall the app finds its container again with no picker.
- It comes back on a new phone.
- Costs:
  - an iCloud entitlement on the Bendyline team;
  - iCloud Drive must be on;
  - file coordination (`NSFileCoordinator`) for every read and write;
  - evicted placeholders must be downloaded before a read;
  - conflict versions (`NSFileVersion`) must be resolved.

**iOS fallback: a folder the person picks** (document picker, folder mode). This covers no iCloud,
or a person who wants the files local or in another provider.
- They can create a folder in *On My iPhone* itself, outside any app's own folder, so it is not
  deleted with the app.
- The security-scoped bookmark lives in the sandbox, so after a reinstall first run must ask them to
  pick the folder again ("Restore from your Gezel folder").

**Android: a folder the person picks through the Storage Access Framework.** The default suggestion
is `Documents/Gezel`.
- The persisted URI grant is revoked on uninstall, so a reinstall re-picks.
- SAF works through `DocumentsContract` URIs, not file paths. It is slower for many small files and
  not every provider gives an atomic rename.
- Android's alternatives fail:
  - app-specific external storage is deleted on uninstall;
  - after a reinstall, files the app wrote to shared `Documents/` without SAF belong to an app it no
    longer is;
  - Auto Backup caps an app at 25 MB.

## Architecture

**A storage port with routed roots.** The phone product already reaches storage through one
six-operation interface (`PortableFileSystem`: read, write, list, mkdir, remove, rename), backed by
native `ProductFiles` rooted at `product/`. Replace that single root with a router. It sends Work
paths to the durable root and Device paths to the sandbox, keeping one path namespace so product
code does not change:

- `gezels/**`, `projects/**` → durable root.
- `config.json` stays device-side, whole. It needs no split: `ensureLayout` re-derives the Meester
  and shared-library pointers from the gezels and projects it finds on every launch, so a restored
  folder re-binds by itself. Person-level preferences reset on a new device, as they would for a
  desktop pointed at a copied `~/.gezel`.
- `.transactions/` stays device-side; see "Crash safety".
- Prompt drafts stay with their project in Work. A sent draft holds the attachments its message
  references, so it is part of the conversation. Unsent autosaves are local file writes, which
  iCloud coalesces; revisit only if the spike shows a cost.
- Derived subpaths inside Work stay device-side (memory indexes, `artifacts/shadow`,
  `artifacts/tabular`, `input-staging`). The rule is the same one the desktop uses for its
  carve-outs.

One classifier, `storageTierFor(path)` in core, decides the tier of every home-relative path. The
phone router uses it now. The desktop Store adopts the same classifier when it gains a Work root
(see "The desktop and iCloud Drive").

**Native durable-root providers**, each implementing the six operations:
- iOS iCloud: file-coordinated `FileManager`, download-on-read, and conflict detection that surfaces
  instead of silently picking a winner.
- iOS picked folder: security-scoped access around each operation.
- Android SAF: `DocumentsContract`, with write-temp-then-rename where the provider supports it and
  copy-then-verify where it does not.

**Crash safety.** Today a multi-file commit journals into `.transactions/` beside the files, then
replays. With the journal in the sandbox and the files in the Gezel folder:
- **A crash** replays the journal on next launch, as now.
- **An uninstall mid-commit** loses the journal. Each file write is already atomic, so the folder
  holds whole files, possibly from two consecutive commits. That is the same outcome a desktop
  user gets from a power cut with cloud sync running, and it is acceptable.

Never put the journal in iCloud: a replay racing a sync is worse than either alone.

**External changes.** A Gezel folder in iCloud Drive or a picked provider can change underneath the
app, from the Files app, another device or a desktop. Watch it (`NSMetadataQuery` /
`NSFilePresenter` on iOS; poll on resume on Android) and treat a changed file the way the desktop
treats an outside edit: re-read and never overwrite blind. One device writing at a time is the
supported case; simultaneous editing on two devices is not a goal of this plan.

## Linked folders and Photos

**Folders.** A project can point at a folder the person picks, playing the desktop `workingDir`'s
role. It is read-only unless they allow writes.
- iOS keeps a security-scoped bookmark.
- Android keeps a persisted SAF tree grant.
- Both expire on reinstall and are re-granted from the project's settings.
- Keep phone locators (bookmark data, content URIs) distinct from desktop paths, as §7 of the
  mobile plan already requires.

**Photos** is a read-only source, not a folder.
- The default gives access only to items the person selects: PHPicker on iOS, the Photo Picker on
  Android.
- An opt-in full-library source (PhotoKit limited or full access; `READ_MEDIA_IMAGES` /
  `READ_MEDIA_VISUAL_USER_SELECTED`) is for gezels that browse or describe the library.
- A photo reaches a gezel as a read-only item or as an imported copy in the project's artifacts.
  Descriptions, face data and thumbnails stay in the device tier.

## The desktop and iCloud Drive

macOS shows an app's public iCloud container as an ordinary folder,
`~/Library/Mobile Documents/iCloud~com~bendyline~gezel/Documents/`. Reading a file there downloads
it on demand, so a desktop daemon can open the phone's Gezel folder **by path, with no iCloud
entitlement**.

That makes "the desktop sees it" nearly free, and "the desktop works primarily in it" a real option:
- **Same layout, one Work root.** The desktop Store already writes `gezels/` and `projects/` with the
  phone's shapes. Give it a Work root, routed by the same `storageTierFor`, and point that root at
  the iCloud folder. Phone and Mac then share one crew and one set of projects. Device state
  (engines, models, indexes, logs, runtime) stays in `~/.gezel/`.
- **Hosting limit.** The machine-wide system service runs as `_gezeld` and cannot reach a person's
  iCloud Drive. Only a per-user daemon (spawn, embedded, or autostart) can work there.
- **Two writers.** A Mac and a phone editing the same project is new. File-level last-writer-wins
  is what iCloud gives. The desktop already handles outside edits for cloud-synced folders
  (documents-library.md), and that is the starting point. A conversation is one JSON file rewritten
  per turn, so concurrent turns in one thread on two devices would conflict; one active device per
  thread is the supported case.
- **Not on day one.** The phone work lands first. The desktop step is its own phase: a Work-root
  setting in Settings › Folders, the per-user hosting check, and outside-change handling for
  sessions.

## Phases

0. **Spike (a few days).** Measure on the iPhone 14 Pro Max and the S20 FE:
   - iCloud container round-trips, eviction and conflict behavior;
   - SAF throughput for the product's real write pattern (a session JSON per turn, a whole project
     created at once);
   - whether an *On My iPhone* folder really survives app deletion.
1. **Tiering in the store.** `storageTierFor` in core, the routing file system, and a second native
   root on iOS and Android. No migration: nothing has shipped.
2. **iOS Gezel folder.** iCloud default with picked-folder fallback, first-run restore, outside-change
   handling, conflict surfacing. Settings › Storage shows where the folder is and offers to move it.
3. **Android Gezel folder.** The SAF provider, the restore flow, write strategy per provider.
4. **Linked folders and Photos.** Project folder grants with re-grant UI. The Photos source with
   selected-items default and opt-in library access. Derived data in the device tier.
5. **Desktop Work root.** The desktop Store routes Work paths through `storageTierFor` to a
   configurable root, which can be the iCloud folder on a Mac.
6. **Hardening.** Interruption tests (kill during commit, uninstall during sync, provider offline,
   evicted file), backup and export paths updated, docs, and an ADR recording the tier split.

## Progress

- **Phase 1, done (2026-10-01):**
  - core: `storageTierFor` (`packages/core/src/storage-tiers.ts`) and `createTieredFileSystem`
    (`runtime/tiered-files.ts`). Tests cover routing, cross-tier rename and remove, and a fresh
    device root restoring its crew, projects and single shared library from an existing Gezel
    folder.
  - mobile host: `createRoutedProductFiles` asks the native side once (`productStorage`) and
    routes by tier only when a Work root exists.
- **Phase 2, iOS, in progress:**
  - `ProductFiles` has an iCloud mode: coordinated reads and writes, evicted placeholders listed
    under their real names, download before read.
  - The plugin resolves the Work root from the `iCloud.com.bendyline.gezel` container and takes a
    `root` option on all six file calls. `App/App.entitlements` and `NSUbiquitousContainers`
    ("Gezel") are in place.
  - Physical-device evals detach the Work root, so trials never reach a person's iCloud.
  - Verified on the iPhone 14 Pro Max (2026-10-01): a fresh install wrote its crew, projects and
    library into *iCloud Drive › Gezel*, and the Mac received them under
    `~/Library/Mobile Documents/iCloud~com~bendyline~gezel/Documents/` with the phone's layout.
- **Phase 3, Android:** `productStorage` answers `{ work: null }` until the SAF folder picker
  lands.

## Decisions (2026-10-01)

1. **Conversations are Work.**
2. **iOS defaults to iCloud Drive**, falling back to a picked folder when iCloud is off.
3. **The Mac may see and work in the same folder.** This is the desktop phase above.
4. **No migration.** Nothing has shipped.
5. **Share code paths with the desktop wherever possible.** One tier classifier, the same layout, the
   same outside-change rules.
