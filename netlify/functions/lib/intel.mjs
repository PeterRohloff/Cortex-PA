// ============================================================================
// CORTEX INTEL — Shared library for the Office 365 / Microsoft 365
// Open-Source Threat Intelligence platform.
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Persistence via Netlify Blobs (sources, items, settings)
//   - Default catalog of CREDIBLE, M365-scoped intelligence sources
//   - Feed fetching + parsing (RSS/Atom, CISA KEV JSON, NVD CVE API)
//   - Microsoft 365 relevance filtering (keeps the platform M365-only)
//   - Heuristic threat scoring (severity + exploitation signals)
//
// Design note on "underground / hacker forum" sourcing:
//   Directly scraping criminal forums or dark-web marketplaces is legally
//   fraught (CFAA and equivalents) and operationally unsafe. This platform
//   instead surfaces the *legal early-warning signals* of underground
//   activity — public exploit databases (Exploit-DB), CISA's Known Exploited
//   Vulnerabilities catalog (in-the-wild exploitation), and public PoC
//   monitoring — and provides an extensible `custom_api` source type so an
//   analyst can plug in a LICENSED commercial dark-web CTI feed (e.g.
//   Recorded Future, Flashpoint, Intel 471, Google/Mandiant) with their own
//   API key. See README.md for the full rationale.
// ============================================================================

import { getStore } from "@netlify/blobs";

const STORE = "cortex-intel";
const SOURCES_KEY = "sources";
const ITEMS_KEY = "items";
const SETTINGS_KEY = "settings";
const MAX_ITEMS = 1500;

function store() {
  return getStore(STORE);
}

// ---------------------------------------------------------------------------
// M365 relevance filter
// ---------------------------------------------------------------------------
// Default keyword set. Editable at runtime via settings so the analyst can
// tune what counts as "Microsoft 365 related".
export const DEFAULT_KEYWORDS = [
  "microsoft 365", "office 365", "m365", "o365",
  "exchange online", "exchange server", "microsoft exchange",
  "sharepoint", "onedrive", "microsoft teams", "outlook",
  "azure ad", "azure active directory", "entra id", "entra",
  "microsoft defender", "defender for office", "microsoft intune",
  "power platform", "power automate", "power apps",
  "microsoft copilot", "microsoft 365 copilot",
  "msrc", "microsoft security", "microsoft account",
  "windows hello for business", "conditional access", "adfs",
  "microsoft graph", "office", "microsoft word", "microsoft excel",
  "microsoft powerpoint", "microsoft onenote",
];

// Query fragment reused when building Google News / search scoped feeds.
const M365_QUERY = '("Microsoft 365" OR "Office 365" OR Exchange OR SharePoint OR Outlook OR "Entra" OR "Azure AD" OR "Microsoft Defender" OR Intune OR "Microsoft Teams")';

