# Installer-only: grant a service's per-service SID on one directory, the way
# `icacls <path> /grant:r "NT SERVICE\<name>:<spec>"` does, without looking the
# account up.
#
# icacls resolves its trustee through the account lookup, even when handed
# `*S-1-5-80-...`. After a service is deleted and re-created under the same
# name, which every upgrade does, `NT SERVICE\<name>` can stop resolving: on
# Windows 11 build 28000 (2026-10-24) every grant failed with 1332 ("No
# mapping between account names and security IDs") for a service that existed,
# and the upgrade removed the machine service. The service's token carries its
# SID regardless, and that SID is a pure function of the name (the one
# `sc.exe showsid` prints), so this derives it and grants it directly.
#
#   -Path     an absolute directory, never a reparse point
#   -Service  the service name
#   -Grant    icacls-style specs, ';'-separated: (OI)(CI)(M), (OI)(CI)(RX),
#             (OI)(CI)(IO)(F)
#
# Replaces any explicit ACEs the SID already holds (/grant:r) and keeps the
# DACL's protection. The write goes through SetNamedSecurityInfo, which carries
# inheritable ACEs to existing children exactly as icacls does. Exit 0 on
# success.
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Service,
    [Parameter(Mandatory = $true)][string]$Grant
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = $PSHOME + '\Modules'

function Get-ServiceSid([string]$Name) {
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $hash = $sha1.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant()))
    } finally {
        $sha1.Dispose()
    }
    $parts = for ($i = 0; $i -lt 20; $i += 4) { [System.BitConverter]::ToUInt32($hash, $i) }
    'S-1-5-80-' + ($parts -join '-')
}

function ConvertTo-AccessRule([System.Security.Principal.SecurityIdentifier]$Trustee, [string]$Spec) {
    $tokens = @([regex]::Matches($Spec, '\(([A-Z]+)\)') | ForEach-Object { $_.Groups[1].Value })
    if ($tokens.Count -lt 1 -or ($tokens -join '') -ne ($Spec -replace '[()]', '')) { throw "unreadable grant: $Spec" }
    $rights = switch ($tokens[$tokens.Count - 1]) {
        'F' { [System.Security.AccessControl.FileSystemRights]::FullControl }
        'M' { [System.Security.AccessControl.FileSystemRights]::Modify }
        'RX' { [System.Security.AccessControl.FileSystemRights]::ReadAndExecute }
        default { throw "unsupported rights in $Spec" }
    }
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    $propagate = [System.Security.AccessControl.PropagationFlags]::None
    for ($i = 0; $i -lt $tokens.Count - 1; $i++) {
        switch ($tokens[$i]) {
            'OI' { $inherit = $inherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
            'CI' { $inherit = $inherit -bor [System.Security.AccessControl.InheritanceFlags]::ContainerInherit }
            'IO' { $propagate = $propagate -bor [System.Security.AccessControl.PropagationFlags]::InheritOnly }
            default { throw "unsupported flag ($($tokens[$i])) in $Spec" }
        }
    }
    New-Object System.Security.AccessControl.FileSystemAccessRule($Trustee, $rights, $inherit, $propagate, 'Allow')
}

try {
    if ($Service -notmatch '^[A-Za-z0-9_-]{1,256}$') { throw "not a service name: $Service" }
    if ($Path -notmatch '^[A-Za-z]:\\.') { throw "not an absolute directory below a drive root: $Path" }
    $attributes = [System.IO.File]::GetAttributes($Path)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { throw "not a directory: $Path" }
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "refusing a reparse point: $Path" }

    $sid = Get-ServiceSid $Service
    $trustee = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $rules = @($Grant.Split(';') | ForEach-Object { ConvertTo-AccessRule $trustee $_.Trim() })

    $acl = [System.IO.Directory]::GetAccessControl($Path, [System.Security.AccessControl.AccessControlSections]::Access)
    $acl.PurgeAccessRules($trustee)
    foreach ($rule in $rules) { $acl.AddAccessRule($rule) }
    [System.IO.Directory]::SetAccessControl($Path, $acl)
    Write-Output "[grant-service-sid] $Path : $Service ($sid) $Grant"
    exit 0
} catch {
    Write-Error "[grant-service-sid] $Path : $_" -ErrorAction Continue
    exit 1
}
