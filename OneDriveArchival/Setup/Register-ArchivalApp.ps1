<#
.SYNOPSIS
    One-time helper that creates the Entra ID app registration, a self-signed
    certificate, and assigns the permissions required by the archival solution.

.DESCRIPTION
    Run this ONCE, interactively, as an administrator who can register apps and
    grant admin consent. It uses PnP PowerShell's Register-PnPAzureADApp to:
      * create the app registration,
      * create a self-signed certificate in CurrentUser\My,
      * upload the public key to the app,
      * request the listed Graph + SharePoint application permissions.

    After it completes, grant admin consent (the cmdlet opens the consent page),
    then copy the printed Tenant/Client IDs and certificate thumbprint into
    Config\ArchivalConfig.psd1.

.NOTES
    Permissions requested (all APPLICATION permissions):
      Microsoft Graph : User.Read.All, Directory.Read.All
      SharePoint      : Sites.FullControl.All
#>
param(
    [Parameter(Mandatory)] [string] $Tenant,        # e.g. contoso.onmicrosoft.com
    [string] $AppName = 'OneDrive-Archival-Automation',
    [string] $CertOutPath = "$env:USERPROFILE\Desktop"
)

Write-Host "Registering Entra ID app '$AppName' in tenant '$Tenant'..." -ForegroundColor Cyan

Register-PnPAzureADApp `
    -ApplicationName $AppName `
    -Tenant $Tenant `
    -Store CurrentUser `
    -GraphApplicationPermissions 'User.Read.All', 'Directory.Read.All' `
    -SharePointApplicationPermissions 'Sites.FullControl.All' `
    -OutPath $CertOutPath `
    -DeviceLogin

Write-Host ""
Write-Host "Done. Next steps:" -ForegroundColor Green
Write-Host "  1. Grant admin consent for the app in the Entra portal (if not already prompted)."
Write-Host "  2. Note the printed AzureAppId/ClientId and Certificate Thumbprint."
Write-Host "  3. Put TenantId, ClientId and CertificateThumbprint into Config\ArchivalConfig.psd1."
Write-Host "  4. Ensure the certificate's PRIVATE key is installed on the machine that will run"
Write-Host "     the scheduled task (import the .pfx into the same cert store / service account)."