// Build a Google News RSS search URL scoped to an outlet domain + M365 terms.
// This is a robust, legal way to get an M365-filtered feed from any outlet,
// including those that no longer publish native RSS.
export function gnews(domain, extra = "") {
  const q = `${M365_QUERY} ${extra} site:${domain}`.trim();
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

export function isM365Relevant(text, keywords) {
  if (!text) return false;
  const hay = String(text).toLowerCase();
  const kws = keywords && keywords.length ? keywords : DEFAULT_KEYWORDS;
  return kws.some((k) => hay.includes(k.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Default source catalog (the CREDIBLE list, mapped to real feeds)
// ---------------------------------------------------------------------------
// category: vendor | government | vendor-research | news | exploit | podcast | underground
// trust:    1 (highest, authoritative) .. 3 (contextual)
// type:     rss | cisa_kev | nvd | custom_api  (drives the parser)
export function defaultSources() {
  return [
    // --- Microsoft (authoritative vendor) ---
    { id: "msrc-updates", name: "Microsoft MSRC — Security Update Guide", category: "vendor", trust: 1,
      type: "rss", url: "https://api.msrc.microsoft.com/update-guide/rss", enabled: true,
      note: "Authoritative CVE disclosures for Microsoft products." },
    { id: "ms-security-blog", name: "Microsoft Security Blog", category: "vendor", trust: 1,
      type: "rss", url: "https://www.microsoft.com/en-us/security/blog/feed/", enabled: true },
    { id: "msrc-blog", name: "Microsoft MSRC Blog", category: "vendor", trust: 1,
      type: "rss", url: "https://msrc.microsoft.com/blog/feed", enabled: true },
    { id: "ms-technet", name: "Microsoft Tech Community / TechNet (M365 security)", category: "vendor", trust: 1,
      type: "rss", url: gnews("techcommunity.microsoft.com"), enabled: true,
      note: "TechNet content now lives on Microsoft Tech Community." },
    // --- Microsoft Threat Intelligence Podcast ---
    { id: "ms-ti-podcast", name: "The Microsoft Threat Intelligence Podcast (notes)", category: "podcast", trust: 1,
      type: "rss", url: gnews("thecyberwire.com", '"Microsoft Threat Intelligence Podcast"'), enabled: true,
      note: "Fallback search feed. Paste the exact podcast RSS URL here for verbatim episode notes." },

    // --- US Government / agencies ---
    { id: "cisa-advisories", name: "CISA — Cybersecurity Advisories", category: "government", trust: 1,
      type: "rss", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml", enabled: true },
    { id: "cisa-kev", name: "CISA — Known Exploited Vulnerabilities (Microsoft)", category: "exploit", trust: 1,
      type: "cisa_kev", url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", enabled: true,
      note: "Vulnerabilities confirmed exploited in the wild — highest-priority early warning." },
    { id: "fbi-news", name: "FBI — National Press Releases", category: "government", trust: 1,
      type: "rss", url: "https://www.fbi.gov/feeds/national-press-releases/rss.xml", enabled: true },
    { id: "nsa-advisories", name: "NSA — Cybersecurity Advisories", category: "government", trust: 1,
      type: "rss", url: gnews("nsa.gov"), enabled: true },
    { id: "cia-news", name: "CIA — News & Press", category: "government", trust: 2,
      type: "rss", url: gnews("cia.gov"), enabled: true },
    { id: "disa-stig", name: "DISA — STIG & Advisories", category: "government", trust: 1,
      type: "rss", url: gnews("disa.mil", "STIG OR advisory"), enabled: true },

    // --- Vendor threat research ---
    { id: "trellix-research", name: "Trellix — Threat Research", category: "vendor-research", trust: 1,
      type: "rss", url: gnews("trellix.com"), enabled: true },
    { id: "trendmicro-research", name: "Trend Micro — Research & News", category: "vendor-research", trust: 1,
      type: "rss", url: gnews("trendmicro.com"), enabled: true },
    { id: "mcafee-labs", name: "McAfee — Labs / Blogs", category: "vendor-research", trust: 1,
      type: "rss", url: "https://www.mcafee.com/blogs/feed/", enabled: true },

    // --- National / wire news (M365-filtered) ---
    { id: "reuters", name: "Reuters (M365 coverage)", category: "news", trust: 2, type: "rss", url: gnews("reuters.com"), enabled: true },
    { id: "ap", name: "Associated Press (M365 coverage)", category: "news", trust: 2, type: "rss", url: gnews("apnews.com"), enabled: true },
    { id: "nbc", name: "NBC News (M365 coverage)", category: "news", trust: 2, type: "rss", url: gnews("nbcnews.com"), enabled: true },
    { id: "cnn", name: "CNN (M365 coverage)", category: "news", trust: 2, type: "rss", url: gnews("cnn.com"), enabled: true },

    // --- Vulnerability / exploit intelligence (legal early-warning signals) ---
    { id: "nvd-m365", name: "NVD — Microsoft 365 CVEs", category: "exploit", trust: 1,
      type: "nvd", url: "https://services.nvd.nist.gov/rest/json/cves/2.0", enabled: true,
      note: "National Vulnerability Database, keyword-scoped to Microsoft 365 products." },
    { id: "exploit-db", name: "Exploit-DB (Microsoft)", category: "exploit", trust: 2,
      type: "rss", url: "https://www.exploit-db.com/rss.xml", enabled: true,
      note: "Public exploit database — signals weaponization / PoC availability." },

    // --- Underground / dark-web (licensed CTI template, disabled by default) ---
    { id: "licensed-ctimpl", name: "Underground / Dark-Web CTI (licensed API — configure)", category: "underground", trust: 2,
      type: "custom_api", url: "", enabled: false,
      note: "Template for a LICENSED commercial dark-web feed (Recorded Future, Flashpoint, Intel 471, Mandiant, etc.). Add the provider's JSON API URL and an API key header below. Direct scraping of criminal forums is intentionally NOT performed — see README." },
  ];
}

// ---------------------------------------------------------------------------
// Blob persistence
// ---------------------------------------------------------------------------
export async function getSources() {
  const s = store();
  let sources = await s.get(SOURCES_KEY, { type: "json" });
  if (!sources) {
    sources = defaultSources();
    await s.setJSON(SOURCES_KEY, sources);
  }
  return sources;
}

export async function saveSources(sources) {
  await store().setJSON(SOURCES_KEY, sources);
  return sources;
}

export async function getSettings() {
  const s = store();
  let settings = await s.get(SETTINGS_KEY, { type: "json" });
  if (!settings) {
    settings = { keywords: DEFAULT_KEYWORDS, m365Only: true };
    await s.setJSON(SETTINGS_KEY, settings);
  }
  return settings;
}

export async function saveSettings(settings) {
  await store().setJSON(SETTINGS_KEY, settings);
  return settings;
}

export async function getItems() {
  const items = await store().get(ITEMS_KEY, { type: "json" });
  return items || [];
}

export async function saveItems(items) {
  const trimmed = items
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, MAX_ITEMS);
  await store().setJSON(ITEMS_KEY, trimmed);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Threat scoring (heuristic; Claude assessment adds depth on demand)
// ---------------------------------------------------------------------------
const HIGH_SIGNALS = [
  "actively exploited", "exploited in the wild", "zero-day", "0-day",
  "in-the-wild", "known exploited", "ransomware", "remote code execution",
  "unauthenticated", "wormable", "emergency patch", "out-of-band",
  "critical", "cvss:9", "cvss:10", "proof of concept", "poc available",
  "privilege escalation", "authentication bypass", "nation-state",
];
const MED_SIGNALS = [
  "high severity", "important", "spoofing", "elevation of privilege",
  "information disclosure", "phishing", "credential", "token theft",
  "patch available", "advisory", "vulnerability", "cve-",
];

export function scoreThreat({ title = "", summary = "", category = "", raw = "" }) {
  const hay = `${title} ${summary} ${raw}`.toLowerCase();
  const hits = (arr) => arr.filter((s) => hay.includes(s));
  const highHits = hits(HIGH_SIGNALS);
  const medHits = hits(MED_SIGNALS);

  let severity = "info";
  if (category === "exploit" && (highHits.length || hay.includes("cve-"))) severity = "critical";
  if (highHits.length >= 1) severity = severity === "critical" ? "critical" : "high";
  else if (medHits.length >= 1) severity = "medium";
  else severity = "low";

  // CISA KEV items are, by definition, exploited in the wild.
  if (category === "exploit" && hay.includes("known exploited")) severity = "critical";

  const cve = (hay.match(/cve-\d{4}-\d{4,7}/g) || []).map((c) => c.toUpperCase());
  return {
    severity,
    signals: [...new Set([...highHits, ...medHits])].slice(0, 8),
    cves: [...new Set(cve)],
  };
}

export function severityRank(sev) {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[sev] ?? 0;
}

// ---------------------------------------------------------------------------
// Feed fetching + parsing
// ---------------------------------------------------------------------------
function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? stripHtml(m[1]) : "";
}

function attr(xml, name, a) {
  const m = xml.match(new RegExp(`<${name}[^>]*\\b${a}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

// Minimal, dependency-free RSS/Atom parser. Handles both <item> (RSS) and
// <entry> (Atom) structures — robust enough for the feeds we consume and
// avoids pulling a heavy XML library into the serverless bundle.
export function parseFeed(xml) {
  const out = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    let link = tag(b, "link");
    if (!link) link = attr(b, "link", "href"); // Atom <link href="">
    const summary = tag(b, "description") || tag(b, "summary") || tag(b, "content:encoded") || tag(b, "content");
    const published = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date") || "";
    if (title || summary) out.push({ title, link, summary, published });
  }
  return out;
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "CortexIntel/1.0 (+threat-intel-aggregator)", Accept: "*/*", ...headers },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function makeId(source, link, title) {
  const basis = `${source}|${link || title}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0;
  return `itm_${(h >>> 0).toString(36)}`;
}

function normalize(source, entry) {
  const { severity, signals, cves } = scoreThreat({
    title: entry.title, summary: entry.summary, category: source.category, raw: entry.raw || "",
  });
  return {
    id: makeId(source.id, entry.link, entry.title),
    sourceId: source.id,
    sourceName: source.name,
    category: source.category,
    trust: source.trust,
    title: entry.title || "(untitled)",
    link: entry.link || "",
    summary: entry.summary || "",
    raw: entry.raw || entry.summary || "",
    published: entry.published || new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    severity,
    signals,
    cves,
    tags: [],
    notes: "",
    status: "new", // new | reviewing | mitigated | dismissed
    assessment: null,
  };
}

// --- Source-type-specific fetchers -----------------------------------------
async function fetchRss(source) {
  const xml = await fetchText(source.url);
  return parseFeed(xml).map((e) => normalize(source, e));
}

async function fetchCisaKev(source) {
  const txt = await fetchText(source.url);
  const data = JSON.parse(txt);
  const vulns = (data.vulnerabilities || []).filter((v) => {
    const vendor = `${v.vendorProject || ""} ${v.product || ""}`.toLowerCase();
    return vendor.includes("microsoft");
  });
  return vulns.map((v) =>
    normalize(source, {
      title: `${v.cveID} — ${v.vulnerabilityName}`,
      link: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
      summary: `KNOWN EXPLOITED. ${v.shortDescription} Required action: ${v.requiredAction} (due ${v.dueDate}).`,
      raw: `${v.cveID} | ${v.vendorProject} ${v.product} | Added ${v.dateAdded} | Known exploited in the wild. ${v.shortDescription} Required action: ${v.requiredAction}. Due: ${v.dueDate}. Ransomware campaign use: ${v.knownRansomwareCampaignUse}.`,
      published: v.dateAdded ? `${v.dateAdded}T00:00:00Z` : new Date().toISOString(),
    })
  );
}

async function fetchNvd(source) {
  // NVD 2.0 keyword search across Microsoft 365 products, last ~30 days.
  const terms = ["Microsoft 365", "Office 365", "Exchange Server", "SharePoint", "Outlook", "Microsoft Teams"];
  const results = [];
  for (const term of terms) {
    try {
      const url = `${source.url}?keywordSearch=${encodeURIComponent(term)}&resultsPerPage=25`;
      const headers = process.env.NVD_API_KEY ? { apiKey: process.env.NVD_API_KEY } : {};
      const txt = await fetchText(url, headers);
      const data = JSON.parse(txt);
      for (const c of data.vulnerabilities || []) {
        const cve = c.cve;
        const desc = (cve.descriptions || []).find((d) => d.lang === "en")?.value || "";
        const metrics = cve.metrics || {};
        const cvss = (metrics.cvssMetricV31 || metrics.cvssMetricV30 || metrics.cvssMetricV2 || [])[0];
        const score = cvss?.cvssData?.baseScore;
        const sev = cvss?.cvssData?.baseSeverity || cvss?.baseSeverity || "";
        results.push(
          normalize(source, {
            title: `${cve.id} — ${term}`,
            link: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
            summary: `${desc}${score ? ` [CVSS ${score} ${sev}]` : ""}`,
            raw: `${cve.id} | Published ${cve.published} | CVSS ${score || "n/a"} ${sev} | ${desc}`,
            published: cve.published || new Date().toISOString(),
          })
        );
      }
    } catch (e) {
      // one term failing shouldn't kill the whole source
    }
  }
  return results;
}

async function fetchCustomApi(source) {
  if (!source.url) return [];
  const headers = {};
  if (source.apiKeyHeader && source.apiKey) headers[source.apiKeyHeader] = source.apiKey;
  const txt = await fetchText(source.url, headers);
  let data;
  try { data = JSON.parse(txt); } catch { return parseFeed(txt).map((e) => normalize(source, e)); }
  // Accept a generic shape: array of {title, link/url, summary/description, published/date}
  const arr = Array.isArray(data) ? data : data.items || data.results || data.data || [];
  return arr.map((r) =>
    normalize(source, {
      title: r.title || r.name || r.headline || "(untitled)",
      link: r.link || r.url || r.href || "",
      summary: r.summary || r.description || r.body || r.snippet || "",
      raw: JSON.stringify(r).slice(0, 4000),
      published: r.published || r.date || r.created_at || new Date().toISOString(),
    })
  );
}

export async function fetchSource(source) {
  switch (source.type) {
    case "cisa_kev": return fetchCisaKev(source);
    case "nvd": return fetchNvd(source);
    case "custom_api": return fetchCustomApi(source);
    case "rss":
    default: return fetchRss(source);
  }
}

// ---------------------------------------------------------------------------
// Ingest orchestration
// ---------------------------------------------------------------------------
export async function runIngest() {
  const [sources, settings, existing] = await Promise.all([getSources(), getSettings(), getItems()]);
  const seen = new Map(existing.map((i) => [i.id, i]));
  const perSource = [];
  let added = 0;

  const enabled = sources.filter((s) => s.enabled);
  const settled = await Promise.allSettled(enabled.map((s) => fetchSource(s)));

  settled.forEach((res, idx) => {
    const src = enabled[idx];
    if (res.status !== "fulfilled") {
      perSource.push({ id: src.id, name: src.name, ok: false, error: String(res.reason).slice(0, 200), added: 0 });
      return;
    }
    let srcAdded = 0;
    for (const item of res.value) {
      // M365 relevance gate (unless the source is already a Microsoft-only feed)
      const alwaysMs = ["cisa_kev", "nvd"].includes(src.type) || src.id.startsWith("msrc") || src.id === "ms-security-blog";
      if (settings.m365Only && !alwaysMs) {
        if (!isM365Relevant(`${item.title} ${item.summary}`, settings.keywords)) continue;
      }
      if (!seen.has(item.id)) {
        seen.set(item.id, item);
        srcAdded++;
        added++;
      }
    }
    perSource.push({ id: src.id, name: src.name, ok: true, added: srcAdded });
  });

  const merged = await saveItems([...seen.values()]);
  return { added, total: merged.length, sources: perSource, ranAt: new Date().toISOString() };
}

// CORS + JSON helpers for the HTTP functions.
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
