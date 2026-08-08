import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================================
// CORTEX INTEL — Microsoft 365 Open-Source Threat Intelligence Platform
// ----------------------------------------------------------------------------
// A searchable, taggable analyst workspace that aggregates M365-scoped threat
// intelligence from credible sources (Microsoft/MSRC, CISA, FBI, NSA, DISA,
// Trellix, Trend Micro, McAfee, Reuters, AP, NBC, CNN, NVD, Exploit-DB, and
// the Microsoft Threat Intelligence Podcast). Backed by Netlify Functions +
// Netlify Blobs; threat assessment + mitigation steps via Claude.
// ============================================================================

const FN = "'Outfit', system-ui, sans-serif";
const MN = "'JetBrains Mono', 'Courier New', monospace";

const SEV = {
  critical: { c: "#ff3b5c", bg: "rgba(255,59,92,0.12)", bd: "rgba(255,59,92,0.35)", l: "Critical" },
  high: { c: "#ff8a4c", bg: "rgba(255,138,76,0.12)", bd: "rgba(255,138,76,0.3)", l: "High" },
  medium: { c: "#fbbf24", bg: "rgba(251,191,36,0.1)", bd: "rgba(251,191,36,0.28)", l: "Medium" },
  low: { c: "#38bdf8", bg: "rgba(56,189,248,0.1)", bd: "rgba(56,189,248,0.25)", l: "Low" },
  info: { c: "#94a3b8", bg: "rgba(148,163,184,0.08)", bd: "rgba(148,163,184,0.2)", l: "Info" },
};
const sev = (s) => SEV[s] || SEV.info;

const CAT = {
  vendor: { l: "Vendor", c: "#38bdf8", i: "🛡️" },
  "vendor-research": { l: "Vendor Research", c: "#a78bfa", i: "🔬" },
  government: { l: "Government", c: "#34d399", i: "🏛️" },
  news: { l: "News", c: "#fbbf24", i: "📰" },
  exploit: { l: "Exploit / Vuln", c: "#ff6b6b", i: "💥" },
  podcast: { l: "Podcast", c: "#f472b6", i: "🎙️" },
  underground: { l: "Underground", c: "#f87171", i: "🕳️" },
  custom: { l: "Custom", c: "#94a3b8", i: "➕" },
};
const cat = (c) => CAT[c] || CAT.custom;

const STATUS = {
  new: { l: "New", c: "#38bdf8" },
  reviewing: { l: "Reviewing", c: "#fbbf24" },
  mitigated: { l: "Mitigated", c: "#34d399" },
  dismissed: { l: "Dismissed", c: "#64748b" },
};

const API = { sources: "/api/intel-sources", ingest: "/api/intel-ingest", items: "/api/intel-items", assess: "/api/intel-assess" };

// Sample data shown when the live backend isn't reachable (e.g. local preview
// without functions running) so the workspace is always explorable.
const SAMPLE_ITEMS = [
  { id: "s1", sourceName: "CISA — Known Exploited Vulnerabilities", category: "exploit", trust: 1,
    title: "CVE-2023-23397 — Microsoft Outlook Elevation of Privilege", link: "https://nvd.nist.gov/vuln/detail/CVE-2023-23397",
    summary: "KNOWN EXPLOITED. Microsoft Outlook contains an improper access control vulnerability that allows for privilege escalation via a specially crafted email that leaks Net-NTLMv2 hashes. Required action: Apply mitigations per vendor instructions.",
    raw: "CVE-2023-23397 | Microsoft Outlook | Known exploited in the wild. Attackers send a crafted message with an extended MAPI property containing a UNC path to an SMB share, triggering NTLM authentication to an attacker-controlled server. No user interaction required.",
    published: "2026-08-07T00:00:00Z", severity: "critical", signals: ["known exploited", "privilege escalation", "cve-"], cves: ["CVE-2023-23397"], tags: ["outlook", "ntlm"], notes: "", status: "reviewing", assessment: null },
  { id: "s2", sourceName: "Microsoft MSRC — Security Update Guide", category: "vendor", trust: 1,
    title: "Exchange Online transport rule bypass — advisory", link: "https://msrc.microsoft.com/",
    summary: "Microsoft published guidance on a spoofing vulnerability affecting Exchange Online transport rules that could allow crafted messages to bypass mail-flow controls.",
    raw: "Spoofing vulnerability in Exchange Online mail transport. CVSS 8.1. Patch available. Customers should review transport rule configurations and enable enhanced filtering.",
    published: "2026-08-06T10:00:00Z", severity: "high", signals: ["spoofing", "patch available"], cves: [], tags: ["exchange"], notes: "", status: "new", assessment: null },
  { id: "s3", sourceName: "Trellix — Threat Research", category: "vendor-research", trust: 1,
    title: "Phishing campaign targets Microsoft 365 credentials via Teams", link: "https://www.trellix.com/",
    summary: "Researchers describe a campaign abusing Microsoft Teams external messaging to deliver credential-harvesting links to M365 tenants.",
    raw: "Threat actors leverage Teams external federation to message targets, bypassing email gateways. Payload leads to an Adversary-in-the-Middle page capturing session tokens for Microsoft 365.",
    published: "2026-08-05T14:30:00Z", severity: "medium", signals: ["phishing", "token theft", "credential"], cves: [], tags: ["teams", "phishing"], notes: "", status: "new", assessment: null },
];

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date(), s = Math.floor((now - d) / 1000);
  if (isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return d.toLocaleDateString();
}

