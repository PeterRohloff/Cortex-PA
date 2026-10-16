<#
.SYNOPSIS
    Core function library for the Deleted-User OneDrive Archival solution.

.DESCRIPTION
    Contains every reusable function used by Archive-DeletedUserOneDrive.ps1 so
    the main script reads as a clear top-to-bottom workflow.

    Design goals (per requirements): run unattended on a schedule, never prompt,
    and be safe to run repeatedly (idempotent / resumable) so it completes every
    time. Authentication is certificate-based app-only for both Microsoft Graph
    and SharePoint/PnP.

    PATH CONVENTIONS (single source of truth - see Copy-OneDriveContent):
      * Get-PnPFolderItem -FolderSiteRelativeUrl : path relative to the WEB
        (e.g. "Documents/Sub").
      * Resolve-PnPFolder -SiteRelativePath      : path relative to the WEB
        (e.g. "john_smith_fabrikam_com/Sub").
      * Add-PnPFile -Folder                       : path relative to the WEB; the
        folder must already exist (we Resolve-PnPFolder first).
      * Get-PnPFile -Url                          : SERVER-relative
        (e.g. "/personal/john_.../Documents/Sub/File.docx").
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# StrictMode-safe property read. Returns $null for a missing property instead of
# throwing. Works for both PSObjects (Graph JSON) and IDictionary responses.
# ---------------------------------------------------------------------------
function Get-PropOrNull {
    param($Object, [Parameter(Mandatory)] [string] $Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if (-not $prop) { return $null }
    # Reading .Value triggers a CSOM lazy getter that throws if the property was
    # never loaded; swallow that so callers always get $null instead of an error.
    try { return $prop.Value } catch { return $null }
}

# ---------------------------------------------------------------------------
# Small URL helper: join segments, drop empties, collapse duplicate slashes
# (without touching a leading "scheme://").
# ---------------------------------------------------------------------------
function Join-UrlSegment {
    param([Parameter(ValueFromRemainingArguments)] [string[]] $Segments)
    $parts = $Segments | Where-Object { -not [string]::IsNullOrEmpty($_) } |
             ForEach-Object { $_.Trim('/') } | Where-Object { $_ -ne '' }
    return ($parts -join '/')
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Write-ArchivalLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'SUCCESS', 'DEBUG')] [string] $Level = 'INFO',
        [string] $LogPath
    )
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line  = "[{0}] [{1,-7}] {2}" -f $stamp, $Level, $Message
    switch ($Level) {
        'ERROR'   { Write-Host $line -ForegroundColor Red }
        'WARN'    { Write-Host $line -ForegroundColor Yellow }
        'SUCCESS' { Write-Host $line -ForegroundColor Green }
        'DEBUG'   { Write-Verbose $line }
        default   { Write-Host $line }
    }
    if ($LogPath) {
        try {
            $dir = Split-Path -Parent $LogPath
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Add-Content -Path $LogPath -Value $line -Encoding UTF8
        } catch {
            Write-Host "[$stamp] [WARN   ] Could not write to log file '$LogPath': $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

# ---------------------------------------------------------------------------
# Retry / throttling helper
# ---------------------------------------------------------------------------
function Invoke-WithRetry {
    <#
    .SYNOPSIS Runs a script block with throttle-aware exponential back-off.
    .DESCRIPTION
        Every Graph / SharePoint call passes through here. On a transient error
        (HTTP 429/500/502/503/504, timeouts, dropped connections) it retries.
        When the server supplies a Retry-After value (header on Graph SDK
        exceptions, or embedded in the SharePoint exception message) that value
        is honoured; otherwise it backs off exponentially (2s, 4s, 8s, ...),
        capped at 5 minutes.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [scriptblock] $ScriptBlock,
        [string] $Operation = 'operation',
        [int]    $MaxAttempts = 8,
        [int]    $InitialDelaySeconds = 2,
        [string] $LogPath
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            return & $ScriptBlock
        } catch {
            $ex  = $_.Exception
            $msg = $ex.Message

            # Retry-After: Graph SDK exposes .ResponseHeaders; SharePoint embeds it
            # in the message. Try both, defensively.
            $retryAfter = $null
            try {
                if (($ex.PSObject.Properties.Name -contains 'ResponseHeaders') -and $ex.ResponseHeaders) {
                    $ra = $ex.ResponseHeaders['Retry-After']
                    if ($ra) { $retryAfter = [int]([string]($ra | Select-Object -First 1)) }
                }
            } catch { $retryAfter = $null }
            if (-not $retryAfter -and $msg -match 'Retry-After[:\s]+(\d+)') { $retryAfter = [int]$Matches[1] }

            # Permanent failures must never be retried, even when their message also
            # contains a generic phrase like "The remote server returned an error".
            $isPermanent = ($msg -match '\b(400|401|403|404)\b|access denied|unauthorized|forbidden|not found|file not found|does not exist')

            $isThrottle  = ($msg -match '\b429\b|throttl|too many requests')
            $isTransient = -not $isPermanent -and (
                           $isThrottle -or
                           ($msg -match '\b(500|502|503|504)\b') -or
                           ($msg -match 'timed out|timeout|temporarily|connection was closed|operation has timed out|The remote server returned an error|service unavailable'))

            if (-not $isTransient -or $attempt -ge $MaxAttempts) {
                Write-ArchivalLog -Level ERROR -LogPath $LogPath -Message "[$Operation] failed on attempt $attempt/${MaxAttempts}: $msg"
                throw
            }

            $delay = if ($retryAfter) { $retryAfter } else { [int][math]::Min(300, $InitialDelaySeconds * [math]::Pow(2, $attempt - 1)) }
            Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "[$Operation] transient error (attempt $attempt/$MaxAttempts): $msg. Retrying in ${delay}s."
            Start-Sleep -Seconds $delay
        }
    }
}

# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------
function Connect-ArchivalSharePoint {
    <#
    .SYNOPSIS Opens a PnP connection to a site and RETURNS the connection object.
    .DESCRIPTION
        Returning the connection (rather than relying on an implicit "current"
        connection) lets us hold the source OneDrive and the archive site open at
        once and pass each via -Connection. Requires the app to have SharePoint
        application permission Sites.FullControl.All.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Url,
        [Parameter(Mandatory)] [string] $TenantId,
        [Parameter(Mandatory)] [string] $ClientId,
        [Parameter(Mandatory)] [string] $CertificateThumbprint,
        [string] $LogPath
    )
    return Invoke-WithRetry -Operation "Connect-PnPOnline:$Url" -LogPath $LogPath -ScriptBlock {
        Connect-PnPOnline -Url $Url -ClientId $ClientId -Tenant $TenantId `
            -Thumbprint $CertificateThumbprint -ReturnConnection -ErrorAction Stop
    }
}

# ---------------------------------------------------------------------------
# Multi-site archive support
# ---------------------------------------------------------------------------
function Get-ArchiveSiteUrlList {
    <#
    .SYNOPSIS Resolves the configured archive site URL(s) into a de-duplicated list.
    .DESCRIPTION
        Accepts both the singular 'ArchiveSiteUrl' and the plural 'ArchiveSiteUrls'
        config keys (either/both), plus optional extra URLs (e.g. a -ArchiveSiteUrl
        parameter). Order is preserved; duplicates (case-insensitive) are removed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable] $Config, [string[]] $Extra)

    $urls = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $add = {
        param($u)
        if ([string]::IsNullOrWhiteSpace($u)) { return }
        $t = $u.Trim().TrimEnd('/')
        if ($seen.Add($t)) { $urls.Add($t) }
    }
    foreach ($u in @($Extra))                 { & $add $u }
    if ($Config.ContainsKey('ArchiveSiteUrls')) { foreach ($u in @($Config.ArchiveSiteUrls)) { & $add $u } }
    if ($Config.ContainsKey('ArchiveSiteUrl'))  { & $add $Config.ArchiveSiteUrl }
    return , $urls.ToArray()
}

function Connect-ArchiveSites {
    <#
    .SYNOPSIS Connects to each archive site and returns site descriptors.
    .DESCRIPTION
        Returns an array of [pscustomobject]@{ Url; Path; Connection } - one per
        site - so callers can search across all of them and reuse each connection.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string[]] $Urls,
        [Parameter(Mandatory)] [string] $TenantId,
        [Parameter(Mandatory)] [string] $ClientId,
        [Parameter(Mandatory)] [string] $CertificateThumbprint,
        [string] $LogPath
    )
    $sites = New-Object System.Collections.Generic.List[object]
    foreach ($u in $Urls) {
        try {
            $conn = Connect-ArchivalSharePoint -Url $u -TenantId $TenantId -ClientId $ClientId `
                -CertificateThumbprint $CertificateThumbprint -LogPath $LogPath
            $sites.Add([pscustomobject]@{
                Url        = $u.TrimEnd('/')
                Path       = ([Uri]$u).AbsolutePath.TrimEnd('/')
                Connection = $conn
            })
            Write-ArchivalLog -LogPath $LogPath -Message "Connected to archive site $u."
        } catch {
            # One unreachable archive site must not abort the whole run.
            Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Could not connect to archive site '$u' - skipping it: $($_.Exception.Message)"
        }
    }
    if ($sites.Count -eq 0) { throw "Could not connect to ANY configured archive site." }
    Write-ArchivalLog -Level SUCCESS -LogPath $LogPath -Message "Connected to $($sites.Count) of $($Urls.Count) archive site(s)."
    return , $sites.ToArray()
}

function Get-ArchiveSiteStorageBytes {
    <#
    .SYNOPSIS Returns the site's current storage usage in bytes (or $null on failure).
    .DESCRIPTION
        Reads Site.Usage.Storage, which is available to an app with
        Sites.FullControl.All - no SharePoint admin center access required.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Connection, [string] $LogPath)
    try {
        $site = Get-PnPSite -Connection $Connection -ErrorAction Stop
        Get-PnPProperty -Connection $Connection -ClientObject $site -Property Usage -ErrorAction Stop | Out-Null
        return [double]$site.Usage.Storage
    } catch {
        Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Could not read storage usage for a site: $($_.Exception.Message)"
        return $null
    }
}

function Get-ArchiveSiteLibraryCount {
    <#
    .SYNOPSIS Returns the number of user document libraries (template 101) on a site.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Connection, [string] $LogPath)
    try {
        $lists = Invoke-WithRetry -Operation 'Get-PnPList(count)' -LogPath $LogPath -ScriptBlock {
            Get-PnPList -Connection $Connection -ErrorAction Stop
        }
        return @($lists | Where-Object { $_.BaseTemplate -eq 101 }).Count
    } catch {
        Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Could not count libraries for a site: $($_.Exception.Message)"
        return $null
    }
}

function Select-TargetArchiveSite {
    <#
    .SYNOPSIS Chooses which site a NEW user library should be created in.
    .DESCRIPTION
        Mode 'LeastStorage' (default) picks the site using the least storage;
        'LeastLibraries' picks the site hosting the fewest user libraries; 'First'
        always returns the first site. If a metric can't be read for any site, the
        selection falls back gracefully to the first site. Returns a site descriptor.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Sites, [string] $Mode = 'LeastStorage', [string] $LogPath)

    $list = @($Sites)
    if ($list.Count -le 1) { return $list[0] }

    $metricName = $null
    $best = $null; $bestVal = [double]::MaxValue
    foreach ($s in $list) {
        $v = $null
        switch ($Mode) {
            'First'          { return $list[0] }
            'LeastLibraries' { $metricName = 'libraries'; $v = Get-ArchiveSiteLibraryCount -Connection $s.Connection -LogPath $LogPath }
            default          { $metricName = 'storage bytes'; $v = Get-ArchiveSiteStorageBytes -Connection $s.Connection -LogPath $LogPath }
        }
        if ($null -ne $v -and [double]$v -lt $bestVal) { $bestVal = [double]$v; $best = $s }
    }
    if (-not $best) {
        Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "No $metricName metric available; defaulting to first site $($list[0].Url)."
        return $list[0]
    }
    Write-ArchivalLog -LogPath $LogPath -Message "Selected $($best.Url) by $Mode ($metricName = $bestVal)."
    return $best
}

function Find-ArchiveLibraryInSites {
    <#
    .SYNOPSIS Finds a user's library (by URL suffix) across all archive sites.
    .DESCRIPTION Returns [pscustomobject]@{ Site; List } for the first match, or $null.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Sites, [Parameter(Mandatory)] [string] $UrlSuffix, [string] $LogPath)
    foreach ($s in @($Sites)) {
        $lib = Get-ArchiveLibrary -Connection $s.Connection -UrlSuffix $UrlSuffix -ArchiveSiteUrl $s.Url -LogPath $LogPath
        if ($lib) { return [pscustomobject]@{ Site = $s; List = $lib } }
    }
    return $null
}

