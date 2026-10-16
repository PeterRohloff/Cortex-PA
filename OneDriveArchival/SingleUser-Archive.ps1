<#
.SYNOPSIS
    Archives ONE targeted user's OneDrive to the archive site collection.

.DESCRIPTION
    A focused, single-user companion to Archive-DeletedUserOneDrive.ps1. It reuses
    the same module (auth, library naming/creation, incremental copy, metadata,
    version history, throttling, CSV+HTML reporting) but targets exactly one user
    identified by EITHER -UserPrincipalName OR -OneDriveUrl (exactly one required).

    Behaviour:
      * If the archive library for the user does NOT exist  -> it is created
        (URL = OneDrive suffix, Title = "Last, First") and all content is copied.
      * If the library DOES exist -> the script stops UNLESS -UpdateLibraryIfPresent
        is supplied, in which case it performs an INCREMENTAL update.

    The copy is ALWAYS incremental and NEVER destructive: it only adds or updates
    files in the target (files already present with the same byte size are skipped)
    and never deletes anything from the archive.

    Unlike the bulk script, single-user mode needs no Microsoft Graph permission -
    the display name is read from the OneDrive site itself.

.PARAMETER UserPrincipalName
    The user's UPN, e.g. 'joe.smith@contoso.com'. The OneDrive URL is derived from
    it and the tenant's MySiteHostUrl in the config. Mutually exclusive with -OneDriveUrl.

.PARAMETER OneDriveUrl
    The full OneDrive personal-site URL, e.g.
    'https://contoso-my.sharepoint.com/personal/joe_smith_contoso_com'.
    Mutually exclusive with -UserPrincipalName.

.PARAMETER UpdateLibraryIfPresent
    If the archive library already exists, perform an incremental update instead
    of stopping. Without this switch an existing library is left untouched.

.PARAMETER PreserveMetadata
    Preserve original Created/Modified + author (default $true).

.PARAMETER IncludeVersionHistory
    Copy full version history (default $true).

.PARAMETER IncludeRecycleBin
    Also write a manifest of the user's recycle bin (read-only). Opt-in.

.PARAMETER ThrottleDelayMs
    Pause (ms) after each file. -1 uses the config value.

.EXAMPLE
    .\SingleUser-Archive.ps1 -UserPrincipalName 'joe.smith@contoso.com'

.EXAMPLE
    .\SingleUser-Archive.ps1 -OneDriveUrl 'https://contoso-my.sharepoint.com/personal/joe_smith_contoso_com' -UpdateLibraryIfPresent

.NOTES
    Requires module: PnP.PowerShell (PowerShell 7). Same config + certificate app
    registration as the bulk script (SharePoint Sites.FullControl.All is enough).
    Author: SharePoint Developer.
#>
#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $UserPrincipalName,
    [string] $OneDriveUrl,
    [switch] $UpdateLibraryIfPresent,
    [string] $ConfigPath = (Join-Path $PSScriptRoot 'Config\ArchivalConfig.psd1'),
    [bool]   $PreserveMetadata = $true,
    [bool]   $IncludeVersionHistory = $true,
    [switch] $IncludeRecycleBin,
    [int]    $ThrottleDelayMs = -1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Validate the target selector: exactly one of UPN / OneDriveUrl.
# ---------------------------------------------------------------------------
$hasUpn = -not [string]::IsNullOrWhiteSpace($UserPrincipalName)
$hasUrl = -not [string]::IsNullOrWhiteSpace($OneDriveUrl)
if (-not $hasUpn -and -not $hasUrl) { throw "Provide either -UserPrincipalName or -OneDriveUrl (one is required)." }
if ($hasUpn -and $hasUrl)           { throw "Provide only ONE of -UserPrincipalName or -OneDriveUrl, not both." }

# ---------------------------------------------------------------------------
# Bootstrap: config + module + preflight.
# ---------------------------------------------------------------------------
if (-not (Test-Path $ConfigPath)) { throw "Configuration file not found: $ConfigPath" }
$config = Import-PowerShellDataFile -Path $ConfigPath

# Fail fast with a clear message if a required config value is missing/blank.
$requiredKeys = 'TenantId', 'ClientId', 'CertificateThumbprint', 'OutputFolder', 'StagingFolder'
$missingKeys = $requiredKeys | Where-Object { -not $config.ContainsKey($_) -or [string]::IsNullOrWhiteSpace("$($config[$_])") }
if ($missingKeys) { throw "Config '$ConfigPath' is missing required value(s): $($missingKeys -join ', ')." }