export default function Intel({ onExit }) {
  const [sources, setSources] = useState([]);
  const [settings, setSettings] = useState({ keywords: [], m365Only: true });
  const [items, setItems] = useState([]);
  const [facets, setFacets] = useState({ categories: {}, severities: {}, tags: {}, totalItems: 0 });
  const [tags, setTags] = useState([]);
  const [total, setTotal] = useState(0);

  const [filters, setFilters] = useState({ q: "", source: "", category: "", severity: "", tag: "", status: "" });
  const [sort, setSort] = useState("recent");
  const [selected, setSelected] = useState(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [toast, setToast] = useState(null);
  const [showSources, setShowSources] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const qRef = useRef(null);

  const flash = (msg, ms = 3200) => { setToast(msg); setTimeout(() => setToast(null), ms); };

  // ---- data loading -------------------------------------------------------
  const loadSources = useCallback(async () => {
    try {
      const r = await fetch(API.sources);
      if (!r.ok) throw new Error("no backend");
      const d = await r.json();
      setSources(d.sources || []);
      setSettings(d.settings || { keywords: [], m365Only: true });
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  const loadItems = useCallback(async (f, s) => {
    const params = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && params.set(k, v));
    params.set("sort", s);
    try {
      const r = await fetch(`${API.items}?${params}`);
      if (!r.ok) throw new Error("no backend");
      const d = await r.json();
      setItems(d.items || []);
      setTotal(d.total || 0);
      setTags(d.tags || []);
      setFacets(d.facets || {});
      setOffline(false);
    } catch {
      // Offline fallback: filter the sample set client-side.
      setOffline(true);
      let sample = SAMPLE_ITEMS.filter((i) => {
        if (f.q && !`${i.title} ${i.summary} ${i.raw}`.toLowerCase().includes(f.q.toLowerCase())) return false;
        if (f.severity && i.severity !== f.severity) return false;
        if (f.category && i.category !== f.category) return false;
        if (f.tag && !i.tags.includes(f.tag)) return false;
        if (f.status && i.status !== f.status) return false;
        return true;
      });
      setItems(sample);
      setTotal(sample.length);
      setTags([...new Set(SAMPLE_ITEMS.flatMap((i) => i.tags))]);
      setFacets({ totalItems: SAMPLE_ITEMS.length, categories: {}, severities: {}, tags: {} });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);
  // Debounced item reload on filter/sort change.
  useEffect(() => {
    const t = setTimeout(() => loadItems(filters, sort), 220);
    return () => clearTimeout(t);
  }, [filters, sort, loadItems]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await fetch(API.ingest, { method: "POST" });
      if (!r.ok) throw new Error("no backend");
      const d = await r.json();
      setLastRun(d);
      flash(`Ingested ${d.added} new item${d.added === 1 ? "" : "s"} across ${d.sources?.length || 0} sources`);
      await loadItems(filters, sort);
    } catch {
      setOffline(true);
      flash("Live backend not reachable — deploy to Netlify with functions enabled to pull real feeds.");
    } finally {
      setRefreshing(false);
    }
  };

  const patchItem = async (id, patch) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    if (selected?.id === id) setSelected((s) => ({ ...s, ...patch }));
    if (offline) return;
    try { await fetch(API.items, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) }); }
    catch { /* optimistic */ }
  };

  const assess = async (item) => {
    if (offline) { flash("Assessment needs the live Claude backend (ANTHROPIC_API_KEY on Netlify)."); return; }
    setAssessing(true);
    try {
      const r = await fetch(API.assess, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setSelected((s) => ({ ...s, assessment: d.assessment, severity: d.assessment.severity || s.severity, status: "reviewing" }));
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, assessment: d.assessment, severity: d.assessment.severity || i.severity } : i)));
      flash("Claude assessment complete");
    } catch (e) {
      flash("Assessment failed: " + e.message);
    } finally {
      setAssessing(false);
    }
  };

  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: f[k] === v ? "" : v }));
  const activeFilters = Object.entries(filters).filter(([k, v]) => v && k !== "q");

  const critCount = items.filter((i) => i.severity === "critical").length;

  // ---- shared style atoms -------------------------------------------------
  const panel = { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14 };
  const chip = (active, color) => ({
    fontSize: 11, fontWeight: 700, fontFamily: FN, padding: "5px 10px", borderRadius: 8, cursor: "pointer",
    border: `1px solid ${active ? color : "rgba(255,255,255,0.08)"}`,
    background: active ? `${color}22` : "rgba(255,255,255,0.02)",
    color: active ? color : "rgba(255,255,255,0.5)", whiteSpace: "nowrap", transition: "all .15s",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "radial-gradient(1200px 600px at 80% -10%, rgba(255,107,107,0.06), transparent), linear-gradient(180deg, #0a0a0c 0%, #08080a 100%)", color: "#faf9f6", fontFamily: FN, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* ---- Top bar ---- */}
      <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 22px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: "linear-gradient(140deg,#ff6b6b,#ee5a24)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, boxShadow: "0 8px 24px rgba(238,90,36,0.25)" }}>🛰️</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 900, letterSpacing: -0.3 }}>Cortex Intel <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 600, fontSize: 13 }}>· M365 Threat Intelligence</span></div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: MN }}>
            {facets.totalItems || total} items indexed · {sources.filter((s) => s.enabled).length || "—"} sources active
            {critCount > 0 && <span style={{ color: SEV.critical.c, fontWeight: 700 }}> · {critCount} critical in view</span>}
            {lastRun && <span> · updated {timeAgo(lastRun.ranAt)}</span>}
          </div>
        </div>
        {offline && <span style={{ ...chip(true, "#fbbf24"), cursor: "default" }} title="Live functions unreachable; showing sample data.">◍ Sample mode</span>}
        <button onClick={() => setShowSources(true)} style={{ ...chip(false, "#38bdf8"), padding: "8px 14px", fontSize: 12 }}>⚙︎ Sources</button>
        <button onClick={refresh} disabled={refreshing} style={{ padding: "8px 16px", borderRadius: 10, border: "none", cursor: refreshing ? "wait" : "pointer", fontFamily: FN, fontWeight: 800, fontSize: 12, color: "#fff", background: "linear-gradient(135deg,#ff6b6b,#ee5a24)", opacity: refreshing ? 0.7 : 1 }}>
          {refreshing ? "⟳ Ingesting…" : "⟳ Refresh intel"}
        </button>
        {onExit && <button onClick={onExit} title="Back to Cortex" style={{ ...chip(false, "#94a3b8"), padding: "8px 12px", fontSize: 12 }}>✕</button>}
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* ---- Sidebar: filters ---- */}
        <aside style={{ width: 230, flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.06)", padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18 }}>
          <FilterGroup title="Severity">
            {Object.keys(SEV).map((k) => (
              <div key={k} onClick={() => setF("severity", k)} style={chip(filters.severity === k, sev(k).c)}>
                {sev(k).l}{facets.severities?.[k] ? ` · ${facets.severities[k]}` : ""}
              </div>
            ))}
          </FilterGroup>
          <FilterGroup title="Category">
            {Object.keys(CAT).map((k) => (
              <div key={k} onClick={() => setF("category", k)} style={chip(filters.category === k, cat(k).c)}>
                {cat(k).i} {cat(k).l}{facets.categories?.[k] ? ` · ${facets.categories[k]}` : ""}
              </div>
            ))}
          </FilterGroup>
          <FilterGroup title="Workflow">
            {Object.keys(STATUS).map((k) => (
              <div key={k} onClick={() => setF("status", k)} style={chip(filters.status === k, STATUS[k].c)}>{STATUS[k].l}</div>
            ))}
          </FilterGroup>
          <FilterGroup title="Tags">
            {tags.length === 0 && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>No tags yet</span>}
            {tags.map((t) => (
              <div key={t} onClick={() => setF("tag", t)} style={chip(filters.tag === t, "#a78bfa")}>#{t}{facets.tags?.[t] ? ` · ${facets.tags[t]}` : ""}</div>
            ))}
          </FilterGroup>
          <FilterGroup title="Source">
            <div onClick={() => setFilters((f) => ({ ...f, source: "" }))} style={chip(!filters.source, "#38bdf8")}>All sources</div>
            {sources.filter((s) => s.enabled).map((s) => (
              <div key={s.id} onClick={() => setF("source", s.id)} style={{ ...chip(filters.source === s.id, cat(s.category).c), fontSize: 10.5 }}>{s.name}</div>
            ))}
          </FilterGroup>
        </aside>

        {/* ---- Center: search + list ---- */}
        <main style={{ flex: selected ? "1 1 0" : "2 1 0", minWidth: 0, display: "flex", flexDirection: "column", borderRight: selected ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
          <div style={{ padding: "14px 18px", display: "flex", gap: 10, alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 }}>
            <div style={{ flex: 1, position: "relative" }}>
              <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", opacity: 0.4 }}>🔍</span>
              <input ref={qRef} value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
                placeholder="Search title, summary, CVE, source…  (e.g. Exchange RCE, CVE-2023-23397)"
                style={{ width: "100%", padding: "10px 12px 10px 36px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#faf9f6", fontSize: 13, fontFamily: FN, outline: "none", boxSizing: "border-box" }} />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#faf9f6", fontSize: 12, fontFamily: FN, outline: "none", cursor: "pointer" }}>
              <option value="recent">Newest first</option>
              <option value="severity">Severity first</option>
            </select>
          </div>

          {activeFilters.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 18px 0" }}>
              {activeFilters.map(([k, v]) => (
                <span key={k} onClick={() => setFilters((f) => ({ ...f, [k]: "" }))} style={{ ...chip(true, "#ff6b6b"), fontSize: 10 }}>{k}: {v} ✕</span>
              ))}
              <span onClick={() => setFilters({ q: filters.q, source: "", category: "", severity: "", tag: "", status: "" })} style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", cursor: "pointer", padding: "5px 4px" }}>clear all</span>
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", fontFamily: MN }}>{loading ? "loading…" : `${total} result${total === 1 ? "" : "s"}`}</div>
            {!loading && items.length === 0 && (
              <div style={{ ...panel, padding: 28, textAlign: "center", marginTop: 20 }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>🗂️</div>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>No intelligence yet</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 14 }}>Pull the latest from your credible sources to populate the workspace.</div>
                <button onClick={refresh} style={{ padding: "9px 18px", borderRadius: 10, border: "none", cursor: "pointer", fontFamily: FN, fontWeight: 800, fontSize: 12, color: "#fff", background: "linear-gradient(135deg,#ff6b6b,#ee5a24)" }}>⟳ Refresh intelligence</button>
              </div>
            )}
            {items.map((it) => {
              const v = sev(it.severity), c = cat(it.category);
              const active = selected?.id === it.id;
              return (
                <div key={it.id} onClick={() => setSelected(it)} style={{ ...panel, borderColor: active ? v.bd : "rgba(255,255,255,0.06)", background: active ? v.bg : "rgba(255,255,255,0.02)", padding: 14, cursor: "pointer", transition: "all .12s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: v.c, background: v.bg, border: `1px solid ${v.bd}`, padding: "2px 7px", borderRadius: 5 }}>{v.l}</span>
                    <span style={{ fontSize: 10, color: c.c, fontWeight: 700 }}>{c.i} {it.sourceName}</span>
                    {it.trust === 1 && <span title="Authoritative source" style={{ fontSize: 10, color: "#34d399" }}>✓ trusted</span>}
                    <span style={{ marginLeft: "auto", fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: MN }}>{timeAgo(it.published)}</span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3, marginBottom: 5 }}>{it.title}</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{it.summary}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                    {(it.cves || []).slice(0, 3).map((cve) => <span key={cve} style={{ fontSize: 9.5, fontFamily: MN, color: "#ff8a4c", background: "rgba(255,138,76,0.1)", padding: "1px 6px", borderRadius: 4 }}>{cve}</span>)}
                    {(it.tags || []).map((t) => <span key={t} style={{ fontSize: 9.5, color: "#a78bfa", background: "rgba(167,139,250,0.1)", padding: "1px 6px", borderRadius: 4 }}>#{t}</span>)}
                    {it.assessment && <span style={{ fontSize: 9.5, color: "#34d399", fontWeight: 700 }}>✦ assessed</span>}
                    {it.status && it.status !== "new" && <span style={{ fontSize: 9.5, color: STATUS[it.status]?.c, marginLeft: "auto" }}>● {STATUS[it.status]?.l}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </main>

        {/* ---- Right: detail / assessment ---- */}
        {selected && (
          <section style={{ flex: "1.1 1 0", minWidth: 340, maxWidth: 560, overflowY: "auto", padding: 20 }}>
            <DetailPanel item={selected} onClose={() => setSelected(null)} onPatch={patchItem} onAssess={assess} assessing={assessing} allTags={tags} />
          </section>
        )}
      </div>

      {toast && <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: "rgba(20,20,24,0.97)", border: "1px solid rgba(255,255,255,0.12)", color: "#faf9f6", padding: "11px 18px", borderRadius: 12, fontSize: 12.5, fontWeight: 600, boxShadow: "0 16px 40px rgba(0,0,0,0.5)", zIndex: 50, maxWidth: 520, textAlign: "center" }}>{toast}</div>}

      {showSources && <SourcesModal sources={sources} settings={settings} offline={offline} onClose={() => setShowSources(false)} setSources={setSources} setSettings={setSettings} flash={flash} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function FilterGroup({ title, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function DetailPanel({ item, onClose, onPatch, onAssess, assessing, allTags }) {
  const [tagInput, setTagInput] = useState("");
  const [notes, setNotes] = useState(item.notes || "");
  const v = sev(item.severity), c = cat(item.category), a = item.assessment;
  useEffect(() => { setNotes(item.notes || ""); }, [item.id]);

  const addTag = (t) => {
    const tag = t.trim().toLowerCase().replace(/^#/, "");
    if (!tag) return;
    if (!(item.tags || []).includes(tag)) onPatch(item.id, { tags: [...(item.tags || []), tag] });
    setTagInput("");
  };
  const removeTag = (t) => onPatch(item.id, { tags: (item.tags || []).filter((x) => x !== t) });

  const box = { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 14, marginBottom: 12 };
  const label = { fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: "rgba(255,255,255,0.3)", marginBottom: 6 };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: v.c, background: v.bg, border: `1px solid ${v.bd}`, padding: "3px 9px", borderRadius: 6 }}>{v.l}</span>
          <span style={{ fontSize: 11, color: c.c, fontWeight: 700 }}>{c.i} {c.l}</span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 18, cursor: "pointer" }}>✕</button>
      </div>

      <h2 style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.3, margin: "0 0 6px" }}>{item.title}</h2>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: MN, marginBottom: 14 }}>
        {item.sourceName} · {new Date(item.published).toLocaleString()}
        {item.link && <> · <a href={item.link} target="_blank" rel="noreferrer" style={{ color: "#38bdf8" }}>open source ↗</a></>}
      </div>

      {/* Curate: status + tags + notes */}
      <div style={box}>
        <div style={label}>Workflow status</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {Object.keys(STATUS).map((k) => (
            <span key={k} onClick={() => onPatch(item.id, { status: k })} style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 8, cursor: "pointer", border: `1px solid ${item.status === k ? STATUS[k].c : "rgba(255,255,255,0.08)"}`, background: item.status === k ? STATUS[k].c + "22" : "transparent", color: item.status === k ? STATUS[k].c : "rgba(255,255,255,0.5)" }}>{STATUS[k].l}</span>
          ))}
        </div>
        <div style={label}>Tags</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {(item.tags || []).map((t) => <span key={t} onClick={() => removeTag(t)} style={{ fontSize: 11, color: "#a78bfa", background: "rgba(167,139,250,0.12)", padding: "3px 9px", borderRadius: 6, cursor: "pointer" }}>#{t} ✕</span>)}
        </div>
        <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag(tagInput)} list="all-tags" placeholder="Add tag + Enter (e.g. exchange, zero-day, priority)"
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#faf9f6", fontSize: 12, fontFamily: FN, outline: "none", boxSizing: "border-box" }} />
        <datalist id="all-tags">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
      </div>

      {/* Claude assessment */}
      <div style={{ ...box, borderColor: a ? "rgba(52,211,153,0.25)" : "rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: a ? 12 : 0 }}>
          <div style={label}>✦ Claude threat assessment & mitigation</div>
          <button onClick={() => onAssess(item)} disabled={assessing} style={{ padding: "6px 12px", borderRadius: 8, border: "none", cursor: assessing ? "wait" : "pointer", fontFamily: FN, fontWeight: 800, fontSize: 11, color: "#fff", background: "linear-gradient(135deg,#34d399,#059669)", opacity: assessing ? 0.7 : 1 }}>
            {assessing ? "Analyzing…" : a ? "Re-assess" : "Assess with Claude"}
          </button>
        </div>
        {a && (
          <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <Pill c={sev(a.severity).c}>{sev(a.severity).l}</Pill>
              {a.recommended_priority && <Pill c="#ff8a4c">{String(a.recommended_priority).split(" ")[0]}</Pill>}
              {a.exploitation_status && <Pill c="#f472b6">{a.exploitation_status}</Pill>}
              {a.confidence && <Pill c="#94a3b8">confidence: {a.confidence}</Pill>}
            </div>
            {a.summary && <p style={{ margin: "0 0 10px", color: "rgba(255,255,255,0.8)" }}>{a.summary}</p>}
            {a.who_is_at_risk && <AField t="Who is at risk">{a.who_is_at_risk}</AField>}
            <AList t="M365 exposure" items={a.m365_exposure} color="#38bdf8" />
            <AList t="Mitigation next steps" items={a.mitigations} color="#34d399" ordered />
            <AList t="Detection guidance" items={a.detection_guidance} color="#fbbf24" />
            {a.recommended_priority && <AField t="Priority">{a.recommended_priority}</AField>}
            <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.25)", fontFamily: MN, marginTop: 10 }}>assessed {a.assessedAt ? new Date(a.assessedAt).toLocaleString() : ""} · {a.model || ""}</div>
          </div>
        )}
        {!a && <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.35)", margin: "10px 0 0" }}>Run an AI assessment to get a defender-focused severity call, affected M365 components, and prioritized mitigation + detection steps.</p>}
      </div>

      {/* Notes */}
      <div style={box}>
        <div style={label}>Analyst notes</div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => onPatch(item.id, { notes })} placeholder="Add context, decisions, or tracking references…"
          style={{ width: "100%", minHeight: 70, padding: "9px 11px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#faf9f6", fontSize: 12, fontFamily: FN, outline: "none", boxSizing: "border-box", resize: "vertical" }} />
      </div>

      {/* Raw source */}
      <div style={box}>
        <div style={label}>Raw source content</div>
        {(item.cves || []).length > 0 && <div style={{ marginBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>{item.cves.map((cve) => <a key={cve} href={`https://nvd.nist.gov/vuln/detail/${cve}`} target="_blank" rel="noreferrer" style={{ fontSize: 10, fontFamily: MN, color: "#ff8a4c", background: "rgba(255,138,76,0.1)", padding: "2px 7px", borderRadius: 5, textDecoration: "none" }}>{cve} ↗</a>)}</div>}
        {(item.signals || []).length > 0 && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 8 }}>Signals detected: {item.signals.join(", ")}</div>}
        <div style={{ fontSize: 12, lineHeight: 1.6, color: "rgba(255,255,255,0.65)", fontFamily: MN, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflowY: "auto" }}>{item.raw || item.summary}</div>
      </div>
    </div>
  );
}

function Pill({ children, c }) {
  return <span style={{ fontSize: 10, fontWeight: 800, color: c, background: c + "1e", border: `1px solid ${c}44`, padding: "3px 9px", borderRadius: 6, textTransform: "capitalize" }}>{children}</span>;
}
function AField({ t, children }) {
  return <div style={{ marginBottom: 10 }}><div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: "rgba(255,255,255,0.35)", marginBottom: 3 }}>{t}</div><div style={{ color: "rgba(255,255,255,0.75)" }}>{children}</div></div>;
}
function AList({ t, items, color, ordered }) {
  if (!items || !items.length) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: "rgba(255,255,255,0.35)", marginBottom: 4 }}>{t}</div>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 5 }}>
        {items.map((x, i) => (
          <li key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "rgba(255,255,255,0.75)", fontSize: 12.5, lineHeight: 1.45 }}>
            <span style={{ color, fontWeight: 800, flexShrink: 0, fontFamily: MN, fontSize: 11 }}>{ordered ? `${i + 1}.` : "▸"}</span>
            <span>{x}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
function SourcesModal({ sources, settings, offline, onClose, setSources, setSettings, flash }) {
  const [form, setForm] = useState({ name: "", type: "rss", url: "", category: "custom", note: "", apiKeyHeader: "", apiKey: "" });
  const [kwText, setKwText] = useState((settings.keywords || []).join(", "));
  const [busy, setBusy] = useState(false);

  const call = async (opts) => {
    if (offline) { flash("Source changes need the live backend."); return null; }
    try { const r = await fetch(API.sources, opts); const d = await r.json(); if (d.error) throw new Error(d.error); return d; }
    catch (e) { flash("Failed: " + e.message); return null; }
  };

  const toggle = async (s) => {
    const next = sources.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x));
    setSources(next);
    await call({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, enabled: !s.enabled }) });
  };
  const remove = async (s) => {
    setSources(sources.filter((x) => x.id !== s.id));
    await call({ method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }) });
  };
  const add = async () => {
    if (!form.name || (!form.url && form.type !== "custom_api")) { flash("Name and feed URL required."); return; }
    setBusy(true);
    const d = await call({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    if (d) { setSources(d.sources); setForm({ name: "", type: "rss", url: "", category: "custom", note: "", apiKeyHeader: "", apiKey: "" }); flash("Source added"); }
    else if (offline) { setSources([...sources, { ...form, id: "local_" + Date.now(), enabled: true, trust: 2 }]); }
    setBusy(false);
  };
  const saveKeywords = async () => {
    const keywords = kwText.split(",").map((k) => k.trim()).filter(Boolean);
    setSettings((s) => ({ ...s, keywords }));
    if (offline) { flash("Keyword filter saved (sample mode — not persisted)"); return; }
    try {
      await fetch(API.sources + "?settings=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keywords }) });
      flash("M365 keyword filter saved");
    } catch (e) { flash("Failed to save keywords: " + e.message); }
  };
  const resetDefaults = async () => {
    const d = await fetch(API.sources + "?reset=1", { method: "POST" }).then((r) => r.json()).catch(() => null);
    if (d?.sources) { setSources(d.sources); flash("Default source catalog restored"); }
  };

  const inp = { width: "100%", padding: "9px 11px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#faf9f6", fontSize: 12.5, fontFamily: FN, outline: "none", boxSizing: "border-box" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.66)", backdropFilter: "blur(6px)", zIndex: 60, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: 30, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(760px, 100%)", background: "linear-gradient(180deg,#141416,#0e0e10)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 18, padding: 24, boxShadow: "0 40px 100px rgba(0,0,0,0.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ fontSize: 19, fontWeight: 900, margin: 0 }}>Intelligence sources</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", margin: "0 0 18px", lineHeight: 1.5 }}>
          Toggle, add, or remove feeds. Everything is M365-scoped: items that don't mention a Microsoft 365 product are filtered out at ingest. Direct scraping of criminal forums is intentionally not performed — use the <b>Underground / Dark-Web CTI</b> template to plug in a licensed provider's API.
        </p>

        {/* keyword filter */}
        <div style={{ background: "rgba(56,189,248,0.05)", border: "1px solid rgba(56,189,248,0.15)", borderRadius: 12, padding: 14, marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#38bdf8", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>M365 relevance keywords</div>
          <textarea value={kwText} onChange={(e) => setKwText(e.target.value)} style={{ ...inp, minHeight: 54, resize: "vertical", fontFamily: MN, fontSize: 11 }} />
          <button onClick={saveKeywords} style={{ marginTop: 8, padding: "7px 14px", borderRadius: 8, border: "1px solid rgba(56,189,248,0.3)", background: "rgba(56,189,248,0.12)", color: "#38bdf8", fontWeight: 800, fontSize: 11.5, cursor: "pointer", fontFamily: FN }}>Save keyword filter</button>
        </div>

        {/* source list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18, maxHeight: 300, overflowY: "auto" }}>
          {sources.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10 }}>
              <div onClick={() => toggle(s)} style={{ width: 34, height: 19, borderRadius: 10, background: s.enabled ? "#34d399" : "rgba(255,255,255,0.12)", padding: 2, cursor: "pointer", flexShrink: 0 }}>
                <div style={{ width: 15, height: 15, borderRadius: 8, background: "#fff", transform: s.enabled ? "translateX(15px)" : "translateX(0)", transition: "all .2s" }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: cat(s.category).c }}>{cat(s.category).i}</span>{s.name}
                  {s.trust === 1 && <span style={{ fontSize: 9, color: "#34d399" }}>✓</span>}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: MN, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.type} · {s.url || "(configure API URL)"}</div>
                {s.note && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{s.note}</div>}
              </div>
              <button onClick={() => remove(s)} style={{ background: "none", border: "1px solid rgba(255,107,107,0.2)", color: "#ff6b6b", borderRadius: 7, padding: "4px 9px", fontSize: 11, cursor: "pointer", flexShrink: 0, fontFamily: FN }}>Remove</button>
            </div>
          ))}
        </div>

        {/* add source */}
        <div style={{ background: "rgba(255,107,107,0.03)", border: "1px solid rgba(255,107,107,0.1)", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#ff6b6b", marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>Add a source</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <input placeholder="Source name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inp} />
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={inp}>
              <option value="rss">RSS / Atom feed</option>
              <option value="cisa_kev">CISA KEV (JSON)</option>
              <option value="nvd">NVD CVE API</option>
              <option value="custom_api">Custom API (licensed CTI)</option>
            </select>
          </div>
          <input placeholder={form.type === "custom_api" ? "API endpoint URL (returns JSON items)" : "Feed URL (https://…)"} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} style={{ ...inp, marginBottom: 8 }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inp}>
              {Object.keys(CAT).map((k) => <option key={k} value={k}>{cat(k).l}</option>)}
            </select>
            <input placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={inp} />
          </div>
          {form.type === "custom_api" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <input placeholder="Auth header name (e.g. X-API-Key)" value={form.apiKeyHeader} onChange={(e) => setForm({ ...form, apiKeyHeader: e.target.value })} style={inp} />
              <input placeholder="API key" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} style={inp} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={add} disabled={busy} style={{ padding: "9px 18px", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: FN, fontWeight: 800, fontSize: 12, color: "#fff", background: "linear-gradient(135deg,#ff6b6b,#ee5a24)" }}>{busy ? "Adding…" : "Add source"}</button>
            <button onClick={resetDefaults} style={{ padding: "9px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", fontFamily: FN, fontWeight: 700, fontSize: 12, color: "rgba(255,255,255,0.5)", background: "transparent" }}>Restore defaults</button>
          </div>
        </div>
      </div>
    </div>
  );
}