function Find-ArchiveLibraryByTitleInSites {
    <#
    .SYNOPSIS Finds a library by TITLE (or URL leaf) across all archive sites.
    .DESCRIPTION Returns [pscustomobject]@{ Site; List; Root } for the first match, or $null.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Sites, [Parameter(Mandatory)] [string] $TitleOrLeaf, [string] $LogPath)
    foreach ($s in @($Sites)) {
        $lists = Invoke-WithRetry -Operation "Get-PnPList:$($s.Url)" -LogPath $LogPath -ScriptBlock {
            Get-PnPList -Connection $s.Connection -Includes RootFolder.ServerRelativeUrl -ErrorAction Stop
        }
        $lib = $lists | Where-Object {
            $_.BaseTemplate -eq 101 -and (
                $_.Title -eq $TitleOrLeaf -or
                ($_.RootFolder.ServerRelativeUrl -split '/')[-1] -ieq $TitleOrLeaf
            )
        } | Select-Object -First 1
        if ($lib) { return [pscustomobject]@{ Site = $s; List = $lib; Root = $lib.RootFolder.ServerRelativeUrl.TrimEnd('/') } }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Deleted-user discovery
# ---------------------------------------------------------------------------
function Get-ArchivalDeletedUsers {
    <#
    .SYNOPSIS Returns soft-deleted users from the Entra ID recycle bin via Graph.
    .DESCRIPTION
        Calls Microsoft Graph THROUGH PnP (Invoke-PnPGraphMethod) using the same
        app/cert connection. This deliberately avoids the Microsoft.Graph SDK,
        whose assemblies conflict with the ones PnP.PowerShell loads in the same
        process ("Could not load type ... from Microsoft.Graph.Core"). The app
        still needs the Graph application role User.Read.All (admin-consented).
        Returns objects shaped exactly like Get-ArchivalUsersFromCsv.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [string]   $LogPath,
        [string[]] $OnlyTheseUpns
    )

    Write-ArchivalLog -LogPath $LogPath -Message "Querying Entra ID deleted-user recycle bin via Graph (through PnP)..."

    $selectFields = 'id,userPrincipalName,displayName,givenName,surname,mail,deletedDateTime'
    # Backtick-escaped '$select'/'$top' so PowerShell does not treat them as variables.
    $url = "v1.0/directory/deletedItems/microsoft.graph.user?`$select=$selectFields&`$top=100"

    $users = New-Object System.Collections.Generic.List[object]
    while ($url) {
        $pageUrl = $url
        $resp = Invoke-WithRetry -Operation 'Graph-deletedItems-user' -LogPath $LogPath -ScriptBlock {
            Invoke-PnPGraphMethod -Connection $Connection -Method Get -Url $pageUrl -ErrorAction Stop
        }
        # Use Get-PropOrNull for every access: under StrictMode, reading a property
        # that the response omits (e.g. '@odata.nextLink' on a single page, or a
        # null-valued user attribute) would otherwise throw.
        foreach ($u in @(Get-PropOrNull $resp 'value')) {
            $users.Add([pscustomobject]@{
                Id                = Get-PropOrNull $u 'id'
                UserPrincipalName = Get-PropOrNull $u 'userPrincipalName'
                DisplayName       = Get-PropOrNull $u 'displayName'
                GivenName         = Get-PropOrNull $u 'givenName'
                Surname           = Get-PropOrNull $u 'surname'
                Mail              = Get-PropOrNull $u 'mail'
                DeletedDateTime   = Get-PropOrNull $u 'deletedDateTime'
            })
        }
        # Follow @odata.nextLink for paging; strip the absolute base to a graph-relative URL.
        $next = Get-PropOrNull $resp '@odata.nextLink'
        $url  = if ($next) { "$next" -replace '^https?://[^/]+/', '' } else { $null }
    }

    # Detect the "limited information" trap: if the app lacks User.Read.All, Graph
    # returns the objects with only id populated and userPrincipalName = null.
    $withUpn = @($users | Where-Object { $_.UserPrincipalName })
    if ($users.Count -gt 0 -and $withUpn.Count -eq 0) {
        throw "Graph returned $($users.Count) deleted object(s) but ALL have a null userPrincipalName. The app is missing the Graph 'User.Read.All' application role (admin consent). Grant it and re-run; use Setup\Test-GraphAccess.ps1 to verify."
    }

    $result = if ($OnlyTheseUpns) {
        $users | Where-Object {
            $clean = Get-CleanUserPrincipalName -UserPrincipalName $_.UserPrincipalName -ObjectId $_.Id
            ($OnlyTheseUpns -contains $_.UserPrincipalName) -or ($OnlyTheseUpns -contains $clean)
        }
    } else { $users }
    $result = @($result)

    Write-ArchivalLog -Level SUCCESS -LogPath $LogPath -Message "Found $($result.Count) deleted user(s) to evaluate."
    return $result
}

function Get-ArchivalUsersFromCsv {
    <#
    .SYNOPSIS Builds the user list from a CSV feed instead of Microsoft Graph.
    .DESCRIPTION
        Lets the solution run with NO directory-read permission. The CSV must have a
        UserPrincipalName column; DisplayName, GivenName and Surname are optional and
        used to build the "Last, First" library title. Returns objects shaped like the
        Graph deleted-user objects so the rest of the script is identical either way.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $CsvPath,
        [string[]] $OnlyTheseUpns,
        [string]   $LogPath
    )

    if (-not (Test-Path $CsvPath)) { throw "UserListCsv not found: $CsvPath" }
    Write-ArchivalLog -LogPath $LogPath -Message "Reading user list from CSV: $CsvPath"

    $rows = @(Import-Csv -Path $CsvPath)
    if ($rows.Count -eq 0) {
        Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "UserListCsv '$CsvPath' has no data rows; nothing to archive."
        return @()
    }
    $cols = @($rows[0].PSObject.Properties.Name)
    if ($cols -notcontains 'UserPrincipalName') {
        throw "UserListCsv '$CsvPath' must contain a 'UserPrincipalName' column. Found: $($cols -join ', ')"
    }

    $users = foreach ($r in $rows) {
        $upn = "$($r.UserPrincipalName)".Trim()
        if ([string]::IsNullOrWhiteSpace($upn)) { continue }
        [pscustomobject]@{
            Id                = if ($cols -contains 'UserId') { $r.UserId } else { '' }
            UserPrincipalName = $upn
            DisplayName       = if ($cols -contains 'DisplayName') { $r.DisplayName } else { '' }
            GivenName         = if ($cols -contains 'GivenName')   { $r.GivenName }   else { '' }
            Surname           = if ($cols -contains 'Surname')     { $r.Surname }     else { '' }
            Mail              = if ($cols -contains 'Mail')        { $r.Mail }        else { '' }
            DeletedDateTime   = if ($cols -contains 'DeletedDateTime') { $r.DeletedDateTime } else { '' }
        }
    }

    if ($OnlyTheseUpns) {
        $users = $users | Where-Object { $OnlyTheseUpns -contains $_.UserPrincipalName }
    }
    $users = @($users)
    Write-ArchivalLog -Level SUCCESS -LogPath $LogPath -Message "Loaded $($users.Count) user(s) from CSV."
    return $users
}

# ---------------------------------------------------------------------------
# Naming helpers
# ---------------------------------------------------------------------------
function Get-CleanUserPrincipalName {
    <#
    .SYNOPSIS Returns the original UPN of a (possibly mangled) soft-deleted user.
    .DESCRIPTION
        When some directory objects are soft-deleted, identity attributes can be
        stamped with the object's GUID (e.g. the 32-hex object id is prepended to
        the UPN local part). To reconstruct the real OneDrive URL we strip that
        prefix when present. If the UPN is already clean, it is returned as-is, so
        this is safe for the normal case.
    #>
    [CmdletBinding()]
    param([string] $UserPrincipalName, [string] $ObjectId)

    if ([string]::IsNullOrWhiteSpace($UserPrincipalName)) { return $UserPrincipalName }
    $upn = $UserPrincipalName

    # Strip an exact leading "<objectId-without-dashes>" prefix if Entra stamped one.
    if ($ObjectId) {
        $guid = ($ObjectId -replace '-', '')
        if ($upn -match "^(?i)$([regex]::Escape($guid))(.+)$") { $upn = $Matches[1] }
    }
    # Fallback: strip any leading 32-hex run directly in front of the local part.
    if ($upn -match '^[0-9a-fA-F]{32}([^@]+@.+)$') { $upn = $Matches[1] }
    return $upn
}

function Get-OneDriveUrlSuffix {
    <#
    .SYNOPSIS Converts a UPN to its OneDrive personal-site URL suffix.
    .DESCRIPTION
        OneDrive personal sites live at https://<tenant>-my.sharepoint.com/personal/<suffix>
        where <suffix> is the UPN with every non-alphanumeric character replaced by
        an underscore. e.g. john.smith@fabrikam.com -> john_smith_fabrikam_com
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $UserPrincipalName)
    if ([string]::IsNullOrWhiteSpace($UserPrincipalName)) {
        throw "Cannot derive OneDrive suffix: UserPrincipalName is empty."
    }
    return ($UserPrincipalName.ToLowerInvariant() -replace '[^a-z0-9]', '_')
}

