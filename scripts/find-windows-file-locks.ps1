param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$type = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class RestartManagerFileLocks
{
    private const int ErrorMoreData = 234;
    private const int MaxAppName = 255;
    private const int MaxServiceName = 63;

    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess
    {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    private enum AppType
    {
        Unknown = 0,
        MainWindow = 1,
        OtherWindow = 2,
        Service = 3,
        Explorer = 4,
        Console = 5,
        Critical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo
    {
        public UniqueProcess Process;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxAppName + 1)]
        public string AppName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxServiceName + 1)]
        public string ServiceShortName;

        public AppType ApplicationType;
        public uint AppStatus;
        public uint TerminalSessionId;

        [MarshalAs(UnmanagedType.Bool)]
        public bool Restartable;
    }

    public sealed class LockOwner
    {
        public int ProcessId { get; set; }
        public string ProcessName { get; set; }
        public string AppName { get; set; }
        public string ServiceName { get; set; }
        public bool Restartable { get; set; }
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint sessionHandle, int sessionFlags, StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint sessionHandle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        IntPtr applications,
        uint serviceCount,
        string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint sessionHandle,
        out uint processInfoNeeded,
        ref uint processInfoCount,
        [In, Out] ProcessInfo[] affectedApps,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint sessionHandle);

    public static LockOwner[] GetOwners(string path)
    {
        uint session;
        var key = new StringBuilder(Guid.NewGuid().ToString("N"));
        var result = RmStartSession(out session, 0, key);
        if (result != 0) throw new InvalidOperationException("RmStartSession failed: " + result);

        try
        {
            result = RmRegisterResources(session, 1, new[] { path }, 0, IntPtr.Zero, 0, null);
            if (result != 0) throw new InvalidOperationException("RmRegisterResources failed: " + result);

            uint needed = 0;
            uint count = 0;
            uint rebootReasons = 0;
            result = RmGetList(session, out needed, ref count, null, ref rebootReasons);
            if (result == 0) return new LockOwner[0];
            if (result != ErrorMoreData) throw new InvalidOperationException("RmGetList failed: " + result);

            var info = new ProcessInfo[needed];
            count = needed;
            result = RmGetList(session, out needed, ref count, info, ref rebootReasons);
            if (result != 0) throw new InvalidOperationException("RmGetList failed: " + result);

            var owners = new List<LockOwner>();
            for (var index = 0; index < count; index++)
            {
                var item = info[index];
                string processName = null;
                try { processName = Process.GetProcessById(item.Process.ProcessId).ProcessName; }
                catch { }
                owners.Add(new LockOwner
                {
                    ProcessId = item.Process.ProcessId,
                    ProcessName = processName,
                    AppName = item.AppName,
                    ServiceName = item.ServiceShortName,
                    Restartable = item.Restartable
                });
            }
            return owners.ToArray();
        }
        finally
        {
            RmEndSession(session);
        }
    }
}
'@

$resolved = (Resolve-Path -LiteralPath $Path).Path
$exclusive = $null
try {
  # Restart Manager can occasionally fail inside a job object or report no
  # owner during a race. This is the authoritative safety check: if Windows
  # grants an exclusive handle, pnpm will be able to replace the package.
  $exclusive = [System.IO.File]::Open(
    $resolved,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::None
  )
  @() | ConvertTo-Json
  exit 0
} catch [System.IO.IOException], [System.UnauthorizedAccessException] {
  # Expected when another process has the package open. Resolve its friendly
  # name below, falling back to a generic actionable owner if RM is unavailable.
} finally {
  if ($null -ne $exclusive) { $exclusive.Dispose() }
}

try {
  Add-Type -TypeDefinition $type
  $owners = @([RestartManagerFileLocks]::GetOwners($resolved))
  if ($owners.Count -gt 0) {
    $owners | ConvertTo-Json -Depth 3
    exit 0
  }
} catch {
  # The exclusive-open result above is sufficient to stop the install safely.
}

[PSCustomObject]@{
  ProcessId = 0
  ProcessName = 'unknown process'
  AppName = 'another Windows process or security tool'
  ServiceName = ''
  Restartable = $false
} | ConvertTo-Json -Depth 3
