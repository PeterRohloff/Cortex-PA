<#
.SYNOPSIS
    Copies content FROM an archive library TO another user's OneDrive, into a
    folder named "Archive-<SourceLibrary>", and logs the action to an
    'IncidentTracking' list on the archive site that holds the source library.

.DESCRIPTION
    Restore/hand-off companion to the archival scripts. It finds a library (by its
    title, e.g. 'Smith, Joe') across ALL configured archive sites, selects content
    by one or more filters, and copies it into the destination user's OneDrive under
    "Documents/Archive-<SourceLibrary>" (e.g. 'Archive-Smith, Joe').

    Selection (combine as needed):
      -All                     everything in the library (default if no filter)
      -Folder  a,b             one or more folders (recursive)
      -File    x,y             one or more specific files (path or leaf name)
      -AllFilesWithExtension mp4[,mov]   every file with the extension(s), in ANY
                               folder (great for gathering all meeting recordings)
    -Folder/-File set the scope; -AllFilesWithExtension then filters that scope.

    The copy is incremental and NON-destructive: a destination file already present
    with the same byte size is skipped; nothing is ever deleted.

    Tracking: for every run, an item is added to the 'IncidentTracking' list on the
    archive site holding the source library, with TicketNumber, Source, Destination
    and ProcessedOn. The list and its columns are created automatically if missing.

.PARAMETER SourceLibrary
    Title (or URL leaf) of the archive library to copy from, e.g. 'Smith, Joe'.

.PARAMETER DestinationOneDrive
    Destination user's OneDrive URL (https://...-my.sharepoint.com/personal/...)
    OR their UserPrincipalName (e.g. abbey.marks@contosohealth.com).

.PARAMETER TicketNumber
    Required. Tracking ticket number recorded in the IncidentTracking list.

.PARAMETER All
    Copy everything in the source library (same as supplying no selection filter).

.PARAMETER Folder
    One or more folders (library-relative) to copy recursively.

.PARAMETER File
    One or more specific files (library-relative path or just the leaf name).

.PARAMETER AllFilesWithExtension
    One or more extensions (e.g. mp4, 'mp4','mov'); copies every matching file in
    the selected scope regardless of which subfolder it lives in.

.PARAMETER Flatten
    Place all copied files directly in the Archive-<name> folder instead of
    recreating their source subfolder structure. (Off by default.)

.EXAMPLE
    .\Copy-FromArchive.ps1 -SourceLibrary 'Smith, Joe' `
        -DestinationOneDrive 'https://contosohealth-my.sharepoint.com/personal/abbey_marks_contosohealth_com' `
        -AllFilesWithExtension mp4 -TicketNumber 'INC0012345'

.NOTES
    Requires module: PnP.PowerShell (PowerShell 7). Same config + certificate app
    (SharePoint Sites.FullControl.All). Author: SharePoint Developer.
#>
#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string]   $SourceLibrary,
    [Parameter(Mandatory)] [string]   $DestinationOneDrive,
    [Parameter(Mandatory)] [string]   $TicketNumber,
    [switch]   $All,
    [string[]] $Folder,
    [string[]] $File,
    [string[]] $AllFilesWithExtension,
    [switch]   $Flatten,
    [string]   $ConfigPath = (Join-Path $PSScriptRoot 'Config\ArchivalConfig.psd1'),
    [int]      $ThrottleDelayMs = -1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Bootstrap: config + module + preflight
# ---------------------------------------------------------------------------
if (-not (Test-Path $ConfigPath)) { throw "Configuration file not found: $ConfigPath" }
$config = Import-PowerShellDataFile -Path $ConfigPath
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

$archiveUrls = Get-ArchiveSiteUrlList -Config $config
if ($archiveUrls.Count -eq 0) { throw "Config must define ArchiveSiteUrl or ArchiveSiteUrls." }

$runStamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
$throttleMs = if ($ThrottleDelayMs -ge 0) { $ThrottleDelayMs }
              elseif ($config.ContainsKey('ThrottleDelayMs')) { [int]$config.ThrottleDelayMs } else { 200 }