function Get-ArchiveLibraryTitle {
    <#
    .SYNOPSIS Builds the "Last, First" display title for a user.
    .DESCRIPTION
        Prefers the authoritative surname/givenName attributes. Falls back to a
        best-effort parse of displayName and finally to the UPN local-part so a
        title is ALWAYS produced (never blank). Multi-word-surname parsing in the
        displayName fallback is best-effort only; the library URL (not the title)
        is the durable identity.
    #>
    [CmdletBinding()]
    param([string] $GivenName, [string] $Surname, [string] $DisplayName, [string] $UserPrincipalName)

    if (-not [string]::IsNullOrWhiteSpace($Surname) -and -not [string]::IsNullOrWhiteSpace($GivenName)) {
        return ('{0}, {1}' -f $Surname.Trim(), $GivenName.Trim())
    }
    if (-not [string]::IsNullOrWhiteSpace($DisplayName)) {
        $parts = $DisplayName.Trim() -split '\s+'
        if ($parts.Count -ge 2) {
            return ('{0}, {1}' -f $parts[-1], ($parts[0..($parts.Count - 2)] -join ' '))
        }
        return $DisplayName.Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace($UserPrincipalName)) { return ($UserPrincipalName -split '@')[0] }
    return 'Unknown User'
}

function Get-SafeSharePointName {
    <#
    .SYNOPSIS Sanitizes a file/folder name for SharePoint, logging any change.
    .DESCRIPTION
        SharePoint rejects ~ " # % & * : < > ? / \ { | } and names with leading/
        trailing spaces or a trailing dot. We replace illegal characters with "_"
        so an otherwise-valid OneDrive name never permanently blocks a copy (which
        would otherwise keep a user in PartiallyArchived forever).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Name)
    $safe = $Name -replace '[~"#%&*:<>?/\\{|}]', '_'
    $safe = $safe.Trim().TrimEnd('.')
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = '_' }
    return $safe
}

# ---------------------------------------------------------------------------
# Archive library management
# ---------------------------------------------------------------------------
function Get-ArchiveLibrary {
    <#
    .SYNOPSIS Returns the archive library whose URL matches the suffix, or $null.
    .DESCRIPTION
        Matches on the library's web-relative URL (its immutable identity), NOT
        its title, so re-runs reliably find it even if a title was hand-edited.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)] [string] $UrlSuffix,
        [Parameter(Mandatory)] [string] $ArchiveSiteUrl,
        [string] $LogPath
    )
    $sitePath = ([Uri]$ArchiveSiteUrl).AbsolutePath.TrimEnd('/')
    $targetRootRelUrl = ("$sitePath/$UrlSuffix").ToLowerInvariant()
    $lists = Invoke-WithRetry -Operation 'Get-PnPList' -LogPath $LogPath -ScriptBlock {
        Get-PnPList -Connection $Connection -Includes RootFolder.ServerRelativeUrl -ErrorAction Stop
    }
    return $lists | Where-Object {
        $_.BaseTemplate -eq 101 -and
        $_.RootFolder.ServerRelativeUrl.ToLowerInvariant() -eq $targetRootRelUrl
    } | Select-Object -First 1
}

function New-ArchiveLibrary {
    <#
    .SYNOPSIS Creates the archive library (URL = suffix, Title = "Last, First").
    .DESCRIPTION
        A library's web-relative URL is fixed at creation from the value passed as
        -Title and cannot change afterwards. We therefore create the library with
        -Title = the URL suffix (locking in the URL), then rename the Title to the
        friendly "Last, First" value (URL stays put). ArchiveSiteUrl is passed in
        explicitly so we never rely on an implicit "current" connection.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)] [string] $UrlSuffix,
        [Parameter(Mandatory)] [string] $DisplayTitle,
        [Parameter(Mandatory)] [string] $ArchiveSiteUrl,
        [string] $LogPath
    )
    Write-ArchivalLog -LogPath $LogPath -Message "Creating archive library '/$UrlSuffix' (title '$DisplayTitle')..."

    # Step 1: create with Title = suffix so the web-relative URL becomes the suffix.
    Invoke-WithRetry -Operation "New-PnPList-$UrlSuffix" -LogPath $LogPath -ScriptBlock {
        New-PnPList -Connection $Connection -Title $UrlSuffix -Template DocumentLibrary `
            -OnQuickLaunch:$false -ErrorAction Stop | Out-Null
    }

    # Step 2: re-fetch the library by URL. New-PnPList's return shape varies across
    # PnP versions (its .Id can come back null), so we never rely on its output;
    # Get-ArchiveLibrary gives us a fully-populated list object to act on.
    $lib = Get-ArchiveLibrary -Connection $Connection -UrlSuffix $UrlSuffix -ArchiveSiteUrl $ArchiveSiteUrl -LogPath $LogPath
    if (-not $lib) { throw "Library '/$UrlSuffix' was not found immediately after creation." }

    # Step 3: rename the Title to the friendly "Last, First" value (URL stays put).
    # Identify by the list object itself, which is unambiguous and version-safe.
    Invoke-WithRetry -Operation "Set-PnPList-$UrlSuffix" -LogPath $LogPath -ScriptBlock {
        Set-PnPList -Connection $Connection -Identity $lib -Title $DisplayTitle -ErrorAction Stop
    }
    Write-ArchivalLog -Level SUCCESS -LogPath $LogPath -Message "Created archive library '/$UrlSuffix' (title '$DisplayTitle')."
}

# ---------------------------------------------------------------------------
# Fidelity helpers: columns, metadata, version history, recycle bin
# ---------------------------------------------------------------------------
function Initialize-ArchiveLibraryColumns {
    <#
    .SYNOPSIS Ensures versioning is on and the "Original*" metadata columns exist.
    .DESCRIPTION
        We preserve the source's Created/Modified/Author/Editor onto the native
        SharePoint fields where possible, but the original author is frequently a
        now-deleted user that cannot be set as a person value. So we ALSO keep the
        originals in plain text/date columns that can never fail to populate.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Connection, [Parameter(Mandatory)] $List, [string] $LogPath)

    # NOTE: pipe to Out-Null - Set-PnPList can emit the list object, which would
    # otherwise leak into the caller's pipeline and corrupt its return value.
    try { Set-PnPList -Connection $Connection -Identity $List -EnableVersioning $true -ErrorAction Stop | Out-Null }
    catch { Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Could not enable versioning on target library: $($_.Exception.Message)" }

    $wanted = @(
        @{ Name = 'OriginalCreated';    Type = 'DateTime'; Display = 'Original Created' },
        @{ Name = 'OriginalModified';   Type = 'DateTime'; Display = 'Original Modified' },
        @{ Name = 'OriginalCreatedBy';  Type = 'Text';     Display = 'Original Created By' },
        @{ Name = 'OriginalModifiedBy'; Type = 'Text';     Display = 'Original Modified By' },
        @{ Name = 'SourcePath';         Type = 'Note';     Display = 'Source Path' },
        @{ Name = 'VersionHistory';     Type = 'Note';     Display = 'Version History' }
    )
    $existing = @()
    try { $existing = @(Get-PnPField -Connection $Connection -List $List -ErrorAction Stop | ForEach-Object { $_.InternalName }) } catch {}
    foreach ($f in $wanted) {
        if ($existing -notcontains $f.Name) {
            try {
                Add-PnPField -Connection $Connection -List $List -DisplayName $f.Display `
                    -InternalName $f.Name -Type $f.Type -AddToDefaultView:$false -ErrorAction Stop | Out-Null
            } catch {
                Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Could not add column '$($f.Name)': $($_.Exception.Message)"
            }
        }
    }
}

