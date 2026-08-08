// =====================================================================
// Cortex-PA — Azure infrastructure (Phase 1)
// ---------------------------------------------------------------------
// Provisions a secure, low-cost environment inside ONE subscription:
//   - Public static-website storage for the SPA shell (no data/secrets)
//   - Private data plane: Azure SQL (serverless) + Blob, public access
//     DISABLED, reached only via Private Endpoints from the VNet
//   - Key Vault (RBAC, purge protection) for keys/secrets
//   - VNet-integrated Function App (Flex Consumption, scale-to-zero)
//     with a system-assigned managed identity — NO secrets in code
//
// Validate before deploying:
//   az bicep build --file infra/main.bicep
//   az deployment group what-if -g <rg> -f infra/main.bicep -p @infra/main.parameters.json
// Some API versions / subnet delegations may need per-region tweaks;
// see docs/IMPLEMENTATION.md.
// =====================================================================

targetScope = 'resourceGroup'

@description('Short prefix for resource names, e.g. "cortexpa". Lowercase, <= 11 chars.')
@maxLength(11)
param namePrefix string = 'cortexpa'

@description('Azure region. Keep everything in one region for residency + cost.')
param location string = resourceGroup().location

@description('Entra tenant id (for token validation config).')
param tenantId string = subscription().tenantId

@description('Entra object id of the person/group to set as SQL Entra admin.')
param sqlAdminObjectId string

@description('Display name/UPN of the SQL Entra admin (login name).')
param sqlAdminLoginName string

@description('App (client) id of the Entra app registration used by the SPA + API.')
param apiAppClientId string

@description('Deploy Private Endpoints for SQL/Blob/Key Vault (recommended). Adds a few $/mo each.')
param deployPrivateEndpoints bool = true

var suffix          = uniqueString(resourceGroup().id)
var webStorageName  = toLower('${namePrefix}web${substring(suffix, 0, 6)}')
var dataStorageName = toLower('${namePrefix}dat${substring(suffix, 0, 6)}')
var funcStorageName = toLower('${namePrefix}fn${substring(suffix, 0, 7)}')
var keyVaultName    = toLower('${namePrefix}-kv-${substring(suffix, 0, 6)}')
var sqlServerName   = toLower('${namePrefix}-sql-${substring(suffix, 0, 6)}')
var sqlDbName       = 'cortex'
var funcAppName     = '${namePrefix}-api-${substring(suffix, 0, 6)}'
var planName        = '${namePrefix}-plan'
var vnetName        = '${namePrefix}-vnet'
var laName          = '${namePrefix}-logs'
var aiName          = '${namePrefix}-appi'

// ---------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------
resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.30.0.0/16'] }
    subnets: [
      {
        name: 'snet-func'
        properties: {
          addressPrefix: '10.30.1.0/24'
          delegations: [
            { name: 'flexdelegation', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.30.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource funcSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' existing = {
  parent: vnet
  name: 'snet-func'
}
resource peSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' existing = {
  parent: vnet
  name: 'snet-pe'
}

// ---------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------
resource la 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: laName
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}
resource ai 'Microsoft.Insights/components@2020-02-02' = {
  name: aiName
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: la.id }
}

// ---------------------------------------------------------------------
// Web (static website) storage — public shell only, no data/secrets
// (Static website $web is enabled via CLI post-deploy; see deploy.sh)
// ---------------------------------------------------------------------
resource webStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: webStorageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false      // $web is served independently of this flag
    supportsHttpsTrafficOnly: true
  }
}

// ---------------------------------------------------------------------
// Data storage — PRIVATE (message bodies, attachments, avatars, exports)
// ---------------------------------------------------------------------
resource dataStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: dataStorageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: false       // force Entra/MI auth, no account keys
    publicNetworkAccess: deployPrivateEndpoints ? 'Disabled' : 'Enabled'
    networkAcls: { defaultAction: deployPrivateEndpoints ? 'Deny' : 'Allow', bypass: 'AzureServices' }
  }
}
resource dataBlob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: dataStorage
  name: 'default'
  properties: { isVersioningEnabled: true }   // supports immutability/WORM policies
}
resource cMessages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlob
  name: 'messages'
}
resource cAttachments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlob
  name: 'attachments'
}
resource cAvatars 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlob
  name: 'avatars'
}
resource cExports 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlob
  name: 'exports'
}

// ---------------------------------------------------------------------
// Function runtime storage (Flex Consumption deployment/host storage)
// ---------------------------------------------------------------------
resource funcStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: funcStorageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}
resource funcBlob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: funcStorage
  name: 'default'
}
resource cDeployment 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: funcBlob
  name: 'deployment'
}

// ---------------------------------------------------------------------
// Key Vault — CMK + change-notification cert + any app secrets
// ---------------------------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    publicNetworkAccess: deployPrivateEndpoints ? 'Disabled' : 'Enabled'
    networkAcls: { defaultAction: deployPrivateEndpoints ? 'Deny' : 'Allow', bypass: 'AzureServices' }
  }
}

