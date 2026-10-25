param([Parameter(Mandatory = $true)][string]$Scratch)
$ErrorActionPreference = 'Stop'
# The helper reports paths in Path.GetFullPath form, which expands 8.3 names
# under .NET Framework; the CI runner's TEMP is C:\Users\RUNNER~1\..., so the
# observers' path comparisons must use the same form or they never match.
$Scratch = [System.IO.Path]::GetFullPath($Scratch)
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

# An upgrade leaves the previous service tree out of the data-root repair only
# while it is still sealed as the installer published it and its sentinel
# matches the attestation. Every other state is repaired like any child.
$attested = 'ab' * 32
$sealedDacl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OWNER)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;S-1-5-80-1786395786-4294646720-3734801101-1595390539-2055821610)'
function SealedTree([string]$name, [string]$dacl, [string]$sentinel = $attested) {
    $parent = Fixture $name
    Set-Content -LiteralPath (Join-Path $parent 'other.txt') -Value 'other'
    $tree = Join-Path $parent 'service'
    New-Item -ItemType Directory -Path (Join-Path $tree 'dist') | Out-Null
    Set-Content -LiteralPath (Join-Path $tree 'dist\code.js') -Value 'code'
    if ($sentinel) { [System.IO.File]::WriteAllText((Join-Path $tree '.gezel-bundle.sha256'), $sentinel + "`n") }
    # An elevated token creates objects owned by Administrators, so the
    # trusted owner is set explicitly rather than assumed.
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetSecurityDescriptorSddlForm(('O:' + $testOwner + $dacl).Replace('OWNER', $testOwner), 'Owner, Access')
    [System.IO.Directory]::SetAccessControl($tree, $security)
    return $parent
}
function RepairKeeping([string]$path) {
    $script:keptPaths = @()
    [Gezel.Installer.ResetTreeAcl]::Run($path, $testOwner, 'service', $attested, [Action[string,string]] {
        param($stage, $entry)
        if ($stage -eq 'kept') { $script:keptPaths += $entry }
    })
}

$sealed = SealedTree 'sealed-tree' $sealedDacl
$sealedTree = Join-Path $sealed 'service'
$treeBefore = AclText $sealedTree
$codeBefore = AclText (Join-Path $sealedTree 'dist\code.js')
$count = RepairKeeping $sealed
Assert ($script:keptPaths.Count -eq 1 -and $script:keptPaths[0] -eq $sealedTree) 'A sealed, attested tree was repaired'
Assert ($count -eq 2) 'The repair walked into a kept tree'
Assert ((AclText $sealedTree) -eq $treeBefore) 'A kept tree changed'
Assert ((AclText (Join-Path $sealedTree 'dist\code.js')) -eq $codeBefore) 'A file in a kept tree changed'
Assert ((Get-Acl -LiteralPath $sealed).AreAccessRulesProtected) 'The root beside a kept tree was not secured'

foreach ($case in @(
        @{ Name = 'stale-attestation'; Dacl = $sealedDacl; Sentinel = ('cd' * 32); Count = 6 },
        @{ Name = 'no-sentinel'; Dacl = $sealedDacl; Sentinel = ''; Count = 5 },
        @{ Name = 'users-modify'; Dacl = $sealedDacl.Replace('(A;OICI;0x1200a9;;;BU)', '(A;OICI;0x1301bf;;;BU)'); Sentinel = $attested; Count = 6 },
        @{ Name = 'inherit-only-write'; Dacl = $sealedDacl + '(A;OICIIO;FA;;;BU)'; Sentinel = $attested; Count = 6 },
        @{ Name = 'unprotected'; Dacl = $sealedDacl.Replace('D:P', 'D:'); Sentinel = $attested; Count = 6 })) {
    $parent = SealedTree $case.Name $case.Dacl $case.Sentinel
    $count = RepairKeeping $parent
    Assert ($script:keptPaths.Count -eq 0) "A $($case.Name) tree was kept"
    Assert ($count -eq $case.Count) "A $($case.Name) tree was not fully repaired ($count entries)"
    Assert (!(Get-Acl -LiteralPath (Join-Path $parent 'service')).AreAccessRulesProtected) "A $($case.Name) tree kept its own DACL"
}

# A link where the sentinel belongs is read through nothing and never kept.
$linkedSentinel = SealedTree 'linked-sentinel' $sealedDacl ''
New-Item -ItemType Junction -Path (Join-Path $linkedSentinel 'service\.gezel-bundle.sha256') -Target $outside | Out-Null
Assert ((RepairKeeping $linkedSentinel) -eq 6) 'A tree with a linked sentinel was not fully repaired'
Assert ($script:keptPaths.Count -eq 0) 'A tree with a linked sentinel was kept'
Assert ((AclText $outside) -eq $outsideAcl) 'A linked sentinel target changed'

# A link in place of the tree is repaired as a link, never kept or followed.
$linkedTree = Fixture 'linked-tree'
New-Item -ItemType Junction -Path (Join-Path $linkedTree 'service') -Target $outside | Out-Null
Assert ((RepairKeeping $linkedTree) -eq 2) 'A linked tree was kept or followed'
Assert ((AclText $outside) -eq $outsideAcl) 'A linked tree target changed'

foreach ($arguments in @(@('a\b', $attested), @('..', $attested), @('service', 'not-a-sha'))) {
    $refused = $false
    try { [Gezel.Installer.ResetTreeAcl]::Run($sealed, $testOwner, $arguments[0], $arguments[1], $null) | Out-Null } catch { $refused = $true }
    Assert $refused "Accepted keep arguments $($arguments -join ', ')"
}

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

    $publishedRoot = Fixture 'production-sealed'
    $publishedTree = Join-Path $publishedRoot 'service'
    New-Item -ItemType Directory -Path $publishedTree | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $publishedTree '.gezel-bundle.sha256'), $attested)
    $publishedAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $publishedAcl.SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)')
    [System.IO.Directory]::SetAccessControl($publishedTree, $publishedAcl)
    $launcherOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'reset-tree-acl.ps1') -Root $publishedRoot -KeepSealedChild service -SealedSha $attested
    Assert ($LASTEXITCODE -eq 0) 'Production launcher failed beside a sealed tree'
    Assert (($launcherOutput -join "`n").Contains("Left $publishedTree as published")) 'Production launcher repaired a sealed, attested tree'
    Write-Output 'Elevated sealed-tree launcher passed'
} else {
    Write-Output 'Elevated production launcher not run: current token is not elevated'
}
Write-Output 'ACL race regression tests passed'