function Get-SourceFileMetadata {
    <#
    .SYNOPSIS Reads Created/Modified/Author/Editor from a source file's list item.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Connection, [Parameter(Mandatory)] [string] $SourceServerRel, [string] $LogPath)

    $item = Get-PnPFile -Connection $Connection -Url $SourceServerRel -AsListItem -ErrorAction Stop

    # try/catch is a statement, not an expression, so read each field into a
    # variable first (a missing/unloaded field then yields $null instead of throwing).
    $created = $null; $modified = $null; $author = $null; $editor = $null
    try { $created  = $item['Created'] }  catch {}
    try { $modified = $item['Modified'] } catch {}
    try { $author   = $item['Author'] }   catch {}
    try { $editor   = $item['Editor'] }   catch {}

    $authorName  = if ($author) { Get-PropOrNull $author 'LookupValue' } else { $null }
    $authorEmail = if ($author) { Get-PropOrNull $author 'Email' }       else { $null }
    $editorName  = if ($editor) { Get-PropOrNull $editor 'LookupValue' } else { $null }
    $editorEmail = if ($editor) { Get-PropOrNull $editor 'Email' }       else { $null }

    [pscustomobject]@{
        Created         = $created
        Modified        = $modified
        CreatedByText   = if ($authorName) { "$authorName <$authorEmail>" } else { '' }
        ModifiedByText  = if ($editorName) { "$editorName <$editorEmail>" } else { '' }
        CreatedByEmail  = $authorEmail
        ModifiedByEmail = $editorEmail
        SourcePath      = $SourceServerRel
    }
}

function Set-ArchivedFileMetadata {
    <#
    .SYNOPSIS Stamps the archived file's list item with the original metadata.
    .DESCRIPTION
        Uses SystemUpdate so that explicitly-set Created/Modified/Author/Editor
        actually persist (a regular update re-stamps Modified/Editor to "now"/the
        app identity and would silently discard them). Author/Editor are still
        best-effort - they only resolve for users that still exist; for the usual
        deleted-user case we fall back to dates + the always-on "Original*" text
        columns, which is the durable record. Never throws.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)] $ListId,
        [Parameter(Mandatory)] [string] $TargetServerRel,
        [Parameter(Mandatory)] $Meta,
        [string] $VersionHistoryJson,
        [string] $LogPath
    )
    $item = Get-PnPFile -Connection $Connection -Url $TargetServerRel -AsListItem -ErrorAction Stop
    $id   = $item.Id

    $custom = @{}
    if ($Meta.Created)        { $custom['OriginalCreated']    = $Meta.Created }
    if ($Meta.Modified)       { $custom['OriginalModified']   = $Meta.Modified }
    if ($Meta.CreatedByText)  { $custom['OriginalCreatedBy']  = $Meta.CreatedByText }
    if ($Meta.ModifiedByText) { $custom['OriginalModifiedBy'] = $Meta.ModifiedByText }
    if ($Meta.SourcePath)     { $custom['SourcePath']         = $Meta.SourcePath }
    if ($VersionHistoryJson)  { $custom['VersionHistory']     = $VersionHistoryJson }

    $native = @{}
    if ($Meta.Created)  { $native['Created']  = $Meta.Created }
    if ($Meta.Modified) { $native['Modified'] = $Meta.Modified }

    # Attempt 1: native dates + person fields + custom columns.
    $full = @{} + $native + $custom
    if ($Meta.CreatedByEmail)  { $full['Author'] = $Meta.CreatedByEmail }
    if ($Meta.ModifiedByEmail) { $full['Editor'] = $Meta.ModifiedByEmail }
    # SystemUpdate so the explicit Created/Modified/Author/Editor values persist
    # (a regular update would overwrite Modified/Editor with now/app identity) and
    # so no extra version is created on top of any replayed history.
    try {
        Set-PnPListItem -Connection $Connection -List $ListId -Identity $id -Values $full -UpdateType SystemUpdate -ErrorAction Stop | Out-Null
        return
    } catch {
        Write-ArchivalLog -Level DEBUG -LogPath $LogPath -Message "Author/Editor not settable (likely deleted user); storing originals in text columns. $($_.Exception.Message)"
    }
    # Attempt 2: dates + custom columns only (always works).
    try {
        Set-PnPListItem -Connection $Connection -List $ListId -Identity $id -Values (@{} + $native + $custom) -UpdateType SystemUpdate -ErrorAction Stop | Out-Null
    } catch {
        Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Could not set metadata for '$TargetServerRel': $($_.Exception.Message)"
    }
}

