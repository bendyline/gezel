# 0007 — Gezel is the wallpaper rotator, applied from Electron main

Status: Accepted (2026-08)

## Context

The ambient dashboard feature has the meester periodically render a PNG
snapshot of the workshop (`AmbientDashboardGenerator`, writing dated files +
`latest.png` under `~/.gezel/ambient/`) and asks the host OS to show it
ambiently — wallpaper, and lock screen where feasible. Two architectural
questions had non-obvious answers.

**Who rotates?** The intuitive design — "write PNGs to a folder and configure
the OS to slideshow through it" — is not automatable on any supported OS in
2026:

- macOS: rotation ("change picture every N minutes") is Settings-UI-only; the
  wallpaper store (`~/Library/Application Support/com.apple.wallpaper/`) is
  undocumented and hostile to edits since Sonoma. Setting a *single* image via
  System Events AppleScript is the one supported-ish path.
- Windows: slideshow configuration means synthesizing `.theme` files or poking
  undocumented `Desktop Slideshow` registry blobs. A single image via
  `SystemParametersInfo(SPI_SETDESKWALLPAPER)` is stable, per-user, no admin.
- Linux: GNOME/KDE have no folder-rotation key (GNOME needs hand-built XML
  slideshow files). Single image via `gsettings` / `plasma-apply-wallpaperimage`
  is clean.

**Which process applies?** Wallpaper APIs are user-session state. The machine
engine broker (root/SYSTEM, session 0) can never touch them. The per-user
daemon usually can on macOS/Linux, but under `systemctl --user` it may lack
`DISPLAY`, and on macOS the TCC Automation prompt would attribute to the raw
node binary instead of Gezel.app — a trust-destroying dialog.

## Decision

1. **Gezel is the rotator.** The dashboard self-updates hourly anyway, so OS
   folder-rotation adds nothing: the Electron main process re-applies the
   newest PNG whenever the generator publishes an `ambient_dashboard` SSE
   event (plus catch-up checks at connection-ready and on `powerMonitor`
   resume). Manual folder-pointing survives as the always-available tier —
   the Settings card documents per-OS slideshow + lock-screen steps.
2. **Electron main is the only applier in v1** (`packages/app/src/ambient-display/`,
   contract + per-OS modules mirroring `autostart/`). Daemon-side apply for
   app-closed macOS/Linux is possible later (`DBUS_SESSION_BUS_ADDRESS` is
   derivable as `unix:path=$XDG_RUNTIME_DIR/bus` on systemd distros) but is
   deliberately deferred for the TCC-attribution reason above.
3. **Applies go through alternating slot files** (`applied-a.png` /
   `applied-b.png`), never `latest.png`: macOS and GNOME treat re-setting the
   currently-set path as a no-op even when the file content changed, so the
   applied path must differ every time. The slots also sit outside the
   generator's dated-file retention, so the file the OS references is never
   deleted from under it.
4. **Opt-in with restore.** `config.ambientDisplay.applyWallpaper` defaults
   off; the enable flow captures the current wallpaper (once — never
   overwritten on re-enable, so a double-enable can't save one of our own
   slots as "the user's wallpaper") into `display-state.json` and disable
   restores it. KDE has no read-back, so restore is honestly reported as
   unavailable there.
5. **Lock screen is documentation, not code.** macOS follows the desktop
   wallpaper since Sonoma (free win). Windows per-user lock-screen image has
   no public API (PersonalizationCSP is admin/MDM); the card points at
   Settings → Personalization → Lock screen → Slideshow. GNOME gets a
   best-effort `org.gnome.desktop.screensaver picture-uri` set alongside the
   wallpaper.

## Regression surface

- Applying `latest.png` directly (or "simplifying" the slots away) breaks
  silent-refresh on macOS/GNOME — the wallpaper freezes on the first image
  while everything appears to work.
- Retention in `AmbientDashboardGenerator.prune` must keep matching only
  `dashboard-*.png`; deleting `applied-*.png` yanks the live wallpaper file.
- The TCC prompt must originate from a user click (the enable IPC), not a
  background timer; see `gezel:ambient:enable` in main.ts.
- The generator never starts in the machine-engine role, and no wallpaper
  code may move into the daemon without revisiting the session/TCC caveats
  above (docs/service-boundaries.md rows).
