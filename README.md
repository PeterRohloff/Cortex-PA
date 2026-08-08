# Cortex-PA

An internal, Azure-hosted **investigative eDiscovery platform for Microsoft 365**. Phase 1 covers
**Microsoft Teams chats**: search collected conversations by person and rich filters, review them in
an Apple-Messages or native-Teams threaded rendering, organize work into secured **Cases**, collect
continuously for later review, and export to HTML / Word / Excel — all read-only, encrypted, and
with the data plane reachable only from inside your Azure subscription.

## Repository layout

| Path | What it is |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | Full solution & architecture design + requirements traceability matrix. |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | **Step-by-step Azure runbook** to stand it up. |
| [`infra/`](infra) | Bicep infrastructure-as-code (static-site storage, private SQL + Blob + Key Vault, VNet, Function App) + `deploy.sh`. |
| [`api/`](api) | Azure Functions API (TypeScript): Entra auth + RBAC, cases, search, conversation, export, audit, Teams collection. `api/sql/schema.sql` is the data model. |
| [`web/`](web) | Static front-end (Vite + React + MSAL) uploaded to the Storage static website. |

## Architecture at a glance

- **Front-end** → Azure **Storage static website** (`$web`) — the app shell only; no data, no secrets.
- **API** → **Azure Functions** (Flex Consumption, VNet-integrated, Entra-authenticated, private).
- **Data** → **Azure SQL** (serverless, Entra-only, Ledger tables) + private **Blob** (message
  bodies, attachments, avatars, exports), **public network access disabled**, reached only by the
  Function's **managed identity** — no secrets in code.
- **Collection** → Teams **Export APIs** (backfill) + **change-notification subscriptions**
  (continuous). These Teams APIs are **no longer metered per message (Aug 2025)**.

> **Data-privacy note.** The static website is a public, anonymous endpoint — it serves only the
> HTML/JS/CSS shell. All data protection is enforced at the private, Entra-authenticated API and the
> private encrypted stores. To make even the shell non-public, see Hardening in the runbook.

## Quick start

See [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md). In short: create the Entra app registration →
`az deployment group create` the Bicep → enable the static website → apply the SQL schema → grant the
Function's managed identity Graph app roles → publish the API and upload the SPA. `infra/deploy.sh`
wraps most of it. Both `api` and `web` build clean (`npm ci && npm run build`).

## Governance built in

- **RBAC**: Entra login required; **Platform Admin** / **Case Creator** platform roles + per-case
  **Owner** / **Member** roles, enforced server-side on every call.
- **Immutable case identity**: random obscure codename + non-editable case number, auto-generated.
- **Continuous collection** is gated behind a required legal-authorization attestation checkbox that
  is recorded to the audit log (design §8.3).
- **Tamper-evident, admin-only audit log**, exportable to HTML and CSV.

## What's implemented vs. next

Working end-to-end: infra, auth/RBAC, cases (codename + case number + custodians), search, threaded
conversation views (Teams + Messages), **HTML / Word / Excel export** with chain-of-custody
manifest, audit log + export, **Teams Export-API backfill**, and the **live change-notification
pipeline** (subscription create/renew + decrypt + auto-collect with the update bell). Clearly-marked
next steps in code: Blob-stored HTML bodies, broaden monitored-user matching to full chat membership,
avatar caching, and CMK/BYOK + WORM enablement. Details in the runbook's final section.

> Note: the earlier Netlify/React PWA scaffold (`netlify.toml`, `cortex-pwa-netlify.zip`,
> mail/calendar functions) predates this direction and is superseded by the Azure-native solution
> here (design §2.1).