function Copy-FileVersionHistory {
    <#
    .SYNOPSIS Replays a source file's prior versions into the target file in order.
    .DESCRIPTION
        Downloads each historical version oldest-first and re-uploads it, so the
        archived file accumulates native version history (content). Returns a
        manifest (label/date/size/author) that the caller stores in the
        VersionHistory column, because SharePoint stamps the replayed versions
        with the archive time, not the originals. Never throws.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $SourceConnection,
        [Parameter(Mandatory)] $TargetConnection,
        [Parameter(Mandatory)] [string] $SourceServerRel,
        [Parameter(Mandatory)] [string] $TargetFolderSiteRel,
        [Parameter(Mandatory)] [string] $SafeName,
        [Parameter(Mandatory)] [string] $StagingDir,
        [string] $LogPath
    )
    $manifest = New-Object System.Collections.Generic.List[object]
    $versions = @()
    try { $versions = @(Get-PnPFileVersion -Connection $SourceConnection -Url $SourceServerRel -ErrorAction Stop) } catch { return $manifest }
    if ($versions.Count -eq 0) { return $manifest }

    # Sort oldest-first by (major, minor) integers. [double] would mis-order minor
    # versions (e.g. "1.10" -> 1.1 sorts before "1.2" -> 1.2).
    $sorted = $versions | Sort-Object `
        @{ Expression = { try { [int](("$($_.VersionLabel)" -split '\.')[0]) } catch { 0 } } },
        @{ Expression = { try { [int](("$($_.VersionLabel)" -split '\.')[1]) } catch { 0 } } }
    foreach ($v in $sorted) {
        $label = Get-PropOrNull $v 'VersionLabel'
        $by = ''
        try { $by = $v.CreatedBy.User.LookupValue } catch { try { $by = $v.CreatedBy.LookupValue } catch { $by = '' } }
        $manifest.Add([pscustomobject]@{
            VersionLabel = $label
            Created      = "$(Get-PropOrNull $v 'Created')"
            SizeBytes    = Get-PropOrNull $v 'Size'
            CreatedBy    = $by
        })

        # Historical versions live under _vti_history and are NOT retrievable via
        # Get-PnPFile -Url (it resolves live files only, returning "does not exist").
        # Download the version content through its CSOM binary stream instead.
        $localVer = Join-Path $StagingDir $SafeName
        try {
            Invoke-WithRetry -Operation "DownloadVer-$label" -LogPath $LogPath -ScriptBlock {
                $streamResult = $v.OpenBinaryStream()
                Invoke-PnPQuery -Connection $SourceConnection -ErrorAction Stop
                if (-not $streamResult.Value) { throw "Version $label returned no content stream." }
                $fs = [System.IO.File]::Create($localVer)
                try { $streamResult.Value.CopyTo($fs) } finally { $fs.Dispose() }
            }
            Invoke-WithRetry -Operation "UploadVer-$label" -LogPath $LogPath -ScriptBlock {
                Add-PnPFile -Connection $TargetConnection -Path $localVer -Folder $TargetFolderSiteRel -ErrorAction Stop | Out-Null
            }
            Remove-Item $localVer -Force -ErrorAction SilentlyContinue
        } catch {
            Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Version $label of '$SafeName' could not be copied: $($_.Exception.Message)"
        }
    }
    return $manifest
}

function Export-OneDriveRecycleBinManifest {
    <#
    .SYNOPSIS Writes a CSV manifest of the source OneDrive recycle bin into the library.
    .DESCRIPTION
        Read-only: it records each recycled item (name, original location, size,
        who/when deleted) without restoring anything, so the source is never
        mutated. Byte-for-byte content of recycled items is NOT captured because
        that would require restoring them in the source OneDrive.
        Returns the number of items recorded.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $SourceConnection,
        [Parameter(Mandatory)] $TargetConnection,
        [Parameter(Mandatory)] [string] $TargetLibrarySiteRelative,
        [Parameter(Mandatory)] [string] $StagingRoot,
        [string] $LogPath
    )
    $items = @()
    try { $items = @(Get-PnPRecycleBinItem -Connection $SourceConnection -ErrorAction Stop) }
    catch { Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Could not read recycle bin: $($_.Exception.Message)"; return 0 }

    if ($items.Count -eq 0) { Write-ArchivalLog -Level INFO -LogPath $LogPath -Message "Source recycle bin is empty."; return 0 }

    $rows = $items | Select-Object `
        @{N='Title';E={Get-PropOrNull $_ 'Title'}},
        @{N='ItemType';E={"$(Get-PropOrNull $_ 'ItemType')"}},
        @{N='OriginalLocation';E={Get-PropOrNull $_ 'DirName'}},
        @{N='LeafName';E={Get-PropOrNull $_ 'LeafName'}},
        @{N='SizeBytes';E={Get-PropOrNull $_ 'Size'}},
        @{N='DeletedDate';E={"$(Get-PropOrNull $_ 'DeletedDate')"}},
        @{N='DeletedByEmail';E={Get-PropOrNull $_ 'DeletedByEmail'}},
        @{N='OriginalAuthorEmail';E={Get-PropOrNull $_ 'AuthorEmail'}},
        @{N='Stage';E={"$(Get-PropOrNull $_ 'ItemState')"}},
        @{N='Id';E={"$(Get-PropOrNull $_ 'Id')"}}

    $local = Join-Path $StagingRoot '_RecycleBinManifest.csv'
    $rows | Export-Csv -Path $local -NoTypeInformation -Encoding UTF8
    Invoke-WithRetry -Operation 'UploadRecycleManifest' -LogPath $LogPath -ScriptBlock {
        Add-PnPFile -Connection $TargetConnection -Path $local -Folder $TargetLibrarySiteRelative -ErrorAction Stop | Out-Null
    }
    Remove-Item $local -Force -ErrorAction SilentlyContinue
    Write-ArchivalLog -Level SUCCESS -LogPath $LogPath -Message "Recycle-bin manifest written ($($items.Count) item(s))."
    return $items.Count
}

