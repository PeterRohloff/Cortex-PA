// Netlify Function: Trigger an on-demand ingest of all enabled sources.
//   POST /api/intel-ingest  -> fetch, filter (M365), dedupe, store; returns run summary.
// Used by the "Refresh intelligence" button in the UI. The scheduled function
// intel-poll.mjs runs the same pipeline automatically on a cron.

import { runIngest, json, CORS } from "./lib/intel.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  try {
    const result = await runIngest();
    return json(result);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};

export const config = { path: "/api/intel-ingest" };
