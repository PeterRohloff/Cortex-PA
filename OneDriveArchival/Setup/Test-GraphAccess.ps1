<#
.SYNOPSIS
    Diagnoses whether the automation app can read the Entra ID deleted-user
    recycle bin THROUGH PnP (the same path the archival script uses). Run this
    after granting Graph User.Read.All + admin consent to confirm the fix worked.

.DESCRIPTION
    Uses Connect-PnPOnline + Invoke-PnPGraphMethod with the SAME app/cert the
    archival script uses - so it needs only PnP.PowerShell (no Microsoft.Graph
    SDK) and validates the exact code path. It classifies the result:
      - 403 / Authorization_RequestDenied -> User.Read.All role/consent missing.
      - rows with id but null userPrincipalName -> missing User.Read.All
        (the "limited information" trap).
      - rows with populated userPrincipalName -> SUCCESS.
      - empty -> no soft-deleted users currently in the 30-day bin.

.EXAMPLE
    .\Test-GraphAccess.ps1 -ConfigPath ..\Config\ArchivalConfig.psd1
#>
#Requires -Version 7.2
param(
    [string] $ConfigPath = (Join-Path $PSScriptRoot '..\Config\ArchivalConfig.psd1')
)

$ErrorActionPreference = 'Stop'
$cfg = Import-PowerShellDataFile -Path $ConfigPath

Write-Host "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
if ($PSVersionTable.PSEdition -ne 'Core') {
    throw "Run this in PowerShell 7 (pwsh). PnP.PowerShell does not load on Windows PowerShell 5.1."
}
Import-Module PnP.PowerShell -ErrorAction Stop

Write-Host "Connecting to SharePoint (app-only) to obtain a Graph token via PnP ..." -ForegroundColor Cyan
$conn = Connect-PnPOnline -Url $cfg.ArchiveSiteUrl -ClientId $cfg.ClientId -Tenant $cfg.TenantId `
    -Thumbprint $cfg.CertificateThumbprint -ReturnConnection

$selectFields = 'id,userPrincipalName,displayName'
$url = "v1.0/directory/deletedItems/microsoft.graph.user?`$select=$selectFields&`$top=20"

Write-Host "Querying $url ..." -ForegroundColor Cyan
try {
    $resp  = Invoke-PnPGraphMethod -Connection $conn -Method Get -Url $url -ErrorAction Stop
    $value = @($resp.value)

    if ($value.Count -eq 0) {
        Write-Host "RESULT: 0 deleted users returned. Either the bin is empty, or the app cannot read users." -ForegroundColor Yellow
        return
    }
    $withUpn = @($value | Where-Object { $_.userPrincipalName })
    if ($withUpn.Count -eq 0) {
        Write-Host "RESULT: $($value.Count) object(s) returned but ALL have a null userPrincipalName." -ForegroundColor Red
        Write-Host "        => The app is MISSING the Graph 'User.Read.All' application role (limited-information trap)." -ForegroundColor Red
        Write-Host "        Grant User.Read.All + admin consent, then re-run." -ForegroundColor Red
        return
    }

    Write-Host "RESULT: SUCCESS - the app can read deleted users." -ForegroundColor Green
    $value | Select-Object id, userPrincipalName, displayName | Format-Table -AutoSize
}
catch {
    $msg = "$($_.Exception.Message)"
    Write-Host "RESULT: Graph call FAILED: $msg" -ForegroundColor Red
    if ($msg -match 'Authorization_RequestDenied|403|Forbidden') {
        Write-Host "        => 403: the 'User.Read.All' application role is not granted/consented." -ForegroundColor Red
    }
}
finally {
    if ($conn) { try { Disconnect-PnPOnline -Connection $conn -ErrorAction SilentlyContinue } catch {} }
}
