# Windows installer ACL repair

`reset-tree-acl.ps1` loads `ResetTreeAcl.cs` from the installed, administrator-
protected application directory. Both ship with the Electron release, rather
than the separately pinned engine release. Windows PowerShell/.NET Framework
are OS components; no download or dependency installation occurs. A blocked
PowerShell/compiler invocation fails the machine-engine installation closed.
The launcher restricts module loading to Windows PowerShell's own modules and
places compiler scratch files beside the helper in the protected installation
directory, never in the invoking user's writable TEMP directory.

The old `icacls /setowner /T` and `/reset /T` commands could follow a junction
inserted after the link preflight. Another preflight cannot close that race.
The replacement has these invariants:

- Open the root with `OBJ_DONT_REPARSE`; refuse a link in any root component.
- Enumerate using `NtQueryDirectoryFile` on an open directory handle. Child
  names are single validated components, opened relative to that same handle.
- Use `FILE_OPEN_REPARSE_POINT` and inspect the resulting handle. Repair a
  link's own descriptor but never enumerate or open its target. This preserves
  legitimate pnpm and uv links; the separate link policy still rejects/removes
  unsafe links before service startup.
- Retain each ancestor handle during traversal, with neither write nor delete
  sharing. An already-open mutable object fails repair. A directory cannot be
  replaced or converted to a junction after its handle was checked.
- Refuse multiply linked files before changing permissions, so an in-tree
  name cannot alias a pre-existing outside file. Opening a handle pins object
  identity, not all names: adding a new name for that same in-tree object does
  not redirect the operation to a different object.
- Use `NtSetSecurityObject` to change only the opened object. High-level ACL
  APIs can trigger their own propagation, bypassing the controlled traversal.
- Close the root to SYSTEM/Administrators and reset descendants to inherited
  versions of that policy. Only after a successful repair does NSIS publish
  the intended runtime, model, and shared-product boundary ACLs.
- Fail on any incomplete repair. Do not fall back to recursive shell commands
  or continue with an attacker-owned/uninspectable descendant. Close programs
  holding the affected tree and retry; hard links need separate investigation.

Backup and restore privileges let the elevated installer open old protected
objects without invoking path-based `takeown` between inspection and mutation.
The helper does not change the service's privileges or execution identity.

`windows-acl.test.ts` runs the real Windows APIs against disposable fixtures,
including deterministic swaps before/after opening, pre-existing hard links, held
writers, root/ancestor links, cycles, normal inheritance, and outside-target
ACL preservation. It also proves that the low-level mutation does not silently
walk children. On an elevated runner it executes the production launcher with
Administrators ownership and a locked-down child. Other hosts skip the syscall
tests explicitly. The Windows release workflow runs them before packaging.

## Keeping a sealed service tree

On an upgrade the data-root repair leaves `service\` as it is when it is still
sealed as `PublishServiceTree` left it: Administrators own it, its DACL is
protected, no ACE outside SYSTEM and Administrators grants a write, delete,
permission or ownership right (inherit-only ACEs included), and the first 64
bytes of its `.gezel-bundle.sha256` equal the attestation the installer read
from `HKLM\Software\Bendyline\Gezel` in `customInit`. It has to be read there:
the old uninstaller an upgrade runs deletes that key before `customInstall`.
The helper decides on the child handle it already pinned, and opens the
sentinel relative to it without following links; a link, hard link, missing or
different sentinel, or any looser DACL gets the full repair. The extractor
commits every tree as a fresh object under the private root, so a tree in that
state can only have been changed by an administrator. Re-securing its ~48k
entries was six of an upgrade's nine minutes on Windows on ARM, spent just
before extraction replaced the tree.

## Service SID grants

`grant-service-sid.ps1` gives `GezelService`'s per-service SID its four
directory grants (data root, `runtime`, `assets`, the published service tree).
icacls cannot do this reliably: it looks every trustee up, even one written as
`*S-1-5-80-...`. After an upgrade deletes and re-creates the service,
`NT SERVICE\GezelService` can stop resolving; on Windows 11 build 28000 every
grant failed with 1332 and the installer removed the service. The script
derives the SID from the service name (SHA-1 of the upper-cased UTF-16LE name,
the value `sc.exe showsid` prints and the service token carries), replaces that
SID's explicit ACEs as `/grant:r` does, and refuses a reparse point as its
target. Inheritable ACEs propagate through `SetNamedSecurityInfo` exactly as
they did under icacls; the descendant link checks in the installer still run
before any grant and again before startup.

Relevant Windows contracts: [NtOpenFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntopenfile),
[NtSetSecurityObject](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetsecurityobject),
and [SetSecurityInfo propagation](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).
