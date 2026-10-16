# Deleted-User OneDrive Archival

Automatically copies a user's **OneDrive for Business** into a central **archive
site collection** when their account lands in the **Entra ID (Azure AD) deleted
users recycle bin**, then writes a CSV report of exactly what was done.

It is built to run **unattended on a schedule**, **without any interaction**, and
to be **safe to run over and over** — every file copy is idempotent and resumable,
and every network call retries through SharePoint/Graph throttling, so a run will
reliably complete every time.

---

## What it does (per deleted user)

1. Reads the Entra ID deleted-user recycle bin (`/directory/deletedItems`). These
   users are in the 30-day soft-delete window, so their OneDrive still exists.
2. Derives the OneDrive URL suffix from the UPN
   (`john.smith@fabrikam.com` → `john_smith_fabrikam_com`).
3. Looks in the archive site for a library whose **URL** equals that suffix.
4. **If the library already exists, it does NOT copy** — the existing data is
   left untouched (see *Existing-library behaviour* below).
5. If it does not exist, creates a document library with
   **URL = `john_smith_fabrikam_com`** and **Title = `Smith, John`**, then
   recursively copies every folder and file from the OneDrive into it.
6. Writes a completion marker and records a CSV row describing **what** was
   archived, **where** it was stored, and the **status**.

### Existing-library behaviour

| Situation | Default action | With `-CopyIfLibraryExists` |
|-----------|----------------|------------------------------|
| Library does **not** exist | Create it and copy all content | Same |
| Library exists, prior run **completed** it | Skip copy — `AlreadyArchived` | Copy/resume into it |
| Library exists, **no** completion marker (partial/manual) | Skip copy, **log a WARNING**, flag row `SkippedExists-Incomplete` | Copy/resume to finish it |

So out of the box **an existing location is never copied into**. To deliberately
finish a library a previous run left incomplete (or refresh an existing one), run
with `-CopyIfLibraryExists`.

---

## Files

| File | Purpose |
|------|---------|
| `Archive-DeletedUserOneDrive.ps1` | Main entry point. Run this (or schedule it). |
| `Modules/OneDriveArchival.psm1`   | All reusable functions (auth, discovery, copy, reporting). |
| `Config/ArchivalConfig.psd1`      | Your tenant/app/site settings. Edit this. |
| `Setup/Register-ArchivalApp.ps1`  | One-time app registration + certificate helper. |

---

## Discovery modes — where the user list comes from

The script needs a list of users to archive. It can get that two ways:

| Mode | How to run | Permission needed |
|------|-----------|-------------------|
| **Entra deleted bin** (default) | `.\Archive-DeletedUserOneDrive.ps1` | Graph **`User.Read.All`** (Application) + admin consent |
| **CSV feed** | `.\Archive-DeletedUserOneDrive.ps1 -UserListCsv .\to-archive.csv` | **None** beyond SharePoint — Graph is not contacted |

> **"My service principal doesn't see the deleted users."** Reading the Entra ID
> deleted-user recycle bin is a **Microsoft Graph** operation. A PnP/SharePoint
> service principal that only has `Sites.FullControl.All` cannot see it. Grant the
> app the Graph **`User.Read.All`** *application* role **and grant admin consent**.
> Watch for the "limited information" trap: without that role, Graph can return
> deleted-user objects whose `UserPrincipalName` is **null**, so the run finds
> "nothing to archive". The script now detects this and logs a clear error.
> If you can't grant the role, use **`-UserListCsv`** instead (see `Samples\to-archive.csv`).

The CSV needs a `UserPrincipalName` column; `DisplayName`, `GivenName`, `Surname`
are optional (used to build the `Last, First` title):

```csv
UserPrincipalName,DisplayName,GivenName,Surname
john.smith@fabrikam.com,John Smith,John,Smith
```

## Prerequisites

- **PowerShell 7 (`pwsh`) — required, not optional.** Current PnP.PowerShell only
  loads on PowerShell 7; it does **not** work in Windows PowerShell 5.1
  (`powershell.exe`). The script enforces this and refuses to run under 5.1.
  Check with `$PSVersionTable` (PSEdition must be `Core`). Install PowerShell 7
  from https://aka.ms/powershell, then launch with **`pwsh`**.
