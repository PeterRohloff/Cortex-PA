// Netlify Scheduled Function: Poll all enabled intelligence sources on a cron
// so the platform stays near real-time without any manual action. Runs the
// same ingest pipeline as the on-demand /api/intel-ingest endpoint.
//
// Default cadence: every 30 minutes. Adjust `schedule` below (cron, UTC).

import { runIngest } from "./lib/intel.mjs";

export default async () => {
  const started = new Date().toISOString();
  try {
    const result = await runIngest();
    console.log(`[intel-poll] ${started} added=${result.added} total=${result.total}`);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[intel-poll] failed:", e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
};

export const config = { schedule: "*/30 * * * *" };
