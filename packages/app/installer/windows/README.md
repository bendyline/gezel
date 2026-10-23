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

Relevant Windows contracts: [NtOpenFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntopenfile),
[NtSetSecurityObject](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetsecurityobject),
and [SetSecurityInfo propagation](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).