Import-Module (Join-Path $PSScriptRoot 'Modules\OneDriveArchival.psm1') -Force

if ($PSVersionTable.PSEdition -ne 'Core') {
    throw "This solution requires PowerShell 7 (pwsh); PnP.PowerShell does not load on Windows PowerShell 5.1."
}
if (-not (Get-Module -ListAvailable -Name 'PnP.PowerShell')) {
    throw "Required module 'PnP.PowerShell' is not available to $([Environment]::UserName). Install: Install-Module PnP.PowerShell -Scope CurrentUser -Force"
}
Import-Module PnP.PowerShell -DisableNameChecking -ErrorAction Stop

$runStamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
$throttleMs = if ($ThrottleDelayMs -ge 0) { $ThrottleDelayMs }
              elseif ($config.ContainsKey('ThrottleDelayMs')) { [int]$config.ThrottleDelayMs } else { 200 }

$dateFolder   = (Get-Date).ToString('yyyy-MM-dd')
$runOutputDir = Join-Path $config.OutputFolder $dateFolder
if (-not (Test-Path $runOutputDir))         { New-Item -ItemType Directory -Path $runOutputDir         -Force | Out-Null }
if (-not (Test-Path $config.StagingFolder)) { New-Item -ItemType Directory -Path $config.StagingFolder -Force | Out-Null }
$logPath  = Join-Path $runOutputDir "SingleUserRun_$runStamp.log"
$csvPath  = Join-Path $runOutputDir "SingleUserReport_$runStamp.csv"
$htmlPath = Join-Path $runOutputDir "SingleUserReport_$runStamp.html"

Write-ArchivalLog -LogPath $logPath -Level INFO -Message "=== Single-user OneDrive archival run $runStamp started ==="
Write-ArchivalLog -LogPath $logPath -Level INFO -Message "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) on $([Environment]::UserName). Throttle ${throttleMs}ms/file."

$report = New-Object System.Collections.Generic.List[object]
$odConn = $null; $archiveSites = @(); $userStaging = $null
$userStart = Get-Date

# ---------------------------------------------------------------------------
# Resolve the OneDrive URL + suffix from whichever selector was supplied.
# ---------------------------------------------------------------------------
if ($hasUrl) {
    $uri = $null
    if (-not [Uri]::TryCreate($OneDriveUrl, [UriKind]::Absolute, [ref]$uri)) {
        throw "-OneDriveUrl '$OneDriveUrl' is not a valid absolute URL (expected e.g. https://contoso-my.sharepoint.com/personal/joe_smith_contoso_com)."
    }
    $segs = @($uri.AbsolutePath.Trim('/').Split('/'))
    $pi = -1
    for ($i = 0; $i -lt $segs.Count; $i++) { if ($segs[$i] -ieq 'personal') { $pi = $i; break } }
    if ($pi -lt 0 -or $pi + 1 -ge $segs.Count) { throw "Could not find a '/personal/<suffix>' segment in -OneDriveUrl '$OneDriveUrl'." }
    $suffix = $segs[$pi + 1].ToLowerInvariant()
    $odUrl  = "$($uri.Scheme)://$($uri.Authority)/personal/$suffix"
} else {
    $suffix = Get-OneDriveUrlSuffix -UserPrincipalName $UserPrincipalName
    if ([string]::IsNullOrWhiteSpace($config.MySiteHostUrl)) { throw "Config 'MySiteHostUrl' is required to derive a OneDrive URL from a UPN." }
    $odUrl  = "$($config.MySiteHostUrl.TrimEnd('/'))/personal/$suffix"
}

# Resolve the configured archive site list (supports one or many).
$archiveUrls = Get-ArchiveSiteUrlList -Config $config
if ($archiveUrls.Count -eq 0) { throw "Config must define ArchiveSiteUrl or ArchiveSiteUrls." }
$selectionMode = if ($config.ContainsKey('SiteSelectionMode') -and $config.SiteSelectionMode) { "$($config.SiteSelectionMode)" } else { 'LeastStorage' }

