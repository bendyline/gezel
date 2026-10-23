param([Parameter(Mandatory = $true)][string]$Scratch)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = $PSHOME + '\Modules'
Add-Type -Path (Join-Path $PSScriptRoot 'ResetTreeAcl.cs')
$testOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Assert($condition, [string]$message) {
    if (!$condition) { throw $message }
}
function AclText([string]$path) {
    (Get-Acl -LiteralPath $path).Sddl
}
function Fixture([string]$name) {
    $testRoot = Join-Path $Scratch $name
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $acl = Get-Acl -LiteralPath $testRoot
    $sid = New-Object System.Security.Principal.SecurityIdentifier($testOwner)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $testRoot -AclObject $acl
    return $testRoot
}
function Repair([string]$path, [Action[string,string]]$observe = $null) {
    [Gezel.Installer.ResetTreeAcl]::Run($path, $testOwner, $observe)
}
$outside = Fixture 'outside'
$marker = Join-Path $outside 'marker.txt'
Set-Content -LiteralPath $marker -Value 'outside data'
New-Item -ItemType Directory -Path (Join-Path $outside 'nested') | Out-Null
$outsideAcl = AclText $outside
$markerAcl = AclText $marker

# The old preflight/recursive-command race: replace an enumerated ordinary
# directory before the helper opens it. Only the link itself may be repaired.
$beforeOpen = Fixture 'before-open'
$swap = Join-Path $beforeOpen 'swap'
New-Item -ItemType Directory -Path $swap | Out-Null
$script:swapped = $false
$count = Repair $beforeOpen {
    param($stage, $path)
    if ($stage -eq 'enumerated' -and $path -eq $swap -and !$script:swapped) {
        [System.IO.Directory]::Delete($swap)
        New-Item -ItemType Junction -Path $swap -Target $outside | Out-Null
        $script:swapped = $true
    }
}
Assert $script:swapped 'The deterministic replacement did not run'
Assert ($count -eq 2) 'The repair traversed the junction'
Assert ((AclText $outside) -eq $outsideAcl) 'Outside directory ACL changed'
Assert ((AclText $marker) -eq $markerAcl) 'Outside file ACL changed'
Assert ((Get-Content -LiteralPath $marker).Trim() -eq 'outside data') 'Outside bytes changed'

# Once a handle is acquired, replacement must fail until its visit ends.
$afterOpen = Fixture 'after-open'
$pinned = Join-Path $afterOpen 'pinned'
New-Item -ItemType Directory -Path $pinned | Out-Null
Set-Content -LiteralPath (Join-Path $pinned 'child.txt') -Value 'inside'
$script:renameBlocked = $false
Repair $afterOpen {
    param($stage, $path)
    if ($stage -eq 'opened' -and $path -eq $pinned) {
        try { [System.IO.Directory]::Move($pinned, (Join-Path $afterOpen 'moved')) }
        catch [System.IO.IOException] { $script:renameBlocked = $true }
    }
} | Out-Null
Assert $script:renameBlocked 'An opened directory could be replaced'

# Updating a directory must not implicitly propagate its ACL before the
# children are individually opened and checked by the helper.
$propagation = Fixture 'propagation'
$child = Join-Path $propagation 'child.txt'
Set-Content -LiteralPath $child -Value 'inside'
$childBefore = AclText $child
$script:checkedPropagation = $false
Repair $propagation {
    param($stage, $path)
    if ($stage -eq 'secured' -and $path -eq $propagation) {
        Assert ((AclText $child) -eq $childBefore) 'ACL API implicitly walked children'
        $script:checkedPropagation = $true
    }
} | Out-Null
Assert $script:checkedPropagation 'Propagation assertion did not run'
$childAfter = Get-Acl -LiteralPath $child
Assert (!$childAfter.AreAccessRulesProtected) 'Child no longer inherits boundary changes'
Assert (@($childAfter.Access | Where-Object { !$_.IsInherited }).Count -eq 0) 'Child kept explicit ACEs'

