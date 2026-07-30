; Gezel NSIS installer hooks
;
; Registers gezeld as a machine-wide Windows service hosted by the
; first-party gezel-service-host (native/helpers/service-host/).  The
; service intentionally runs as LocalService, never LocalSystem: the daemon
; exposes a user-facing terminal, so its child processes must inherit a
; least-privileged token.
;
; State lives at C:\ProgramData\Gezel.  Its ACL has two distinct boundaries:
;   - the home itself is private to SYSTEM, Administrators, and the
;     per-service NT SERVICE\GezelService SID;
;   - runtime\ is additionally readable (never writable) by BUILTIN\Users so
;     desktop clients can discover port/cert/auth-token.
; runtime/auth-token is a non-root first-party client credential.  The daemon
; root token remains process-local.  Do not broaden the root data ACL merely
; to make client discovery convenient.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define GEZEL_SERVICE_NAME "GezelService"
!define GEZEL_DATA_DIR "C:\ProgramData\Gezel"
!define GEZEL_SERVICE_TREE "${GEZEL_DATA_DIR}\service"
!define GEZEL_INTERPRETER "$INSTDIR\Gezel.exe"
!define GEZEL_EXTRACT_CLI "$INSTDIR\resources\app.asar.unpacked\dist\extract-service-bundle.js"
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

; Stop/remove both current and legacy registrations via sc.exe.
; Missing-service errors are expected.  NSSM-era registrations are
; ordinary SCM services, so the same stop/delete path covers them.
!macro RemoveGezelService
  ; Quarantine first. If deletion later fails, SCM still cannot auto-start a
  ; partially configured legacy/default-LocalSystem registration on reboot.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" config ${GEZEL_SERVICE_NAME} start= disabled'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop ${GEZEL_SERVICE_NAME}'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete ${GEZEL_SERVICE_NAME}'
  Pop $0
  ; A successful delete is asynchronous when another process still holds an
  ; SCM handle.  Poll for bounded time before deciding that a legacy service
  ; survived.  sc.exe returns ERROR_SERVICE_DOES_NOT_EXIST (1060) only once
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
  Delete "${GEZEL_DATA_DIR}\runtime\lock"
!macroend

