// Netlify Function: AI processing via Claude API
// Generates smart reply drafts and extracts tasks from email content.

export default async (req) => {
  const { action, emailBody, emailFrom, emailSubject, accountType } = await req.json();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables" }, { status: 500 });
  }

  const tone = accountType === "personal" ? "casual and friendly" : "professional and concise";

  let prompt = "";
  if (action === "draft-reply") {
    prompt = `Draft a reply to this email. Use a ${tone} tone. Keep it brief.\n\nFrom: ${emailFrom}\nSubject: ${emailSubject}\nBody: ${emailBody}\n\nReply:`;
  } else if (action === "extract-tasks") {
    prompt = `Extract action items from this email. Return a JSON array of objects with "title" and "due" fields.\n\nFrom: ${emailFrom}\nSubject: ${emailSubject}\nBody: ${emailBody}\n\nJSON:`;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || "";

  return Response.json({ result: text, action });
};

export const config = { path: "/api/ai-process" };
