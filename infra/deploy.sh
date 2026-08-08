#!/usr/bin/env bash
# =====================================================================
# Cortex-PA — end-to-end deploy helper.
# Prereqs: az CLI (logged in), sqlcmd, Node 20, an Entra app registration
# (see docs/IMPLEMENTATION.md steps 1-2). Run from the repo root.
# =====================================================================
set -euo pipefail

RG="${RG:-rg-cortex-pa}"
LOCATION="${LOCATION:-eastus}"
PARAMS="infra/main.parameters.json"

echo "==> [1/7] Resource group"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> [2/7] Validate Bicep (what-if)"
az deployment group what-if -g "$RG" -f infra/main.bicep -p @"$PARAMS"

echo "==> [3/7] Deploy infrastructure"
OUT=$(az deployment group create -g "$RG" -f infra/main.bicep -p @"$PARAMS" --query properties.outputs -o json)
WEB=$(echo "$OUT"      | jq -r .webStorageAccount.value)
DATA=$(echo "$OUT"     | jq -r .dataStorageAccount.value)
FUNC=$(echo "$OUT"     | jq -r .functionAppName.value)
SQLFQDN=$(echo "$OUT"  | jq -r .sqlServerFqdn.value)
SQLDB=$(echo "$OUT"    | jq -r .sqlDatabase.value)
echo "    web=$WEB data=$DATA func=$FUNC sql=$SQLFQDN/$SQLDB"

echo "==> [4/7] Enable static website on the web storage account"
az storage blob service-properties update --account-name "$WEB" --auth-mode login \
  --static-website --index-document index.html --404-document index.html -o none

echo "==> [5/7] Apply SQL schema (Entra auth; you must be the SQL Entra admin)"
# Requires your client IP allowed on SQL, or run from a VM in the VNet if PEs are on.
sqlcmd -G -S "$SQLFQDN" -d "$SQLDB" -i api/sql/schema.sql

echo "==> [6/7] Build + publish the Function API"
( cd api && npm ci && npm run build )
func azure functionapp publish "$FUNC" --javascript || \
  echo "    (install Azure Functions Core Tools v4, or use 'az functionapp deployment' — see runbook)"

echo "==> [7/7] Build + upload the SPA to \$web"
API_HOST=$(az functionapp show -g "$RG" -n "$FUNC" --query defaultHostName -o tsv)
( cd web && npm ci && VITE_API_BASE="https://$API_HOST/api" npm run build )
az storage blob upload-batch --account-name "$WEB" --auth-mode login \
  -d '$web' -s web/dist --overwrite -o none

echo "Done. SPA: https://$WEB.z13.web.core.windows.net"
echo "Next: grant the Function's managed identity Graph app roles + SQL db access (see runbook §6)."
