@{
    # ---------------------------------------------------------------------
    # Deleted-User OneDrive Archival - configuration
    # ---------------------------------------------------------------------
    # Fill these in once. No secrets are stored here: authentication uses a
    # certificate that lives in the machine/user certificate store and is
    # referenced only by thumbprint.

    # Entra ID (Azure AD) tenant GUID, e.g. 'contoso.onmicrosoft.com' or a GUID.
    TenantId = '00000000-0000-0000-0000-000000000000'

    # App registration (client) ID of the unattended automation app.
    ClientId = '11111111-1111-1111-1111-111111111111'

    # Thumbprint of the certificate uploaded to the app registration. The matching
    # private key must be installed in the certificate store of the machine that
    # runs the scheduled task (CurrentUser\My or LocalMachine\My).
    CertificateThumbprint = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'

    # Full URL of the archive site collection that will hold one library per user.
    ArchiveSiteUrl = 'https://contoso.sharepoint.com/sites/OneDriveArchive'

    # SharePoint "-my" host for OneDrive personal sites (no trailing slash).
    MySiteHostUrl = 'https://contoso-my.sharepoint.com'

    # Output folder for CSV reports and run logs (created if missing).
    OutputFolder = 'C:\OneDriveArchival\Output'

    # Local staging folder used to stream files (download -> upload). Cleaned up
    # automatically. Use a drive with enough free space for your largest file.
    StagingFolder = 'C:\OneDriveArchival\Staging'

    # Throttling controls (proactive pacing on top of the reactive Retry-After
    # handling). Increase these if the tenant throttles large runs.
    #   ThrottleDelayMs       - pause after each file operation (milliseconds).
    #   InterUserDelaySeconds - pause between users (seconds).
    ThrottleDelayMs       = 200
    InterUserDelaySeconds = 2
}
