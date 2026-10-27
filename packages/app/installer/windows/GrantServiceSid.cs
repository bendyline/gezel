// Installer-only: grant a service's per-service SID on one directory, the way
// `icacls <path> /grant:r "NT SERVICE\<name>:<spec>"` does, without looking the
// account up.
//
// icacls resolves its trustee through the account lookup, even when handed
// `*S-1-5-80-...`. After a service is deleted and re-created under the same
// name, which every upgrade does, `NT SERVICE\<name>` can stop resolving: on
// Windows 11 build 28000 (2026-10-24) every grant failed with 1332 ("No
// mapping between account names and security IDs") for a service that existed,
// and the upgrade removed the machine service. The service's token carries its
// SID regardless, and that SID is a pure function of the name (the one
// `sc.exe showsid` prints), so this derives it and grants it directly.
//
// Grants are icacls-style specs, ';'-separated: (OI)(CI)(M), (OI)(CI)(RX),
// (OI)(CI)(IO)(F). Any explicit ACEs the SID already holds are replaced
// (/grant:r) and the DACL keeps its protection. The write goes through
// SetNamedSecurityInfo, which carries inheritable ACEs to existing children
// exactly as icacls does.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

namespace Gezel.Installer
{
    public static class GrantServiceSid
    {
        public static string ServiceSid(string name)
        {
            byte[] hash;
            using (SHA1 sha1 = SHA1.Create())
                hash = sha1.ComputeHash(Encoding.Unicode.GetBytes(name.ToUpperInvariant()));
            var parts = new string[5];
            for (int i = 0; i < parts.Length; i++)
                parts[i] = BitConverter.ToUInt32(hash, i * 4).ToString(CultureInfo.InvariantCulture);
            return "S-1-5-80-" + string.Join("-", parts);
        }

        static FileSystemAccessRule Rule(SecurityIdentifier trustee, string spec)
        {
            var tokens = new List<string>();
            foreach (Match match in Regex.Matches(spec, @"\(([A-Z]+)\)")) tokens.Add(match.Groups[1].Value);
            if (tokens.Count < 1 || string.Concat(tokens) != spec.Replace("(", "").Replace(")", ""))
                throw new ArgumentException("unreadable grant: " + spec);
            FileSystemRights rights;
            switch (tokens[tokens.Count - 1])
            {
                case "F": rights = FileSystemRights.FullControl; break;
                case "M": rights = FileSystemRights.Modify; break;
                case "RX": rights = FileSystemRights.ReadAndExecute; break;
                default: throw new ArgumentException("unsupported rights in " + spec);
            }
            var inherit = InheritanceFlags.None;
            var propagate = PropagationFlags.None;
            for (int i = 0; i < tokens.Count - 1; i++)
            {
                switch (tokens[i])
                {
                    case "OI": inherit |= InheritanceFlags.ObjectInherit; break;
                    case "CI": inherit |= InheritanceFlags.ContainerInherit; break;
                    case "IO": propagate |= PropagationFlags.InheritOnly; break;
                    default: throw new ArgumentException("unsupported flag (" + tokens[i] + ") in " + spec);
                }
            }
            return new FileSystemAccessRule(trustee, rights, inherit, propagate, AccessControlType.Allow);
        }

        /// <summary>Replace the service SID's explicit ACEs on <paramref name="path"/>; returns the SID.</summary>
        public static string Run(string path, string service, string grant)
        {
            if (!Regex.IsMatch(service, "^[A-Za-z0-9_-]{1,256}$"))
                throw new ArgumentException("not a service name: " + service);
            if (!Regex.IsMatch(path, @"^[A-Za-z]:\\."))
                throw new ArgumentException("not an absolute directory below a drive root: " + path);
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.Directory) == 0) throw new IOException("not a directory: " + path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("refusing a reparse point: " + path);

            string sid = ServiceSid(service);
            var trustee = new SecurityIdentifier(sid);
            var rules = new List<FileSystemAccessRule>();
            foreach (string spec in grant.Split(';')) rules.Add(Rule(trustee, spec.Trim()));

            DirectorySecurity acl = Directory.GetAccessControl(path, AccessControlSections.Access);
            acl.PurgeAccessRules(trustee);
            foreach (FileSystemAccessRule rule in rules) acl.AddAccessRule(rule);
            Directory.SetAccessControl(path, acl);
            return sid;
        }
    }
}