# Handle-relative traversal also avoids the MAX_PATH failure of recursive
# command-line ACL tools. Only fixture creation needs the extended path form.
$longRoot = Fixture 'long-path'
$longLeaf = $longRoot
for ($level = 0; $level -lt 6; $level++) {
    $longLeaf = $longLeaf + '\' + ('segment-' + ('x' * 55))
    [System.IO.Directory]::CreateDirectory('\\?\' + $longLeaf) | Out-Null
}
[System.IO.File]::WriteAllText('\\?\' + $longLeaf + '\leaf.txt', 'long path')
Assert ((Repair $longRoot) -eq 8) 'Long-path descendants were not all repaired'

# Internal pnpm/uv-style links and cycles survive; the real target is visited
# once at its own directory entry. Outside and dangling links are also never
# followed (the separate installer link policy decides which to retain).
$links = Fixture 'links'
$target = Join-Path $links 'versioned-runtime'
New-Item -ItemType Directory -Path $target | Out-Null
Set-Content -LiteralPath (Join-Path $target 'runtime.txt') -Value 'runtime'
New-Item -ItemType Junction -Path (Join-Path $links 'python-current') -Target $target | Out-Null
New-Item -ItemType Junction -Path (Join-Path $links 'cycle') -Target $links | Out-Null
New-Item -ItemType Junction -Path (Join-Path $links 'escape') -Target $outside | Out-Null
Assert ((Repair $links) -eq 6) 'Unexpected link traversal count'
Assert ((Get-Item -LiteralPath (Join-Path $links 'python-current')).LinkType -eq 'Junction') 'uv link lost'
Assert ((AclText $marker) -eq $markerAcl) 'Outside ACL changed through retained link'
# Publishing a boundary uses container-only icacls, without /T. Verify that
# the repaired descendants inherit it while reparse targets remain unchanged.
& icacls.exe $links /grant '*S-1-5-32-545:(OI)(CI)(RX)' /L /Q | Out-Null
Assert ($LASTEXITCODE -eq 0) 'Boundary publication failed'
$published = Get-Acl -LiteralPath (Join-Path $target 'runtime.txt')
Assert (@($published.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-545' -and $_.IsInherited }).Count -gt 0) 'Boundary permissions did not propagate'
Assert ((AclText $outside) -eq $outsideAcl) 'Boundary publication followed a junction'
Assert ((AclText $marker) -eq $markerAcl) 'Boundary publication changed an outside file'

# Root/ancestor reparse points must be refused before any ACL is changed.
$rootLink = Join-Path $Scratch 'root-link'
New-Item -ItemType Junction -Path $rootLink -Target $outside | Out-Null
foreach ($candidate in @($rootLink, (Join-Path $rootLink 'nested'))) {
    $refused = $false
    try { Repair $candidate | Out-Null } catch { $refused = $true }
    Assert $refused 'A root with a reparse component was accepted'
}
Assert ((AclText $marker) -eq $markerAcl) 'Root-link target changed'

# A file hard link aliases an outside security descriptor too.
$hard = Fixture 'hard-link'
New-Item -ItemType HardLink -Path (Join-Path $hard 'alias.txt') -Target $marker | Out-Null
$refused = $false
try { Repair $hard | Out-Null } catch { $refused = $true }
Assert $refused 'Hard-linked file was accepted'
Assert ((AclText $marker) -eq $markerAcl) 'Hard-link target ACL changed'

# A mutable handle acquired before us is a closed failure, not a reason to
# drop sharing restrictions or invoke the old recursive fallback.
$busy = Fixture 'busy'
$busyFile = Join-Path $busy 'busy.txt'
Set-Content -LiteralPath $busyFile -Value 'busy'
$busyBefore = AclText $busyFile
$held = [System.IO.File]::Open($busyFile, 'Open', 'ReadWrite', 'ReadWrite')
try {
    $refused = $false
    try { Repair $busy | Out-Null } catch { $refused = $true }
    Assert $refused 'An existing writable handle was ignored'
    Assert ((AclText $busyFile) -eq $busyBefore) 'Busy child changed before refusal'
} finally { $held.Dispose() }

# The release Windows runner is elevated. Exercise the actual production
# launcher/owner and privilege recovery there; ordinary desktop runs retain
# the same syscall/race coverage on files owned by the test account.
$principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $locked = Fixture 'production-privileges'
    $lockedFile = Join-Path $locked 'locked.txt'
    Set-Content -LiteralPath $lockedFile -Value 'private'
    $restoreAcl = Get-Acl -LiteralPath $lockedFile
    try {
        $lockedAcl = New-Object System.Security.AccessControl.FileSecurity
        $lockedAcl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;SY)')
        Set-Acl -LiteralPath $lockedFile -AclObject $lockedAcl
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'reset-tree-acl.ps1') -Root $locked
        Assert ($LASTEXITCODE -eq 0) 'Production privileged launcher failed'
        Assert ((Get-Acl -LiteralPath $lockedFile).GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-544') 'Production owner was not set'
        Write-Output 'Elevated production launcher passed'
    } finally { Set-Acl -LiteralPath $lockedFile -AclObject $restoreAcl }
} else {
    Write-Output 'Elevated production launcher not run: current token is not elevated'
}
Write-Output 'ACL race regression tests passed'
