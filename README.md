# Cortex‑PA — with **Cortex Intel**

Cortex‑PA is a Progressive Web App. It ships two things:

1. **Cortex** — the original AI executive assistant (Apple Mail / Calendar via IMAP + CalDAV).
2. **Cortex Intel** — a **Microsoft 365 Open‑Source Threat‑Intelligence platform** that aggregates, searches, tags, and *assesses* M365‑related vulnerability and threat intelligence from credible sources in near‑real time.

This document focuses on **Cortex Intel**.

---

## What Cortex Intel does

A single, searchable analyst workspace focused **exclusively on the Microsoft 365 / Office 365 platform** (Exchange Online, SharePoint, OneDrive, Teams, Outlook, Entra ID / Azure AD, Intune, Defender for Office 365, Power Platform, Copilot).

- **Aggregates** threat intelligence from a curated set of credible sources (below), on a schedule, automatically.
- **Filters everything to M365** — any item that doesn't mention a Microsoft 365 product is dropped at ingest. The keyword filter is fully editable.
- **Scores** each item heuristically (critical → info) using exploitation signals ("actively exploited", "zero‑day", "RCE", CVSS, CVE presence, CISA‑KEV membership).
- **Searchable** full‑text across title, summary, raw content, CVE IDs, and source.
- **Read the raw source** of every item inside the platform, with deep links out to the origin and to NVD for any CVE.
- **Tag & organize** — free‑form tags, a workflow status (New → Reviewing → Mitigated → Dismissed), and analyst notes on every item.
- **Assess with Claude** — one click produces a defender‑focused evaluation: severity call, affected M365 components, exploitation status, *prioritized mitigation next steps*, and detection guidance.
- **Fully customizable sources** — add, disable, or remove any feed at will. Add your own RSS/Atom feeds, NVD keyword feeds, CISA‑KEV, or a licensed commercial CTI API.

---

## Credible sources (shipped by default)

All are M365‑filtered at ingest. The catalog is defined in
`netlify/functions/lib/intel.mjs` → `defaultSources()` and can be edited live in the UI (**⚙︎ Sources**).

| Source | Category | How it's pulled |
|---|---|---|
| Microsoft MSRC — Security Update Guide | Vendor (authoritative) | RSS |
| Microsoft Security Blog | Vendor | RSS |
| Microsoft MSRC Blog | Vendor | RSS/Atom |
| Microsoft Tech Community / **TechNet** (M365 security) | Vendor | scoped search feed |
| **The Microsoft Threat Intelligence Podcast** (notes) | Podcast | scoped search feed¹ |
| **CISA** — Cybersecurity Advisories | Government | RSS (`all.xml`) |
| **CISA** — Known Exploited Vulnerabilities (Microsoft) | Exploit | KEV JSON, Microsoft‑filtered |
| **FBI** — National Press Releases | Government | RSS |
| **NSA** — Cybersecurity Advisories | Government | scoped search feed |
| **CIA** — News & Press | Government | scoped search feed |
| **DISA** — STIG & Advisories | Government | scoped search feed |
| **Trellix** — Threat Research | Vendor Research | scoped search feed |
| **Trend Micro** — Research & News | Vendor Research | scoped search feed |
| **McAfee** — Labs / Blogs | Vendor Research | RSS |
| **Reuters** (M365 coverage) | News | scoped search feed |
| **Associated Press** (M365 coverage) | News | scoped search feed |
| **NBC News** (M365 coverage) | News | scoped search feed |
| **CNN** (M365 coverage) | News | scoped search feed |
| **NVD** — Microsoft 365 CVEs | Exploit | NVD 2.0 API, keyword‑scoped |
| Exploit‑DB (Microsoft) | Exploit | RSS |
| Underground / Dark‑Web CTI (template) | Underground | licensed `custom_api` (disabled by default) |

**"Scoped search feed"** = a Google News RSS query pinned to that outlet's domain *and* Microsoft‑365 vulnerability terms. It's a robust, legal way to get an M365‑filtered stream from outlets that no longer publish granular native RSS. If an outlet exposes a better native feed, paste it in via **⚙︎ Sources** — the source type is just `rss`.

¹ For the podcast, paste the exact podcast RSS URL into the source to get verbatim episode notes; the default is a search‑feed fallback.

---

## On "hacker forums and underground sources" — read this

The brief asked the platform to *"intelligently source data from any hacker forums or other available sources where this information may be knowingly exchanged."* That intent — early warning, before a threat matures — is exactly right and is a core CTI discipline. **How** it's done matters, and this platform makes a deliberate choice:

**It does not scrape criminal forums or dark‑web marketplaces directly.** Doing so typically means creating accounts on, authenticating to, and harvesting from services whose access terms and applicable law (e.g. the U.S. Computer Fraud and Abuse Act and equivalents elsewhere) make automated collection legally hazardous and operationally unsafe. Building that scraper into the product would put the operator at legal and security risk.

**Instead, the platform surfaces the legal early‑warning signals of underground activity**, which in practice give you the same lead time:

