// Netlify Function: AI threat assessment via Claude.
//   POST /api/intel-assess  body: { id }            -> assess a stored item, persist result
//   POST /api/intel-assess  body: { text, title? }  -> assess ad-hoc text (not stored)
//
// Produces a structured, defender-focused evaluation: severity call, M365
// exposure, and prioritized mitigation / hardening next steps. Requires
// ANTHROPIC_API_KEY in the Netlify environment.

import { getItems, saveItems, json, CORS } from "./lib/intel.mjs";

const MODEL = "claude-sonnet-4-20250514";

const SYSTEM = `You are a senior Microsoft 365 threat-intelligence analyst supporting a defensive security team.
You assess open-source intelligence about vulnerabilities and threats affecting the Microsoft 365 / Office 365 platform
(Exchange Online, SharePoint, OneDrive, Teams, Outlook, Entra ID / Azure AD, Intune, Defender for Office 365, Power Platform, Copilot).
Your job is purely DEFENSIVE: help the team understand exposure and mitigate risk. Never provide exploit code or offensive tradecraft.
Respond ONLY with a compact JSON object, no prose outside it.`;

function prompt(title, text) {
  return `Assess the following Microsoft 365 threat intelligence item.

TITLE: ${title || "(none)"}
CONTENT:
${(text || "").slice(0, 6000)}

Return JSON with exactly these fields:
{
  "severity": "critical|high|medium|low|info",
  "confidence": "high|medium|low",
  "summary": "2-3 sentence plain-language explanation of the threat",
  "m365_exposure": ["which M365 services/components are affected"],
  "affected_cves": ["CVE-IDs if any"],
  "exploitation_status": "in-the-wild | poc-available | theoretical | unknown",
  "who_is_at_risk": "1 sentence on which orgs/configs are most exposed",
  "mitigations": ["prioritized, concrete defensive next steps: patches, config changes, CA policies, detections"],
  "detection_guidance": ["what to hunt for: sign-in logs, audit events, indicators"],
  "recommended_priority": "P1|P2|P3|P4 with a short reason"
}
Base everything on the content provided; if information is missing, say so rather than inventing specifics.`;
}

async function callClaude(apiKey, title, text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt(title, text) }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Claude API error");
  const raw = data.content?.[0]?.text || "";
  const m = raw.match(/\{[\s\S]*\}/);
  let parsed = null;
  try { parsed = JSON.parse(m ? m[0] : raw); } catch { parsed = { summary: raw, severity: "info" }; }
  parsed.assessedAt = new Date().toISOString();
  parsed.model = MODEL;
  return parsed;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables" }, 500);

  try {
    const body = await req.json();

    if (body.id) {
      const all = await getItems();
      const idx = all.findIndex((i) => i.id === body.id);
      if (idx < 0) return json({ error: "item not found" }, 404);
      const item = all[idx];
      const assessment = await callClaude(apiKey, item.title, `${item.summary}\n\n${item.raw}`);
      all[idx].assessment = assessment;
      if (assessment.severity) all[idx].severity = assessment.severity;
      if (all[idx].status === "new") all[idx].status = "reviewing";
      await saveItems(all);
      return json({ item: all[idx], assessment });
    }

    if (body.text) {
      const assessment = await callClaude(apiKey, body.title || "", body.text);
      return json({ assessment });
    }

    return json({ error: "provide either { id } or { text }" }, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};

export const config = { path: "/api/intel-assess" };
