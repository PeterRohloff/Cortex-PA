<#
.SYNOPSIS
    Archives the OneDrive of every user currently in the Entra ID (Azure AD)
    deleted-user recycle bin into a central archive site collection, then writes
    a CSV report of everything that was done.

.DESCRIPTION
    For each soft-deleted user the script:
      1. Derives the user's OneDrive personal-site URL from their UPN.
      2. Checks the archive site for a library whose URL == the OneDrive suffix.
      3. Creates that library if missing (URL = suffix, Title = "Last, First").
      4. Copies every folder and file from the OneDrive into the library.
      5. Records the outcome (what, where, status) for the CSV report.

    The run is fully unattended (certificate app-only auth), idempotent
    (re-running skips already-copied files and already-completed users), and
    resilient (every network call is wrapped with throttle-aware retries).

.PARAMETER ConfigPath
    Path to the .psd1 configuration file. Defaults to .\Config\ArchivalConfig.psd1.

.PARAMETER UserPrincipalName
    Optional. Restrict the run to one or more specific deleted users (handy for
    testing). Accepts an array of UPNs.

.PARAMETER MaxUsers
    Optional. Process at most this many users (handy for a controlled first run).

.PARAMETER UserListCsv
    Optional. Path to a CSV listing the users to archive, used INSTEAD of querying
    the Entra ID deleted-user bin. Use this when the app can't be granted the Graph
    User.Read.All role, or to drive archival from an HR/offboarding feed. Required
    column: UserPrincipalName. Optional columns: DisplayName, GivenName, Surname
    (used to build the "Last, First" library title). Microsoft Graph is not called.

.PARAMETER CopyIfLibraryExists
    Optional switch. By default, if the archive library for a user already exists
    the script does NOT copy (existing data is left untouched); incomplete
    libraries are skipped with a WARNING and flagged in the CSV. Supply this
    switch to force a re-run to copy/resume into an existing library (e.g. to
    finish a library a prior run left incomplete).

.PARAMETER PreserveMetadata
    Optional (default $true). Stamp each archived file with the original
    Created/Modified dates and author/editor. Native person fields are set when
    the user still exists; the originals are ALWAYS also written to the
    "Original Created/Modified/Created By/Modified By" columns. Use
    -PreserveMetadata:$false to skip for speed.

.PARAMETER IncludeVersionHistory
    Optional (default $true). Copy each file's full version history (replays
    prior versions so the archived file has native versions; a JSON summary of
    the original version labels/dates/authors is stored in the "Version History"
    column). Use -IncludeVersionHistory:$false to copy only the current version.

.PARAMETER IncludeRecycleBin
    Optional switch. Write a CSV manifest of the user's OneDrive recycle bin
    (name, original location, size, who/when deleted) into the library. Read-only
    — recycled file CONTENT is not byte-copied (that would require restoring it).

.PARAMETER WhatIf
    Optional. Discover and report what WOULD happen without creating libraries
    or copying files.

.EXAMPLE
    .\Archive-DeletedUserOneDrive.ps1

.EXAMPLE
    .\Archive-DeletedUserOneDrive.ps1 -UserPrincipalName 'john.smith@fabrikam.com' -WhatIf

.EXAMPLE
    # Finish any libraries a previous run left incomplete:
    .\Archive-DeletedUserOneDrive.ps1 -CopyIfLibraryExists

.EXAMPLE
    # Drive archival from a CSV instead of the Entra deleted bin (no Graph role needed):
    .\Archive-DeletedUserOneDrive.ps1 -UserListCsv 'C:\offboarding\to-archive.csv'

