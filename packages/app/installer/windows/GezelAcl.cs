// gezel-acl.exe: the Windows installer's permission helper. NSIS runs it
// elevated to repair the machine data tree (ResetTreeAcl.cs) and to grant the
// service SID its directories (GrantServiceSid.cs).
//
// It is compiled at build time and Authenticode-signed with the rest of the
// payload, replacing two PowerShell scripts that compiled the same C# with
// Add-Type during the install. A Group Policy AllSigned execution policy
// refused those scripts and App Control's Constrained Language Mode refused
// Add-Type, so managed machines never got the machine engine.
//
//   gezel-acl reset-tree-acl -Root <dir> [-KeepSealedChild <name> -SealedSha <sha256>]
//                            [-SeparateZones <name,name>]
//   gezel-acl grant-service-sid -Path <dir> -Service <name> -Grant <specs>
//
// Exit 0 on success, 1 when the operation was refused, 2 on a usage error.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.RegularExpressions;

[assembly: AssemblyTitle("Gezel permission helper")]
[assembly: AssemblyDescription("Secures Gezel's machine data folder during installation")]
[assembly: AssemblyCompany("Bendyline LLC")]
[assembly: AssemblyProduct("Gezel")]

namespace Gezel.Installer
{
    public static class GezelAcl
    {
        const string Administrators = "S-1-5-32-544";

        public static int Main(string[] args)
        {
            if (args.Length == 0) return Usage("missing command");
            switch (args[0])
            {
                case "reset-tree-acl":
                {
                    Dictionary<string, string> options = Options(args,
                        new[] { "Root", "KeepSealedChild", "SealedSha", "SeparateZones" }, new[] { "Root" });
                    return options == null ? 2 : ResetTree(options);
                }
                case "grant-service-sid":
                {
                    Dictionary<string, string> options = Options(args,
                        new[] { "Path", "Service", "Grant" }, new[] { "Path", "Service", "Grant" });
                    return options == null ? 2 : GrantSid(options);
                }
                default:
                    return Usage("unknown command " + args[0]);
            }
        }

        static int Usage(string problem)
        {
            Console.Error.WriteLine("[gezel-acl] " + problem);
            Console.Error.WriteLine(
                "usage: gezel-acl reset-tree-acl -Root <dir> [-KeepSealedChild <name> -SealedSha <sha256>] [-SeparateZones <names>]");
            Console.Error.WriteLine(
                "       gezel-acl grant-service-sid -Path <dir> -Service <name> -Grant <specs>");
            return 2;
        }

        // `-Name value` pairs, names matched case-insensitively as PowerShell
        // parameters were. Null (after printing usage) on anything unexpected.
        static Dictionary<string, string> Options(string[] args, string[] known, string[] required)
        {
            var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < args.Length; i += 2)
            {
                string name = args[i].StartsWith("-") ? args[i].Substring(1) : null;
                if (name == null || Array.FindIndex(known, k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase)) < 0)
                {
                    Usage("unexpected argument " + args[i]);
                    return null;
                }
                if (i + 1 >= args.Length || options.ContainsKey(name))
                {
                    Usage((options.ContainsKey(name) ? "repeated " : "no value for ") + args[i]);
                    return null;
                }
                options[name] = args[i + 1];
            }
            foreach (string name in required)
            {
                if (!options.ContainsKey(name) || options[name].Length == 0)
                {
                    Usage("missing -" + name);
                    return null;
                }
            }
            return options;
        }

        static string Optional(Dictionary<string, string> options, string name)
        {
            string value;
            return options.TryGetValue(name, out value) && value.Length > 0 ? value : null;
        }

        static int ResetTree(Dictionary<string, string> options)
        {
            string keepChild = Optional(options, "KeepSealedChild");
            string sha = Optional(options, "SealedSha");
            string zones = Optional(options, "SeparateZones");
            try
            {
                ResetTreeAcl.EnablePrivileges();
                string keep = null;
                string sealedSha = null;
                if (keepChild != null)
                {
                    if (sha != null && Regex.IsMatch(sha, "^[0-9A-Fa-f]{64}$"))
                    {
                        keep = keepChild;
                        sealedSha = sha;
                    }
                    else
                    {
                        Console.WriteLine("[reset-tree-acl] No readable attestation for " + keepChild + "; repairing it too.");
                    }
                }
                var separate = new List<string>();
                if (zones != null)
                    foreach (string zone in zones.Split(',')) separate.Add(zone.Trim());
                var kept = new List<string>();
                int secured = ResetTreeAcl.Run(options["Root"], Administrators, keep, sealedSha, separate.ToArray(),
                    (stage, path) => { if (stage == "kept") kept.Add(path); });
                foreach (string path in kept)
                    Console.WriteLine("[reset-tree-acl] Left " + path + " as published: it is still sealed and attested.");
                Console.WriteLine("[reset-tree-acl] Secured " + secured + " entries without following links.");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("[reset-tree-acl] Refusing incomplete ACL repair: " + error.Message);
                return 1;
            }
        }

        static int GrantSid(Dictionary<string, string> options)
        {
            string path = options["Path"];
            try
            {
                string sid = GrantServiceSid.Run(path, options["Service"], options["Grant"]);
                Console.WriteLine("[grant-service-sid] " + path + " : " + options["Service"] + " (" + sid + ") " + options["Grant"]);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("[grant-service-sid] " + path + " : " + error.Message);
                return 1;
            }
        }
    }
}