- **Just one module — `PnP.PowerShell`** — installed in `pwsh`, for the account
  that runs the task (a module installed under your profile is not visible to a
  service account). The Entra deleted-user query is made *through* PnP
  (`Invoke-PnPGraphMethod`), so the Microsoft.Graph SDK is **not** required — and
  is deliberately avoided because its assemblies conflict with PnP's in the same
  process (`Could not load type … Microsoft.Graph.Core`).
  ```powershell
  # run this inside pwsh, not powershell.exe
  Install-Module PnP.PowerShell -Scope AllUsers -Force
  ```
- One or more **archive site collections** already created (e.g.
  `https://contoso.sharepoint.com/sites/OneDriveArchive`).

---

## Multiple archive sites

All three scripts support **several archive site collections** (useful once one
site approaches SharePoint's storage limit). List them in the config:

```powershell
ArchiveSiteUrls = @(
    'https://contoso.sharepoint.com/sites/OneDriveArchive'
    'https://contoso.sharepoint.com/sites/OneDriveArchive2'
)
SiteSelectionMode = 'LeastStorage'   # or 'LeastLibraries' or 'First'
```

- **Finding a user** always searches **every** configured site, so re-runs,
  `SingleUser-Archive.ps1`, and `Copy-FromArchive.ps1` locate a user's library no
  matter which site holds it.
- **Placing a new library** uses `SiteSelectionMode`:
  - `LeastStorage` *(default)* — the site currently using the least storage.
  - `LeastLibraries` — the site hosting the fewest user libraries.
  - `First` — always the first site in the list.
  Both auto modes are **admin-free** (no SharePoint admin-center access needed).
- The archival scripts also accept **`-ArchiveSiteUrl`** (force new libraries this
  run onto a specific site) and **`-SiteSelectionMode`** (override the config mode).
- One unreachable site is logged and skipped; the run continues on the rest.

## Setup (do this once)

1. **Register the automation app + certificate**
   ```powershell
   .\Setup\Register-ArchivalApp.ps1 -Tenant contoso.onmicrosoft.com
   ```
   This creates an Entra ID app with these **application** permissions and a
   self-signed certificate:
   - Microsoft Graph: `User.Read.All`, `Directory.Read.All`
   - SharePoint: `Sites.FullControl.All`

   **Grant admin consent — this is the step most often missed.** Requesting the
   role is not enough; a Global Administrator must click **Grant admin consent**
   (Entra portal → App registration → API permissions). Until then the app can't
   read the deleted-user bin and the run will find nothing to archive.

   **Verify it worked** before scheduling:
   ```powershell
   .\Setup\Test-GraphAccess.ps1
   ```
   It prints `SUCCESS` when the app can read deleted users, or tells you exactly
   what's missing (403 = consent not granted; null UPNs = `User.Read.All` missing).

2. **Install the certificate's private key** on the machine/service account that
   will run the scheduled task (import the generated `.pfx` into the same
   certificate store the task runs under).

   > **Validate orphaned-OneDrive access.** A soft-deleted user's OneDrive is an
   > *orphaned* personal site. `Sites.FullControl.All` app-only access normally
   > reads these sites, but some tenants restrict app access to personal sites.
   > Confirm with a `-WhatIf` run against one deleted user before relying on the
   > schedule. If access is denied, grant the app site-collection access (e.g.
   > `Set-SPOUser -Site <odUrl> -LoginName <appId> -IsSiteCollectionAdmin $true`).
   > The script reports a 403 as `Failed` (not `Skipped-NoOneDrive`) so a
   > permissions misconfiguration is never mistaken for an empty run.

3. **Fill in `Config/ArchivalConfig.psd1`** with your `TenantId`, `ClientId`,
   `CertificateThumbprint`, `ArchiveSiteUrl`, and `MySiteHostUrl`.

---

## Run it

Test against a single user first, without making changes:

```powershell
.\Archive-DeletedUserOneDrive.ps1 -UserPrincipalName 'john.smith@fabrikam.com' -WhatIf
```

Then a real, limited run:

```powershell
.\Archive-DeletedUserOneDrive.ps1 -MaxUsers 1
```

Full unattended run (what the schedule calls):

```powershell
.\Archive-DeletedUserOneDrive.ps1
```

Output (CSV report + log) is written to the `OutputFolder` from the config.

---

## Schedule it (unattended)

### Option A – Windows Task Scheduler

```powershell
$action  = New-ScheduledTaskAction -Execute 'pwsh.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\OneDriveArchival\Archive-DeletedUserOneDrive.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00AM
# S4U lets the task run unattended WITHOUT storing a password. The certificate's
# private key must then live in the LocalMachine\My store (or the service
# account's own store) so the task account can read it.
$principal = New-ScheduledTaskPrincipal -UserId 'CONTOSO\svc-archival' -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName 'OneDrive Archival' -Action $action -Trigger $trigger -Principal $principal
```

> **Certificate store must match the run-as account.** `Setup\Register-ArchivalApp.ps1`
> creates the cert in `CurrentUser\My` of the person who runs it. For an unattended
> task running as `svc-archival` (or a gMSA), export the `.pfx` and import it into
> **`LocalMachine\My`** (or that account's `CurrentUser\My`), otherwise the task
> won't find the certificate by thumbprint. A **gMSA** is the most hands-off
> option: register the task with a gMSA principal (`-LogonType Password`, where
> Windows retrieves the managed password automatically — nothing is stored).

### Option B – Azure Automation runbook

Import the three modules into the Automation account, upload the certificate as
an Automation certificate (or use the machine cert store on a Hybrid Worker),
add the same files, and schedule the runbook. Because auth is certificate
app-only, nothing prompts at runtime.

---

## Why it "completes every time"

- **Unattended auth** – certificate app-only for both Graph and SharePoint; no
  interactive sign-in is ever required.
- **Throttle-aware retries** – every Graph/SharePoint call goes through
  `Invoke-WithRetry`, which honours a server `Retry-After` value when one is
  provided and otherwise backs off exponentially (capped at 5 min) on HTTP
  429/5xx and transient network errors.
- **Idempotent & safe to re-run** – an existing library is never copied into by
  default, so scheduled runs never duplicate data or touch already-archived
  users. A `_ArchiveComplete.json` marker records completed users. To finish a
  library a prior run left incomplete, re-run with `-CopyIfLibraryExists`; the
  copy then skips files already present (matching size) and only transfers what's
  missing.
- **Per-user isolation** – one user's failure is caught, reported as `Failed` /
  `PartiallyArchived` in the CSV, and never stops the rest of the run.

> **Known limitation.** When two source files have names that sanitize to the
> same SharePoint-legal name (e.g. `a:b.txt` and `a?b.txt` → `a_b.txt`), the
> second is archived as `a_b_1.txt`. This relies on the source library returning
> items in a stable order between runs (normally true); only in the rare case of
> a reordered enumeration *and* such a collision could a file be re-copied.

---

## What gets archived (fidelity)

| Item | Archived? | Notes |
|------|-----------|-------|
| Files & folders (current content) | ✅ | Full recursive copy of the Documents library. |
| Real folders named "Attachments" etc. | ✅ | Only `Forms`, `_w`, `_t` (true system/cache folders) are skipped. |
| Created/Modified dates | ✅ (default) | Set on native fields + always in `Original Created`/`Original Modified` columns. `-PreserveMetadata:$false` to skip. |
| Author / Editor | ✅ (default, best-effort) | Native person fields when the user still exists; original name+email always stored in `Original Created By`/`Original Modified By`. |
| Version history | ✅ (default) | Prior versions replayed as native versions; original labels/dates/authors saved as JSON in the `Version History` column. `-IncludeVersionHistory:$false` for current-only. |
| OneDrive recycle bin | ⚙️ opt-in | `-IncludeRecycleBin` writes `_RecycleBinManifest.csv` (metadata only — content isn't byte-copied, which would require restoring items). |
| Sharing links & permissions | ❌ | Archived copy inherits the archive site's permissions. |
| Retention labels / holds | ❌ | Not carried over. |
| Libraries other than "Documents" | ❌ | Only the OneDrive default Documents library is copied. |

> Files that genuinely can't be copied (checked-out with no checked-in version,
> path > ~400 chars) are reported per-file in the log and the user ends as
> `PartiallyArchived` — never silently dropped.

> **Cost of version history.** `-IncludeVersionHistory` (on by default) downloads
> and re-uploads *every* prior version of *every* file, so a tenant with many
> large, heavily-versioned OneDrives will take substantially longer and make far
> more API calls. The run is still resumable and throttle-aware, but for a big
> first pass consider `-IncludeVersionHistory:$false` (current version only) and
> enabling it later, or running in batches with `-MaxUsers`.

> **Re-runs don't backfill.** Metadata and version history are applied when a file
> is first copied. On a `-CopyIfLibraryExists` resume, files already present
> (same size) are skipped and are *not* retro-fitted with metadata/versions. To
> re-archive a user with richer fidelity, remove their library first.

### Examples

```powershell
# Default: content + metadata + version history
.\Archive-DeletedUserOneDrive.ps1

# Faster: current versions only, no metadata stamping
.\Archive-DeletedUserOneDrive.ps1 -IncludeVersionHistory:$false -PreserveMetadata:$false

# Also capture a manifest of each user's recycle bin
.\Archive-DeletedUserOneDrive.ps1 -IncludeRecycleBin
```

---

## Re-running against already-migrated data

| Run mode | Already-archived users | Per-file behaviour |
|----------|------------------------|--------------------|
| **Default** | Skipped entirely — nothing overwritten or re-stamped (`AlreadyArchived` / `SkippedExists-Incomplete`). | n/a |
| **`-CopyIfLibraryExists`** | Re-entered and updated **incrementally**. | A target file with the **same byte size** is skipped; a **missing or different-size** file is re-copied (overwrites content, adds a version, re-stamps metadata). |

So a re-run is **incremental, not a blanket overwrite**, and unchanged files are left alone (no needless version churn). "Changed" is judged by **byte size**, so a same-size edit isn't detected — delete the file/library to force a full refresh.

## Reports & output organisation

Every run writes its log, a **CSV**, and an **HTML** summary into a date folder:

```
<OutputFolder>\yyyy-MM-dd\ArchivalRun_<timestamp>.log
<OutputFolder>\yyyy-MM-dd\ArchivalReport_<timestamp>.csv
<OutputFolder>\yyyy-MM-dd\ArchivalReport_<timestamp>.html
```

The HTML report shows summary cards (users processed, files copied/skipped, GB copied, counts per status) and a colour-coded per-user table. Both files are produced on **every** completed run (header-only CSV if there were no users).

## Throttling

On top of the reactive `Retry-After` handling, the run paces itself proactively:

- `ThrottleDelayMs` — pause after each file (default **200 ms**).
- `InterUserDelaySeconds` — pause between users (default **2 s**).

Set them in `Config\ArchivalConfig.psd1`, or override per run with `-ThrottleDelayMs` / `-InterUserDelaySeconds`. Raise them if the tenant still throttles a large run.

---

## CSV report columns

`Timestamp, UserPrincipalName, RawUserPrincipalName, DisplayName, UserId,
DeletedDateTime, OneDriveUrl, ArchiveLibraryUrl, ArchiveLibraryTitle,
FoldersCreated, FilesCopied, FilesSkipped, BytesCopied, DurationSeconds,
Status, Details`

**Status** values: `Archived`, `AlreadyArchived`, `SkippedExists-Incomplete`,
`PartiallyArchived`, `Skipped-NoOneDrive`, `Skipped-ExternalUser`, `Skipped`,
`WhatIf`, `Failed`.

---

## Troubleshooting

**`'Connect-PnPOnline' is not recognized…`** — You're running under **Windows
PowerShell 5.1**, or PnP.PowerShell is installed for a different account. PnP only
loads on **PowerShell 7**. Fix:
1. Launch with **`pwsh`** (not `powershell.exe`); confirm `$PSVersionTable.PSEdition`
   is `Core`.
2. Install the module for the running account: `Install-Module PnP.PowerShell -Scope AllUsers -Force` (inside `pwsh`).
3. Schedule the task with `pwsh.exe`, and if it runs as a service account, make
   sure the module is visible to that account (`-Scope AllUsers`).

The script now preflights this and stops with a clear message instead of the
"not recognized" error.

**`Could not load type '…AzureIdentityAccessTokenProvider' from assembly 'Microsoft.Graph.Core…'`**
— An assembly clash between the Microsoft.Graph SDK and PnP.PowerShell in the same
process. This solution no longer uses the Microsoft.Graph SDK (it calls Graph
through `Invoke-PnPGraphMethod`), so make sure you're running the **current**
files. If you previously imported `Microsoft.Graph.*` in the same window, open a
**fresh `pwsh`** session and run again.

**Run finds no deleted users** — a Graph permission/consent gap. Run
`Setup\Test-GraphAccess.ps1` to pinpoint it (403 = admin consent missing;
null UPNs = `User.Read.All` app role missing).

**`Access denied` connecting to a OneDrive** — the app lacks site access to that
orphaned personal site. The CSV row shows `Failed` with a hint; grant the app
site-collection access or confirm `Sites.FullControl.All` + admin consent.