.NOTES
    Requires module: PnP.PowerShell (PowerShell 7). The Entra ID deleted-user
    query is made through PnP via Invoke-PnPGraphMethod, so the Microsoft.Graph
    SDK is intentionally NOT used (its assemblies conflict with PnP's).
    Author: SharePoint Developer.
#>
#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]   $ConfigPath = (Join-Path $PSScriptRoot 'Config\ArchivalConfig.psd1'),
    [string[]] $UserPrincipalName,
    [int]      $MaxUsers = 0,

    # Optional. Path to a CSV that supplies the users to archive instead of querying
    # the Entra ID deleted-user bin (which needs the Graph User.Read.All app role).
    # Required column: UserPrincipalName. Optional: DisplayName, GivenName, Surname.
    # When supplied, Microsoft Graph is NOT contacted at all.
    [string]   $UserListCsv,

    # Default behaviour: if the archive library already exists, the user's content
    # is NOT copied (existing data is left untouched). Set this switch to force a
    # re-run to copy/resume into an existing library (e.g. to finish a library that
    # a prior run left incomplete).
    [switch]   $CopyIfLibraryExists,

    # Preserve original Created/Modified dates and author/editor (best-effort:
    # native person fields for live users, always-on text columns for the rest).
    # On by default; pass -PreserveMetadata:$false to skip for speed.
    [bool]     $PreserveMetadata = $true,

    # Copy each file's full version history (not just the current version).
    # On by default; pass -IncludeVersionHistory:$false to copy current only.
    [bool]     $IncludeVersionHistory = $true,

    # Also write a CSV manifest of the user's OneDrive recycle bin into the
    # library (read-only; recycled file CONTENT is not byte-copied). Opt-in.
    [switch]   $IncludeRecycleBin,

    # Proactive throttling pace (per file). -1 means "use the config value".
    [int]      $ThrottleDelayMs = -1,

    # Pause between users, in seconds. -1 means "use the config value".
    [int]      $InterUserDelaySeconds = -1,

    # Force NEW libraries this run onto a specific archive site (must be reachable;
    # it is added to the set searched for existing libraries). Omit to let
    # SiteSelectionMode choose automatically across the configured sites.
    [string]   $ArchiveSiteUrl,

    # Override how a NEW library's site is chosen when several are configured:
    # 'LeastStorage' (default), 'LeastLibraries', or 'First'. Omit to use the
    # config's SiteSelectionMode.
    [ValidateSet('LeastStorage', 'LeastLibraries', 'First')]
    [string]   $SiteSelectionMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Bootstrap: load config + module
# ---------------------------------------------------------------------------
if (-not (Test-Path $ConfigPath)) { throw "Configuration file not found: $ConfigPath" }
$config = Import-PowerShellDataFile -Path $ConfigPath

Import-Module (Join-Path $PSScriptRoot 'Modules\OneDriveArchival.psm1') -Force

$runStamp = (Get-Date).ToString('yyyyMMdd_HHmmss')

# Resolve throttling settings: explicit parameter > config value > built-in default.
$throttleMs = if ($ThrottleDelayMs -ge 0) { $ThrottleDelayMs }
              elseif ($config.ContainsKey('ThrottleDelayMs')) { [int]$config.ThrottleDelayMs } else { 200 }
$interUserSec = if ($InterUserDelaySeconds -ge 0) { $InterUserDelaySeconds }
              elseif ($config.ContainsKey('InterUserDelaySeconds')) { [int]$config.InterUserDelaySeconds } else { 2 }

# Outputs are organised into a per-run-date folder (yyyy-MM-dd).
$dateFolder = (Get-Date).ToString('yyyy-MM-dd')
$runOutputDir = Join-Path $config.OutputFolder $dateFolder
if (-not (Test-Path $runOutputDir))         { New-Item -ItemType Directory -Path $runOutputDir         -Force | Out-Null }
if (-not (Test-Path $config.StagingFolder)) { New-Item -ItemType Directory -Path $config.StagingFolder -Force | Out-Null }
$logPath  = Join-Path $runOutputDir "ArchivalRun_$runStamp.log"
$csvPath  = Join-Path $runOutputDir "ArchivalReport_$runStamp.csv"
$htmlPath = Join-Path $runOutputDir "ArchivalReport_$runStamp.html"

Write-ArchivalLog -LogPath $logPath -Level INFO -Message "=== Deleted-User OneDrive Archival run $runStamp started ==="
Write-ArchivalLog -LogPath $logPath -Level INFO -Message "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) on $([Environment]::UserName)."
Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Output folder: $runOutputDir. Throttle: ${throttleMs}ms/file, ${interUserSec}s/user."
if ($WhatIfPreference) { Write-ArchivalLog -LogPath $logPath -Level WARN -Message "WhatIf mode: no libraries will be created and no files copied." }

# ---------------------------------------------------------------------------
# Preflight: fail fast (with actionable guidance) if a required module can't be
# loaded for THIS PowerShell edition / account. This turns the confusing
# "'Connect-PnPOnline' is not recognized" error into a clear instruction.
# ---------------------------------------------------------------------------
if ($PSVersionTable.PSEdition -ne 'Core') {
    throw "This solution requires PowerShell 7 (pwsh), but it is running under Windows PowerShell $($PSVersionTable.PSVersion). PnP.PowerShell does not load on Windows PowerShell 5.1. Re-run with 'pwsh' (and schedule the task with pwsh.exe, not powershell.exe)."
}
# Only PnP.PowerShell is needed: the Entra deleted-user query goes through PnP
# (Invoke-PnPGraphMethod), so the Microsoft.Graph SDK is intentionally NOT used.
$requiredModules = @('PnP.PowerShell')
foreach ($m in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $m)) {
        throw "Required module '$m' is not available to $([Environment]::UserName) in PowerShell $($PSVersionTable.PSVersion). Install it for the account that runs this script: Install-Module $m -Scope CurrentUser -Force  (or -Scope AllUsers as admin). If a scheduled task runs as a service account, install it for THAT account or with -Scope AllUsers."
    }
    Import-Module $m -DisableNameChecking -ErrorAction Stop
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Loaded module $m $((Get-Module $m).Version)."
}

