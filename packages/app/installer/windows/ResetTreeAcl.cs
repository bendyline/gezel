// Installer-only Windows ACL repair. All enumeration and mutation is relative
// to pinned directory handles; a path preflight is never an authorization check.
using System;
using System.Collections.Generic;
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
        const int BufferOverflow = unchecked((int)0x80000005);
        const int FileHardLinkInformation = 46;
        const uint ShareAll = 7, BackupSemantics = 0x02000000, OpenReparsePointFlag = 0x00200000;
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
        struct FileIdDescriptor { public uint Size; public int Type; public long FileId, Reserved; }
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
        static extern int NtQueryInformationFile(SafeFileHandle handle, out IoStatus status,
            IntPtr buffer, uint length, int infoClass);
        [DllImport("ntdll.dll")]
        static extern uint RtlNtStatusToDosError(int status);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern SafeFileHandle OpenFileById(SafeFileHandle volumeHint, ref FileIdDescriptor id,
            uint access, uint share, IntPtr security, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path,
            uint length, uint flags);
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

        // A repair's root, resolved once, and the direct children of it that
        // are trust zones of their own: the tree every local account can write
        // and the published service code. The rest of the root is one zone.
        sealed class Scope
        {
            public SafeFileHandle Root;
            public string RootPath;
            public string[] SeparateZones;
        }

        static string FinalPath(SafeFileHandle handle, string display)
        {
            var path = new StringBuilder(512);
            uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
            if (length >= path.Capacity)
            {
                path = new StringBuilder(checked((int)length + 1));
                length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
            }
            if (length == 0 || length >= path.Capacity)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve " + display);
            return path.ToString();
        }

        static string DirectoryPath(Scope scope, long fileId, string display)
        {
            var id = new FileIdDescriptor {
                Size = (uint)Marshal.SizeOf(typeof(FileIdDescriptor)), Type = 0, FileId = fileId
            };
            using (SafeFileHandle directory = OpenFileById(scope.Root, ref id, ReadAttributes | Synchronize,
                ShareAll, IntPtr.Zero, BackupSemantics | OpenReparsePointFlag))
            {
                if (directory.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve a name of " + display);
                return FinalPath(directory, display);
            }
        }

        // Every name of a file, as full paths, read from the file's own handle
        // (FILE_LINKS_INFORMATION) rather than from any path.
        static List<string> LinkNames(SafeFileHandle file, Scope scope, string display)
        {
            int size = 4096;
            for (int attempt = 0; attempt < 8; attempt++)
            {
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    IoStatus status;
                    int result = NtQueryInformationFile(file, out status, buffer, (uint)size,
                        FileHardLinkInformation);
                    if (result == BufferOverflow || result == BufferTooSmall)
                    {
                        size = Math.Max(size * 2, Marshal.ReadInt32(buffer, 0) + 64);
                        continue;
                    }
                    Check(result, "Cannot list the names of " + display);
                    int count = Marshal.ReadInt32(buffer, 4);
                    var names = new List<string>(count);
                    int offset = 8;
                    for (int i = 0; i < count; i++)
                    {
                        if (offset + 20 > size) throw new IOException("Invalid name list for " + display);
                        int next = Marshal.ReadInt32(buffer, offset);
                        long parent = Marshal.ReadInt64(buffer, offset + 8);
                        int chars = Marshal.ReadInt32(buffer, offset + 16);
                        if (chars < 1 || offset + 20 + chars * 2 > size)
                            throw new IOException("Invalid name list for " + display);
                        string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 20), chars);
                        names.Add(DirectoryPath(scope, parent, display) + "\\" + name);
                        if (next == 0) break;
                        if (next < 20) throw new IOException("Invalid name list for " + display);
                        offset += next;
                    }
                    return names;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            throw new IOException("Cannot list the names of " + display);
        }

        // null outside the repaired tree, a separate zone's name inside one,
        // and "" anywhere else in the tree.
        static string Zone(Scope scope, string path)
        {
            string prefix = scope.RootPath + "\\";
            if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
            string rest = path.Substring(prefix.Length);
            int slash = rest.IndexOf('\\');
            if (slash > 0)
            {
                string first = rest.Substring(0, slash);
                foreach (string zone in scope.SeparateZones)
                    if (string.Equals(first, zone, StringComparison.OrdinalIgnoreCase)) return zone;
            }
            return "";
        }

        // A hard link is another name for the same security descriptor:
        // repairing it repairs every name, and the boundaries NSIS publishes
        // afterwards reach every name through inheritance. That is safe only
        // while all of them lie in one zone of this tree, which is where the
        // machine engine's speech-model store and uv's cache link on purpose.
        // A name outside the tree, or in another zone, is refused: an outside
        // target would be taken over, and a name in the shared tree would hand
        // its users the private file's other name.
        static void RequireOneZone(SafeFileHandle file, Scope scope, string display, uint links)
        {
            List<string> names = LinkNames(file, scope, display);
            if (names.Count != links)
                throw new IOException("Refusing hard-linked file whose names cannot all be listed: " + display);
            string first = null;
            foreach (string name in names)
            {
                string zone = Zone(scope, name);
                if (zone == null)
                    throw new IOException("Refusing hard-linked file with a name outside the tree: " + display);
                if (first == null) first = zone;
                else if (zone != first)
                    throw new IOException("Refusing hard-linked file whose names cross trust zones: " + display);
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
            int depth, Action<string, string> observe, string keepSealedChild, string sealedSha,
            Scope scope)
        {
            if (depth > 512) throw new IOException("Directory nesting limit exceeded: " + display);
            FileInfo info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), display);
            bool directory = (info.Attributes & Directory) != 0;
            bool reparse = (info.Attributes & ReparsePoint) != 0;
            if (root && (!directory || reparse)) throw new IOException("Root must be a real directory");
            if (!directory && info.Links != 1) RequireOneZone(handle, scope, display, info.Links);
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
                        count += Visit(child, childDisplay, owner, false, depth + 1, observe, null, null, scope);
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

        public static int Run(string root, string owner, string keepSealedChild, string sealedSha,
            Action<string, string> observe)
        {
            return Run(root, owner, keepSealedChild, sealedSha, null, observe);
        }

        // keepSealedChild names one direct child of root that is left exactly
        // as it is when IsSealedTree holds for it; any other state repairs it.
        // separateZones names direct children of root whose subtrees are trust
        // zones of their own; a hard link may not join names across zones.
        public static int Run(string root, string owner, string keepSealedChild, string sealedSha,
            string[] separateZones, Action<string, string> observe)
        {
            separateZones = separateZones ?? new string[0];
            foreach (string zone in separateZones)
                if (string.IsNullOrEmpty(zone) || zone == "." || zone == ".." ||
                    zone.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0)
                    throw new ArgumentException("Each zone must be a single directory name");
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
            {
                var scope = new Scope {
                    Root = handle, RootPath = FinalPath(handle, full).TrimEnd('\\'),
                    SeparateZones = separateZones
                };
                return Visit(handle, full, owner, true, 0, observe, keepSealedChild, sealedSha, scope);
            }
        }
    }
}
