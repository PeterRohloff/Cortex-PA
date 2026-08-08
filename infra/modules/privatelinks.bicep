// Private Endpoints + Private DNS zones for the private data plane.
// Keeps SQL, data Blob, and Key Vault reachable ONLY from inside the VNet.

param location string
param vnetId string
param peSubnetId string
param dataStorageId string
param sqlServerId string
param keyVaultId string

var zones = {
  blob: 'privatelink.blob.${environment().suffixes.storage}'
  sql: 'privatelink${environment().suffixes.sqlServerHostname}'
  kv: 'privatelink.vaultcore.azure.net'
}

// ---- Private DNS zones ----
resource zBlob 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: zones.blob
  location: 'global'
}
resource zSql 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: zones.sql
  location: 'global'
}
resource zKv 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: zones.kv
  location: 'global'
}

resource lBlob 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zBlob
  name: 'link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnetId } }
}
resource lSql 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zSql
  name: 'link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnetId } }
}
resource lKv 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zKv
  name: 'link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnetId } }
}

// ---- Private Endpoints ----
resource peBlob 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-blob'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      { name: 'blob', properties: { privateLinkServiceId: dataStorageId, groupIds: ['blob'] } }
    ]
  }
}
resource peBlobDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: peBlob
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: 'blob', properties: { privateDnsZoneId: zBlob.id } } ] }
}

resource peSql 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-sql'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      { name: 'sql', properties: { privateLinkServiceId: sqlServerId, groupIds: ['sqlServer'] } }
    ]
  }
}
resource peSqlDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: peSql
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: 'sql', properties: { privateDnsZoneId: zSql.id } } ] }
}

resource peKv 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-kv'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      { name: 'kv', properties: { privateLinkServiceId: keyVaultId, groupIds: ['vault'] } }
    ]
  }
}
resource peKvDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: peKv
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: 'kv', properties: { privateDnsZoneId: zKv.id } } ] }
}