- **CISA Known Exploited Vulnerabilities** — vulnerabilities *confirmed exploited in the wild*. This is the single highest‑value "it's being used right now" signal, and it's authoritative and free.
- **Exploit‑DB / public PoC availability** — tells you when a vulnerability has been weaponized and code is circulating.
- **NVD + MSRC** — the authoritative disclosure trail, scored and CVE‑linked.
- **Vendor threat research** (Trellix, Trend Micro, McAfee) — these teams *do* run licensed underground collection and publish what they find about M365 campaigns.

**For genuine dark‑web / forum collection, use a licensed provider.** The platform includes an **Underground / Dark‑Web CTI** source template (`custom_api`, disabled by default). Drop in the JSON API endpoint and API key for a commercial provider that already does this legally — e.g. Recorded Future, Flashpoint, Intel 471, or Google/Mandiant — and its M365‑relevant hits flow into the same searchable, taggable, Claude‑assessable workspace as everything else. This is the industry‑standard, defensible way to get forum/dark‑web intelligence.

If your organization has separate legal authorization and infrastructure for direct collection, you can point a `custom_api` source at your own internal collection service's JSON endpoint.

---

## Architecture

```
React PWA (src/App.js  → launches →  src/Intel.js)
        │  fetch /api/intel-*
        ▼
Netlify Functions (netlify/functions/*.mjs)
        │
   ┌────┴───────────────────────────────────────────────┐
   │ intel-sources   CRUD sources + M365 keyword settings │
   │ intel-ingest    on-demand fetch → filter → dedupe    │
   │ intel-poll      scheduled (cron */30) same pipeline  │
   │ intel-items     search / filter / tag / notes / status│
   │ intel-assess    Claude threat + mitigation assessment │
   │ lib/intel.mjs   feeds, parsing, M365 filter, scoring  │
   └───────────────────────────────────────────────────┘
        │
   Netlify Blobs  (store: "cortex-intel" → sources, items, settings)
```

- **No external database** — persistence is [Netlify Blobs](https://docs.netlify.com/blobs/overview/), which is zero‑config on Netlify.
- **Near‑real‑time** — `intel-poll` runs every 30 minutes by default (cron in `netlify/functions/intel-poll.mjs`); the **Refresh intel** button runs the same pipeline on demand.
- **Dependency‑light** — the RSS/Atom parser is built in (`lib/intel.mjs`), so the serverless bundle stays small.

### API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/intel-sources` | list sources + settings |
| `POST` | `/api/intel-sources` | add/update a source |
| `POST` | `/api/intel-sources?settings=1` | update M365 keywords / `m365Only` |
| `POST` | `/api/intel-sources?reset=1` | restore default catalog |
| `DELETE` | `/api/intel-sources` | remove a source (`{id}`) |
| `POST` | `/api/intel-ingest` | run ingest now |
| `GET` | `/api/intel-items?q=&severity=&category=&source=&tag=&status=&sort=` | search/filter |
| `PATCH` | `/api/intel-items` | update `{id, tags?, notes?, status?}` |
| `DELETE` | `/api/intel-items` | remove item (`{id}`) |
| `POST` | `/api/intel-assess` | Claude assessment (`{id}` or `{text,title}`) |

---

## Deploy

Prerequisites: a [Netlify](https://netlify.com) account and (for AI assessment) an Anthropic API key.

1. **Push this repo** and connect it as a Netlify site (build command `npm run build`, publish dir `build` — already set in `netlify.toml`).
2. **Environment variables** (Netlify → Site settings → Environment):
   - `ANTHROPIC_API_KEY` — enables **Assess with Claude** (`intel-assess`). *Without it, aggregation/search/tagging still work; only AI assessment is disabled.*
   - `NVD_API_KEY` *(optional)* — a free [NVD API key](https://nvd.nist.gov/developers/request-an-api-key) raises rate limits for the NVD source.
3. **Deploy.** Netlify Blobs and the scheduled function are provisioned automatically. Open the site, launch **Cortex Intel**, and click **Refresh intel** to populate.

### Local development

```bash
npm install
npm run build          # verify the production build
netlify dev            # runs the SPA + functions + Blobs locally
```

Opening `build/` as a static site (no functions) still works — Cortex Intel detects the missing backend, shows a **Sample mode** banner, and renders a small sample dataset so the UI is fully explorable.

---

## Customizing

- **Add a source:** ⚙︎ Sources → *Add a source*. Pick a type (`rss`, `cisa_kev`, `nvd`, or `custom_api`), paste the URL, choose a category. Custom‑API sources accept an auth header name + key.
- **Remove / disable a source:** toggle it off or **Remove** it. Removed a source you regret? **Restore defaults** brings the whole catalog back.
- **Tune the M365 filter:** ⚙︎ Sources → *M365 relevance keywords*. Comma‑separated; an item must match at least one to be kept (MSRC/NVD/KEV are Microsoft‑only by definition and bypass the gate).
- **Change poll cadence:** edit `export const config = { schedule: "*/30 * * * *" }` in `netlify/functions/intel-poll.mjs`.

---

## Security & privacy notes

- Cortex Intel is a **defensive** tool. The Claude assessment prompt is explicitly constrained to defensive analysis and mitigation; it will not produce exploit code or offensive tradecraft.
- Only aggregate sources you're authorized to collect from. The default catalog is public, credible, open‑source intelligence.
- API keys for `custom_api` sources are stored in Netlify Blobs alongside the source definition — restrict access to your Netlify site accordingly, and prefer least‑privilege, read‑only provider keys.
