// Netlify Function: Manage intelligence sources + platform settings.
//   GET    /api/intel-sources            -> { sources, settings }
//   POST   /api/intel-sources            -> add/update a source
//   DELETE /api/intel-sources            -> remove a source (body: { id })
//   POST   /api/intel-sources?settings=1 -> update settings (keywords, m365Only)
//   POST   /api/intel-sources?reset=1    -> restore the default source catalog

import {
  getSources, saveSources, getSettings, saveSettings, defaultSources, json, CORS,
} from "./lib/intel.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const [sources, settings] = await Promise.all([getSources(), getSettings()]);
      return json({ sources, settings });
    }

    if (req.method === "POST" && url.searchParams.get("reset")) {
      const sources = await saveSources(defaultSources());
      return json({ sources });
    }

    if (req.method === "POST" && url.searchParams.get("settings")) {
      const body = await req.json();
      const current = await getSettings();
      const next = {
        ...current,
        ...(body.keywords ? { keywords: body.keywords } : {}),
        ...(typeof body.m365Only === "boolean" ? { m365Only: body.m365Only } : {}),
      };
      await saveSettings(next);
      return json({ settings: next });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.name || !body.type) return json({ error: "name and type are required" }, 400);
      const sources = await getSources();
      const id = body.id || `src_${body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
      const source = {
        id,
        name: body.name,
        category: body.category || "custom",
        trust: body.trust || 2,
        type: body.type, // rss | cisa_kev | nvd | custom_api
        url: body.url || "",
        enabled: body.enabled !== false,
        note: body.note || "",
        ...(body.apiKeyHeader ? { apiKeyHeader: body.apiKeyHeader } : {}),
        ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      };
      const idx = sources.findIndex((s) => s.id === id);
      if (idx >= 0) sources[idx] = { ...sources[idx], ...source };
      else sources.push(source);
      await saveSources(sources);
      return json({ sources, source });
    }

    if (req.method === "DELETE") {
      const body = await req.json().catch(() => ({}));
      const id = body.id || url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      const sources = (await getSources()).filter((s) => s.id !== id);
      await saveSources(sources);
      return json({ sources });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};

export const config = { path: "/api/intel-sources" };
