; Gezel NSIS installer hooks
;
; Registers the machine-wide model engine hosted by the
; first-party gezel-service-host (native/helpers/service-host/).  The
; service intentionally runs as LocalService, never LocalSystem: native model
; engines and download helpers must inherit a least-privileged token.
;
; State lives at C:\ProgramData\Gezel.  Its ACL has two distinct boundaries:
;   - the home itself is private to SYSTEM, Administrators, and the
;     per-service NT SERVICE\GezelService SID;
;   - runtime\ is additionally readable (never writable) by BUILTIN\Users so
;     user daemons can discover port/cert/auth-token/service-role.
; runtime/auth-token is scoped to inference and model lifecycle.  Electron
; never receives it, and the daemon root token remains process-local.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define GEZEL_SERVICE_NAME "GezelService"
!define GEZEL_DATA_DIR "C:\ProgramData\Gezel"
!define GEZEL_SHARED_DIR "${GEZEL_DATA_DIR}\shared"

; Where customInstall records whether the shared model engine registered.
; Read by the desktop app (ordinary users can read HKLM) so a silent
; auto-update that lost the service can still be surfaced in the UI. Not under
; GEZEL_DATA_DIR: the failures worth recording are usually ACL problems in that
; very directory.
!define GEZEL_STATE_REGISTRY_KEY "Software\Bendyline\Gezel"
; Set to the sha of the bundle whose extracted tree this installer published
; for per-user daemons (see PublishServiceTree below).  HKLM because it is the
; attestation itself: ordinary users can read it and cannot forge it, so the
; supervisor can tell "an elevated installer of this exact build applied the
; published ACL" from "someone put a directory there".  Deleted before every
; publish attempt so a failed one can never be covered by a stale record.
!define GEZEL_PUBLISHED_TREE_VALUE "SharedServiceTreeSha"
!define GEZEL_SERVICE_TREE "${GEZEL_DATA_DIR}\service"
; Install-time maintenance is plain JavaScript and does not need Chromium.
; Use the independently signed Node runtime that already ships with the app
; instead of booting the Electron executable through ELECTRON_RUN_AS_NODE.
; Besides being smaller, this keeps Windows installer work outside Electron's
; sandbox/ICU startup path, whose process-level failures surface only as
; STATUS_BREAKPOINT (0x80000003) and previously forced a shared-engine fallback.
!define GEZEL_INTERPRETER "$INSTDIR\resources\app.asar.unpacked\dist\node-bundle\node.exe"
!define GEZEL_EXTRACT_CLI "$INSTDIR\resources\app.asar.unpacked\dist\extract-service-bundle.js"
!define GEZEL_MIGRATE_SHARED_CLI "$INSTDIR\resources\app.asar.unpacked\dist\migrate-legacy-shared.js"
!define GEZEL_BUNDLE_TARBALL "$INSTDIR\resources\app.asar.unpacked\dist\service-bundle.tar.gz"
!define GEZEL_BUNDLE_META "$INSTDIR\resources\app.asar.unpacked\dist\service-bundle.meta.json"
; The first-party service host is GezelService's ImagePath.  It spawns
; gezeld with the full service environment compiled in (see
; native/helpers/service-host/src/main.cpp) — the installer no longer
; carries the env/logging contract.  GEZEL_NSSM* are the retired NSSM
; wrapper names; upgrades over NSSM-era installs delete the stale files
; (their service registration is an ordinary SCM entry that
; RemoveGezelService's sc.exe path handles).
!define GEZEL_SERVICE_HOST "$INSTDIR\gezel-service-host.exe"
!define GEZEL_NSSM "$INSTDIR\gezel-nssm.exe"
!define GEZEL_NSSM_LEGACY "$INSTDIR\nssm.exe"

; Set only when this installer successfully stops an existing broker. Abort
; and failure callbacks use it to restart an intact registration; once the
; install takes ownership of the service lifecycle it is cleared.
Var GezelServiceStoppedForInstall

; The first-party service host gives gezeld 10 seconds to exit cleanly and
; then waits up to 2 more seconds after killing its job. Keep this budget
; comfortably above that complete ladder. A shorter installer wait can call
; `sc delete` while the service is still STOP_PENDING, which only marks the
; registration for later deletion and races an immediate reinstall/uninstall
; verification.
!define GEZEL_SERVICE_STOP_POLL_ATTEMPTS 40
!define GEZEL_SERVICE_STOP_POLL_INTERVAL_MS 500

; electron-builder 26's PowerShell app-running probe ignores the executable
; name and treats every process whose image lives below $INSTDIR as the app.
; An exact image-name check is not sufficient either: GezelService launches
; the same $INSTDIR\gezel.exe under ELECTRON_RUN_AS_NODE in Windows session 0.
; A silent uninstall would keep finding (and unsuccessfully killing) that
; supervised daemon, then exit before customUnInstall could stop the service.
;
; Desktop instances run in interactive sessions, so exclude session 0 from
; both detection and termination. The elevated customUnInstall hook remains
; the sole owner of the machine service lifecycle.
!macro FindGezelDesktopApp RETURN
  nsExec::Exec `"$CmdPath" /D /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FI "SESSION ne 0" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${RETURN}
!macroend

!macro customCheckAppRunning
  !insertmacro FindGezelDesktopApp $R0
  ${If} $R0 == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK GezelStopDesktopApp
    Quit

    GezelStopDesktopApp:
    DetailPrint "$(appClosing)"
    nsExec::ExecToLog `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /FI "SESSION ne 0"`
    Pop $R0
    Sleep 1000
    !insertmacro FindGezelDesktopApp $R0
    ${If} $R0 == 0
      nsExec::ExecToLog `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "SESSION ne 0"`
      Pop $R0
      Sleep 1000
      !insertmacro FindGezelDesktopApp $R0
      ${If} $R0 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY GezelStopDesktopApp
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Gracefully stop a registered service and wait (bounded) for STOPPED.
; `sc stop` only REQUESTS the stop; returning immediately used to leave the
; host running while electron-builder killed app processes and replaced
; files, so every upgrade logged event 7034 ("terminated unexpectedly") for
; a service that was actually healthy. `find` on the query output is the
; least-fragile completion check available to NSIS: sc.exe state tokens
; (STOPPED) are unlocalized. Callers must query first so a missing service
; never burns this macro's full twenty-second budget.
!macro WaitGezelServiceStopped
  StrCpy $8 0
  ${Do}
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C ""$SYSDIR\sc.exe" query ${GEZEL_SERVICE_NAME} | "$SYSDIR\find.exe" "STOPPED" >NUL"'
    Pop $9
    ${If} $9 == 0
      ${ExitDo}
    ${EndIf}
    IntOp $8 $8 + 1
    ${If} $8 >= ${GEZEL_SERVICE_STOP_POLL_ATTEMPTS}
      ${ExitDo}
    ${EndIf}
    Sleep ${GEZEL_SERVICE_STOP_POLL_INTERVAL_MS}
  ${Loop}
!macroend

; Stop only when the registration exists. Shared by the assisted install's
; InstFiles pre-hook and silent updates. The former runs after the user has
; accepted the installer flow but before electron-builder closes processes,
; uninstalls the old version, or replaces files. The latter has no assisted
; confirmation page; UAC has already authorized the elevated process before
; .onInit runs.
!macro StopGezelServiceForInstall
  nsExec::ExecToLog '"$SYSDIR\sc.exe" query ${GEZEL_SERVICE_NAME}'
  Pop $0
  ${If} $0 == 0
    nsExec::ExecToLog '"$SYSDIR\sc.exe" stop ${GEZEL_SERVICE_NAME}'
    Pop $0
    ${If} $0 == 0
      StrCpy $GezelServiceStoppedForInstall 1
    ${EndIf}
    !insertmacro WaitGezelServiceStopped
  ${EndIf}
!macroend

; Best-effort rollback for the narrow window after the committed stop but
; before the old registration is removed. If removal already quarantined the
; service with start=disabled, `sc start` safely refuses; if it was deleted,
; the existence query skips the attempt. Never recreate an old registration.
!macro RestartGezelServiceAfterAbortedInstall
  ${If} $GezelServiceStoppedForInstall == 1
    nsExec::ExecToLog '"$SYSDIR\sc.exe" query ${GEZEL_SERVICE_NAME}'
    Pop $0
    ${If} $0 == 0
      nsExec::ExecToLog '"$SYSDIR\sc.exe" start ${GEZEL_SERVICE_NAME}'
      Pop $0
    ${EndIf}
    StrCpy $GezelServiceStoppedForInstall 0
  ${EndIf}
!macroend

; electron-builder expands this immediately before MUI_PAGE_INSTFILES. Its
; PRE callback is therefore the last pre-install boundary in assisted mode:
; cancelling on the welcome/license pages leaves a healthy broker untouched.
; The intermediate BUILD_UNINSTALLER pass has no installer pages and treats
; an emitted but unreferenced function as an error, so omit this pair there.
!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE GezelBeforeInstall
!macroend

Function GezelBeforeInstall
  !insertmacro StopGezelServiceForInstall
FunctionEnd
!endif

; Silent auto-updates do not traverse the MUI page callbacks, so retain the
; orderly pre-file-replacement stop for that committed, non-interactive path.
!macro customInit
  ${If} ${Silent}
    !insertmacro StopGezelServiceForInstall
  ${EndIf}
!macroend

; Modern UI owns .onUserAbort and generates it when electron-builder inserts
; the language macros. Register our rollback through its supported hook so the
; generated wrapper and this include do not define the same NSIS callback.
!define MUI_CUSTOMFUNCTION_ABORT GezelOnUserAbort

Function GezelOnUserAbort
  !insertmacro RestartGezelServiceAfterAbortedInstall
FunctionEnd

Function .onInstFailed
  !insertmacro RestartGezelServiceAfterAbortedInstall
FunctionEnd

; Stop/remove both current and legacy registrations via sc.exe.
; Missing-service errors are expected.  NSSM-era registrations are
; ordinary SCM services, so the same stop/delete path covers them.
!macro RemoveGezelService
  ; A fresh install or fallback uninstall has no service. Preserve 1060 in
  ; $9 for callers and skip both bounded waits instead of idling for 10-40s.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" query ${GEZEL_SERVICE_NAME}'
  Pop $9
  ${If} $9 != 1060
    ; Quarantine first. If deletion later fails, SCM still cannot auto-start a
    ; partially configured legacy/default-LocalSystem registration on reboot.
    nsExec::ExecToLog '"$SYSDIR\sc.exe" config ${GEZEL_SERVICE_NAME} start= disabled'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\sc.exe" stop ${GEZEL_SERVICE_NAME}'
    Pop $0
    ; Deleting a service whose stop is still in flight marks it
    ; delete-pending and can strand the registration until reboot; wait for
    ; STOPPED first (the committed-install pre-hook usually made this instant).
    !insertmacro WaitGezelServiceStopped
    nsExec::ExecToLog '"$SYSDIR\sc.exe" delete ${GEZEL_SERVICE_NAME}'
    Pop $0
    ; A successful delete is asynchronous when another process still holds an
    ; SCM handle. Poll for bounded time before deciding that a legacy service
    ; survived. sc.exe returns ERROR_SERVICE_DOES_NOT_EXIST (1060) only once
    ; the registration is no longer queryable. Preserve the final result in $9.
    StrCpy $8 0
    ${Do}
      nsExec::ExecToLog '"$SYSDIR\sc.exe" query ${GEZEL_SERVICE_NAME}'
      Pop $9
      ${If} $9 == 1060
        ${ExitDo}
      ${EndIf}
      IntOp $8 $8 + 1
      ${If} $8 >= 30
        ${ExitDo}
      ${EndIf}
      Sleep 1000
    ${Loop}
  ${EndIf}
!macroend

; Remove stale discovery material after stopping a prior service.  Older
; releases wrote a root-equivalent token here; an upgrade must invalidate it
; before any new service registration is attempted.
!macro ClearGezelRuntime
  Delete "${GEZEL_DATA_DIR}\runtime\auth-token"
  Delete "${GEZEL_DATA_DIR}\runtime\web-ui-token"
  Delete "${GEZEL_DATA_DIR}\runtime\port"
  Delete "${GEZEL_DATA_DIR}\runtime\pid"
  Delete "${GEZEL_DATA_DIR}\runtime\cert.pem"
  Delete "${GEZEL_DATA_DIR}\runtime\cert-fingerprint"
  Delete "${GEZEL_DATA_DIR}\runtime\service-role"
  Delete "${GEZEL_DATA_DIR}\runtime\lock"
!macroend

; Refuse any installer-owned path that is a symlink/junction/reparse point.
; A standard user can pre-create ProgramData children; following one while
; elevated would redirect ACL changes or bundle extraction to its target.
; GetFileAttributes returns -1 both when a path is absent and when inspection
; fails. Only FILE_NOT_FOUND/PATH_NOT_FOUND are safe for a not-yet-created
; child; access-denied and I/O failures must stop the elevated operation.
;
; The last-error code MUST come from the System plugin's `?e` suffix, which
; reads it inside the same call. A separate `GetLastError()` System::Call is
; not atomic: the plugin's own marshalling between the two calls overwrites
; the thread's last error, so the check reads an unrelated leftover code.
; That shipped once and broke every *fresh* Windows install — the service
; tree is the one guarded path that legitimately does not exist yet, so it
; was the only one to take the -1 branch, where a stale ERROR_FILE_EXISTS (80)
; failed the != 2 / != 3 test and aborted the machine-service install.
!macro RejectReparsePoint PATH DESCRIPTION FAILURE_LABEL
  System::Call 'kernel32::GetFileAttributesW(w "${PATH}") i .r0 ?e'
  Pop $1
  ${If} $0 == -1
    ${If} $1 != 2
    ${AndIf} $1 != 3
      DetailPrint "ERROR: ${DESCRIPTION} could not be inspected safely (Win32 error $1)."
      MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not safely inspect ${PATH} (Windows error $1). No elevated service-data operation will be performed through that path." /SD IDOK
      Goto ${FAILURE_LABEL}
    ${EndIf}
  ${Else}
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      DetailPrint "ERROR: ${DESCRIPTION} is a reparse point; refusing machine-service install."
      MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel found an unsafe reparse point at ${PATH}. The shared model engine will not be installed; remove or inspect that path before retrying." /SD IDOK
      Goto ${FAILURE_LABEL}
    ${EndIf}
  ${EndIf}
!macroend

; Take Administrators ownership of one container.  Fails closed: an owner we
; do not trust can rewrite whatever DACL we set next.
;
; Two commands because icacls alone is not sufficient.  icacls never enables
; SeTakeOwnershipPrivilege, so /setowner only works where the object's
; existing DACL already grants the installer WRITE_OWNER — it returns access
; denied on a directory whose previous owner locked us out, which is exactly
; the pre-created-directory case this hardening exists for.  takeown.exe does
; enable the privilege, and /A assigns the Administrators group.  Try the
; cheap path first, then the privileged one.
!macro TakeTrustedOwnership PATH SUBJECT FAILURE_LABEL
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${PATH}" /setowner "*S-1-5-32-544" /L /Q'
  Pop $0
  ${If} $0 != 0
    DetailPrint "icacls could not take ownership of ${PATH} (exit $0); retrying with takeown."
    nsExec::ExecToLog '"$SYSDIR\takeown.exe" /F "${PATH}" /A'
    Pop $0
  ${EndIf}
  ${If} $0 != 0
    DetailPrint "ERROR: failed to set a trusted owner on ${PATH} (exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not take secure ownership of ${SUBJECT} (Windows error $0). The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto ${FAILURE_LABEL}
  ${EndIf}
!macroend

; Strip ownership and explicit ACEs from whatever a pre-created data
; directory already contained, so a planted child cannot keep granting its
; author access once the container is closed.
;
; Deliberately best-effort, and deliberately run before the container DACL is
; applied (/reset resets the named object too, so it would undo it).
; Recursive icacls fails as a whole for reasons that are ordinary inside a
; preserved GEZEL_HOME: without /C it stops at the first object it cannot
; open, and it cannot open a path over MAX_PATH at all — uv virtualenvs,
; cloned repos and sandbox node_modules all produce those, and a model file
; mapped by a leftover engine process produces the first.
;
; Aborting the machine-service install over one such file is not the safe
; outcome.  It drops the user onto the per-user daemon, which has no service
; isolation, no restricted SID and no private home — strictly weaker than
; this service with one stale child ACE.  The controls that actually bound
; the blast radius are the container's owner and DACL, and both of those
; still fail closed.
!macro SanitizeDescendants PATH SUBJECT
  ; /Q keeps a per-file success line out of the log, but a big preserved home
  ; still takes a while with real-time scanning on, so say what is happening.
  DetailPrint "Reviewing existing permissions under ${PATH}..."
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${PATH}" /setowner "*S-1-5-32-544" /T /C /L /Q'
  Pop $0
  ${If} $0 != 0
    DetailPrint "WARNING: some ${SUBJECT} entries kept a previous owner (icacls exit $0)."
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${PATH}" /reset /T /C /L /Q'
  Pop $0
  ${If} $0 != 0
    DetailPrint "WARNING: some ${SUBJECT} entries kept explicit permissions (icacls exit $0)."
  ${EndIf}
!macroend

; Publish the freshly-extracted service tree so every account's per-user
; daemon can EXECUTE this copy instead of unpacking a byte-identical second
; one into its own home.  That duplicate is the difference between one ~48k
; file extraction per machine and one per account — roughly three minutes of
; first launch each, since Defender scans every extracted file synchronously.
; Linux and macOS have published their trees since the shared-tree work
; landed; this is the Windows half of the same contract, and the supervisor
; side lives in supervisor/shared-service-tree.ts.
;
; READ is widened here, never WRITE.  The identical bytes are already readable
; by every local account inside $INSTDIR (resources\app.asar.unpacked\dist\
; service-bundle.tar.gz), so this discloses nothing new; write stays with
; SYSTEM, Administrators, and the service SID.  ${GEZEL_DATA_DIR} itself keeps
; its traverse-only Users ACE and remains unlistable, exactly as $DATA_DIR
; stays 0711 on Linux.
;
; Deliberately non-fatal, and deliberately quiet.  Publishing is an
; optimization: every failure below simply leaves the tree private, and each
; account falls back to extracting its own copy — today's behavior.  So this
; must not reuse TakeTrustedOwnership, which raises a modal and aborts the
; whole machine-service install.
;
; ORDERING: this runs AFTER extraction, and must.  The extractor commits by
; renaming a sibling staging directory over the destination, so the live tree
; is always a fresh object carrying only the ACEs it inherited from the
; private parent.  An ACE applied before extraction would be discarded by the
; very next upgrade.
!macro PublishServiceTree
  ; Withdraw any previous record first. Extraction has already replaced the
  ; tree with a fresh, private one, so a record surviving a failed publish
  ; below would tell the supervisor to adopt a tree it cannot even read.
  SetRegView 64
  DeleteRegValue SHELL_CONTEXT "${GEZEL_STATE_REGISTRY_KEY}" "${GEZEL_PUBLISHED_TREE_VALUE}"
  SetRegView lastused

  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_SERVICE_TREE}" /setowner "*S-1-5-32-544" /L /Q'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Service tree kept a previous owner (icacls exit $0); each account will extract its own copy."
    Goto GezelTreeUnpublished
  ${EndIf}

  ; Container ACE only — no /T.  The tree was just written by the extractor,
  ; so every child is pure-inheritance and picks (OI)(CI) up automatically;
  ; a recursive pass over ~48k files would cost more than the extraction this
  ; is meant to save.  Same reasoning the asset-store ACL relies on above.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_SERVICE_TREE}" /grant:r "*S-1-5-32-545:(OI)(CI)(RX)" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Could not publish the service tree (icacls exit $0); each account will extract its own copy."
    Goto GezelTreeUnpublished
  ${EndIf}

  ; Record which bundle was published.  Read from the extractor's own sentinel
  ; rather than re-deriving it: a sha256 is exactly 64 hex characters and is
  ; the first thing in the file, so a bounded FileRead needs no newline
  ; handling and cannot pick up a partially-written value.
  ClearErrors
  FileOpen $1 "${GEZEL_SERVICE_TREE}\.gezel-bundle.sha256" r
  ${If} ${Errors}
    DetailPrint "Published tree carries no bundle sentinel; each account will extract its own copy."
    Goto GezelTreeUnpublished
  ${EndIf}
  FileRead $1 $2 64
  FileClose $1
  StrLen $0 $2
  ${If} $0 != 64
    DetailPrint "Published tree has an unreadable bundle sentinel; each account will extract its own copy."
    Goto GezelTreeUnpublished
  ${EndIf}
  SetRegView 64
  WriteRegStr SHELL_CONTEXT "${GEZEL_STATE_REGISTRY_KEY}" "${GEZEL_PUBLISHED_TREE_VALUE}" "$2"
  SetRegView lastused
  DetailPrint "Published the shared service tree; per-user daemons will reuse it."

  GezelTreeUnpublished:
!macroend

; `dir /A:L` selects reparse-point entries. A zero exit code means at least
; one descendant exists. The tree itself is checked separately above; this
; closes the upgrade case where an old broadly-writable service directory
; contains a planted child junction before elevated recursive replacement.
!macro RejectReparseDescendants PATH DESCRIPTION FAILURE_LABEL
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C "dir /A:L /S /B \"${PATH}\" >NUL 2>&1"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "ERROR: ${DESCRIPTION} contains a reparse point; refusing machine-service install."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel found an unsafe reparse point below ${PATH}. The shared model engine will not be installed; remove or inspect that path before retrying." /SD IDOK
    Goto ${FAILURE_LABEL}
  ${EndIf}
!macroend

; Ensure the Microsoft Visual C++ 2015-2022 Redistributable is present.
;
; Every native engine we ship (ggml-base.dll, ggml-cpu.dll, llama.dll,
; whisper.dll, and the gezel-*-server.exe binaries) imports MSVCP140.dll,
; VCRUNTIME140.dll and VCRUNTIME140_1.dll.  Those are not Windows
; components; without the redistributable the loader fails each DLL before
; main(), so local models never start and the only symptom is a chat that
; won't answer.  Nothing guaranteed it before native-v0.1.18.
;
; Central deployment (running Microsoft's installer) rather than copying the
; DLLs next to the binaries: both are licensed, but a centrally installed
; runtime is serviced by Windows Update, while app-local copies freeze at
; build time.  Staged by packages/app/scripts/stage-vc-redist.mjs, which
; only accepts a Microsoft-signed binary from the build host's Visual Studio.
;
; This is best-effort by design.  Gezel's cloud providers work fine without
; a CRT, so a redist hiccup must not fail the whole install — it warns and
; continues, and only local-model support is affected.
!macro InstallVCRedist
  ; The runtimes key lives in the native 64-bit view. electron-builder's
  ; onInit already selects the 64-bit view on x64, so this bracket is
  ; defensive; the restore must be `lastused`, never a hardcoded view — the
  ; uninstaller's registry cleanup runs after our hooks and relies on the
  ; baseline view they leave behind.
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  SetRegView lastused
  ${If} $0 == 1
    DetailPrint "Microsoft Visual C++ runtime already present."
  ${Else}
!if /FileExists "${PROJECT_DIR}\dist\vc-redist\vc_redist.x64.exe"
    DetailPrint "Installing the Microsoft Visual C++ runtime (required by local model engines)..."
    ; $PLUGINSDIR is a temp dir NSIS deletes on exit, so the 25 MB payload
    ; does not linger under Program Files after the install completes.
    ; SetOutPath rather than File /oname= — /oname with a variable is not
    ; portable across NSIS versions. Restore $OUTDIR afterwards so later
    ; steps in customInstall still resolve relative paths under $INSTDIR.
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "${PROJECT_DIR}\dist\vc-redist\vc_redist.x64.exe"
    SetOutPath "$INSTDIR"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
    ; 0 = installed, 1638 = a newer runtime is already present, 3010 = ok
    ; but a reboot is pending. All three mean the CRT is usable.
    ${If} $0 == 0
    ${OrIf} $0 == 1638
    ${OrIf} $0 == 3010
      DetailPrint "Microsoft Visual C++ runtime ready (exit $0)."
    ${Else}
      DetailPrint "WARNING: the Visual C++ runtime installer returned $0."
      MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not install the Microsoft Visual C++ runtime (error $0). Gezel will still run, but local AI models may fail to start until you install the 'Microsoft Visual C++ 2015-2022 Redistributable (x64)'." /SD IDOK
    ${EndIf}
!else
    !warning "vc_redist.x64.exe was not staged - the installer will not provision the Visual C++ runtime. Run packages/app/scripts/stage-vc-redist.mjs before packaging (release CI sets GEZEL_VCREDIST_REQUIRED=1)."
    DetailPrint "Visual C++ runtime not bundled with this build; skipping."
!endif
  ${EndIf}
!macroend

!macro customInstall
  ; electron-builder records InstallLocation under its own INSTALL_REGISTRY_KEY
  ; (HKLM\SOFTWARE\<app guid>), which is what its upgrade detection reads back,
  ; but it never writes one into the Add/Remove Programs key.  Uninstall works
  ; without it — UninstallString carries the full path — yet Settings > Installed
  ; apps shows no location, and inventory tooling that reads ARP (winget, Intune,
  ; SCCM) sees a blank.  registryAddInstallInfo has already created this key by
  ; the time customInstall runs, so this only adds the missing value.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"

  !insertmacro InstallVCRedist

  ; No elevation check here on purpose: `perMachine: true` makes
  ; electron-builder emit `RequestExecutionLevel admin`, so Windows either
  ; elevated this process or never started it.  Everything below — SCM
  ; registration, ProgramData ownership, service-SID ACLs — can assume an
  ; administrator token, which is also why an access-denied result from any
  ; of them means something other than "the user is not an admin".
  DetailPrint "Installing least-privileged GezelService..."

  !insertmacro RemoveGezelService
  ; From here the old registration is either gone or deliberately
  ; quarantined; an installer abort must not try to revive it.
  StrCpy $GezelServiceStoppedForInstall 0
  ${If} $9 != 1060
    DetailPrint "ERROR: the prior GezelService registration is still present (sc.exe exit $9)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not fully remove the prior shared model engine. It has been disabled and a replacement will not be installed; reboot or inspect the service before retrying." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ${IfNot} ${FileExists} "${GEZEL_SERVICE_HOST}"
    DetailPrint "ERROR: gezel-service-host.exe is missing; the shared model engine cannot be registered."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel was built without gezel-service-host.exe. The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ${IfNot} ${FileExists} "${GEZEL_INTERPRETER}"
    DetailPrint "ERROR: bundled node.exe is missing; shared-engine maintenance cannot run."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel was built without its bundled Node.js runtime. The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ; Upgrades over NSSM-era installs leave the old wrapper behind (its
  ; service registration was already removed above; the files are unlocked).
  Delete "${GEZEL_NSSM}"
  Delete "${GEZEL_NSSM_LEGACY}"

  ; ProgramData permits ordinary users to create child directories.  Take
  ; trusted ownership first so a pre-created Gezel directory cannot retain an
  ; attacker owner who can rewrite its DACL after installation.
  CreateDirectory "${GEZEL_DATA_DIR}"
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}" "Gezel data directory" SkipNssm
  ; The container is the boundary, so its owner is the one ownership step
  ; that fails closed.  /L operates on links themselves rather than
  ; traversing their targets.
  !insertmacro TakeTrustedOwnership "${GEZEL_DATA_DIR}" "its machine-service data directory" SkipNssm
  !insertmacro SanitizeDescendants "${GEZEL_DATA_DIR}" "existing machine-service data"

  ; Private root: SYSTEM + Administrators only until the per-service SID exists.
  ; Remove inherited/broad Users, Authenticated Users, Everyone, and generic
  ; LocalService grants.  Well-known SIDs keep this locale-independent.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" /remove:g "*S-1-5-32-545" "*S-1-5-11" "*S-1-1-0" "*S-1-5-19" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to harden ${GEZEL_DATA_DIR} ACL (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its shared-engine data directory (Windows error $0). The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}
  ; POSIX-0711 equivalent: let desktop users traverse this exact directory to
  ; the known runtime path, but do not inherit the ACE and do not grant list,
  ; read-data, or write access on the private root.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /grant:r "*S-1-5-32-545:(X)" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant traverse-only client access (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not configure safe user-daemon access to engine discovery (Windows error $0). The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}
  ; The root may have been attacker-owned when the first check ran. Re-check
  ; after the no-follow ACL operations; the private DACL then closes the race
  ; before any child is created, deleted, or extracted through this path.
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}" "Gezel data directory" SkipNssm

  ${IfNot} ${FileExists} "${GEZEL_MIGRATE_SHARED_CLI}"
    DetailPrint "ERROR: migrate-legacy-shared.js is missing; legacy product data cannot be moved safely."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel was built without its shared-data migration tool. The shared model engine will not be changed, so existing machine-wide projects remain available through compatibility mode." /SD IDOK
    Goto SkipNssm
  ${EndIf}
  !insertmacro RejectReparsePoint "${GEZEL_SHARED_DIR}" "Gezel machine-shared data directory" SkipNssm
  DetailPrint "Migrating legacy machine-wide projects and gezels..."
  nsExec::ExecToLog '"${GEZEL_INTERPRETER}" "${GEZEL_MIGRATE_SHARED_CLI}" --source="${GEZEL_DATA_DIR}" --dest="${GEZEL_SHARED_DIR}"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: legacy shared-data migration failed (exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not safely migrate existing machine-wide projects (exit $0). Nothing was overwritten; the shared model engine will not be replaced until the migration can complete." /SD IDOK
    Goto SkipNssm
  ${EndIf}
  !insertmacro RejectReparsePoint "${GEZEL_SHARED_DIR}" "Gezel machine-shared data directory" SkipNssm

  ; The marker sits at the root under the private parent's traverse-only ACE,
  ; so users can read but cannot replace it. Product scope directories receive
  ; inherited Modify access and are operated on only by per-user daemons.
  !insertmacro TakeTrustedOwnership "${GEZEL_SHARED_DIR}" "its machine-shared product directory" SkipNssm
  !insertmacro SanitizeDescendants "${GEZEL_SHARED_DIR}" "machine-shared product"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_SHARED_DIR}" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(RX)" /remove:g "*S-1-5-11" "*S-1-1-0" "*S-1-5-19" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to protect the shared-data root (icacls exit $0)."
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_SHARED_DIR}\.gezel-machine-shared-v1.json" /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" "*S-1-5-32-545:(R)" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to publish the shared-data marker (icacls exit $0)."
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_SHARED_DIR}\projects" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(M)" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to publish shared projects (icacls exit $0)."
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_SHARED_DIR}\gezels" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(M)" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to publish shared gezels (icacls exit $0)."
    Goto SkipNssm
  ${EndIf}

  CreateDirectory "${GEZEL_DATA_DIR}\runtime"
  CreateDirectory "${GEZEL_DATA_DIR}\assets"
  CreateDirectory "${GEZEL_DATA_DIR}\assets\models"
  CreateDirectory "${GEZEL_DATA_DIR}\logs"
  CreateDirectory "${GEZEL_DATA_DIR}\tmp"
  CreateDirectory "${GEZEL_DATA_DIR}\appdata"
  CreateDirectory "${GEZEL_DATA_DIR}\localappdata"
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\runtime" "Gezel runtime directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\assets" "Gezel public asset directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\assets\models" "Gezel shared model directory" SkipNssm
  ; Exact-path checks are not enough for a preserved asset tree. A planted
  ; descendant junction would make the elevated ownership/ACL sweep below
  ; operate outside ProgramData even though the assets container itself is a
  ; normal directory. Refuse the machine broker before any recursive icacls.
  !insertmacro RejectReparseDescendants "${GEZEL_DATA_DIR}\assets" "Gezel shared asset store" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\logs" "Gezel logs directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\tmp" "Gezel temporary directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\appdata" "Gezel roaming application-data directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\localappdata" "Gezel local application-data directory" SkipNssm
  ; Cleanup is deliberately after both the private-parent ACL and exact-path
  ; reparse checks.  Running Delete through an attacker-planted junction while
  ; elevated would otherwise turn upgrade cleanup into an arbitrary-file
  ; deletion primitive.
  !insertmacro ClearGezelRuntime
  !insertmacro TakeTrustedOwnership "${GEZEL_DATA_DIR}\runtime" "its shared-engine runtime directory" SkipNssm

  ; Public immutable asset boundary. Users may traverse and read/execute
  ; published models, but cannot create, replace, or delete them. The service
  ; SID receives write access only after it exists below.
  !insertmacro TakeTrustedOwnership "${GEZEL_DATA_DIR}\assets" "its shared model store" SkipNssm
  !insertmacro SanitizeDescendants "${GEZEL_DATA_DIR}\assets" "published model"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\assets" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(RX)" /remove:g "*S-1-5-11" "*S-1-1-0" "*S-1-5-19" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to apply the read-only asset-store ACL (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its shared model store (Windows error $0). The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}
  ; No recursive pass here: SanitizeDescendants above already reset every
  ; reachable model back to pure inheritance, so the container ACEs — which
  ; are (OI)(CI) — propagate to them.

  ; User-daemon discovery boundary.  BUILTIN\Users receives read/execute only on
  ; runtime and its files.  It receives no access to config, secrets, gezels,
  ; projects, service code, or logs under the private parent.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\runtime" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(RX)" /remove:g "*S-1-5-11" "*S-1-1-0" "*S-1-5-19"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to apply the runtime discovery ACL (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its shared-engine discovery directory (Windows error $0). The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  !insertmacro RejectReparsePoint "${GEZEL_SERVICE_TREE}" "Gezel service tree" SkipNssm
  !insertmacro RejectReparseDescendants "${GEZEL_SERVICE_TREE}" "Gezel service tree" SkipNssm
  DetailPrint "Extracting service bundle..."
  nsExec::ExecToLog '"${GEZEL_INTERPRETER}" "${GEZEL_EXTRACT_CLI}" --tarball="${GEZEL_BUNDLE_TARBALL}" --meta="${GEZEL_BUNDLE_META}" --dest="${GEZEL_SERVICE_TREE}" --force'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: service bundle extraction failed (exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not extract its shared-engine bundle (exit code $0). The shared model engine will not be installed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  !insertmacro PublishServiceTree

  ; One atomic registration: born disabled AND born LocalService — no
  ; transient LocalSystem window (NSSM's default account) ever exists.
  ; The registration stays disabled until the SID, privilege, and ACL
  ; controls below all succeed.  The `\"` quoting yields an ImagePath of
  ; `"C:\...\gezel-service-host.exe" run` — quoted-with-spaces, not
  ; hijackable via C:\Program.exe.  sc.exe requires the space after each
  ; `option=`.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" create ${GEZEL_SERVICE_NAME} type= own start= disabled obj= "NT AUTHORITY\LocalService" DisplayName= "Gezel Shared Model Engine" binPath= "\"$INSTDIR\gezel-service-host.exe\" run"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: service registration failed (sc create exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not register its shared model engine (Windows error $0). Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ; A per-service SID puts NT SERVICE\GezelService in the token, which is what
  ; every ACL below grants.  It is load-bearing: without it the service holds
  ; only the generic LocalService identity, and the private home — which
  ; deliberately grants LocalService nothing — becomes unreadable to its own
  ; daemon.  So this step still fails closed.
  ;
  ; `unrestricted`, NOT `restricted`, and the difference is not cosmetic.
  ; `restricted` additionally makes the token *write-restricted*: every write
  ; is second-checked against {service SID, World, WRITE RESTRICTED, logon
  ; SID}, so a grant to BUILTIN\Users no longer satisfies it.  Node/libuv
  ; creates a named pipe per piped stdio handle before every CreateProcess,
  ; and that creation is a write into the NPFS namespace — which under the
  ; write-restricted token is denied.  The daemon could then spawn NOTHING:
  ; local engines, the GPU probes, the stdio MCP server, sandboxed scripts,
  ; pnpm toolset installs and git all died as `spawn EPERM`.
  ;
  ; Observed on two v1.26215.31 machines — the first release whose installer
  ; actually registered this service on a fresh install, so it is also the
  ; first release where anyone ran under the write-restricted token.  The
  ; daemon's own log named every one of them at once:
  ;   device-health helper: spawn EPERM; nvidia-smi: spawn EPERM;
  ;   amd-smi: spawn EPERM; rocm-smi: spawn EPERM
  ; and `sc.exe sidtype GezelService unrestricted` + restart fixed all of it.
  ;
  ; Note what this does NOT give up.  The service keeps its own SID, keeps
  ; LocalService, keeps the stripped privilege set below, and keeps the
  ; private ProgramData home — those are the controls that bound the blast
  ; radius.  Write-restriction bought hardening against a *compromised*
  ; daemon writing outside its home; it cost the daemon its ability to run
  ; any child process at all, which is most of what the product does.
  ; Do not set `restricted` again without a per-user execution broker.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" sidtype ${GEZEL_SERVICE_NAME} unrestricted'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to set the per-service SID (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not give its shared model engine a dedicated identity (Windows error $0). The registration was removed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ; LocalService normally carries privileges the daemon does not need,
  ; notably SeImpersonatePrivilege.  Native engine/download children must not
  ; inherit those.  Keep only traverse-change notification, which Node needs
  ; for ordinary filesystem path traversal.  An empty/failed required-
  ; privileges policy would silently restore the account default, so fail
  ; closed and remove the registration on any error.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" privs ${GEZEL_SERVICE_NAME} SeChangeNotifyPrivilege'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to restrict service privileges (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not remove unnecessary privileges from its shared model engine (Windows error $0). The registration was removed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ; Grant the per-service SID access to private state and separately to the
  ; protected runtime directory (which intentionally does not inherit).
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /grant:r "NT SERVICE\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant the service SID access to private state (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not grant its restricted model engine access to private state (Windows error $0). The registration was removed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\runtime" /grant:r "NT SERVICE\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant the service SID access to runtime state (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not grant its restricted model engine access to runtime state (Windows error $0). The registration was removed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}
  ; Two ACEs, and the second one is load-bearing.
  ;
  ; The asset store is public-read by design: BUILTIN\Users gets (OI)(CI)(RX)
  ; above so per-user daemons and standalone CLI runs can reuse whatever the
  ; broker downloaded.  A model bundle only reaches that state if something
  ; re-inherits it: NTFS keeps a directory's explicit DACL across a rename
  ; within the volume, so a bundle moved in from the broker's private staging
  ; area (or from the pre-asset-store private model tree) arrives carrying its
  ; old private ACL and stays invisible to every other account.  gezeld fixes
  ; that with `icacls <model> /reset /T` — see makeSharedModelReadable in
  ; packages/service/src/models/storage-roots.ts.
  ;
  ; `/reset` REWRITES A DACL, so it needs WRITE_DAC, and Modify does not
  ; include WRITE_DAC.  With (M) alone the broker could not publish any bundle
  ; whose owner it does not hold — and SanitizeDescendants above has just made
  ; BUILTIN\Administrators the owner of every pre-existing model.  On an
  ; upgrade over an install that already had models, every publish attempt
  ; therefore failed with "Access is denied", makeSharedModelReadable threw out
  ; of startService, and the service crash-looped on SCM 1066 forever.  Fresh
  ; installs were unaffected (nothing to migrate, and the broker owns what it
  ; downloads itself), which is exactly why CI never saw it.
  ;
  ; (IO) — inherit-only — keeps the fix scoped.  The FullControl ACE applies to
  ; DESCENDANTS ONLY, so the broker can re-inherit model subtrees while the
  ; `assets` container's own DACL stays outside its reach; a compromised daemon
  ; still cannot rewrite the boundary that makes this store read-only to users.
  ; The (M) ACE is what covers the container itself, so creating and deleting
  ; bundles under assets\models keeps working.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\assets" /grant:r "NT SERVICE\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)" "NT SERVICE\${GEZEL_SERVICE_NAME}:(OI)(CI)(IO)(F)" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant the service SID access to shared assets (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not grant its restricted model engine access to shared model assets (Windows error $0). The registration was removed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ; The service environment (GEZEL_SYSTEM_SCOPE=1, GEZEL_HOME, temp/profile
  ; redirects), working directory, and stdout/stderr log redirection with
  ; rotation are all compiled into gezel-service-host — see env_overrides in
  ; native/helpers/service-host/src/main.cpp, guarded by its --self-test.
  ; The installer configures only the SCM-side registration.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" description ${GEZEL_SERVICE_NAME} "Local-first AI gezels service. Hosts the API and tools used by the Gezel desktop app."'
  Pop $0

  ; Enabling autostart is deliberately the LAST mutating step: the service
  ; becomes startable only after every account/SID/privilege/ACL control
  ; above succeeded. Re-check the complete writable asset boundary here too:
  ; this closes the interval between the pre-sanitize check and startup, and
  ; prevents a descendant reparse point from ever becoming broker-writable.
  !insertmacro RejectReparseDescendants "${GEZEL_DATA_DIR}\assets" "Gezel shared asset store" RemoveUnsafeGezelService
  nsExec::ExecToLog '"$SYSDIR\sc.exe" config ${GEZEL_SERVICE_NAME} start= auto'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to enable GezelService autostart (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not enable its shared model engine (Windows error $0). The registration was removed; Gezel will use an account-local model engine." /SD IDOK
    Goto SkipNssm
  ${EndIf}

  ; A registration that cannot start is not a working machine engine, and the
  ; breadcrumb below is the app's ONLY signal that the shared broker is absent.
  ; Recording "installed" purely because `sc create` succeeded made the one
  ; control designed to surface a missing engine report health while the
  ; service crash-looped: MachineServiceInstalled stayed 1, machineServiceMissing()
  ; in packages/app/src/supervisor/index.ts only fires on a positive 0, and the
  ; UI said nothing at all. Treat the start result as the outcome that matters.
  ;
  ; `sc start` returns before the service reaches RUNNING, so a service that
  ; dies during startup still exits 0 here. Re-query after a bounded wait and
  ; believe the state, not the launch call.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start ${GEZEL_SERVICE_NAME}'
  Pop $0
  ${If} $0 != 0
    DetailPrint "WARNING: GezelService failed to start (exit $0); Gezel will use an account-local model engine."
    Goto SkipNssm
  ${EndIf}
  StrCpy $8 0
  ${Do}
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C ""$SYSDIR\sc.exe" query ${GEZEL_SERVICE_NAME} | "$SYSDIR\find.exe" "RUNNING" >NUL"'
    Pop $9
    ${If} $9 == 0
      ${ExitDo}
    ${EndIf}
    IntOp $8 $8 + 1
    ${If} $8 >= 30
      ${ExitDo}
    ${EndIf}
    Sleep 1000
  ${Loop}
  ${If} $9 != 0
    DetailPrint "WARNING: GezelService was registered but did not reach RUNNING; Gezel will use an account-local model engine."
    Goto SkipNssm
  ${EndIf}
  DetailPrint "GezelService installed under restricted LocalService."

  ; Registered AND running. Clear any breadcrumb a prior failed install left
  ; behind so the app stops reporting a fallback that no longer applies.
  ; 64-bit view explicitly, so the 64-bit Electron app finds the key even if
  ; a caller changed the view. Restores are `lastused`, never a hardcoded
  ; view: electron-builder's un.onInit sets the 64-bit baseline and its own
  ; uninstall-key cleanup runs AFTER customUnInstall — restoring 32 here left
  ; that cleanup deleting nonexistent Wow6432Node keys, orphaning the
  ; Add/Remove Programs entry on every full uninstall.
  SetRegView 64
  WriteRegDWORD SHELL_CONTEXT "${GEZEL_STATE_REGISTRY_KEY}" "MachineServiceInstalled" 1
  SetRegView lastused
  Goto DoneNssm

  RemoveUnsafeGezelService:
  !insertmacro RemoveGezelService
  Goto SkipNssm

  SkipNssm:
  ; Record that this install fell back to the per-user daemon.
  ;
  ; Most paths reaching this label have already shown the user a dialog. The
  ; two startup paths above deliberately have not: a registration that did not
  ; come up is recoverable on the next boot (it stays `start= auto`) and the app
  ; degrades cleanly to its per-user daemon, so a modal would be noise. They
  ; still have to land here, because the flag is what the app reads.
  ;
  ; And no path shows a dialog under `/S` — electron-updater runs the NSIS
  ; installer silently for every Windows auto-update, and NSIS skips MessageBox
  ; entirely in silent mode. Without this an update can delete a working shared
  ; model engine, fail to replace it, and leave no dialog, no service, and no
  ; trace. The user just gets slow launches and no background work.
  ;
  ; HKLM rather than a marker file under GEZEL_DATA_DIR on purpose: the
  ; failures that land here are usually ACL or ownership problems in exactly
  ; that directory, so it is the one place that cannot be trusted to accept a
  ; write. Ordinary users can read this key without elevation.
  ; The failing version is already recorded as DisplayVersion under the
  ; uninstall key, so the flag alone is enough to describe the state.
  SetRegView 64
  WriteRegDWORD SHELL_CONTEXT "${GEZEL_STATE_REGISTRY_KEY}" "MachineServiceInstalled" 0
  SetRegView lastused
  DoneNssm:
!macroend

!macro customUnInstall
  DetailPrint "Removing GezelService..."
  !insertmacro RemoveGezelService
  ${If} $9 != 1060
    DetailPrint "WARNING: GezelService is still registered (sc.exe exit $9). It remains disabled; runtime cleanup was skipped."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not fully remove its shared model engine. The registration was disabled, but it may require a reboot or administrator cleanup." /SD IDOK
    Goto SkipUninstallRuntimeCleanup
  ${EndIf}
  ; Uninstall is elevated too.  Apply the same no-follow rule before deleting
  ; discovery credentials from a preserved data tree.
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}" "Gezel data directory" SkipUninstallRuntimeCleanup
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\runtime" "Gezel runtime directory" SkipUninstallRuntimeCleanup
  !insertmacro ClearGezelRuntime

  ; Shared models survive uninstall so standalone app/CLI runs can keep using
  ; them. Re-publish their inherited read-only ACL after the broker has
  ; stopped: directories atomically moved out of the broker's private staging
  ; area retain that private DACL on NTFS, even though their destination is
  ; below the public assets container. Without this final elevated repair the
  ; model ids are visible, but ordinary users cannot open manifest.json.
  ${If} ${FileExists} "${GEZEL_DATA_DIR}\assets\*.*"
    !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\assets" "Gezel public asset directory" SkipUninstallRuntimeCleanup
    !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\assets\models" "Gezel shared model directory" SkipUninstallRuntimeCleanup
    !insertmacro RejectReparseDescendants "${GEZEL_DATA_DIR}\assets" "Gezel shared asset store" SkipUninstallRuntimeCleanup
    !insertmacro TakeTrustedOwnership "${GEZEL_DATA_DIR}\assets" "its preserved shared model store" SkipUninstallRuntimeCleanup
    !insertmacro SanitizeDescendants "${GEZEL_DATA_DIR}\assets" "preserved shared model"
    nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\assets" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(RX)" /remove:g "*S-1-5-11" "*S-1-1-0" "*S-1-5-19" /L'
    Pop $0
    ${If} $0 != 0
      DetailPrint "WARNING: shared models were preserved, but their standalone read permissions could not be repaired (icacls exit $0)."
      MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel preserved the shared models, but could not make them readable to standalone app or CLI runs (Windows error $0). An administrator may need to repair permissions under ${GEZEL_DATA_DIR}\assets." /SD IDOK
    ${EndIf}
  ${EndIf}
  SkipUninstallRuntimeCleanup:
  ; The service is gone by design now, so the install-state breadcrumb must go
  ; with it — leaving it behind would make the next fresh install look like it
  ; had already failed. User data is deliberately preserved; this key is not
  ; user data.
  ;
  ; This also withdraws ${GEZEL_PUBLISHED_TREE_VALUE}, which is what stops the
  ; supervisor adopting the preserved service tree after uninstall. The tree's
  ; read ACE is deliberately left alone rather than re-privatized: it holds
  ; daemon code, not user data, and the same bytes were readable to every
  ; account under $INSTDIR until a moment ago. Removing the attestation is the
  ; control; the ACL is not load-bearing once no build claims that sha.
  SetRegView 64
  DeleteRegKey SHELL_CONTEXT "${GEZEL_STATE_REGISTRY_KEY}"
  SetRegView lastused
  ; Preserve shared models, engine state, and any legacy data for recovery.
  DetailPrint "GezelService removed. Shared model and legacy data at ${GEZEL_DATA_DIR} preserved."
!macroend