$report = New-Object System.Collections.Generic.List[object]
# Declared before the try so the finally block is StrictMode-safe even if the
# very first connection attempt throws.
$archiveSites = @()

# Resolve the archive site list (one or many) and the new-library placement mode.
$archiveUrls = Get-ArchiveSiteUrlList -Config $config -Extra $ArchiveSiteUrl
if ($archiveUrls.Count -eq 0) { throw "Config must define ArchiveSiteUrl or ArchiveSiteUrls." }
$selectionMode = if ($SiteSelectionMode) { $SiteSelectionMode }
                 elseif ($config.ContainsKey('SiteSelectionMode') -and $config.SiteSelectionMode) { "$($config.SiteSelectionMode)" }
                 else { 'LeastStorage' }

# Helper to push a row into the report. Accepts IDictionary so an [ordered]
# hashtable (OrderedDictionary) is preserved with its column order intact.
function Add-Row {
    param([System.Collections.IDictionary] $Row)
    $report.Add([pscustomobject]$Row)
}

try {
    # -----------------------------------------------------------------------
    # 1. Connect to ALL archive sites. Existing user libraries are found across
    #    every site; new libraries are placed by SiteSelectionMode (or forced to
    #    -ArchiveSiteUrl). The Graph deleted-user query runs through the first
    #    connection (Invoke-PnPGraphMethod), so the Microsoft.Graph SDK is never
    #    loaded and cannot conflict with PnP's assemblies.
    # -----------------------------------------------------------------------
    $archiveSites = Connect-ArchiveSites -Urls $archiveUrls -TenantId $config.TenantId `
        -ClientId $config.ClientId -CertificateThumbprint $config.CertificateThumbprint -LogPath $logPath
    $primaryConn = $archiveSites[0].Connection
    $forcedTarget = $null
    if ($ArchiveSiteUrl) { $forcedTarget = $archiveSites | Where-Object { $_.Url -ieq $ArchiveSiteUrl.TrimEnd('/') } | Select-Object -First 1 }

    # -----------------------------------------------------------------------
    # 2. Discover the users to archive (CSV feed OR Entra ID deleted-user bin)
    # -----------------------------------------------------------------------
    if ($UserListCsv) {
        # CSV feed: no Graph / directory permission required at all.
        $deletedUsers = Get-ArchivalUsersFromCsv -CsvPath $UserListCsv -OnlyTheseUpns $UserPrincipalName -LogPath $logPath
    }
    else {
        # Graph-through-PnP. The null-UPN "limited information" trap is detected
        # and thrown inside Get-ArchivalDeletedUsers.
        $deletedUsers = Get-ArchivalDeletedUsers -Connection $primaryConn -LogPath $logPath -OnlyTheseUpns $UserPrincipalName
        if (@($deletedUsers).Count -eq 0) {
            Write-ArchivalLog -LogPath $logPath -Level WARN -Message ("No soft-deleted users were returned. Either there are none in the 30-day bin, " +
                "or the app cannot read them (verify Graph 'User.Read.All' app role + admin consent, or use -UserListCsv).")
        }
    }
    $deletedUsers = @($deletedUsers)
    if ($MaxUsers -gt 0) { $deletedUsers = $deletedUsers | Select-Object -First $MaxUsers }

    # -----------------------------------------------------------------------
    # 2. Process each user
    # -----------------------------------------------------------------------
    foreach ($user in $deletedUsers) {
        $userStart = Get-Date
        # Soft-deleted users can have a GUID-stamped UPN; reconstruct the original
        # so the derived OneDrive URL matches the real personal site.
        $rawUpn = $user.UserPrincipalName
        $upn    = Get-CleanUserPrincipalName -UserPrincipalName $rawUpn -ObjectId $user.Id
        # [ordered] so the CSV columns always appear in this exact, documented order.
        $row = [ordered]@{
            Timestamp           = (Get-Date).ToString('s')
            UserPrincipalName   = $upn
            RawUserPrincipalName = $rawUpn
            DisplayName         = $user.DisplayName
            UserId              = $user.Id
            DeletedDateTime     = $user.DeletedDateTime
            OneDriveUrl         = ''
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

        # Declared before the try so the finally block is safe on an early 'continue'.
        $odConn      = $null
        $userStaging = $null

        try {
            if ([string]::IsNullOrWhiteSpace($upn)) {
                $row.Status = 'Skipped'; $row.Details = 'Deleted user has no UserPrincipalName.'
                Write-ArchivalLog -LogPath $logPath -Level WARN -Message "Skipping user $($user.Id): no UPN."
                continue   # the finally block records the row exactly once
            }

            # External / guest accounts (#EXT#) have no personal OneDrive; skip them
            # cleanly instead of failing on a non-existent personal site.
            if ($rawUpn -match '#EXT#' -or $upn -match '#EXT#') {
                $row.Status = 'Skipped-ExternalUser'
                $row.Details = 'External/guest account (#EXT#) - no OneDrive to archive.'
                Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Skipping external/guest user '$rawUpn'."
                continue   # the finally block records the row exactly once
            }

            $suffix   = Get-OneDriveUrlSuffix -UserPrincipalName $upn
            $title    = Get-ArchiveLibraryTitle -GivenName $user.GivenName -Surname $user.Surname `
                            -DisplayName $user.DisplayName -UserPrincipalName $upn
            $odUrl    = "$($config.MySiteHostUrl)/personal/$suffix"

            $row.OneDriveUrl         = $odUrl
            $row.ArchiveLibraryTitle = $title

            Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Processing '$upn' -> library '/$suffix' (title '$title')."

            # ---- connect to the source OneDrive ----
            try {
                $odConn = Connect-ArchivalSharePoint -Url $odUrl -TenantId $config.TenantId `
                    -ClientId $config.ClientId -CertificateThumbprint $config.CertificateThumbprint -LogPath $logPath
            } catch {
                $em = $_.Exception.Message
                # Distinguish a permissions problem (403/Access denied) from a genuinely
                # absent OneDrive (404). A permissions issue is a real failure that must be
                # surfaced, not silently treated as "no OneDrive".
                if ($em -match '\b403\b|access denied|unauthorized|forbidden') {
                    $row.Status  = 'Failed'
                    $row.Details = "Access denied connecting to OneDrive (check app site-collection access): $em"
                    Write-ArchivalLog -LogPath $logPath -Level ERROR -Message "Access denied for '$upn' OneDrive. $em"
                } else {
                    $row.Status  = 'Skipped-NoOneDrive'
                    $row.Details = "OneDrive not reachable: $em"
                    Write-ArchivalLog -LogPath $logPath -Level WARN -Message "No reachable OneDrive for '$upn'. $em"
                }
                continue   # the finally block records the row exactly once
            }

            $sourceRoot = "/personal/$suffix"

            # ---- locate the library across ALL archive sites, else pick a target ----
            $found = Find-ArchiveLibraryInSites -Sites $archiveSites -UrlSuffix $suffix -LogPath $logPath
            if ($found) {
                $tgt = $found.Site; $lib = $found.List
                Write-ArchivalLog -LogPath $logPath -Level INFO -Message "'$upn' existing library on $($tgt.Url)."
            } else {
                $tgt = if ($forcedTarget) { $forcedTarget } else { Select-TargetArchiveSite -Sites $archiveSites -Mode $selectionMode -LogPath $logPath }
                $lib = $null
            }
            $archiveConn        = $tgt.Connection
            $archiveSitePath    = $tgt.Path
            $targetLibServerRel = "$archiveSitePath/$suffix"
            $libUrl             = "$($tgt.Url)/$suffix"
            $row.ArchiveLibraryUrl = $libUrl

            if (-not $lib) {
                if ($PSCmdlet.ShouldProcess($libUrl, 'Create archive library')) {
                    New-ArchiveLibrary -Connection $archiveConn -UrlSuffix $suffix `
                        -DisplayTitle $title -ArchiveSiteUrl $tgt.Url -LogPath $logPath
                } else {
                    $row.Status = 'WhatIf'; $row.Details = 'Would create library and copy content.'
                    continue   # the finally block records the row exactly once
                }
            } else {
                # The library already exists. By default we do NOT copy into an
                # existing library (existing data is left untouched). The
                # -CopyIfLibraryExists switch overrides this to allow a re-run to
                # copy/resume.
                $isComplete = Test-ArchiveComplete -Connection $archiveConn -TargetLibraryServerRel $targetLibServerRel -LogPath $logPath

                if (-not $CopyIfLibraryExists) {
                    if ($isComplete) {
                        $row.Status  = 'AlreadyArchived'
                        $row.Details = 'Library exists and a prior run completed it; copy skipped.'
                        Write-ArchivalLog -LogPath $logPath -Level SUCCESS -Message "'$upn' already fully archived - skipping copy."
                    } else {
                        # Exists but never completed: skip per policy, but WARN and
                        # flag the row so partial archives are easy to spot and re-run.
                        $row.Status  = 'SkippedExists-Incomplete'
                        $row.Details = 'Library exists but has no completion marker (possible partial archive). Copy skipped - re-run with -CopyIfLibraryExists to finish.'
                        Write-ArchivalLog -LogPath $logPath -Level WARN -Message "'$upn' library '/$suffix' exists but is INCOMPLETE - skipping copy (re-run with -CopyIfLibraryExists to finish)."
                    }
                    continue   # the finally block records the row exactly once
                }

                # -CopyIfLibraryExists was supplied: proceed to copy/resume.
                $state = if ($isComplete) { 'previously completed' } else { 'incomplete' }
                Write-ArchivalLog -LogPath $logPath -Level INFO -Message "'$upn' library '/$suffix' exists ($state); -CopyIfLibraryExists set - copying/resuming."
            }

            if ($WhatIfPreference) {
                $row.Status = 'WhatIf'; $row.Details = 'Would copy OneDrive content into the library.'
                continue   # the finally block records the row exactly once
            }

            # ---- copy content ----
            $userStaging = Join-Path $config.StagingFolder $suffix
            if (-not (Test-Path $userStaging)) { New-Item -ItemType Directory -Path $userStaging -Force | Out-Null }

            $counters = Copy-OneDriveContent -SourceConnection $odConn -TargetConnection $archiveConn `
                -SourceSiteRelativeRoot $sourceRoot -SourceLibraryName 'Documents' `
                -TargetLibrarySiteRelative $suffix -TargetLibraryServerRel $targetLibServerRel `
                -StagingRoot $userStaging -PreserveMetadata $PreserveMetadata `
                -IncludeVersionHistory $IncludeVersionHistory -ThrottleDelayMs $throttleMs -LogPath $logPath

            # Defensive: if any PnP cmdlet leaked output into the return, keep only
            # the counters hashtable so property access can't fail.
            if ($counters -isnot [hashtable]) {
                $counters = @($counters) | Where-Object { $_ -is [hashtable] } | Select-Object -Last 1
            }
            if (-not $counters) { $counters = @{ Folders = 0; Files = 0; Skipped = 0; Bytes = [long]0; Errors = 0 } }

            # Optional: record the user's OneDrive recycle bin (manifest only, read-only).
            # Wrapped so a recycle-bin hiccup never fails an otherwise-good archive.
            $recycleCount = 0
            if ($IncludeRecycleBin) {
                try {
                    $recycleCount = Export-OneDriveRecycleBinManifest -SourceConnection $odConn -TargetConnection $archiveConn `
                        -TargetLibrarySiteRelative $suffix -StagingRoot $userStaging -LogPath $logPath
                } catch {
                    Write-ArchivalLog -LogPath $logPath -Level WARN -Message "Recycle-bin manifest failed for '$upn': $($_.Exception.Message)"
                }
            }

            $row.FoldersCreated = $counters.Folders
            $row.FilesCopied    = $counters.Files
            $row.FilesSkipped   = $counters.Skipped
            $row.BytesCopied    = $counters.Bytes

            $recycleNote = if ($IncludeRecycleBin) { " Recycle-bin items recorded: $recycleCount." } else { '' }
            if ($counters.Errors -gt 0) {
                $row.Status  = 'PartiallyArchived'
                $row.Details = "$($counters.Errors) file(s) failed to copy - see log $logPath.$recycleNote"
                Write-ArchivalLog -LogPath $logPath -Level WARN -Message "'$upn' partially archived: $($counters.Errors) error(s)."
            } else {
                $row.Status  = 'Archived'
                $row.Details = "Copied $($counters.Files) file(s), $($counters.Folders) folder(s).$recycleNote"
                # Mark complete so future runs skip this user instantly.
                Set-ArchiveComplete -Connection $archiveConn -TargetLibrarySiteRelative $suffix `
                    -Summary @{ User = $upn; CompletedUtc = (Get-Date).ToUniversalTime().ToString('o'); Files = $counters.Files; Folders = $counters.Folders; Bytes = $counters.Bytes } `
                    -StagingRoot $userStaging -LogPath $logPath
                Write-ArchivalLog -LogPath $logPath -Level SUCCESS -Message "'$upn' archived: $($counters.Files) file(s), $($counters.Bytes) bytes."
            }
        }
        catch {
            $em = $_.Exception.Message
            # A "NotFound"/"does not exist" while reaching the OneDrive means the
            # personal site/Documents library isn't there (e.g. never provisioned,
            # or already purged) - treat as no-OneDrive rather than a hard failure.
            if ($em -match 'NotFound|does not exist|404|Cannot get site') {
                $row.Status  = 'Skipped-NoOneDrive'
                $row.Details = "OneDrive/site not found: $em"
                Write-ArchivalLog -LogPath $logPath -Level WARN -Message "No OneDrive for '$upn' (not found). $em"
            } else {
                $row.Status  = 'Failed'
                $row.Details = $em
                Write-ArchivalLog -LogPath $logPath -Level ERROR -Message "Unhandled error for '$upn': $em"
            }
        }
        finally {
            # Release the per-user OneDrive connection and clean its staging folder
            # so connections/disk don't accumulate across a large run.
            if ($odConn) { try { Disconnect-PnPOnline -Connection $odConn -ErrorAction SilentlyContinue } catch {} }
            if ($userStaging -and (Test-Path $userStaging)) { Remove-Item $userStaging -Recurse -Force -ErrorAction SilentlyContinue }
            $row.DurationSeconds = [math]::Round(((Get-Date) - $userStart).TotalSeconds, 1)
            Add-Row $row
        }

        # Proactive pause between users to ease tenant throttling on large runs.
        if ($interUserSec -gt 0) { Start-Sleep -Seconds $interUserSec }
    }
}
catch {
    Write-ArchivalLog -LogPath $logPath -Level ERROR -Message "FATAL: $($_.Exception.Message)"
    # Still emit whatever was collected before the fatal error.
}
finally {
    # -----------------------------------------------------------------------
    # 3. Export CSV + HTML reports (always, into the dated output folder)
    # -----------------------------------------------------------------------
    if ($report.Count -gt 0) {
        $report | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
        Write-ArchivalLog -LogPath $logPath -Level SUCCESS -Message "CSV report written: $csvPath ($($report.Count) row(s))."
    } else {
        # Always emit a (header-only) CSV so a scheduled consumer gets a file every run.
        $columns = 'Timestamp','UserPrincipalName','RawUserPrincipalName','DisplayName','UserId',
                   'DeletedDateTime','OneDriveUrl','ArchiveLibraryUrl','ArchiveLibraryTitle','FoldersCreated',
                   'FilesCopied','FilesSkipped','BytesCopied','DurationSeconds','Status','Details'
        ('"' + ($columns -join '","') + '"') | Set-Content -Path $csvPath -Encoding UTF8
        Write-ArchivalLog -LogPath $logPath -Level WARN -Message "No deleted users to report; wrote header-only CSV: $csvPath."
    }

    # HTML report (best-effort; never let a reporting error mask the run result).
    try {
        Export-ArchivalHtmlReport -Report $report -Path $htmlPath -RunStamp $runStamp -LogPath $logPath
    } catch {
        Write-ArchivalLog -LogPath $logPath -Level WARN -Message "Could not write HTML report: $($_.Exception.Message)"
    }

    foreach ($s in $archiveSites) { if ($s.Connection) { try { Disconnect-PnPOnline -Connection $s.Connection -ErrorAction SilentlyContinue } catch {} } }
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "=== Run $runStamp finished ==="
}
