param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = $PSHOME + '\Modules'
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
$compilerRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$compilerTemp = [System.IO.Path]::Combine($compilerRoot, '.acl-compile-' + [guid]::NewGuid().ToString('N'))
$resultCode = 1
try {
    # Add-Type uses compiler scratch files. Do not place elevated compilation
    # in the launching user's writable TEMP or resolve their PowerShell modules.
    [System.IO.Directory]::CreateDirectory($compilerTemp) | Out-Null
    $env:TEMP = $compilerTemp
    $env:TMP = $compilerTemp
    Add-Type -Path (Join-Path $PSScriptRoot 'ResetTreeAcl.cs')
    [Gezel.Installer.ResetTreeAcl]::EnablePrivileges()
    $securedCount = [Gezel.Installer.ResetTreeAcl]::Run($Root, 'S-1-5-32-544', $null)
    Write-Output "[reset-tree-acl] Secured $securedCount entries without following links."
    $resultCode = 0
} catch {
    Write-Error "[reset-tree-acl] Refusing incomplete ACL repair: $_" -ErrorAction Continue
} finally {
    $env:TEMP = $originalTemp
    $env:TMP = $originalTmp
    if ([System.IO.Directory]::Exists($compilerTemp) -and
        [System.IO.Directory]::GetParent($compilerTemp).FullName -eq $compilerRoot) {
        [System.IO.Directory]::Delete($compilerTemp, $true)
    }
}
exit $resultCode