$dateFolder   = (Get-Date).ToString('yyyy-MM-dd')
$runOutputDir = Join-Path $config.OutputFolder $dateFolder
if (-not (Test-Path $runOutputDir))         { New-Item -ItemType Directory -Path $runOutputDir         -Force | Out-Null }
if (-not (Test-Path $config.StagingFolder)) { New-Item -ItemType Directory -Path $config.StagingFolder -Force | Out-Null }
$logPath = Join-Path $runOutputDir "CopyFromArchive_${TicketNumber}_$runStamp.log"
$csvPath = Join-Path $runOutputDir "CopyFromArchive_${TicketNumber}_$runStamp.csv"

Write-ArchivalLog -LogPath $logPath -Level INFO -Message "=== Copy-FromArchive (ticket $TicketNumber) run $runStamp started ==="
Write-ArchivalLog -LogPath $logPath -Level INFO -Message "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)). Throttle ${throttleMs}ms/file. $($archiveUrls.Count) archive site(s)."

$fileReport = New-Object System.Collections.Generic.List[object]
$archiveSites = @(); $destConn = $null; $staging = $null
$copied = 0; $skipped = 0; $errors = 0; [long]$bytes = 0

try {
    # -----------------------------------------------------------------------
    # 1. Connect to all archive sites and locate the source library by title
    # -----------------------------------------------------------------------
    $archiveSites = Connect-ArchiveSites -Urls $archiveUrls -TenantId $config.TenantId `
        -ClientId $config.ClientId -CertificateThumbprint $config.CertificateThumbprint -LogPath $logPath

    $srcMatch = Find-ArchiveLibraryByTitleInSites -Sites $archiveSites -TitleOrLeaf $SourceLibrary -LogPath $logPath
    if (-not $srcMatch) { throw "Source library '$SourceLibrary' not found on any configured archive site." }
    $archiveConn = $srcMatch.Site.Connection
    $srcList     = $srcMatch.List
    $srcRoot     = $srcMatch.Root
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Source library '$($srcList.Title)' at $srcRoot (site $($srcMatch.Site.Url))."

    # -----------------------------------------------------------------------
    # 2. Resolve the destination OneDrive (URL or UPN) and the target folder
    # -----------------------------------------------------------------------
    if ($DestinationOneDrive -match '://') {
        $du = $null
        if (-not [Uri]::TryCreate($DestinationOneDrive, [UriKind]::Absolute, [ref]$du)) { throw "-DestinationOneDrive is not a valid absolute URL." }
        $dsegs = @($du.AbsolutePath.Trim('/').Split('/'))
        $dpi = -1; for ($i = 0; $i -lt $dsegs.Count; $i++) { if ($dsegs[$i] -ieq 'personal') { $dpi = $i; break } }
        if ($dpi -lt 0 -or $dpi + 1 -ge $dsegs.Count) { throw "Could not find '/personal/<suffix>' in -DestinationOneDrive." }
        $destSuffix = $dsegs[$dpi + 1].ToLowerInvariant()
        $destUrl    = "$($du.Scheme)://$($du.Authority)/personal/$destSuffix"
    }
    elseif ($DestinationOneDrive -match '@') {
        if ([string]::IsNullOrWhiteSpace($config.MySiteHostUrl)) { throw "Config 'MySiteHostUrl' is required to derive a OneDrive URL from a UPN." }
        $destSuffix = Get-OneDriveUrlSuffix -UserPrincipalName $DestinationOneDrive
        $destUrl    = "$($config.MySiteHostUrl.TrimEnd('/'))/personal/$destSuffix"
    }
    else { throw "-DestinationOneDrive must be a OneDrive URL or a UserPrincipalName." }

    $archiveFolderName = Get-SafeSharePointName -Name ("Archive-" + $SourceLibrary)   # e.g. Archive-Smith, Joe
    $destRootSiteRel   = Join-UrlSegment 'Documents' $archiveFolderName               # site-relative within the OneDrive

    $destConn = Connect-ArchivalSharePoint -Url $destUrl -TenantId $config.TenantId `
        -ClientId $config.ClientId -CertificateThumbprint $config.CertificateThumbprint -LogPath $logPath
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Destination OneDrive $destUrl -> folder '/$destRootSiteRel'."

    # Ensure the top-level Archive-<name> folder exists (skip under -WhatIf - it mutates).
    if (-not $WhatIfPreference) {
        Invoke-WithRetry -Operation 'EnsureArchiveFolder' -LogPath $logPath -ScriptBlock {
            Resolve-PnPFolder -Connection $destConn -SiteRelativePath $destRootSiteRel -ErrorAction Stop | Out-Null
        }
    }

    # -----------------------------------------------------------------------
    # 3. Enumerate the source library and apply the selection filters
    # -----------------------------------------------------------------------
    # No -Fields: load default field values (always includes FileRef/FileLeafRef/
    # FSObjType and the size fields) so we never fail on an unrequestable field.
    $items = Invoke-WithRetry -Operation 'Get-PnPListItem' -LogPath $logPath -ScriptBlock {
        Get-PnPListItem -Connection $archiveConn -List $srcList.Id -PageSize 2000 -ErrorAction Stop
    }

    # Project to lightweight file records (files only; FSObjType 0 = file, 1 = folder).
    $allFiles = foreach ($it in $items) {
        $fv = $it.FieldValues
        if ("$($fv['FSObjType'])" -ne '0') { continue }
        $ref  = "$($fv['FileRef'])"
        $leaf = "$($fv['FileLeafRef'])"
        $rel  = $ref
        if ($rel.ToLowerInvariant().StartsWith($srcRoot.ToLowerInvariant())) { $rel = $rel.Substring($srcRoot.Length) }
        $rel  = $rel.TrimStart('/')
        # Use File_x0020_Size (CURRENT version size) to match the destination's
        # current-version .Length. SMTotalFileStreamSize is the sum across ALL
        # versions, so it would never match for a versioned archive file.
        $size = 0L
        if ($fv.ContainsKey('File_x0020_Size') -and $fv['File_x0020_Size'])                 { $size = [long]$fv['File_x0020_Size'] }
        elseif ($fv.ContainsKey('SMTotalFileStreamSize') -and $fv['SMTotalFileStreamSize']) { $size = [long]$fv['SMTotalFileStreamSize'] }
        [pscustomobject]@{ ServerRel = $ref; RelPath = $rel; Name = $leaf; Size = $size }
    }
    # Filter nulls so an empty library doesn't become a phantom @($null) 1-element array.
    $allFiles = @($allFiles | Where-Object { $_ })
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "Library contains $($allFiles.Count) file(s)."

    # Scope: folders/files if given, else whole library.
    $scope = @()
    if ($Folder -or $File) {
        if ($Folder) {
            $normFolders = @($Folder | ForEach-Object { $_.Trim().Trim('/').ToLowerInvariant() } | Where-Object { $_ })
            $scope += $allFiles | Where-Object {
                $d = $_.RelPath.ToLowerInvariant()
                foreach ($nf in $normFolders) { if ($d -eq $nf -or $d.StartsWith("$nf/")) { return $true } }
                $false
            }
        }
        if ($File) {
            $normFiles = @($File | ForEach-Object { $_.Trim().Trim('/').ToLowerInvariant() } | Where-Object { $_ })
            $scope += $allFiles | Where-Object {
                ($normFiles -contains $_.RelPath.ToLowerInvariant()) -or ($normFiles -contains $_.Name.ToLowerInvariant())
            }
        }
        $scope = $scope | Sort-Object -Property ServerRel -Unique
    } else {
        $scope = $allFiles   # -All or no selector
    }

    # Extension filter (applied on top of the scope).
    if ($AllFilesWithExtension) {
        $exts = @($AllFilesWithExtension | ForEach-Object { $_.TrimStart('.').ToLowerInvariant() } | Where-Object { $_ })
        $scope = $scope | Where-Object {
            $e = ([IO.Path]::GetExtension($_.Name)).TrimStart('.').ToLowerInvariant()
            $exts -contains $e
        }
    }
    # Filter nulls so a no-match selection is a clean empty set, not @($null).
    $selected = @($scope | Where-Object { $_ })
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "$($selected.Count) file(s) selected for copy to '/$destRootSiteRel'."
    if ($selected.Count -eq 0) {
        Write-ArchivalLog -LogPath $logPath -Level WARN -Message "No files matched the selection - nothing to copy."
    }

    if ($WhatIfPreference) {
        Write-ArchivalLog -LogPath $logPath -Level WARN -Message "WhatIf: would copy $($selected.Count) file(s). No changes made."
    }

    # -----------------------------------------------------------------------
    # 4. Copy each selected file (incremental, non-destructive)
    # -----------------------------------------------------------------------
    $ensuredFolders = @{ $destRootSiteRel = $true }
    $usedDestPaths  = @{}   # guards against -Flatten leaf-name collisions
    $staging = Join-Path $config.StagingFolder ("copy_" + $runStamp)
    if (-not (Test-Path $staging)) { New-Item -ItemType Directory -Path $staging -Force | Out-Null }

    foreach ($f in $selected) {
        $relDir  = if ($Flatten) { '' } else { [IO.Path]::GetDirectoryName($f.RelPath) -replace '\\', '/' }
        $safeName = Get-SafeSharePointName -Name $f.Name
        $destFolderSiteRel = if ($relDir) { Join-UrlSegment $destRootSiteRel $relDir } else { $destRootSiteRel }

        # With -Flatten (or any case where two source files map to the same target),
        # disambiguate so a differently-sourced file never overwrites another.
        $destKey = "$destFolderSiteRel/$safeName".ToLowerInvariant()
        if ($usedDestPaths.ContainsKey($destKey)) {
            $b = [IO.Path]::GetFileNameWithoutExtension($safeName); $x = [IO.Path]::GetExtension($safeName); $n = 1
            do { $safeName = "${b}_$n$x"; $destKey = "$destFolderSiteRel/$safeName".ToLowerInvariant(); $n++ }
            while ($usedDestPaths.ContainsKey($destKey))
            Write-ArchivalLog -LogPath $logPath -Level WARN -Message "Name collision: '$($f.RelPath)' copied as '$safeName'."
        }
        $usedDestPaths[$destKey] = $true

        $destServerRel = "/personal/$destSuffix/$destFolderSiteRel/$safeName" -replace '(?<!:)//+', '/'

        $status = ''
        try {
            if ($WhatIfPreference) {
                $status = 'WhatIf'
            } else {
                # Ensure the destination subfolder exists (cache to avoid repeat calls).
                if (-not $ensuredFolders.ContainsKey($destFolderSiteRel)) {
                    Invoke-WithRetry -Operation "EnsureFolder-$relDir" -LogPath $logPath -ScriptBlock {
                        Resolve-PnPFolder -Connection $destConn -SiteRelativePath $destFolderSiteRel -ErrorAction Stop | Out-Null
                    }
                    $ensuredFolders[$destFolderSiteRel] = $true
                }

                # Incremental: skip if the destination already has a same-size file.
                $existing = $null
                try { $existing = Get-PnPFile -Connection $destConn -Url $destServerRel -AsFileObject -ErrorAction Stop } catch { $existing = $null }
                if ($existing -and [long]$existing.Length -eq [long]$f.Size) {
                    $skipped++; $status = 'Skipped-Exists'
                } else {
                    Invoke-WithRetry -Operation "Download-$safeName" -LogPath $logPath -ScriptBlock {
                        Get-PnPFile -Connection $archiveConn -Url $f.ServerRel -Path $staging -FileName $safeName -AsFile -Force -ErrorAction Stop
                    }
                    Invoke-WithRetry -Operation "Upload-$safeName" -LogPath $logPath -ScriptBlock {
                        Add-PnPFile -Connection $destConn -Path (Join-Path $staging $safeName) -Folder $destFolderSiteRel -ErrorAction Stop | Out-Null
                    }
                    Remove-Item (Join-Path $staging $safeName) -Force -ErrorAction SilentlyContinue
                    $copied++; $bytes += [long]$f.Size; $status = 'Copied'
                    if ($throttleMs -gt 0) { Start-Sleep -Milliseconds $throttleMs }
                }
            }
        } catch {
            $errors++; $status = 'Failed'
            Write-ArchivalLog -LogPath $logPath -Level ERROR -Message "Failed to copy '$($f.RelPath)': $($_.Exception.Message)"
        }
        $fileReport.Add([pscustomobject]@{
            TicketNumber = $TicketNumber
            SourceFile   = $f.RelPath
            SizeBytes    = $f.Size
            Destination  = "$destRootSiteRel/$(if($Flatten){''}else{$relDir})".TrimEnd('/') + "/$safeName"
            Status       = $status
        })
    }

    Write-ArchivalLog -LogPath $logPath -Level SUCCESS -Message "Copy complete: $copied copied, $skipped skipped, $errors error(s), $bytes bytes."

    # -----------------------------------------------------------------------
    # 5. Record the operation in the IncidentTracking list (create if missing)
    #    on the archive site that holds the source library.
    # -----------------------------------------------------------------------
    if (-not $WhatIfPreference) {
        try {
            $inc = Get-PnPList -Connection $archiveConn -Identity 'IncidentTracking' -ErrorAction SilentlyContinue
            if (-not $inc) {
                Invoke-WithRetry -Operation 'New-IncidentList' -LogPath $logPath -ScriptBlock {
                    New-PnPList -Connection $archiveConn -Title 'IncidentTracking' -Template GenericList -OnQuickLaunch:$false -ErrorAction Stop | Out-Null
                }
            }
            $incFields = @(
                @{ Name = 'TicketNumber'; Type = 'Text';     Display = 'TicketNumber' },
                @{ Name = 'Source';       Type = 'Text';     Display = 'Source' },
                @{ Name = 'Destination';  Type = 'Note';     Display = 'Destination' },
                @{ Name = 'ProcessedOn';  Type = 'DateTime'; Display = 'ProcessedOn' }
            )
            $existingFields = @()
            try { $existingFields = @(Get-PnPField -Connection $archiveConn -List 'IncidentTracking' -ErrorAction Stop | ForEach-Object { $_.InternalName }) } catch {}
            foreach ($fld in $incFields) {
                if ($existingFields -notcontains $fld.Name) {
                    Invoke-WithRetry -Operation "AddField-$($fld.Name)" -LogPath $logPath -ScriptBlock {
                        Add-PnPField -Connection $archiveConn -List 'IncidentTracking' -DisplayName $fld.Display `
                            -InternalName $fld.Name -Type $fld.Type -AddToDefaultView:$true -ErrorAction Stop | Out-Null
                    }
                }
            }
            Invoke-WithRetry -Operation 'Add-IncidentItem' -LogPath $logPath -ScriptBlock {
                Add-PnPListItem -Connection $archiveConn -List 'IncidentTracking' -Values @{
                    Title        = $TicketNumber
                    TicketNumber = $TicketNumber
                    Source       = $SourceLibrary
                    Destination  = $destUrl
                    ProcessedOn  = (Get-Date)
                } -ErrorAction Stop | Out-Null
            }
            Write-ArchivalLog -LogPath $logPath -Level SUCCESS -Message "IncidentTracking entry written for ticket $TicketNumber."
        } catch {
            Write-ArchivalLog -LogPath $logPath -Level ERROR -Message "Could not write IncidentTracking entry: $($_.Exception.Message)"
        }
    }
}
catch {
    Write-ArchivalLog -LogPath $logPath -Level ERROR -Message "FATAL: $($_.Exception.Message)"
    throw
}
finally {
    if ($staging -and (Test-Path $staging)) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
    if ($fileReport.Count -gt 0) { $fileReport | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8 }
    if ($destConn) { try { Disconnect-PnPOnline -Connection $destConn -ErrorAction SilentlyContinue } catch {} }
    foreach ($s in $archiveSites) { if ($s.Connection) { try { Disconnect-PnPOnline -Connection $s.Connection -ErrorAction SilentlyContinue } catch {} } }
    Write-ArchivalLog -LogPath $logPath -Level INFO -Message "=== Copy-FromArchive (ticket $TicketNumber) finished: $copied copied, $skipped skipped, $errors error(s) ==="
}
