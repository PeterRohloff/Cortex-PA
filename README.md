# Cortex-PA

An internal, Azure-hosted **investigative eDiscovery platform for Microsoft 365**. Phase 1 covers
**Microsoft Teams chats**: search collected conversations by person and rich filters, review them in
an Apple-Messages or native-Teams threaded rendering, organize work into secured **Cases**, collect
continuously and silently for later review, and export to HTML / Word / Excel — all read-only,
encrypted, and reachable only from inside your M365 tenant.

## Design

The full solution and architecture design is in **[`docs/DESIGN.md`](docs/DESIGN.md)**, including a
requirements traceability matrix. Highlights:

- **Collection** via the Microsoft Teams **Export APIs** (historical backfill) and **Graph
  change-notification subscriptions** (continuous silent collection). Note: these Teams APIs are
  **no longer metered per message as of Aug 2025**.
- **Azure-native, private** hosting: App Service + serverless Azure SQL (TDE + CMK, Ledger tables) +
  immutable (WORM) Blob Storage, all behind Private Endpoints with public access disabled.
- **RBAC**: Entra ID login required; Platform Admin / Case Creator platform roles + per-case
  Owner / Member roles.
- **Tamper-evident audit log**, admin-only, exportable to HTML and CSV.
- **Continuous silent collection** is gated behind a required legal-authorization attestation
  checkbox that is recorded to the audit log — see §8.3.

> Note: the earlier Netlify/React PWA scaffold in this repo (`netlify.toml`,
> `cortex-pwa-netlify.zip`, mail/calendar functions) predates this direction and does not meet the
> Azure isolation/encryption requirements. The design in `docs/DESIGN.md` supersedes that hosting
> model; see §2.1.