; Refuse any installer-owned path that is a symlink/junction/reparse point.
; A standard user can pre-create ProgramData children; following one while
; elevated would redirect ACL changes or bundle extraction to its target.
; GetFileAttributes returns -1 both when a path is absent and when inspection
; fails. Only FILE_NOT_FOUND/PATH_NOT_FOUND are safe for a not-yet-created
; child; access-denied and I/O failures must stop the elevated operation.
!macro RejectReparsePoint PATH DESCRIPTION FAILURE_LABEL
  System::Call 'kernel32::GetFileAttributesW(w "${PATH}") i .r0'
  ${If} $0 == -1
    System::Call 'kernel32::GetLastError() i .r1'
    ${If} $1 != 2
    ${AndIf} $1 != 3
      DetailPrint "ERROR: ${DESCRIPTION} could not be inspected safely (Win32 error $1)."
      MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not safely inspect ${PATH} (Windows error $1). No elevated service-data operation will be performed through that path."
      Goto ${FAILURE_LABEL}
    ${EndIf}
  ${Else}
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      DetailPrint "ERROR: ${DESCRIPTION} is a reparse point; refusing machine-service install."
      MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel found an unsafe reparse point at ${PATH}. The machine service will not be installed; remove or inspect that path before retrying."
      Goto ${FAILURE_LABEL}
    ${EndIf}
  ${EndIf}
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
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel found an unsafe reparse point below ${PATH}. The machine service will not be installed; remove or inspect that path before retrying."
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
  ; The runtimes key lives in the native 64-bit view; the installer is 32-bit.
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  SetRegView 32
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
      MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not install the Microsoft Visual C++ runtime (error $0). Gezel will still run, but local AI models may fail to start until you install the 'Microsoft Visual C++ 2015-2022 Redistributable (x64)'."
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

  DetailPrint "Installing least-privileged GezelService..."

  !insertmacro RemoveGezelService
  ${If} $9 != 1060
    DetailPrint "ERROR: the prior GezelService registration is still present (sc.exe exit $9)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not fully remove the prior machine service. It has been disabled and a replacement will not be installed; reboot or inspect the service before retrying."
    Goto SkipNssm
  ${EndIf}

  ${IfNot} ${FileExists} "${GEZEL_SERVICE_HOST}"
    DetailPrint "ERROR: gezel-service-host.exe is missing; the machine service cannot be registered."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel was built without gezel-service-host.exe. The machine service will not be installed; the desktop app will use its per-user fallback."
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
  ; Recursively replace legacy/attacker ownership and explicit child ACLs.
  ; /L operates on links themselves rather than traversing their targets.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /setowner "*S-1-5-32-544" /T /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to set a trusted owner on ${GEZEL_DATA_DIR} (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not take secure ownership of its machine-service data directory. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /reset /T /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to reset legacy ACLs under ${GEZEL_DATA_DIR} (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not remove legacy permissions from its machine-service data. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  ; Private root: SYSTEM + Administrators only until the per-service SID exists.
  ; Remove inherited/broad Users, Authenticated Users, Everyone, and generic
  ; LocalService grants.  Well-known SIDs keep this locale-independent.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" /remove:g "*S-1-5-32-545" "*S-1-5-11" "*S-1-1-0" "*S-1-5-19" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to harden ${GEZEL_DATA_DIR} ACL (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its machine-service data directory. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}
  ; POSIX-0711 equivalent: let desktop users traverse this exact directory to
  ; the known runtime path, but do not inherit the ACE and do not grant list,
  ; read-data, or write access on the private root.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /grant:r "*S-1-5-32-545:(X)" /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant traverse-only client access (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not configure safe client traversal to runtime discovery. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}
  ; The root may have been attacker-owned when the first check ran. Re-check
  ; after the no-follow ACL operations; the private DACL then closes the race
  ; before any child is created, deleted, or extracted through this path.
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}" "Gezel data directory" SkipNssm

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
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\logs" "Gezel logs directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\tmp" "Gezel temporary directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\appdata" "Gezel roaming application-data directory" SkipNssm
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\localappdata" "Gezel local application-data directory" SkipNssm
  ; Cleanup is deliberately after both the private-parent ACL and exact-path
  ; reparse checks.  Running Delete through an attacker-planted junction while
  ; elevated would otherwise turn upgrade cleanup into an arbitrary-file
  ; deletion primitive.
  !insertmacro ClearGezelRuntime
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\runtime" /setowner "*S-1-5-32-544"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to set a trusted runtime owner (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its machine-service runtime directory. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  ; Public immutable asset boundary. Users may traverse and read/execute
  ; published models, but cannot create, replace, or delete them. The service
  ; SID receives write access only after it exists below.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\assets" /setowner "*S-1-5-32-544" /T /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to set a trusted asset-store owner (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its shared model store. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\assets" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(RX)" /remove:g "*S-1-5-11" "*S-1-1-0" "*S-1-5-19" /T /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to apply the read-only asset-store ACL (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its shared model store. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  ; Client discovery boundary.  BUILTIN\Users receives read/execute only on
  ; runtime and its files.  It receives no access to config, secrets, gezels,
  ; projects, service code, or logs under the private parent.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\runtime" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(RX)" /remove:g "*S-1-5-11" "*S-1-1-0" "*S-1-5-19"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to apply the runtime discovery ACL (icacls exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not secure its machine-service runtime discovery directory. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  !insertmacro RejectReparsePoint "${GEZEL_SERVICE_TREE}" "Gezel service tree" SkipNssm
  !insertmacro RejectReparseDescendants "${GEZEL_SERVICE_TREE}" "Gezel service tree" SkipNssm
  DetailPrint "Extracting service bundle..."
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'
  nsExec::ExecToLog '"${GEZEL_INTERPRETER}" "${GEZEL_EXTRACT_CLI}" --tarball="${GEZEL_BUNDLE_TARBALL}" --meta="${GEZEL_BUNDLE_META}" --dest="${GEZEL_SERVICE_TREE}" --force'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0)i'
  ${If} $0 != 0
    DetailPrint "ERROR: service bundle extraction failed (exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not extract its machine-service bundle. The service will not be installed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  ; One atomic registration: born disabled AND born LocalService — no
  ; transient LocalSystem window (NSSM's default account) ever exists.
  ; The registration stays disabled until the SID, privilege, and ACL
  ; controls below all succeed.  The `\"` quoting yields an ImagePath of
  ; `"C:\...\gezel-service-host.exe" run` — quoted-with-spaces, not
  ; hijackable via C:\Program.exe.  sc.exe requires the space after each
  ; `option=`.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" create ${GEZEL_SERVICE_NAME} type= own start= disabled obj= "NT AUTHORITY\LocalService" DisplayName= "Gezel Service" binPath= "\"$INSTDIR\gezel-service-host.exe\" run"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: service registration failed (sc create exit $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not register its machine service. The desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  ; A restricted service SID makes the LocalService token write-restricted.
  ; Writes must be allowed to NT SERVICE\GezelService, not merely to the
  ; generic LocalService account.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" sidtype ${GEZEL_SERVICE_NAME} restricted'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to set restricted service SID (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not restrict its machine-service identity. The registration was removed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  ; LocalService normally carries privileges the daemon does not need,
  ; notably SeImpersonatePrivilege.  An arbitrary-command terminal must not
  ; inherit those.  Keep only traverse-change notification, which Node/NSSM
  ; need for ordinary filesystem path traversal.  An empty/failed required-
  ; privileges policy would silently restore the account default, so fail
  ; closed and remove the registration on any error.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" privs ${GEZEL_SERVICE_NAME} SeChangeNotifyPrivilege'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to restrict service privileges (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not remove unnecessary privileges from its machine service. The registration was removed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  ; Grant the per-service SID access to private state and separately to the
  ; protected runtime directory (which intentionally does not inherit).
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}" /grant:r "NT SERVICE\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant the service SID access to private state (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not grant its restricted service access to private state. The registration was removed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\runtime" /grant:r "NT SERVICE\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant the service SID access to runtime state (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not grant its restricted service access to runtime state. The registration was removed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "${GEZEL_DATA_DIR}\assets" /grant:r "NT SERVICE\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)" /T /L'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to grant the service SID access to shared assets (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not grant its restricted service access to shared model assets. The registration was removed; the desktop app will use its per-user fallback."
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
  ; above succeeded.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" config ${GEZEL_SERVICE_NAME} start= auto'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ERROR: failed to enable GezelService autostart (exit $0)."
    !insertmacro RemoveGezelService
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not enable its machine service. The registration was removed; the desktop app will use its per-user fallback."
    Goto SkipNssm
  ${EndIf}

  nsExec::ExecToLog '"$SYSDIR\sc.exe" start ${GEZEL_SERVICE_NAME}'
  Pop $0
  ${If} $0 != 0
    DetailPrint "WARNING: GezelService failed to start (exit $0); the desktop app will use its per-user fallback."
  ${Else}
    DetailPrint "GezelService installed under restricted LocalService."
  ${EndIf}

  SkipNssm:
!macroend

!macro customUnInstall
  DetailPrint "Removing GezelService..."
  !insertmacro RemoveGezelService
  ${If} $9 != 1060
    DetailPrint "WARNING: GezelService is still registered (sc.exe exit $9). It remains disabled; runtime cleanup was skipped."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Gezel could not fully remove its machine service. The registration was disabled, but it may require a reboot or administrator cleanup."
    Goto SkipUninstallRuntimeCleanup
  ${EndIf}
  ; Uninstall is elevated too.  Apply the same no-follow rule before deleting
  ; discovery credentials from a preserved data tree.
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}" "Gezel data directory" SkipUninstallRuntimeCleanup
  !insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\runtime" "Gezel runtime directory" SkipUninstallRuntimeCleanup
  !insertmacro ClearGezelRuntime
  SkipUninstallRuntimeCleanup:
  ; Preserve user data and the extracted service tree for recovery/migration.
  DetailPrint "GezelService removed. User data at ${GEZEL_DATA_DIR} preserved."
!macroend
