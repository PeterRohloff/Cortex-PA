# Cortex-PA — Azure implementation runbook

Step-by-step to stand up Phase 1 (Teams chats) in **one Azure subscription tied to your
Microsoft 365 tenant**. Architecture: a public **Storage static website** (SPA shell only),
a private **Azure Functions** API, and a private **Azure SQL + Blob** data plane behind
private endpoints. Design rationale is in [`DESIGN.md`](DESIGN.md).

> **Data-privacy note.** The static website (`$web`) is a public, anonymous endpoint by
> nature — it serves only the app shell (HTML/JS/CSS), which contains **no data and no
> secrets**. All data lives behind the Entra-authenticated private API and in private,
> encrypted stores (public network access disabled). To make even the shell non-public, see
> [§8 Hardening](#8-hardening-optional).

---

## 0. Prerequisites

- Azure subscription in your M365 tenant; you are **Owner** on the target resource group
  (needed for the role assignments in the Bicep).
- **Global Admin / Privileged Role Admin** to grant admin consent for Graph app permissions.
- Tooling: `az` CLI, `func` (Azure Functions Core Tools v4), `sqlcmd` (go-sqlcmd), Node 20, `jq`.
- **Licensing:** confirm covered custodians have M365 E5 / E5 Compliance so the Teams Export
  APIs return data (design §1). These APIs are **no longer metered per message (Aug 2025)**.

---

## 1. Create the Entra app registration (SPA + API)

One app registration serves both the SPA (public client) and the API (token audience).

```bash
az ad app create --display-name "Cortex-PA" \
  --sign-in-audience AzureADMyOrg \
  --enable-id-token-issuance true
APP_ID=$(az ad app list --display-name "Cortex-PA" --query "[0].appId" -o tsv)
```

Then in **Entra admin center → App registrations → Cortex-PA**:

1. **Expose an API** → set Application ID URI `api://<APP_ID>` → **Add a scope**
   `access_as_user` (admins + users consent).
2. **Authentication** → add a **Single-page application** platform with redirect URI =
   your static-site URL (fill in after step 4), e.g.
   `https://<web-storage>.z13.web.core.windows.net`. Add `http://localhost:5173` for local dev.
3. **App roles** → create three roles (allowed member type: **Users/Groups**):
   - `Platform.Admin` — value `Platform.Admin`
   - `Case.Creator` — value `Case.Creator`
   - `Case.Reviewer` — value `Case.Reviewer` (base; optional)
4. **API permissions** → add **Microsoft Graph → Application permissions**:
   `Chat.Read.All`, `ChannelMessage.Read.All`, `User.Read.All` → **Grant admin consent**.

Assign yourself `Platform.Admin` under **Enterprise applications → Cortex-PA → Users and groups**.

---

## 2. Fill in deployment parameters

Edit [`infra/main.parameters.json`](../infra/main.parameters.json):

```jsonc
"sqlAdminObjectId": "<your Entra object id>",   // az ad signed-in-user show --query id -o tsv
"sqlAdminLoginName": "peter@rohlofftech.com",
"apiAppClientId": "<APP_ID from step 1>",
"deployPrivateEndpoints": true                    // recommended
```

---

## 3. Deploy the infrastructure

```bash
export RG=rg-cortex-pa LOCATION=eastus
az group create -n $RG -l $LOCATION
az bicep build --file infra/main.bicep                 # syntax check
az deployment group what-if -g $RG -f infra/main.bicep -p @infra/main.parameters.json
az deployment group create  -g $RG -f infra/main.bicep -p @infra/main.parameters.json
```

This creates: web + data + function storage, Key Vault, VNet (func + PE subnets), Azure SQL
(serverless, Entra-only), the Flex-Consumption Function App with a system-assigned managed
identity, private endpoints + private DNS, and the least-privilege role assignments for the
Function identity (Blob Data Contributor on data storage, Key Vault Secrets/Crypto User).

`infra/deploy.sh` wraps steps 3–5, 7 if you prefer one command.

---

## 4. Enable the static website

```bash
WEB=$(az deployment group show -g $RG -n main --query properties.outputs.webStorageAccount.value -o tsv)
az storage blob service-properties update --account-name $WEB --auth-mode login \
  --static-website --index-document index.html --404-document index.html
az storage account show -n $WEB --query "primaryEndpoints.web" -o tsv   # this is your SPA URL
```

Put that URL into the app registration's SPA redirect URI (step 1.2).

---

## 5. Create the database schema + grant the Function DB access

The Function authenticates to SQL as its managed identity — create a contained DB user for it.
Run from a host that can reach SQL (allow your IP temporarily, or a VNet jumpbox if PEs are on):

```bash
SQLFQDN=$(az deployment group show -g $RG -n main --query properties.outputs.sqlServerFqdn.value -o tsv)
FUNC=$(az deployment group show -g $RG -n main --query properties.outputs.functionAppName.value -o tsv)

# 5a. Apply schema (you are the Entra SQL admin from step 2)
sqlcmd -G -S $SQLFQDN -d cortex -i api/sql/schema.sql

# 5b. Grant the Function's managed identity access
cat > /tmp/grant.sql <<SQL
CREATE USER [$FUNC] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [$FUNC];
ALTER ROLE db_datawriter ADD MEMBER [$FUNC];
GRANT EXECUTE TO [$FUNC];
SQL
sqlcmd -G -S $SQLFQDN -d cortex -i /tmp/grant.sql
```

> For strict read-only evidence, split into two identities: writer (collection worker) and
> reader (API). The single-identity setup above is the MVP; see design §10.

---

## 6. Grant the Function's managed identity Microsoft Graph app roles

The Function calls the Teams Export API as itself (no secret). Grant its service principal the
three Graph app roles:

```bash
FUNC_MI=$(az functionapp show -g $RG -n $FUNC --query identity.principalId -o tsv)
GRAPH_SP=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)

for ROLE in Chat.Read.All ChannelMessage.Read.All User.Read.All; do
  APP_ROLE_ID=$(az ad sp show --id $GRAPH_SP --query "appRoles[?value=='$ROLE'].id | [0]" -o tsv)
  az rest --method POST \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$FUNC_MI/appRoleAssignments" \
    --body "{\"principalId\":\"$FUNC_MI\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$APP_ROLE_ID\"}"
done
```

---

## 7. Build & deploy the API and SPA

```bash
# API
( cd api && npm ci && npm run build )
func azure functionapp publish $FUNC --javascript

# SPA
API_HOST=$(az functionapp show -g $RG -n $FUNC --query defaultHostName -o tsv)
cat > web/.env <<ENV
VITE_TENANT_ID=$(az account show --query tenantId -o tsv)
VITE_CLIENT_ID=$APP_ID
VITE_API_SCOPE=api://$APP_ID/access_as_user
VITE_API_BASE=https://$API_HOST/api
ENV
( cd web && npm ci && npm run build )
az storage blob upload-batch --account-name $WEB --auth-mode login -d '$web' -s web/dist --overwrite
```

Open the SPA URL, sign in, create a case, add a custodian, and collect.

---

## 8. Continuous collection subscription (design §4.2)

The *Continue collecting* toggle (with the legal attestation) is enforced by the API and recorded
today; wiring the live Graph change-notification subscription requires two more pieces:

1. **Encryption cert in Key Vault** — create an RSA cert; give Graph the public key, keep the
   private key in KV for the receiver to decrypt payloads.
2. **A reachable notify URL** — `https://$API_HOST/api/notifications` (already implemented for the
   validation handshake). Create the subscription with `includeResourceData=true`, `resource`
   `/chats/getAllMessages`, and a renewal timer (subscriptions are short-lived).

Then complete the decrypt-and-persist TODO in `api/src/functions/graphNotifications.ts`. Until
then, use the **backfill** path (works fully) and re-run it on a schedule as a reconciliation sweep.

---

## 9. Hardening (optional)

- **Non-public shell:** front `$web` with **Azure Front Door + WAF + Entra**, or migrate the SPA
  to **Azure Static Web Apps (Standard)** with a **private endpoint** and built-in Entra auth.
- **Conditional Access:** require a compliant/Entra-joined device + this tenant for the app.
- **CMK/BYOK:** assign a Key Vault key to Azure SQL TDE and the data storage account (design §10);
  the Bicep leaves service-managed keys on by default to keep the first deploy simple.
- **Immutable exports:** enable **version-level immutability (WORM)** on the `exports` and
  `messages` containers with a time-based retention policy.
- **Split identities:** separate writer/reader DB + Blob identities so the API is read-only on
  evidence.

---

## Cost summary (design §13)

| Component | Cost posture |
|---|---|
| Storage static website | Pennies/month (LRS + egress). |
| Azure Functions (Flex Consumption) | Scale-to-zero; pay per execution. |
| Azure SQL serverless | Auto-pause → ~$0 compute when idle; storage only. |
| Blob (data) | Hot for active cases; Cool/Archive for aged evidence. |
| Private endpoints ×3 | ~A few $/endpoint/month (the main fixed cost; toggle off via `deployPrivateEndpoints=false` to trade privacy for cost). |
| Teams Export/notification APIs | **No per-message metering (Aug 2025).** Licensing prerequisite only. |

---

## What's implemented vs. next steps

**Working now:** infra as code; Entra-authenticated API with RBAC (platform + per-case roles);
case create with auto codename + immutable case number + custodians; RBAC-filtered case list;
search with all filters; threaded conversation read (Teams + Messages views); **HTML export** with
chain-of-custody manifest; append-only **audit log** with HTML/CSV export; **Teams Export-API
backfill**; the attestation-gated continue-collecting flow (recorded + audited).

**Next steps (clearly marked TODO in code):** live change-notification subscription create/renew +
payload decrypt (§8); **Word/Excel** export writers (`exportConversation.ts` returns 501 for now);
loading sanitized HTML bodies from Blob into the reader/export; avatar caching; CMK/BYOK + WORM
enablement; split reader/writer identities.