$row = [ordered]@{
    Timestamp           = (Get-Date).ToString('s')
    UserPrincipalName   = $UserPrincipalName
    DisplayName         = ''
    OneDriveUrl         = $odUrl
    ArchiveLibraryUrl   = ''
    ArchiveLibraryTitle = ''
    FoldersCreated      = 0
    FilesCopied         = 0
    FilesSkipped        = 0
    BytesCopied         = 0
    DurationSeconds     = 0
    Status              = ''
    Details             = ''
}

try {
    # ---- connect to all archive sites (reused) + the source OneDrive ----
    $archiveSites = Connect-ArchiveSites -Urls $archiveUrls -TenantId $config.TenantId `
        -ClientId $config.ClientId -CertificateThumbprint $config.CertificateThumbprint -LogPath $logPath

    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Connecting to source OneDrive: $odUrl"
    try {
        $odConn = Connect-ArchivalSharePoint -Url $odUrl -TenantId $config.TenantId `
            -ClientId $config.ClientId -CertificateThumbprint $config.CertificateThumbprint -LogPath $logPath
    } catch {
        $em = $_.Exception.Message
        if ($em -match '\b403\b|access denied|unauthorized|forbidden') {
            $row.Status = 'Failed'; $row.Details = "Access denied to OneDrive (check app site access): $em"
        } else {
            $row.Status = 'Skipped-NoOneDrive'; $row.Details = "OneDrive not reachable: $em"
        }
        throw
    }

    # ---- resolve the friendly "Last, First" title from the OneDrive site itself ----
    $displayName = ''
    try { $displayName = (Get-PnPWeb -Connection $odConn -ErrorAction Stop).Title } catch {}
    $title = Get-ArchiveLibraryTitle -DisplayName $displayName -UserPrincipalName $UserPrincipalName
    $row.DisplayName = $displayName
    $row.ArchiveLibraryTitle = $title
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Target '$suffix' -> library '/$suffix' (title '$title')."

    # ---- find the user's library across ALL archive sites; else pick a target ----
    $found = Find-ArchiveLibraryInSites -Sites $archiveSites -UrlSuffix $suffix -LogPath $logPath
    if ($found) {
        $tgt = $found.Site
        Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Existing library found on $($tgt.Url)."
    } else {
        $tgt = Select-TargetArchiveSite -Sites $archiveSites -Mode $selectionMode -LogPath $logPath
        Write-ArchivalLog -LogPath $logPath -Level INFO -Message "No existing library; target site $($tgt.Url) (mode $selectionMode)."
    }
    $archiveConn        = $tgt.Connection
    $targetLibServerRel = "$($tgt.Path)/$suffix"
    $libUrl             = "$($tgt.Url)/$suffix"
    $row.ArchiveLibraryUrl = $libUrl

    if (-not $found) {
        if ($PSCmdlet.ShouldProcess($libUrl, 'Create archive library')) {
            New-ArchiveLibrary -Connection $archiveConn -UrlSuffix $suffix -DisplayTitle $title `
                -ArchiveSiteUrl $tgt.Url -LogPath $logPath
        } else {
            $row.Status = 'WhatIf'; $row.Details = 'Would create library and copy content.'
            throw [System.OperationCanceledException]::new('WhatIf')
        }
    } else {
        if (-not $UpdateLibraryIfPresent) {
            $row.Status  = 'SkippedExists'
            $row.Details = "Library '/$suffix' already exists on $($tgt.Url). Re-run with -UpdateLibraryIfPresent to perform an incremental update."
            Write-ArchivalLog -LogPath $logPath -Level WARN -Message $row.Details
            throw [System.OperationCanceledException]::new('exists')
        }
        Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Library '/$suffix' exists; -UpdateLibraryIfPresent set - incremental update (non-destructive)."
    }

    if ($WhatIfPreference) {
        $row.Status = 'WhatIf'; $row.Details = 'Would copy/update OneDrive content into the library.'
        throw [System.OperationCanceledException]::new('WhatIf')
    }

    # ---- incremental, non-destructive copy ----
    $userStaging = Join-Path $config.StagingFolder $suffix
    if (-not (Test-Path $userStaging)) { New-Item -ItemType Directory -Path $userStaging -Force | Out-Null }

    $counters = Copy-OneDriveContent -SourceConnection $odConn -TargetConnection $archiveConn `
        -SourceSiteRelativeRoot "/personal/$suffix" -SourceLibraryName 'Documents' `
        -TargetLibrarySiteRelative $suffix -TargetLibraryServerRel $targetLibServerRel `
        -StagingRoot $userStaging -PreserveMetadata $PreserveMetadata `
        -IncludeVersionHistory $IncludeVersionHistory -ThrottleDelayMs $throttleMs -LogPath $logPath

    if ($counters -isnot [hashtable]) {
        $counters = @($counters) | Where-Object { $_ -is [hashtable] } | Select-Object -Last 1
    }
    if (-not $counters) { $counters = @{ Folders = 0; Files = 0; Skipped = 0; Bytes = [long]0; Errors = 0 } }

    $recycleCount = 0
    if ($IncludeRecycleBin) {
        try {
            $recycleCount = Export-OneDriveRecycleBinManifest -SourceConnection $odConn -TargetConnection $archiveConn `
                -TargetLibrarySiteRelative $suffix -StagingRoot $userStaging -LogPath $logPath
        } catch { Write-ArchivalLog -LogPath $logPath -Level WARN -Message "Recycle-bin manifest failed: $($_.Exception.Message)" }
    }

    $row.FoldersCreated = $counters.Folders
    $row.FilesCopied    = $counters.Files
    $row.FilesSkipped   = $counters.Skipped
    $row.BytesCopied    = $counters.Bytes
    $recycleNote = if ($IncludeRecycleBin) { " Recycle-bin items recorded: $recycleCount." } else { '' }

    if ($counters.Errors -gt 0) {
        $row.Status  = 'PartiallyArchived'
        $row.Details = "$($counters.Errors) file(s) failed to copy - see log $logPath.$recycleNote"
        Write-ArchivalLog -LogPath $logPath -Level WARN -Message "Partially archived: $($counters.Errors) error(s)."
    } else {
        $row.Status  = 'Archived'
        $row.Details = "Copied $($counters.Files) file(s) ($($counters.Skipped) already present), $($counters.Folders) folder(s).$recycleNote"
        Set-ArchiveComplete -Connection $archiveConn -TargetLibrarySiteRelative $suffix `
            -Summary @{ User = "$UserPrincipalName$OneDriveUrl"; CompletedUtc = (Get-Date).ToUniversalTime().ToString('o'); Files = $counters.Files; Folders = $counters.Folders; Bytes = $counters.Bytes } `
            -StagingRoot $userStaging -LogPath $logPath
        Write-ArchivalLog -LogPath $logPath -Level SUCCESS -Message "Archived: $($counters.Files) file(s), $($counters.Bytes) bytes; $($counters.Skipped) skipped."
    }
}
catch [System.OperationCanceledException] {
    # Controlled early-exit (WhatIf / exists-without-update) - status already set.
}
catch {
    if ([string]::IsNullOrWhiteSpace($row.Status)) {
        $em = $_.Exception.Message
        if ($em -match 'NotFound|does not exist|404|Cannot get site') {
            $row.Status = 'Skipped-NoOneDrive'; $row.Details = "OneDrive/site not found: $em"
        } else {
            $row.Status = 'Failed'; $row.Details = $em
        }
    }
    Write-ArchivalLog -LogPath $logPath -Level ERROR -Message "Error: $($row.Details)"
}
finally {
    if ($odConn) { try { Disconnect-PnPOnline -Connection $odConn -ErrorAction SilentlyContinue } catch {} }
    if ($userStaging -and (Test-Path $userStaging)) { Remove-Item $userStaging -Recurse -Force -ErrorAction SilentlyContinue }
    $row.DurationSeconds = [math]::Round(((Get-Date) - $userStart).TotalSeconds, 1)
    $report.Add([pscustomobject]$row)

    $report | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
    Write-ArchivalLog -LogPath $logPath -Level SUCCESS -Message "CSV report written: $csvPath"
    try { Export-ArchivalHtmlReport -Report $report -Path $htmlPath -RunStamp $runStamp -LogPath $logPath }
    catch { Write-ArchivalLog -LogPath $logPath -Level WARN -Message "Could not write HTML report: $($_.Exception.Message)" }

    foreach ($s in $archiveSites) { if ($s.Connection) { try { Disconnect-PnPOnline -Connection $s.Connection -ErrorAction SilentlyContinue } catch {} } }
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "=== Single-user run $runStamp finished ($($row.Status)) ==="
}
