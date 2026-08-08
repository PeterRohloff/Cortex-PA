// Netlify Function: Query and curate intelligence items.
//   GET /api/intel-items?q=&source=&category=&severity=&tag=&status=&sort=&limit=&offset=
//        -> { items, total, tags, facets }
//   PATCH /api/intel-items  body: { id, tags?, notes?, status? }  -> update curation
//   DELETE /api/intel-items body: { id }                          -> remove item

import { getItems, saveItems, severityRank, json, CORS } from "./lib/intel.mjs";

function matches(item, f) {
  if (f.q) {
    const hay = `${item.title} ${item.summary} ${item.raw} ${(item.cves || []).join(" ")} ${item.sourceName}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  if (f.source && item.sourceId !== f.source) return false;
  if (f.category && item.category !== f.category) return false;
  if (f.severity && item.severity !== f.severity) return false;
  if (f.status && item.status !== f.status) return false;
  if (f.tag && !(item.tags || []).includes(f.tag)) return false;
  return true;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const all = await getItems();
      const f = {
        q: url.searchParams.get("q") || "",
        source: url.searchParams.get("source") || "",
        category: url.searchParams.get("category") || "",
        severity: url.searchParams.get("severity") || "",
        tag: url.searchParams.get("tag") || "",
        status: url.searchParams.get("status") || "",
      };
      const sort = url.searchParams.get("sort") || "recent";
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);

      let filtered = all.filter((i) => matches(i, f));
      if (sort === "severity") {
        filtered.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || new Date(b.published) - new Date(a.published));
      } else {
        filtered.sort((a, b) => new Date(b.published) - new Date(a.published));
      }

      // Facets computed over the *unfiltered* set for stable filter menus.
      const tagCounts = {};
      const catCounts = {};
      const sevCounts = {};
      for (const i of all) {
        (i.tags || []).forEach((t) => (tagCounts[t] = (tagCounts[t] || 0) + 1));
        catCounts[i.category] = (catCounts[i.category] || 0) + 1;
        sevCounts[i.severity] = (sevCounts[i.severity] || 0) + 1;
      }

      return json({
        total: filtered.length,
        items: filtered.slice(offset, offset + limit),
        tags: Object.keys(tagCounts).sort(),
        facets: { tags: tagCounts, categories: catCounts, severities: sevCounts, totalItems: all.length },
      });
    }

    if (req.method === "PATCH") {
      const body = await req.json();
      if (!body.id) return json({ error: "id is required" }, 400);
      const all = await getItems();
      const idx = all.findIndex((i) => i.id === body.id);
      if (idx < 0) return json({ error: "not found" }, 404);
      if (Array.isArray(body.tags)) all[idx].tags = [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))];
      if (typeof body.notes === "string") all[idx].notes = body.notes;
      if (typeof body.status === "string") all[idx].status = body.status;
      await saveItems(all);
      return json({ item: all[idx] });
    }

    if (req.method === "DELETE") {
      const body = await req.json().catch(() => ({}));
      if (!body.id) return json({ error: "id is required" }, 400);
      const all = await getItems();
      await saveItems(all.filter((i) => i.id !== body.id));
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};

export const config = { path: "/api/intel-items" };
