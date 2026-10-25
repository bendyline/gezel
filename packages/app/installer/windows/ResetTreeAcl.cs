// Installer-only Windows ACL repair. All enumeration and mutation is relative
// to pinned directory handles; a path preflight is never an authorization check.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Gezel.Installer
{
    public static class ResetTreeAcl
    {
        const uint ReadControl = 0x20000, WriteDac = 0x40000, WriteOwner = 0x80000;
        const uint Synchronize = 0x100000, ReadAttributes = 0x80, ListDirectory = 1;
        const uint ShareRead = 1, OpenReparsePoint = 0x200000, BackupIntent = 0x4000;
        const uint Synchronous = 0x20, CaseInsensitive = 0x40, DontReparse = 0x1000;
        const uint Directory = 0x10, ReparsePoint = 0x400;
        const uint OwnerSecurity = 1, DaclSecurity = 4;
        const uint ProtectedDacl = 0x80000000, UnprotectedDacl = 0x20000000;
        const int NoMoreFiles = unchecked((int)0x80000006);
        const int BufferTooSmall = unchecked((int)0xC0000023);
        // Write, append, extended-attribute and attribute writes, delete,
        // delete-child, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE and GENERIC_ALL:
        // any one of them lets its holder change a tree.
        const int WriteMask = 0x500D0156;
        const string SentinelName = ".gezel-bundle.sha256";

        [StructLayout(LayoutKind.Sequential)]
        struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)]
        struct ObjectAttributes
        {
            public uint Length;
            public IntPtr RootDirectory, ObjectName;
            public uint Attributes;
            public IntPtr SecurityDescriptor, SecurityQualityOfService;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoStatus { public IntPtr Status, Information; }
        [StructLayout(LayoutKind.Sequential)]
        struct FileInfo
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct Luid { public uint Low; public int High; }
        [StructLayout(LayoutKind.Sequential)]
        struct TokenPrivilege { public uint Count; public Luid Luid; public uint Attributes; }

        [DllImport("ntdll.dll")]
        static extern int NtOpenFile(out SafeFileHandle handle, uint access,
            ref ObjectAttributes attributes, out IoStatus status, uint share, uint options);
        [DllImport("ntdll.dll")]
        static extern int NtQueryDirectoryFile(SafeFileHandle handle, IntPtr evt, IntPtr apc,
            IntPtr context, out IoStatus status, IntPtr buffer, uint length, int infoClass,
            [MarshalAs(UnmanagedType.U1)] bool single, IntPtr name,
            [MarshalAs(UnmanagedType.U1)] bool restart);
        [DllImport("ntdll.dll")]
        static extern int NtSetSecurityObject(SafeFileHandle handle, uint information, byte[] descriptor);
        [DllImport("ntdll.dll")]
        static extern int NtQuerySecurityObject(SafeFileHandle handle, uint information,
            byte[] descriptor, uint length, out uint needed);
        [DllImport("ntdll.dll")]
        static extern uint RtlNtStatusToDosError(int status);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint count,
            out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool AdjustTokenPrivileges(SafeFileHandle token, bool disable,
            ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returned);

        static void Check(int status, string operation)
        {
            if (status < 0)
                throw new Win32Exception((int)RtlNtStatusToDosError(status),
                    operation + " (NTSTATUS 0x" + status.ToString("X8") + ")");
        }

        // Backup/restore privileges are available to the elevated installer.
        // Tests call Run directly on their own files without them. The
        // production launcher must fail before mutation if either is absent.
        public static void EnablePrivileges()
        {
            SafeFileHandle token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            using (token)
            {
                foreach (string name in new[] { "SeBackupPrivilege", "SeRestorePrivilege" })
                {
                    Luid luid;
                    if (!LookupPrivilegeValue(null, name, out luid))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    var state = new TokenPrivilege { Count = 1, Luid = luid, Attributes = 2 };
                    if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    int error = Marshal.GetLastWin32Error();
                    if (error != 0) throw new Win32Exception(error, "Cannot enable " + name);
                }
            }
        }

        static SafeFileHandle Open(IntPtr parent, string name, bool root)
        {
            if (!root && (name.Length == 0 || name == "." || name == ".." ||
                name.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0))
                throw new IOException("Invalid directory entry");
            IntPtr text = Marshal.StringToHGlobalUni(name);
            IntPtr unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            try
            {
                var str = new UnicodeString {
                    Length = checked((ushort)(name.Length * 2)),
                    MaximumLength = checked((ushort)(name.Length * 2)), Buffer = text
                };
                Marshal.StructureToPtr(str, unicode, false);
                var attributes = new ObjectAttributes {
                    Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)), RootDirectory = parent,
                    // Enumerated children use exact names, including on NTFS
                    // directories with WSL case sensitivity enabled.
                    ObjectName = unicode, Attributes = root ? CaseInsensitive | DontReparse : 0
                };
                SafeFileHandle handle;
                IoStatus status;
                // Deny write and delete sharing: replacement, conversion into a
                // junction, and pre-existing mutable handles must fail, not race.
                int result = NtOpenFile(out handle,
                    ReadControl | WriteDac | WriteOwner | ReadAttributes | ListDirectory | Synchronize,
                    ref attributes, out status, ShareRead, OpenReparsePoint | BackupIntent | Synchronous);
                if (result < 0)
                {
                    if (handle != null) handle.Dispose();
                    Check(result, "Cannot pin " + name);
                }
                return handle;
            }
            finally { Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
        }

        static byte[] Descriptor(string owner, bool directory, bool root)
        {
            // Reset to a closed, known policy, not the possibly attacker-owned
            // parent's DACL. NSIS publishes the intended runtime/assets/shared
            // boundaries only after every reachable object is repaired.
            string flags = directory ? "OICI" : "";
            if (!root) flags += "ID";
            string sddl = "O:" + owner + "D:" + (root ? "P" : "AI") +
                "(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;" + owner + ")";
            var security = new RawSecurityDescriptor(sddl);
            byte[] bytes = new byte[security.BinaryLength];
            security.GetBinaryForm(bytes, 0);
            return bytes;
        }

        static bool IsSha256(string text)
        {
            if (text == null || text.Length != 64) return false;
            foreach (char c in text)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')))
                    return false;
            return true;
        }

        static byte[] QuerySecurity(SafeFileHandle handle, uint information, string display)
        {
            byte[] buffer = new byte[4096];
            uint needed;
            int status = NtQuerySecurityObject(handle, information, buffer, (uint)buffer.Length, out needed);
            if (status == BufferTooSmall)
            {
                buffer = new byte[needed];
                status = NtQuerySecurityObject(handle, information, buffer, needed, out needed);
            }
            Check(status, "Cannot inspect " + display);
            return buffer;
        }

        static bool SentinelMatches(SafeFileHandle tree, string sealedSha)
        {
            SafeFileHandle sentinel;
            try { sentinel = Open(tree.DangerousGetHandle(), SentinelName, false); }
            catch (Win32Exception) { return false; }
            using (sentinel)
            {
                FileInfo info;
                if (!GetFileInformationByHandle(sentinel, out info)) return false;
                if ((info.Attributes & (Directory | ReparsePoint)) != 0 || info.Links != 1) return false;
                byte[] text = new byte[64];
                int total = 0;
                while (total < text.Length)
                {
                    byte[] chunk = new byte[text.Length - total];
                    uint read;
                    if (!ReadFile(sentinel, chunk, (uint)chunk.Length, out read, IntPtr.Zero) || read == 0)
                        break;
                    Array.Copy(chunk, 0, text, total, (int)read);
                    total += (int)read;
                }
                if (total != text.Length) return false;
                string value = Encoding.ASCII.GetString(text);
                return IsSha256(value) && string.Equals(value, sealedSha, StringComparison.OrdinalIgnoreCase);
            }
        }

        // An upgrade's previous service tree, still as the installer published
        // it: owned by the trusted owner, its DACL protected, writable by no one
        // but SYSTEM and that owner, and its sentinel naming the bundle the
        // installer attested. The extractor commits every tree as a fresh
        // object under the private root, so since then only an administrator
        // could have changed anything inside it. Re-securing its ~48k entries
        // cost six minutes of every upgrade, just before the tree is replaced.
        static bool IsSealedTree(SafeFileHandle handle, string display, string owner, string sealedSha)
        {
            FileInfo info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), display);
            if ((info.Attributes & Directory) == 0 || (info.Attributes & ReparsePoint) != 0) return false;
            var trusted = new SecurityIdentifier(owner);
            var system = new SecurityIdentifier("S-1-5-18");
            var security = new RawSecurityDescriptor(
                QuerySecurity(handle, OwnerSecurity | DaclSecurity, display), 0);
            if (security.Owner == null || !security.Owner.Equals(trusted)) return false;
            if ((security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0) return false;
            // A null DACL grants everyone everything.
            if (security.DiscretionaryAcl == null) return false;
            foreach (GenericAce ace in security.DiscretionaryAcl)
            {
                var known = ace as CommonAce;
                if (known == null) return false;
                if (known.AceQualifier == AceQualifier.AccessDenied) continue;
                if (known.AceQualifier != AceQualifier.AccessAllowed) return false;
                if (known.SecurityIdentifier.Equals(trusted) || known.SecurityIdentifier.Equals(system)) continue;
                if ((known.AccessMask & WriteMask) != 0) return false;
            }
            return SentinelMatches(handle, sealedSha);
        }

        static int Visit(SafeFileHandle handle, string display, string owner, bool root,
            int depth, Action<string, string> observe, string keepSealedChild, string sealedSha)
        {
            if (depth > 512) throw new IOException("Directory nesting limit exceeded: " + display);
            FileInfo info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), display);
            bool directory = (info.Attributes & Directory) != 0;
            bool reparse = (info.Attributes & ReparsePoint) != 0;
            if (root && (!directory || reparse)) throw new IOException("Root must be a real directory");
            // A hard link is another name for the same security descriptor.
            // Never repair it, even if its other names happen to be in-tree.
            if (!directory && info.Links != 1) throw new IOException("Refusing hard-linked file: " + display);
            if (observe != null) observe("opened", display);
            // NtSetSecurityObject changes this object only. SetSecurityInfo and
            // icacls can initiate their own descendant propagation/traversal,
            // which would bypass the relative opens and no-follow checks here.
            Check(NtSetSecurityObject(handle, OwnerSecurity | DaclSecurity |
                (root ? ProtectedDacl : UnprotectedDacl), Descriptor(owner, directory, root)),
                "Cannot secure " + display);
            if (observe != null) observe("secured", display);
            int count = 1;
            // Reparse entries get their own ACL repaired; their targets are
            // never opened. Legitimate uv/pnpm links therefore survive intact.
            if (!directory || reparse) return count;
            IntPtr buffer = Marshal.AllocHGlobal(65536);
            try
            {
                bool restart = true;
                for (;;)
                {
                    IoStatus status;
                    int result = NtQueryDirectoryFile(handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
                        out status, buffer, 65536, 12, true, IntPtr.Zero, restart);
                    restart = false;
                    if (result == NoMoreFiles) break;
                    Check(result, "Cannot enumerate " + display);
                    if (status.Information.ToInt64() < 12)
                        throw new IOException("Truncated directory result");
                    int bytes = Marshal.ReadInt32(buffer, 8);
                    if (bytes < 0 || bytes > status.Information.ToInt64() - 12 || bytes % 2 != 0)
                        throw new IOException("Invalid directory result");
                    string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, 12), bytes / 2);
                    if (name == "." || name == "..") continue;
                    string childDisplay = display + "\\" + name;
                    if (observe != null) observe("enumerated", childDisplay);
                    using (SafeFileHandle child = Open(handle.DangerousGetHandle(), name, false))
                    {
                        if (root && keepSealedChild != null && name == keepSealedChild &&
                            IsSealedTree(child, childDisplay, owner, sealedSha))
                        {
                            if (observe != null) observe("kept", childDisplay);
                            continue;
                        }
                        count += Visit(child, childDisplay, owner, false, depth + 1, observe, null, null);
                    }
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
            return count;
        }

        // Tests use the callback to interleave a rename/junction swap at exact
        // boundaries; the installer command reads only its "kept" event.
        public static int Run(string root, string owner, Action<string, string> observe)
        {
            return Run(root, owner, null, null, observe);
        }

        // keepSealedChild names one direct child of root that is left exactly
        // as it is when IsSealedTree holds for it; any other state repairs it.
        public static int Run(string root, string owner, string keepSealedChild, string sealedSha,
            Action<string, string> observe)
        {
            if (root == null || root.Length < 4 || !char.IsLetter(root[0]) ||
                root[1] != ':' || root[2] != '\\' || root.IndexOf(':', 2) >= 0)
                throw new ArgumentException("An absolute local drive directory is required");
            string full = Path.GetFullPath(root).TrimEnd('\\');
            if (full.Length <= 3) throw new ArgumentException("A volume root cannot be repaired");
            if (string.IsNullOrEmpty(keepSealedChild))
            {
                keepSealedChild = null;
            }
            else
            {
                if (keepSealedChild == "." || keepSealedChild == ".." ||
                    keepSealedChild.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0)
                    throw new ArgumentException("A single directory name is required");
                if (!IsSha256(sealedSha)) throw new ArgumentException("A sha256 attestation is required");
            }
            using (SafeFileHandle handle = Open(IntPtr.Zero, "\\??\\" + full, true))
                return Visit(handle, full, owner, true, 0, observe, keepSealedChild, sealedSha);
        }
    }
}