# ---------------------------------------------------------------------------
# Content copy
# ---------------------------------------------------------------------------
function Copy-OneDriveContent {
    <#
    .SYNOPSIS Recursively copies all folders & files from a OneDrive into the archive library.
    .DESCRIPTION
        Walks the source OneDrive's default "Documents" library, recreates the
        folder tree under the target library, and copies each file by streaming it
        through a local staging folder (download -> upload). Files already present
        in the target with an identical size are skipped, making the operation
        idempotent and resumable. Returns a counters hashtable for the CSV report.

        All paths are derived from four explicit roots (single source of truth):
          $SourceSiteRelativeRoot    e.g. /personal/john_smith_fabrikam_com
          $SourceLibraryName         e.g. Documents
          $TargetLibrarySiteRelative e.g. john_smith_fabrikam_com
          $TargetLibraryServerRel    e.g. /sites/OneDriveArchive/john_smith_fabrikam_com
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $SourceConnection,
        [Parameter(Mandatory)] $TargetConnection,
        [Parameter(Mandatory)] [string] $SourceSiteRelativeRoot,
        [Parameter(Mandatory)] [string] $SourceLibraryName,
        [Parameter(Mandatory)] [string] $TargetLibrarySiteRelative,
        [Parameter(Mandatory)] [string] $TargetLibraryServerRel,
        [Parameter(Mandatory)] [string] $StagingRoot,
        [bool]   $PreserveMetadata = $true,
        [bool]   $IncludeVersionHistory = $true,
        [int]    $ThrottleDelayMs = 0,
        [string] $LogPath
    )

    # Reference-type counters; nested functions mutate keys (no $script: scope needed).
    $counters = @{ Folders = 0; Files = 0; Skipped = 0; Bytes = [long]0; Errors = 0 }
    # ONLY genuine system/cache folders in a document library. (We deliberately do
    # NOT skip "attachments"/"_private"/"_catalogs": those can be real user folders
    # in a OneDrive and skipping them would silently lose data.)
    $systemFolders = @('forms', '_w', '_t')
    # Tracks target paths used this run so two source names that sanitize to the
    # same value don't silently overwrite each other.
    $usedTargets = @{}

    # Resolve the target list (needed to stamp metadata) and ensure fidelity setup.
    $targetListId = $null
    if ($PreserveMetadata -or $IncludeVersionHistory) {
        $tList = $null
        try {
            $tList = Get-PnPList -Connection $TargetConnection -Includes RootFolder.ServerRelativeUrl -ErrorAction Stop |
                Where-Object { $_.RootFolder.ServerRelativeUrl.ToLowerInvariant() -eq $TargetLibraryServerRel.ToLowerInvariant() } |
                Select-Object -First 1
        } catch {}
        if ($tList) {
            $targetListId = $tList.Id
            Initialize-ArchiveLibraryColumns -Connection $TargetConnection -List $tList -LogPath $LogPath | Out-Null
        } else {
            Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Target list not resolved; metadata/version stamping will be skipped for this user."
        }
    }

    function Copy-Tree {
        param([string] $SourceLibRelPath, [string] $RelPath)

        # --- folders ---
        $folders = Invoke-WithRetry -Operation "ListFolders:$SourceLibRelPath" -LogPath $LogPath -ScriptBlock {
            Get-PnPFolderItem -Connection $SourceConnection -FolderSiteRelativeUrl $SourceLibRelPath -ItemType Folder -ErrorAction Stop
        }
        foreach ($f in $folders) {
            if ($systemFolders -contains $f.Name.ToLowerInvariant()) { continue }
            $safe          = Get-SafeSharePointName -Name $f.Name
            $childRel      = Join-UrlSegment $RelPath $safe
            $targetSiteRel = Join-UrlSegment $TargetLibrarySiteRelative $childRel
            Invoke-WithRetry -Operation "EnsureFolder:$childRel" -LogPath $LogPath -ScriptBlock {
                Resolve-PnPFolder -Connection $TargetConnection -SiteRelativePath $targetSiteRel -ErrorAction Stop | Out-Null
            }
            $counters.Folders++
            Write-ArchivalLog -Level DEBUG -LogPath $LogPath -Message "Folder ensured: $childRel"
            Copy-Tree -SourceLibRelPath (Join-UrlSegment $SourceLibRelPath $f.Name) -RelPath $childRel
        }

        # --- files ---
        $files = Invoke-WithRetry -Operation "ListFiles:$SourceLibRelPath" -LogPath $LogPath -ScriptBlock {
            Get-PnPFolderItem -Connection $SourceConnection -FolderSiteRelativeUrl $SourceLibRelPath -ItemType File -ErrorAction Stop
        }
        foreach ($file in $files) {
            Copy-SingleFile -File $file -SourceLibRelPath $SourceLibRelPath -RelPath $RelPath
            # Proactive pacing to stay under tenant throttling thresholds.
            if ($ThrottleDelayMs -gt 0) { Start-Sleep -Milliseconds $ThrottleDelayMs }
        }
    }

    function Copy-SingleFile {
        param($File, [string] $SourceLibRelPath, [string] $RelPath)

        $safeName        = Get-SafeSharePointName -Name $File.Name
        $targetFolderSiteRel = Join-UrlSegment $TargetLibrarySiteRelative $RelPath

        # Disambiguate if a different source file already claimed this safe name in
        # this folder (e.g. "a:b.txt" and "a?b.txt" both sanitize to "a_b.txt").
        $key = (Join-UrlSegment $RelPath $safeName).ToLowerInvariant()
        if ($usedTargets.ContainsKey($key)) {
            $base = [IO.Path]::GetFileNameWithoutExtension($safeName)
            $ext  = [IO.Path]::GetExtension($safeName)
            $n = 1
            do { $safeName = "${base}_$n$ext"; $key = (Join-UrlSegment $RelPath $safeName).ToLowerInvariant(); $n++ }
            while ($usedTargets.ContainsKey($key))
            Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Name collision: '$($File.Name)' archived as '$safeName'."
        }
        $usedTargets[$key] = $true

        $sourceServerRel = '/' + (Join-UrlSegment $SourceSiteRelativeRoot $SourceLibRelPath $File.Name)
        $targetServerRel = '/' + (Join-UrlSegment $TargetLibraryServerRel $RelPath $safeName)

        # Source size (PnP loads Length for File items; guard defensively).
        $sourceLength = $null
        try { $sourceLength = [long]$File.Length } catch { $sourceLength = $null }

        # Idempotency: skip if a same-sized file already exists in the target.
        $existing = $null
        try {
            $existing = Get-PnPFile -Connection $TargetConnection -Url $targetServerRel -AsFileObject -ErrorAction Stop
        } catch { $existing = $null }
        if ($existing -and $null -ne $sourceLength -and [long]$existing.Length -eq $sourceLength) {
            $counters.Skipped++
            Write-ArchivalLog -Level DEBUG -LogPath $LogPath -Message "Skip (already archived): $(Join-UrlSegment $RelPath $safeName)"
            return
        }

        try {
            $localDir = Join-Path $StagingRoot ($RelPath -replace '/', [IO.Path]::DirectorySeparatorChar)
            if (-not (Test-Path $localDir)) { New-Item -ItemType Directory -Path $localDir -Force | Out-Null }

            # Read original metadata before copying (best-effort).
            $meta = $null
            if ($PreserveMetadata) {
                try { $meta = Get-SourceFileMetadata -Connection $SourceConnection -SourceServerRel $sourceServerRel -LogPath $LogPath }
                catch { Write-ArchivalLog -Level DEBUG -LogPath $LogPath -Message "No metadata read for '$safeName': $($_.Exception.Message)" }
            }

            # Replay prior versions first (creates the target file + its history),
            # then the current version is uploaded last as the latest. Only do this
            # when the target file does NOT already exist, so a re-run can never
            # stack a second copy of the whole version chain onto it.
            $versionJson = $null
            if ($IncludeVersionHistory -and ($null -eq $existing)) {
                $manifest = Copy-FileVersionHistory -SourceConnection $SourceConnection -TargetConnection $TargetConnection `
                    -SourceServerRel $sourceServerRel -TargetFolderSiteRel $targetFolderSiteRel `
                    -SafeName $safeName -StagingDir $localDir -LogPath $LogPath
                if (@($manifest).Count -gt 0) { $versionJson = (@($manifest) | ConvertTo-Json -Depth 4 -Compress) }
            }

            # Current (latest) version.
            Invoke-WithRetry -Operation "Download-$safeName" -LogPath $LogPath -ScriptBlock {
                Get-PnPFile -Connection $SourceConnection -Url $sourceServerRel `
                    -Path $localDir -FileName $safeName -AsFile -Force -ErrorAction Stop
            }
            $localFile = Join-Path $localDir $safeName
            Invoke-WithRetry -Operation "Upload-$safeName" -LogPath $LogPath -ScriptBlock {
                Add-PnPFile -Connection $TargetConnection -Path $localFile `
                    -Folder $targetFolderSiteRel -ErrorAction Stop | Out-Null
            }
            Remove-Item $localFile -Force -ErrorAction SilentlyContinue

            # Stamp the archived file with the original metadata (best-effort).
            if ($targetListId -and ($meta -or $versionJson)) {
                if (-not $meta) { $meta = [pscustomobject]@{ Created=$null;Modified=$null;CreatedByText='';ModifiedByText='';CreatedByEmail=$null;ModifiedByEmail=$null;SourcePath=$sourceServerRel } }
                try {
                    Set-ArchivedFileMetadata -Connection $TargetConnection -ListId $targetListId `
                        -TargetServerRel $targetServerRel -Meta $meta -VersionHistoryJson $versionJson -LogPath $LogPath
                } catch { Write-ArchivalLog -Level WARN -LogPath $LogPath -Message "Metadata stamp failed for '$safeName': $($_.Exception.Message)" }
            }

            $counters.Files++
            if ($null -ne $sourceLength) { $counters.Bytes += $sourceLength }
            Write-ArchivalLog -Level DEBUG -LogPath $LogPath -Message "Copied: $(Join-UrlSegment $RelPath $safeName) ($sourceLength bytes)"
        }
        catch {
            $counters.Errors++
            Write-ArchivalLog -Level ERROR -LogPath $LogPath -Message "FAILED to copy '$(Join-UrlSegment $RelPath $File.Name)': $($_.Exception.Message)"
        }
    }

    # Ensure the library root exists, then walk from the Documents library root.
    Invoke-WithRetry -Operation 'EnsureLibraryRoot' -LogPath $LogPath -ScriptBlock {
        Resolve-PnPFolder -Connection $TargetConnection -SiteRelativePath $TargetLibrarySiteRelative -ErrorAction Stop | Out-Null
    }
    Copy-Tree -SourceLibRelPath $SourceLibraryName -RelPath ''

    return $counters
}

# ---------------------------------------------------------------------------
# Completion marker (per-user idempotency)
# ---------------------------------------------------------------------------
function Test-ArchiveComplete {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)] [string] $TargetLibraryServerRel,
        [string] $LogPath
    )
    $markerUrl = '/' + (Join-UrlSegment $TargetLibraryServerRel '_ArchiveComplete.json')
    $marker = Get-PnPFile -Connection $Connection -Url $markerUrl -AsListItem -ErrorAction SilentlyContinue
    return [bool]$marker
}

function Set-ArchiveComplete {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)] [string] $TargetLibrarySiteRelative,
        [Parameter(Mandatory)] [hashtable] $Summary,
        [Parameter(Mandatory)] [string] $StagingRoot,
        [string] $LogPath
    )
    $markerLocal = Join-Path $StagingRoot '_ArchiveComplete.json'
    ($Summary | ConvertTo-Json -Depth 5) | Set-Content -Path $markerLocal -Encoding UTF8
    Invoke-WithRetry -Operation 'WriteMarker' -LogPath $LogPath -ScriptBlock {
        Add-PnPFile -Connection $Connection -Path $markerLocal -Folder $TargetLibrarySiteRelative -ErrorAction Stop | Out-Null
    }
    Remove-Item $markerLocal -Force -ErrorAction SilentlyContinue
}

function Export-ArchivalHtmlReport {
    <#
    .SYNOPSIS Renders the run report as a styled, self-contained HTML file.
    .DESCRIPTION
        Produces a summary (counts per status + totals) and a per-user table,
        colour-coded by status. No external assets - safe to email or archive.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [System.Collections.IEnumerable] $Report,
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $RunStamp,
        [string] $LogPath
    )

    function HtmlEncode([string] $s) {
        if ($null -eq $s) { return '' }
        return ($s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
    }

    $rows = @($Report)
    $statusColors = @{
        'Archived'                 = '#2e7d32'
        'AlreadyArchived'          = '#1565c0'
        'PartiallyArchived'        = '#ef6c00'
        'SkippedExists-Incomplete' = '#ef6c00'
        'Skipped-NoOneDrive'       = '#757575'
        'Skipped-ExternalUser'     = '#607d8b'
        'Skipped'                  = '#757575'
        'WhatIf'                   = '#6a1b9a'
        'Failed'                   = '#c62828'
    }

    # Summary counts by status.
    $byStatus = $rows | Group-Object Status | Sort-Object Name
    $totalFiles   = ($rows | Measure-Object FilesCopied  -Sum).Sum
    $totalSkipped = ($rows | Measure-Object FilesSkipped -Sum).Sum
    $totalBytes   = ($rows | Measure-Object BytesCopied  -Sum).Sum
    if ($null -eq $totalFiles)   { $totalFiles = 0 }
    if ($null -eq $totalSkipped) { $totalSkipped = 0 }
    if ($null -eq $totalBytes)   { $totalBytes = 0 }
    $gb = [math]::Round(($totalBytes / 1GB), 2)

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('<!DOCTYPE html><html><head><meta charset="utf-8"><title>OneDrive Archival Report</title>')
    [void]$sb.AppendLine('<style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#222}h1{font-size:20px}h2{font-size:15px;margin-top:24px}'+
        'table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}'+
        'th{background:#f4f6f8}tr:nth-child(even){background:#fafafa}.pill{color:#fff;border-radius:10px;padding:2px 8px;font-size:11px;white-space:nowrap}'+
        '.cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.card{border:1px solid #e0e0e0;border-radius:8px;padding:10px 14px;min-width:120px}'+
        '.card .n{font-size:20px;font-weight:600}.card .l{font-size:11px;color:#666}</style></head><body>')
    [void]$sb.AppendLine("<h1>Deleted-User OneDrive Archival &mdash; Run $(HtmlEncode $RunStamp)</h1>")
    [void]$sb.AppendLine("<div class='card' style='display:inline-block'>Generated: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))</div>")

    # Cards
    [void]$sb.AppendLine("<div class='cards'>")
    [void]$sb.AppendLine("<div class='card'><div class='n'>$($rows.Count)</div><div class='l'>Users processed</div></div>")
    [void]$sb.AppendLine("<div class='card'><div class='n'>$totalFiles</div><div class='l'>Files copied</div></div>")
    [void]$sb.AppendLine("<div class='card'><div class='n'>$totalSkipped</div><div class='l'>Files skipped</div></div>")
    [void]$sb.AppendLine("<div class='card'><div class='n'>$gb GB</div><div class='l'>Data copied</div></div>")
    foreach ($g in $byStatus) {
        $c = if ($statusColors.ContainsKey($g.Name)) { $statusColors[$g.Name] } else { '#444' }
        [void]$sb.AppendLine("<div class='card'><div class='n' style='color:$c'>$($g.Count)</div><div class='l'>$(HtmlEncode $g.Name)</div></div>")
    }
    [void]$sb.AppendLine("</div>")

    # Detail table
    [void]$sb.AppendLine("<h2>Per-user detail</h2><table><tr>"+
        "<th>Status</th><th>User</th><th>Display name</th><th>OneDrive</th><th>Archive library</th>"+
        "<th>Folders</th><th>Files</th><th>Skipped</th><th>Bytes</th><th>Seconds</th><th>Details</th></tr>")
    foreach ($r in $rows) {
        $st = "$($r.Status)"
        $c  = if ($statusColors.ContainsKey($st)) { $statusColors[$st] } else { '#444' }
        [void]$sb.AppendLine('<tr>'+
            "<td><span class='pill' style='background:$c'>$(HtmlEncode $st)</span></td>"+
            "<td>$(HtmlEncode "$($r.UserPrincipalName)")</td>"+
            "<td>$(HtmlEncode "$($r.DisplayName)")</td>"+
            "<td>$(HtmlEncode "$($r.OneDriveUrl)")</td>"+
            "<td>$(HtmlEncode "$($r.ArchiveLibraryUrl)")</td>"+
            "<td>$($r.FoldersCreated)</td><td>$($r.FilesCopied)</td><td>$($r.FilesSkipped)</td>"+
            "<td>$($r.BytesCopied)</td><td>$($r.DurationSeconds)</td>"+
            "<td>$(HtmlEncode "$($r.Details)")</td></tr>")
    }
    [void]$sb.AppendLine('</table></body></html>')

    Set-Content -Path $Path -Value $sb.ToString() -Encoding UTF8
    Write-ArchivalLog -Level SUCCESS -LogPath $LogPath -Message "HTML report written: $Path"
}

Export-ModuleMember -Function `
    Join-UrlSegment, Write-ArchivalLog, Invoke-WithRetry, Connect-ArchivalSharePoint, Export-ArchivalHtmlReport,
    Get-ArchiveSiteUrlList, Connect-ArchiveSites, Get-ArchiveSiteStorageBytes, Get-ArchiveSiteLibraryCount,
    Select-TargetArchiveSite, Find-ArchiveLibraryInSites, Find-ArchiveLibraryByTitleInSites,
    Get-ArchivalDeletedUsers, Get-ArchivalUsersFromCsv, Get-CleanUserPrincipalName, Get-OneDriveUrlSuffix, Get-ArchiveLibraryTitle,
    Get-SafeSharePointName, Get-ArchiveLibrary, New-ArchiveLibrary, Copy-OneDriveContent,
    Initialize-ArchiveLibraryColumns, Get-SourceFileMetadata, Set-ArchivedFileMetadata,
    Copy-FileVersionHistory, Export-OneDriveRecycleBinManifest,
    Test-ArchiveComplete, Set-ArchiveComplete