// ---------------------------------------------------------------------
// Azure SQL — serverless, Entra-only auth, TDE on by default
// ---------------------------------------------------------------------
resource sql 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  properties: {
    minimalTlsVersion: '1.2'
    publicNetworkAccess: deployPrivateEndpoints ? 'Disabled' : 'Enabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'User'
      login: sqlAdminLoginName
      sid: sqlAdminObjectId
      tenantId: tenantId
      azureADOnlyAuthentication: true
    }
  }
}
resource sqlDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sql
  name: sqlDbName
  location: location
  sku: { name: 'GP_S_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 1 }
  properties: {
    autoPauseDelay: 60            // pause after 60 min idle -> ~$0 compute when idle
    minCapacity: json('0.5')
    zoneRedundant: false
    // TDE is enabled by default (service-managed key). For CMK/BYOK, assign a
    // Key Vault key + server identity — see docs/IMPLEMENTATION.md.
  }
}
// When public access is enabled (no PEs), still restrict to Azure services only.
resource sqlAzureRule 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = if (!deployPrivateEndpoints) {
  parent: sql
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------------------------------------------------------------------
// Function App (Flex Consumption) — the private, authenticated API
// ---------------------------------------------------------------------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}

resource funcApp 'Microsoft.Web/sites@2023-12-01' = {
  name: funcAppName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: funcSubnet.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${funcStorage.properties.primaryEndpoints.blob}deployment'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 40, instanceMemoryMB: 2048 }
      runtime: { name: 'node', version: '20' }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: {
        // The SPA origin (static-website endpoint). Tighten to the exact URL post-deploy.
        allowedOrigins: [ 'https://${webStorageName}.z13.web.core.windows.net' ]
      }
      appSettings: [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: ai.properties.ConnectionString }
        { name: 'AzureWebJobsStorage__accountName', value: funcStorageName }
        { name: 'TENANT_ID', value: tenantId }
        { name: 'API_APP_CLIENT_ID', value: apiAppClientId }              // token audience
        { name: 'SQL_SERVER', value: '${sqlServerName}${environment().suffixes.sqlServerHostname}' }
        { name: 'SQL_DATABASE', value: sqlDbName }
        { name: 'DATA_STORAGE_ACCOUNT', value: dataStorageName }
        { name: 'KEY_VAULT_NAME', value: keyVaultName }
        { name: 'NOTIFICATION_BASE_URL', value: 'https://${funcAppName}.azurewebsites.net' }
        { name: 'NOTIFICATION_CERT_NAME', value: 'cortex-notify' }
      ]
    }
  }
}

// ---------------------------------------------------------------------
// RBAC — grant the Function's managed identity least-privilege data access
// ---------------------------------------------------------------------
var blobDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var queueDataContributor= subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var kvSecretsUser       = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var kvCryptoUser        = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12338af0-0e69-4776-bea7-57ae8d297424')
var kvCertUser          = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'db79e9a7-68d1-42b4-b6f5-8b83c9a6dc96')

resource raDataBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dataStorage.id, funcApp.id, blobDataContributor)
  scope: dataStorage
  properties: { roleDefinitionId: blobDataContributor, principalId: funcApp.identity.principalId, principalType: 'ServicePrincipal' }
}
resource raFuncBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcStorage.id, funcApp.id, blobDataContributor)
  scope: funcStorage
  properties: { roleDefinitionId: blobDataContributor, principalId: funcApp.identity.principalId, principalType: 'ServicePrincipal' }
}
// Queue trigger for change-notification processing (uses the func storage queues).
resource raFuncQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcStorage.id, funcApp.id, queueDataContributor)
  scope: funcStorage
  properties: { roleDefinitionId: queueDataContributor, principalId: funcApp.identity.principalId, principalType: 'ServicePrincipal' }
}
// Read the change-notification encryption certificate from Key Vault.
resource raKvCert 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, funcApp.id, kvCertUser)
  scope: kv
  properties: { roleDefinitionId: kvCertUser, principalId: funcApp.identity.principalId, principalType: 'ServicePrincipal' }
}
resource raKvSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, funcApp.id, kvSecretsUser)
  scope: kv
  properties: { roleDefinitionId: kvSecretsUser, principalId: funcApp.identity.principalId, principalType: 'ServicePrincipal' }
}
resource raKvCrypto 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, funcApp.id, kvCryptoUser)
  scope: kv
  properties: { roleDefinitionId: kvCryptoUser, principalId: funcApp.identity.principalId, principalType: 'ServicePrincipal' }
}

// ---------------------------------------------------------------------
// Private Endpoints + Private DNS (data storage blob, SQL, Key Vault)
// ---------------------------------------------------------------------
module privateLinks 'modules/privatelinks.bicep' = if (deployPrivateEndpoints) {
  name: 'privateLinks'
  params: {
    location: location
    vnetId: vnet.id
    peSubnetId: peSubnet.id
    dataStorageId: dataStorage.id
    sqlServerId: sql.id
    keyVaultId: kv.id
  }
}

// ---------------------------------------------------------------------
// Outputs (used by deploy.sh + app config)
// ---------------------------------------------------------------------
output webStorageAccount string = webStorageName
output dataStorageAccount string = dataStorageName
output functionAppName string = funcAppName
output functionAppHostname string = funcApp.properties.defaultHostName
output sqlServerFqdn string = '${sqlServerName}${environment().suffixes.sqlServerHostname}'
output sqlDatabase string = sqlDbName
output keyVaultName string = keyVaultName
output functionPrincipalId string = funcApp.identity.principalId
