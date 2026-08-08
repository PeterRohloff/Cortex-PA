import { useState, useEffect } from "react";
import Intel from "./Intel";

// ============================================================================
// CORTEX PWA — Connects to Apple Mail (IMAP) & Apple Calendar (CalDAV)
// ============================================================================
// Deploy: netlify deploy --prod
// Install: Open on iPhone Safari > Share > Add to Home Screen
// Backend: Netlify Functions handle IMAP + CalDAV + Claude AI
// Scheduler: Netlify Scheduled Functions (cron) for overnight automations
// Auth: iCloud app-specific password (generated once at appleid.apple.com)
// ============================================================================

const S = { SETUP: 0, CONNECT: 1, SYNCING: 2, HOME: 3, INBOX: 4, EMAIL: 5, CAL: 6, TASKS: 7, AUTO: 8, DEPLOY: 9 };
const FN = "'Outfit', sans-serif";
const MN = "'Courier New', monospace";

// Simulated multi-account data (in production, fetched via IMAP/CalDAV)
const accounts = [
  { id: "icloud", label: "iCloud", email: "me@icloud.com", color: "#38bdf8", protocol: "IMAP + CalDAV" },
  { id: "gmail", label: "Gmail", email: "me@gmail.com", color: "#34d399", protocol: "IMAP + CalDAV" },
  { id: "work", label: "Acme Corp", email: "me@acmecorp.com", color: "#f59e0b", protocol: "IMAP + CalDAV" },
];

function getColor(id) { return (accounts.find(a => a.id === id) || {}).color || "#888"; }
function getLabel(id) { return (accounts.find(a => a.id === id) || {}).label || ""; }

const Dot = ({ id, s }) => <div style={{ width: s || 7, height: s || 7, borderRadius: s || 7, background: getColor(id), flexShrink: 0 }}/>;

const Tag = ({ id }) => (
  <span style={{ fontSize: 9, fontWeight: 700, color: getColor(id), background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", padding: "1px 6px", borderRadius: 4, fontFamily: FN, whiteSpace: "nowrap" }}>{getLabel(id)}</span>
);

const Pri = ({ p }) => {
  const m = { high: { c: "#ff6b6b", bg: "rgba(255,107,107,0.1)", bd: "rgba(255,107,107,0.2)" }, medium: { c: "#fbbf24", bg: "rgba(251,191,36,0.1)", bd: "rgba(251,191,36,0.18)" }, low: { c: "#64748b", bg: "rgba(100,116,139,0.08)", bd: "rgba(100,116,139,0.14)" } };
  const v = m[p] || m.low;
  return <span style={{ fontSize: 9, fontWeight: 800, color: v.c, background: v.bg, border: "1px solid " + v.bd, padding: "2px 6px", borderRadius: 4, fontFamily: FN, textTransform: "uppercase", letterSpacing: 0.5 }}>{p}</span>;
};

const mails = [
  { id: 1, acct: "work", from: "Sarah Chen", addr: "sarah@designstudio.co", subj: "Q1 Brand Refresh \u2014 Final Deliverables", time: "9:42 AM", read: false, pri: "high",
    body: "Hi!\n\nAttached are the final brand assets from Thursday. Updated the palette \u2014 warmer tones for the primary gradient, refined icon set.\n\nLet me know if this works for mobile screens. Happy to schedule a 30-min review call this week.\n\nCheers,\nSarah",
    reply: "Hi Sarah,\n\nThese look fantastic \u2014 the warmer tones are exactly right for mobile. I'll review in detail this afternoon.\n\nFree Thursday 2 PM or Friday 10 AM for a call \u2014 either work?\n\nBest",
    tasks: ["Review brand assets from Sarah", "Schedule design review call"] },
  { id: 2, acct: "work", from: "Marcus Johnson", addr: "marcus@techventures.io", subj: "Partnership Proposal \u2014 AI Integration", time: "8:15 AM", read: false, pri: "high",
    body: "Hi,\n\nGreat meeting you at Future Tech Summit. Following up \u2014 we'd love to explore an AI-powered workflow automation partnership.\n\nOur platform handles 2M+ daily transactions. Open to a discovery call next week?\n\nBest,\nMarcus Johnson\nCTO, TechVentures",
    reply: "Hi Marcus,\n\nGreat connecting at the summit. Happy to explore this \u2014 could you share a brief scope doc so I can prepare materials?\n\nAvailable Tuesday or Wednesday afternoon.\n\nBest",
    tasks: ["Prep for TechVentures discovery call", "Confirm call time with Marcus"] },
  { id: 3, acct: "work", from: "Diana Patel", addr: "diana@legalcorp.com", subj: "Contract Review \u2014 Urgent", time: "Yesterday", read: false, pri: "high",
    body: "Hi,\n\nPlease review the NDA amendments before our call tomorrow at 11 AM.\n\nSection 4.2: Updated non-compete (narrowed scope)\nSection 7.1: Confidentiality extended to 3 years\nSection 9: New arbitration provisions\n\nNeed sign-off or redline by EOD.\n\nDiana Patel, Senior Counsel",
    reply: "Hi Diana,\n\nThanks for flagging these. I'll review this afternoon and send comments before EOD.\n\nQuick question \u2014 is the extended confidentiality period in 7.1 negotiable?\n\nBest",
    tasks: ["Review NDA Sections 4.2, 7.1, 9", "Send redline to Diana by EOD"] },
  { id: 4, acct: "icloud", from: "Alex Rivera", addr: "alex.r@gmail.com", subj: "Dinner Saturday?", time: "Yesterday", read: true, pri: "low",
    body: "Hey!\n\nFree Saturday for dinner? Thinking Omakase Kitchen downtown. 7:30 PM?\n\n\u2014 Alex",
    reply: "Hey Alex!\n\nSaturday 7:30 works great \u2014 been wanting to try Omakase Kitchen. Should I grab a reservation?\n\nSee you then!",
    tasks: ["Dinner with Alex \u2014 Sat 7:30 PM"] },
  { id: 5, acct: "gmail", from: "Lena Park", addr: "lena@startuphq.co", subj: "Invoice #2847 \u2014 January Retainer", time: "Feb 12", read: true, pri: "medium",
    body: "Hi,\n\nAttached is invoice #2847 for January consulting ($12,500). Net 30 terms.\n\nPlease confirm receipt.\n\nBest,\nLena Park",
    reply: "Hi Lena,\n\nReceived \u2014 I'll process this today. Payment within 30 days.\n\nThanks,",
    tasks: ["Process invoice #2847 \u2014 $12,500"] },
  { id: 6, acct: "gmail", from: "Dr. Mehta Office", addr: "appt@mehtamd.com", subj: "Appointment Reminder \u2014 Feb 20", time: "Feb 11", read: true, pri: "low",
    body: "Reminder: Your appointment with Dr. Mehta is Thursday, February 20 at 10:00 AM. Please arrive 10 minutes early.",
    reply: null,
    tasks: ["Dr. Mehta appt \u2014 Feb 20, 10 AM"] },
];

const calEvents = [
  { id: 1, title: "Morning Focus Block", time: "8:00 \u2013 9:30", acct: "work", color: "#6366f1" },
  { id: 2, title: "Standup \u2014 Engineering", time: "9:30 \u2013 9:45", acct: "work", color: "#06b6d4" },
  { id: 3, title: "NDA Call \u2014 Diana", time: "11:00 \u2013 11:30", acct: "work", color: "#ef4444" },
  { id: 4, title: "Lunch with Jamie", time: "12:00 \u2013 1:00", acct: "icloud", color: "#78716c" },
  { id: 5, title: "Design Review \u2014 Sarah", time: "2:00 \u2013 2:30", acct: "work", color: "#8b5cf6" },
  { id: 6, title: "Product Strategy", time: "2:30 \u2013 3:30", acct: "work", color: "#f97316", conflict: true },
  { id: 7, title: "TechVentures Call", time: "3:00 \u2013 3:45", acct: "gmail", color: "#ef4444", conflict: true },
  { id: 8, title: "Yoga Class", time: "6:30 \u2013 7:30", acct: "icloud", color: "#34d399" },
];

const taskData = [
  { id: 1, t: "Review NDA Sections 4.2, 7.1, 9", src: "Diana Patel", acct: "work", due: "Today EOD", p: "high" },
  { id: 2, t: "Send redline to Diana", src: "Diana Patel", acct: "work", due: "Today EOD", p: "high" },
  { id: 3, t: "Confirm call with Marcus", src: "Marcus Johnson", acct: "work", due: "Today", p: "high" },
  { id: 4, t: "Review brand assets from Sarah", src: "Sarah Chen", acct: "work", due: "Today", p: "high" },
  { id: 5, t: "Prep for TechVentures call", src: "Marcus Johnson", acct: "work", due: "Mon", p: "medium" },
  { id: 6, t: "Process invoice #2847", src: "Lena Park", acct: "gmail", due: "This week", p: "medium" },
  { id: 7, t: "Schedule design review call", src: "Sarah Chen", acct: "work", due: "This week", p: "medium" },
  { id: 8, t: "Dinner with Alex \u2014 Sat 7:30", src: "Alex Rivera", acct: "icloud", due: "Saturday", p: "low" },
  { id: 9, t: "Dr. Mehta appt \u2014 Feb 20", src: "Dr. Mehta", acct: "gmail", due: "Feb 20", p: "low" },
];

const autoData = [
  { id: 1, name: "Email Triage", desc: "Scan all IMAP accounts at 6 AM. Categorize by priority, archive newsletters.", icon: "\uD83D\uDCEC", sched: "Daily 6 AM", saved: "45 min/wk" },
  { id: 2, name: "Smart Reply Drafts", desc: "AI-draft replies overnight. Formal for work, casual for personal.", icon: "\u270D\uFE0F", sched: "Daily 5:30 AM", saved: "30 min/day" },
  { id: 3, name: "Task Extractor", desc: "Parse emails for action items. Auto-create in your task list.", icon: "\u2705", sched: "Real-time", saved: "40 min/day" },
  { id: 4, name: "Calendar Optimizer", desc: "Analyze tomorrow via CalDAV. Detect cross-account conflicts.", icon: "\uD83D\uDCC5", sched: "Daily 10 PM", saved: "20 min/day" },
  { id: 5, name: "Follow-Up Tracker", desc: "Sent mail with no reply after 48 hrs? Draft a follow-up.", icon: "\uD83D\uDD14", sched: "Every 12 hrs", saved: "25 min/wk" },
  { id: 6, name: "Morning Brief", desc: "Compile overnight activity into one notification at 6:30 AM.", icon: "\uD83C\uDF05", sched: "Daily 6:30 AM", saved: "20 min/day" },
];

// ============================================================================
export default function Cortex() {
  const [scr, setScr] = useState(S.SETUP);
  const [mail, setMail] = useState(null);
  const [anim, setAnim] = useState(true);
  const [tF, setTF] = useState("all");
  const [aF, setAF] = useState("all");
  const [done, setDone] = useState({});
  const [sent, setSent] = useState({});
  const [formAccts, setFormAccts] = useState([
    { id: "icloud", label: "iCloud", email: "", password: "", enabled: true, server: "imap.mail.me.com" },
    { id: "gmail", label: "Gmail", email: "", password: "", enabled: false, server: "imap.gmail.com" },
    { id: "work", label: "Outlook/Work", email: "", password: "", enabled: false, server: "outlook.office365.com" },
  ]);
  const [claudeKey, setClaudeKey] = useState("");
  const [syncProgress, setSyncProgress] = useState(0);
  const [platform, setPlatform] = useState("cortex"); // "cortex" | "intel"

  useEffect(() => { setAnim(false); const t = setTimeout(() => setAnim(true), 30); return () => clearTimeout(t); }, [scr]);
  useEffect(() => {
    if (scr === S.SYNCING) {
      let p = 0;
      const iv = setInterval(() => { p += Math.random() * 18 + 5; if (p >= 100) { p = 100; clearInterval(iv); setTimeout(() => setScr(S.HOME), 600); } setSyncProgress(Math.min(p, 100)); }, 400);
      return () => clearInterval(iv);
    }
  }, [scr]);

  const go = (s, m) => { if (m) setMail(m); setScr(s); };
  const unread = mails.filter(m => !m.read).length;
  const conflicts = calEvents.filter(c => c.conflict).length;
  const openTasks = taskData.filter(t => !done[t.id]).length;

  const Btn = ({ children, primary, onClick, style: s }) => (
    <button onClick={onClick} style={{
      padding: "13px 0", borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: FN, width: "100%",
      background: primary ? "linear-gradient(135deg, #ff6b6b, #ee5a24)" : "rgba(255,255,255,0.04)",
      border: primary ? "none" : "1px solid rgba(255,255,255,0.08)",
      color: primary ? "#fff" : "rgba(255,255,255,0.5)", ...s
    }}>{children}</button>
  );

  const Input = ({ label, value, onChange, placeholder, type }) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", fontFamily: FN, display: "block", marginBottom: 4 }}>{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} type={type || "text"}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#faf9f6", fontSize: 13, fontFamily: FN, outline: "none", boxSizing: "border-box" }}/>
    </div>
  );

  // ---- SETUP ----
  const renderSetup = () => (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 30px", textAlign: "center" }}>
      <div style={{ width: 72, height: 72, borderRadius: 20, background: "linear-gradient(140deg, #ff6b6b, #ee5a24)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, margin: "0 auto 20px", boxShadow: "0 14px 40px rgba(238,90,36,0.25)" }}>{"\u26A1"}</div>
      <h1 style={{ fontSize: 30, fontWeight: 900, color: "#faf9f6", margin: "0 0 6px", fontFamily: FN }}>Cortex</h1>
      <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", margin: "0 0 8px", fontFamily: FN, lineHeight: 1.5 }}>Your AI executive assistant.</p>
      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", margin: "0 0 32px", fontFamily: FN, lineHeight: 1.5 }}>Connects to Apple Mail and Apple Calendar via IMAP and CalDAV. No Mac required. Deploy anywhere.</p>
      <Btn primary onClick={() => setScr(S.CONNECT)}>Connect Your Accounts</Btn>
      <Btn onClick={() => setPlatform("intel")} style={{ marginTop: 10 }}>{"🛰️  Open Cortex Intel (M365 Threat Intel)"}</Btn>
      <div style={{ marginTop: 20, display: "flex", justifyContent: "center", gap: 16 }}>
        {[["IMAP", "Apple Mail"], ["CalDAV", "Apple Calendar"], ["AI", "Claude API"]].map(([proto, name], i) => (
          <div key={i} style={{ textAlign: "center" }}>
            <p style={{ fontSize: 11, fontWeight: 800, color: "#ff6b6b", margin: 0, fontFamily: FN }}>{proto}</p>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", margin: "1px 0 0" }}>{name}</p>
          </div>
        ))}
      </div>
    </div>
  );

  // ---- CONNECT ----
  const renderConnect = () => (
    <div style={{ flex: 1, overflow: "auto", padding: "0 24px", paddingBottom: 30 }}>
      <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", margin: "16px 0 4px", fontFamily: FN, letterSpacing: 2, textTransform: "uppercase" }}>Step 1 of 1</p>
      <h2 style={{ fontSize: 22, fontWeight: 900, color: "#faf9f6", margin: "0 0 4px", fontFamily: FN }}>Connect Accounts</h2>
      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", margin: "0 0 16px", lineHeight: 1.5, fontFamily: FN }}>Cortex connects directly to your mail servers via IMAP and your calendars via CalDAV. Your credentials are encrypted and stored only on-device.</p>

      {/* iCloud setup helper */}
      <div style={{ background: "rgba(56,189,248,0.05)", borderRadius: 12, padding: 12, border: "1px solid rgba(56,189,248,0.12)", marginBottom: 16 }}>
        <p style={{ fontSize: 12, fontWeight: 800, color: "#38bdf8", margin: "0 0 4px", fontFamily: FN }}>{"☁\uFE0F iCloud Setup (30 seconds)"}</p>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: 0, lineHeight: 1.5 }}>
          {"Go to appleid.apple.com \u2192 Sign-In and Security \u2192 App-Specific Passwords \u2192 Generate. Use this password below (not your Apple ID password)."}
        </p>
      </div>

      {/* Account forms */}
      {formAccts.map((acct, idx) => (
        <div key={acct.id} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 14, padding: 14, marginBottom: 10, border: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Dot id={acct.id} s={10}/>
              <span style={{ fontSize: 14, fontWeight: 800, color: "#faf9f6", fontFamily: FN }}>{acct.label}</span>
            </div>
            <div onClick={() => { const n = [...formAccts]; n[idx] = { ...n[idx], enabled: !n[idx].enabled }; setFormAccts(n); }}
              style={{ width: 36, height: 20, borderRadius: 10, background: acct.enabled ? "#ff6b6b" : "rgba(255,255,255,0.1)", padding: 2, cursor: "pointer" }}>
              <div style={{ width: 16, height: 16, borderRadius: 8, background: "#fff", transform: acct.enabled ? "translateX(16px)" : "translateX(0)", transition: "all 0.2s" }}/>
            </div>
          </div>
          {acct.enabled && (
            <div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.03)", padding: "2px 6px", borderRadius: 4, fontFamily: MN }}>{"IMAP: " + acct.server}</span>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.03)", padding: "2px 6px", borderRadius: 4, fontFamily: MN }}>{"CalDAV: " + (acct.id === "icloud" ? "caldav.icloud.com" : acct.id === "gmail" ? "apidata.googleusercontent.com" : "outlook.office365.com")}</span>
              </div>
              <Input label="Email" placeholder={acct.id === "icloud" ? "you@icloud.com" : acct.id === "gmail" ? "you@gmail.com" : "you@company.com"}
                value={acct.email} onChange={v => { const n = [...formAccts]; n[idx] = { ...n[idx], email: v }; setFormAccts(n); }}/>
              <Input label={acct.id === "icloud" ? "App-Specific Password" : acct.id === "gmail" ? "App Password (Google Account \u2192 Security)" : "Password or App Password"}
                placeholder={"\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"} type="password"
                value={acct.password} onChange={v => { const n = [...formAccts]; n[idx] = { ...n[idx], password: v }; setFormAccts(n); }}/>
            </div>
          )}
        </div>
      ))}

      {/* Claude API Key */}
      <div style={{ background: "rgba(255,107,107,0.03)", borderRadius: 14, padding: 14, marginBottom: 16, border: "1px solid rgba(255,107,107,0.08)" }}>
        <p style={{ fontSize: 13, fontWeight: 800, color: "#ff6b6b", margin: "0 0 8px", fontFamily: FN }}>{"\u26A1 AI Engine (Optional)"}</p>
        <Input label="Claude API Key" placeholder="sk-ant-..." value={claudeKey} onChange={setClaudeKey}/>
        <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", margin: 0 }}>Powers smart replies, task extraction, and morning briefs. Get a key at console.anthropic.com</p>
      </div>

      <Btn primary onClick={() => setScr(S.SYNCING)}>Connect and Sync</Btn>
      <p style={{ fontSize: 10, color: "rgba(255,255,255,0.15)", textAlign: "center", marginTop: 8, fontFamily: FN }}>Credentials encrypted with AES-256, stored only on your device</p>
    </div>
  );

  // ---- SYNCING ----
  const renderSyncing = () => (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 32px", textAlign: "center" }}>
      <div style={{ width: 56, height: 56, borderRadius: 28, background: "rgba(255,107,107,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 26 }}>{"\u26A1"}</div>
      <h2 style={{ fontSize: 22, fontWeight: 900, color: "#faf9f6", margin: "0 0 6px", fontFamily: FN }}>Syncing...</h2>
      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", margin: "0 0 24px", fontFamily: FN }}>Connecting to your mail servers and calendars</p>
      <div style={{ width: "100%", height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)", marginBottom: 20, overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 3, background: "linear-gradient(90deg, #ff6b6b, #ee5a24)", width: syncProgress + "%", transition: "width 0.3s ease" }}/>
      </div>
      <div style={{ textAlign: "left" }}>
        {[
          [syncProgress > 10, "Connecting to IMAP servers..."],
          [syncProgress > 30, "Reading inbox across " + formAccts.filter(a => a.enabled).length + " accounts..."],
          [syncProgress > 50, "Syncing CalDAV calendars..."],
          [syncProgress > 70, "AI analyzing emails, extracting tasks..."],
          [syncProgress > 90, "Building your morning brief..."],
          [syncProgress >= 100, "Ready!"],
        ].map(([show, text], i) => show ? (
          <p key={i} style={{ fontSize: 11, color: syncProgress >= 100 && i === 5 ? "#ff6b6b" : "rgba(255,255,255,0.35)", margin: "0 0 4px", fontFamily: FN, fontWeight: syncProgress >= 100 && i === 5 ? 800 : 500 }}>{"  \u2713 " + text}</p>
        ) : null)}
      </div>
    </div>
  );

  // ---- HOME ----
  const renderHome = () => (
    <div style={{ flex: 1, overflow: "auto", paddingBottom: 105 }}>
      <div style={{ padding: "10px 22px 0" }}>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", fontFamily: FN, margin: 0, letterSpacing: 2, textTransform: "uppercase" }}>Friday, February 14</p>
        <h1 style={{ fontSize: 27, fontWeight: 900, color: "#faf9f6", margin: "3px 0 0", fontFamily: FN }}>Good morning</h1>
        <div style={{ display: "flex", gap: 8, marginTop: 10, marginBottom: 16 }}>
          {accounts.map(a => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "3px 9px" }}>
              <Dot id={a.id}/><span style={{ fontSize: 10, color: a.color, fontWeight: 700, fontFamily: FN }}>{a.label}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Brief */}
      <div style={{ margin: "0 22px 16px", background: "linear-gradient(135deg, rgba(255,107,107,0.06), rgba(238,90,36,0.03))", borderRadius: 16, padding: 16, border: "1px solid rgba(255,107,107,0.1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg, #ff6b6b, #ee5a24)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>{"\u26A1"}</div>
          <div><p style={{ fontSize: 12, fontWeight: 800, color: "#faf9f6", margin: 0, fontFamily: FN }}>Morning Brief</p><p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", margin: 0 }}>Via IMAP + CalDAV at 6:30 AM</p></div>
        </div>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", lineHeight: 1.6, margin: "0 0 12px", fontFamily: FN }}>
          <span style={{ color: "#ff6b6b", fontWeight: 700 }}>3 unread</span> across Acme Corp. Urgent NDA from Diana (EOD). Replies drafted. <span style={{ color: "#fbbf24", fontWeight: 700 }}>Cross-account conflict at 2:30 PM</span> (Acme vs Gmail calendar). <span style={{ color: "#ff6b6b", fontWeight: 700 }}>{openTasks} tasks</span> extracted.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn primary onClick={() => go(S.INBOX)} style={{ padding: "10px 0", fontSize: 12 }}>Review Emails</Btn>
          <Btn onClick={() => go(S.TASKS)} style={{ padding: "10px 0", fontSize: 12 }}>{openTasks + " Tasks"}</Btn>
        </div>
      </div>
      {/* Cortex Intel launcher */}
      <div onClick={() => setPlatform("intel")} style={{ margin: "0 22px 16px", background: "linear-gradient(135deg, rgba(56,189,248,0.08), rgba(167,139,250,0.05))", borderRadius: 16, padding: 16, border: "1px solid rgba(56,189,248,0.15)", cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #38bdf8, #6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>{"🛰️"}</div>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 800, color: "#faf9f6", margin: 0, fontFamily: FN }}>Cortex Intel</p>
            <p style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", margin: "1px 0 0", fontFamily: FN }}>Microsoft 365 threat intelligence platform</p>
          </div>
          <span style={{ fontSize: 18, color: "#38bdf8" }}>{"→"}</span>
        </div>
      </div>
      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, padding: "0 22px", marginBottom: 18 }}>
        {[{ v: unread, l: "Unread", c: "#ff6b6b", s: S.INBOX }, { v: openTasks, l: "Tasks", c: "#fbbf24", s: S.TASKS }, { v: conflicts, l: "Conflicts", c: "#f97316", s: S.CAL }, { v: 3, l: "Accounts", c: "#38bdf8" }].map((x, i) => (
          <div key={i} onClick={() => x.s && go(x.s)} style={{ background: "rgba(255,255,255,0.025)", borderRadius: 11, padding: "12px 8px", cursor: x.s ? "pointer" : "default", border: "1px solid rgba(255,255,255,0.04)", textAlign: "center" }}>
            <p style={{ fontSize: 21, fontWeight: 900, color: x.c, margin: 0, fontFamily: FN }}>{x.v}</p>
            <p style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", margin: "1px 0 0", fontFamily: FN, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{x.l}</p>
          </div>
        ))}
      </div>
      {/* Calendar */}
      <div style={{ display: "flex", justifyContent: "space-between", padding: "0 22px", marginBottom: 8 }}>
        <h2 style={{ fontSize: 15, fontWeight: 800, color: "#faf9f6", margin: 0, fontFamily: FN }}>Today</h2>
        <button onClick={() => go(S.CAL)} style={{ fontSize: 11, color: "#ff6b6b", background: "none", border: "none", cursor: "pointer", fontWeight: 700, fontFamily: FN }}>{"Full day \u2192"}</button>
      </div>
      <div style={{ padding: "0 22px", marginBottom: 18 }}>
        {calEvents.slice(0, 5).map(e => (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
            <div style={{ width: 3, height: 28, borderRadius: 2, background: e.color, flexShrink: 0 }}/><Dot id={e.acct}/>
            <div style={{ flex: 1 }}><p style={{ fontSize: 12.5, fontWeight: 650, color: "#faf9f6", margin: 0, fontFamily: FN }}>{e.title}</p><p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", margin: "1px 0 0" }}>{e.time}</p></div>
            {e.conflict && <span style={{ fontSize: 8, color: "#ff6b6b", fontWeight: 800, background: "rgba(255,107,107,0.1)", padding: "2px 5px", borderRadius: 4 }}>CONFLICT</span>}
          </div>
        ))}
      </div>
      {/* Overnight */}
      <div style={{ padding: "0 22px" }}>
        <h2 style={{ fontSize: 15, fontWeight: 800, color: "#faf9f6", margin: "0 0 8px", fontFamily: FN }}>While You Slept</h2>
        {["\uD83D\uDCEC Triaged 14 emails via IMAP across 3 accounts", "\u2705 " + taskData.length + " tasks extracted from emails", "\uD83D\uDCC5 Cross-account CalDAV conflict detected at 2:30 PM", "\uD83D\uDD14 Follow-up drafted for James (3 days, no reply)"].map((t, i) => (
          <div key={i} style={{ display: "flex", gap: 9, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", margin: 0, lineHeight: 1.45, fontFamily: FN }}>{t}</p>
          </div>
        ))}
      </div>
    </div>
  );

  // ---- INBOX ----
  const renderInbox = () => (
    <div style={{ flex: 1, overflow: "auto", paddingBottom: 105 }}>
      <div style={{ padding: "10px 22px 0" }}>
        <h1 style={{ fontSize: 25, fontWeight: 900, color: "#faf9f6", margin: "0 0 2px", fontFamily: FN }}>All Inboxes</h1>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", margin: "0 0 12px", fontFamily: FN }}>{unread + " unread via IMAP \u00B7 " + accounts.length + " accounts"}</p>
      </div>
      <div style={{ display: "flex", gap: 6, padding: "0 22px", marginBottom: 12 }}>
        {["all", "icloud", "gmail", "work"].map(f => (
          <button key={f} onClick={() => setAF(f)} style={{
            padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: FN, whiteSpace: "nowrap",
            background: aF === f ? "rgba(255,107,107,0.12)" : "rgba(255,255,255,0.03)",
            border: aF === f ? "1px solid rgba(255,107,107,0.2)" : "1px solid rgba(255,255,255,0.05)",
            color: aF === f ? "#ff6b6b" : "rgba(255,255,255,0.3)"
          }}>{f === "all" ? "All" : getLabel(f)}</button>
        ))}
      </div>
      <div style={{ padding: "0 22px" }}>
        {mails.filter(m => aF === "all" || m.acct === aF).map(m => (
          <div key={m.id} onClick={() => go(S.EMAIL, m)} style={{ display: "flex", gap: 10, padding: "12px 0", borderBottom: "1px solid rgba(255,255,255,0.035)", cursor: "pointer", opacity: m.read ? 0.5 : 1 }}>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: m.pri === "high" ? "linear-gradient(135deg, #ff6b6b, #ee5a24)" : "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", color: m.pri === "high" ? "#fff" : "rgba(255,255,255,0.4)", fontSize: 14, fontWeight: 800, fontFamily: FN }}>{m.from[0]}</div>
              <div style={{ position: "absolute", bottom: -2, right: -2 }}><Dot id={m.acct} s={9}/></div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: m.read ? 500 : 800, color: "#faf9f6", fontFamily: FN }}>{m.from}</span>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>{m.time}</span>
              </div>
              <p style={{ fontSize: 12, fontWeight: m.read ? 400 : 700, color: m.read ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.75)", margin: "2px 0", fontFamily: FN, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.subj}</p>
              <div style={{ display: "flex", gap: 5, marginTop: 3 }}>
                <Tag id={m.acct}/>
                {m.reply && <span style={{ fontSize: 8.5, color: "#ff6b6b", fontWeight: 800, background: "rgba(255,107,107,0.08)", padding: "2px 5px", borderRadius: 3 }}>REPLY READY</span>}
                {m.tasks.length > 0 && <span style={{ fontSize: 8.5, color: "#fbbf24", fontWeight: 800, background: "rgba(251,191,36,0.08)", padding: "2px 5px", borderRadius: 3 }}>{m.tasks.length + " TASK" + (m.tasks.length > 1 ? "S" : "")}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ---- EMAIL ----
  const renderEmail = () => {
    if (!mail) return null;
    const m = mail;
    const a = accounts.find(x => x.id === m.acct);
    return (
      <div style={{ flex: 1, overflow: "auto", paddingBottom: 105 }}>
        <div style={{ padding: "0 22px" }}>
          <button onClick={() => go(S.INBOX)} style={{ background: "none", border: "none", color: "#ff6b6b", fontSize: 13, cursor: "pointer", padding: "8px 0", fontFamily: FN, fontWeight: 800 }}>{"< All Inboxes"}</button>
          <div style={{ marginBottom: 6 }}><Tag id={m.acct}/></div>
          <h2 style={{ fontSize: 19, fontWeight: 900, color: "#faf9f6", margin: "4px 0 10px", fontFamily: FN, lineHeight: 1.3 }}>{m.subj}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg, #ff6b6b, #ee5a24)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 800, fontFamily: FN }}>{m.from[0]}</div>
            <div><p style={{ fontSize: 13, fontWeight: 700, color: "#faf9f6", margin: 0, fontFamily: FN }}>{m.from}</p><p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", margin: 0 }}>{m.addr + " \u2192 " + (a ? a.email : "")}</p></div>
          </div>
          <div style={{ background: "rgba(255,255,255,0.025)", borderRadius: 13, padding: 14, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 12 }}>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", lineHeight: 1.65, margin: 0, fontFamily: FN, whiteSpace: "pre-line" }}>{m.body}</p>
          </div>
          {m.tasks.length > 0 && (
            <div style={{ background: "rgba(251,191,36,0.04)", borderRadius: 13, padding: 13, border: "1px solid rgba(251,191,36,0.1)", marginBottom: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 800, color: "#fbbf24", margin: "0 0 8px", fontFamily: FN }}>{"\u2705 Auto-Extracted Tasks"}</p>
              {m.tasks.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: i > 0 ? "1px solid rgba(251,191,36,0.06)" : "none" }}>
                  <div style={{ width: 13, height: 13, borderRadius: 3, border: "1.5px solid rgba(251,191,36,0.25)", flexShrink: 0 }}/>
                  <p style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", margin: 0, fontFamily: FN }}>{t}</p>
                </div>
              ))}
            </div>
          )}
          {m.reply && (
            <div style={{ background: sent[m.id] ? "rgba(52,211,153,0.04)" : "rgba(255,107,107,0.04)", borderRadius: 13, padding: 14, border: sent[m.id] ? "1px solid rgba(52,211,153,0.12)" : "1px solid rgba(255,107,107,0.1)", marginBottom: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 800, color: sent[m.id] ? "#34d399" : "#ff6b6b", margin: "0 0 8px", fontFamily: FN }}>{sent[m.id] ? "\u2713 Sent via IMAP" : "\u26A1 Smart Reply"}<span style={{ fontWeight: 500, color: "rgba(255,255,255,0.15)", marginLeft: 8, fontSize: 10 }}>{"as " + (a ? a.email : "")}</span></p>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", lineHeight: 1.6, margin: "0 0 12px", fontFamily: FN, whiteSpace: "pre-line" }}>{m.reply}</p>
              {!sent[m.id] && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setSent(p => ({ ...p, [m.id]: true }))} style={{ flex: 1, padding: "11px 0", borderRadius: 10, background: "linear-gradient(135deg, #ff6b6b, #ee5a24)", border: "none", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: FN }}>{"Send via " + (a ? a.label : "")}</button>
                  <button style={{ padding: "11px 14px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Edit</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ---- CALENDAR ----
  const renderCal = () => (
    <div style={{ flex: 1, overflow: "auto", paddingBottom: 105 }}>
      <div style={{ padding: "10px 22px 0" }}>
        <h1 style={{ fontSize: 25, fontWeight: 900, color: "#faf9f6", margin: "0 0 2px", fontFamily: FN }}>Calendar</h1>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", margin: "0 0 12px" }}>{"Fri, Feb 14 \u00B7 " + calEvents.length + " events via CalDAV"}</p>
      </div>
      <div style={{ padding: "0 22px", marginBottom: 12 }}>
        <div style={{ background: "rgba(255,107,107,0.04)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,107,107,0.1)" }}>
          <p style={{ fontSize: 13, fontWeight: 800, color: "#faf9f6", margin: "0 0 3px", fontFamily: FN }}>{"\uD83D\uDD00 Cross-Account Conflict"}</p>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 10px", lineHeight: 1.4 }}>
            <span style={{ color: "#f59e0b", fontWeight: 700 }}>Acme Corp</span>{" Product Strategy (2:30) overlaps "}<span style={{ color: "#34d399", fontWeight: 700 }}>Gmail</span>{" TechVentures Call (3:00). Move TechVentures to Wed 3 PM?"}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ padding: "7px 14px", borderRadius: 8, background: "rgba(255,107,107,0.14)", border: "none", color: "#ff6b6b", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Reschedule</button>
            <button style={{ padding: "7px 14px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "none", color: "rgba(255,255,255,0.25)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Dismiss</button>
          </div>
        </div>
      </div>
      <div style={{ padding: "0 22px" }}>
        {calEvents.map(e => (
          <div key={e.id} style={{ display: "flex", gap: 8, marginBottom: 5 }}>
            <div style={{ width: 40, flexShrink: 0, paddingTop: 8, textAlign: "right" }}>
              <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", margin: 0, fontFamily: MN }}>{e.time.split("\u2013")[0]}</p>
            </div>
            <div style={{ width: 3, borderRadius: 2, background: e.color, flexShrink: 0 }}/>
            <div style={{ flex: 1, background: e.conflict ? "rgba(255,107,107,0.04)" : "rgba(255,255,255,0.025)", borderRadius: 10, padding: "8px 11px", border: e.conflict ? "1px solid rgba(255,107,107,0.1)" : "1px solid rgba(255,255,255,0.035)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <p style={{ fontSize: 12.5, fontWeight: 700, color: "#faf9f6", margin: 0, fontFamily: FN }}>{e.title}</p><Dot id={e.acct}/>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 2 }}><span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>{e.time}</span><Tag id={e.acct}/></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ---- TASKS ----
  const renderTasks = () => (
    <div style={{ flex: 1, overflow: "auto", paddingBottom: 105 }}>
      <div style={{ padding: "10px 22px 0" }}>
        <h1 style={{ fontSize: 25, fontWeight: 900, color: "#faf9f6", margin: "0 0 2px", fontFamily: FN }}>Tasks</h1>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", margin: "0 0 12px" }}>{openTasks + " open \u00B7 Auto-extracted from IMAP emails"}</p>
      </div>
      <div style={{ display: "flex", gap: 6, padding: "0 22px", marginBottom: 12 }}>
        {["all", "high", "medium", "low"].map(x => (
          <button key={x} onClick={() => setTF(x)} style={{
            padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: FN, textTransform: "capitalize",
            background: tF === x ? "rgba(255,107,107,0.12)" : "rgba(255,255,255,0.03)",
            border: tF === x ? "1px solid rgba(255,107,107,0.18)" : "1px solid rgba(255,255,255,0.05)",
            color: tF === x ? "#ff6b6b" : "rgba(255,255,255,0.3)"
          }}>{x}</button>
        ))}
      </div>
      <div style={{ padding: "0 22px" }}>
        {(tF === "all" ? taskData : taskData.filter(t => t.p === tF)).map(t => (
          <div key={t.id} onClick={() => setDone(p => ({ ...p, [t.id]: !p[t.id] }))} style={{ display: "flex", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.03)", cursor: "pointer", opacity: done[t.id] ? 0.3 : 1, transition: "opacity 0.2s" }}>
            <div style={{ width: 17, height: 17, borderRadius: 5, border: done[t.id] ? "none" : "2px solid rgba(255,255,255,0.12)", background: done[t.id] ? "#ff6b6b" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
              {done[t.id] && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>{"\u2713"}</span>}
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 12.5, fontWeight: 650, color: "#faf9f6", margin: "0 0 3px", fontFamily: FN, textDecoration: done[t.id] ? "line-through" : "none" }}>{t.t}</p>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}><Tag id={t.acct}/><span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>{t.src}</span><span style={{ fontSize: 10, color: t.due.includes("Today") ? "#fbbf24" : "rgba(255,255,255,0.2)" }}>{t.due}</span></div>
            </div>
            <Pri p={t.p}/>
          </div>
        ))}
      </div>
    </div>
  );

  // ---- AUTO ----
  const renderAuto = () => (
    <div style={{ flex: 1, overflow: "auto", paddingBottom: 105 }}>
      <div style={{ padding: "10px 22px 0" }}>
        <h1 style={{ fontSize: 25, fontWeight: 900, color: "#faf9f6", margin: "0 0 2px", fontFamily: FN }}>Automations</h1>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", margin: "0 0 8px" }}>{"6 active \u00B7 Netlify Scheduled Functions + Claude AI"}</p>
      </div>
      <div style={{ margin: "0 22px 14px", background: "rgba(255,107,107,0.04)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,107,107,0.08)" }}>
        <span style={{ fontSize: 28, fontWeight: 900, color: "#ff6b6b", fontFamily: FN }}>3.5</span>
        <span style={{ fontSize: 12, color: "rgba(255,107,107,0.5)", fontWeight: 700, fontFamily: FN, marginLeft: 6 }}>hrs/week saved</span>
      </div>
      <div style={{ padding: "0 22px" }}>
        {autoData.map(a => (
          <div key={a.id} style={{ background: "rgba(255,255,255,0.025)", borderRadius: 13, padding: 12, marginBottom: 6, border: "1px solid rgba(255,255,255,0.04)" }}>
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ fontSize: 20 }}>{a.icon}</span>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 13, fontWeight: 800, color: "#faf9f6", margin: "0 0 2px", fontFamily: FN }}>{a.name}</p>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", margin: "0 0 4px", lineHeight: 1.4 }}>{a.desc}</p>
                <div style={{ display: "flex", gap: 10 }}>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.18)" }}>{a.sched}</span>
                  <span style={{ fontSize: 10, color: "#ff6b6b" }}>{a.saved}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ---- DEPLOY ----
  const renderDeploy = () => (
    <div style={{ flex: 1, overflow: "auto", paddingBottom: 105 }}>
      <div style={{ padding: "10px 22px 0" }}>
        <h1 style={{ fontSize: 25, fontWeight: 900, color: "#faf9f6", margin: "0 0 2px", fontFamily: FN }}>Deploy to Netlify</h1>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", margin: "0 0 14px" }}>PWA \u2014 No Mac, no Xcode, no App Store</p>
      </div>
      <div style={{ padding: "0 22px" }}>
        {/* Steps */}
        <div style={{ background: "rgba(255,107,107,0.04)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,107,107,0.1)", marginBottom: 10 }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "#ff6b6b", margin: "0 0 5px", fontFamily: FN }}>3 Steps to Your Phone</p>
          {["Deploy to Netlify (handles IMAP, CalDAV, Claude AI)", "Open the Netlify URL on your iPhone in Safari", "Tap Share \u2192 Add to Home Screen"].map((s, i) => (
            <p key={i} style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", margin: "0 0 4px", fontFamily: FN }}>{(i + 1) + ". " + s}</p>
          ))}
        </div>

        {/* Option A: CLI deploy */}
        <div style={{ background: "rgba(255,255,255,0.025)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "#faf9f6", margin: "0 0 4px", fontFamily: FN }}>Option A: CLI Deploy</p>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: "0 0 8px" }}>From any computer (Windows, Mac, Linux)</p>
          <div style={{ background: "rgba(0,0,0,0.35)", borderRadius: 8, padding: 12, fontFamily: MN, fontSize: 10.5, color: "#ff6b6b", lineHeight: 1.7 }}>
            <p style={{ margin: 0, color: "rgba(255,255,255,0.2)" }}># Install Netlify CLI</p>
            <p style={{ margin: 0 }}>npm install -g netlify-cli</p>
            <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.2)" }}># Clone and setup</p>
            <p style={{ margin: 0 }}>git clone https://github.com/you/cortex-pwa</p>
            <p style={{ margin: 0 }}>cd cortex-pwa</p>
            <p style={{ margin: 0 }}>npm install</p>
            <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.2)" }}># Set environment variables</p>
            <p style={{ margin: 0 }}>netlify login</p>
            <p style={{ margin: 0 }}>netlify init</p>
            <p style={{ margin: 0 }}>netlify env:set ANTHROPIC_API_KEY sk-ant-...</p>
            <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.2)" }}># Build and deploy</p>
            <p style={{ margin: 0 }}>netlify deploy --build --prod</p>
            <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.2)" }}># Your site is live at:</p>
            <p style={{ margin: 0 }}>{"# https://cortex-pwa.netlify.app"}</p>
          </div>
        </div>

        {/* Option B: Git push deploy */}
        <div style={{ background: "rgba(255,255,255,0.025)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "#faf9f6", margin: "0 0 4px", fontFamily: FN }}>Option B: Git Push Deploy</p>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: "0 0 8px" }}>Connect repo once, auto-deploys on every push</p>
          <div style={{ marginBottom: 0 }}>
            {[
              "Push code to GitHub / GitLab / Bitbucket",
              "Log in to app.netlify.com \u2192 Add New Site",
              "Select your repo \u2192 Netlify auto-detects build settings",
              "Add environment variables in Site Settings \u2192 Env",
              "Every git push auto-deploys instantly",
            ].map((s, i) => (
              <p key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 4px", fontFamily: FN }}>{(i + 1) + ". " + s}</p>
            ))}
          </div>
        </div>

        {/* Architecture */}
        <div style={{ background: "rgba(255,255,255,0.025)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "#faf9f6", margin: "0 0 8px", fontFamily: FN }}>Netlify Architecture</p>
          {[
            ["Frontend", "React SPA (static build)"],
            ["Backend", "Netlify Functions (serverless)"],
            ["Email", "IMAP via imapflow (in Functions)"],
            ["Calendar", "CalDAV via tsdav (in Functions)"],
            ["AI", "Claude API (Anthropic)"],
            ["Scheduler", "Netlify Scheduled Functions (cron)"],
            ["Auth", "App-specific passwords (encrypted)"],
            ["Storage", "On-device IndexedDB + Netlify Blobs"],
            ["Hosting", "Netlify (free tier: 125K fn/mo)"],
          ].map(([k, v], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: i < 8 ? "1px solid rgba(255,255,255,0.03)" : "none" }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: FN }}>{k}</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontWeight: 650, fontFamily: FN }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Project structure */}
        <div style={{ background: "rgba(255,255,255,0.025)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "#faf9f6", margin: "0 0 8px", fontFamily: FN }}>Project Structure</p>
          <div style={{ background: "rgba(0,0,0,0.35)", borderRadius: 8, padding: 12, fontFamily: MN, fontSize: 10, color: "rgba(255,255,255,0.45)", lineHeight: 1.7 }}>
            <p style={{ margin: 0, color: "#ff6b6b" }}>cortex-pwa/</p>
            <p style={{ margin: 0 }}>  src/                    # React frontend</p>
            <p style={{ margin: 0 }}>  public/manifest.json    # PWA manifest</p>
            <p style={{ margin: 0, color: "#ff6b6b" }}>  netlify/functions/      # Serverless backend</p>
            <p style={{ margin: 0 }}>    fetch-mail.mts         # IMAP inbox fetch</p>
            <p style={{ margin: 0 }}>    send-mail.mts          # SMTP send reply</p>
            <p style={{ margin: 0 }}>    fetch-calendar.mts     # CalDAV sync</p>
            <p style={{ margin: 0 }}>    ai-process.mts         # Claude AI (drafts/tasks)</p>
            <p style={{ margin: 0 }}>    morning-brief.mts      # Scheduled: daily 6:30 AM</p>
            <p style={{ margin: 0 }}>    email-triage.mts       # Scheduled: daily 6:00 AM</p>
            <p style={{ margin: 0 }}>    follow-up.mts          # Scheduled: every 12 hrs</p>
            <p style={{ margin: 0, color: "#ff6b6b" }}>  netlify.toml            # Build + function config</p>
            <p style={{ margin: 0 }}>  .env                    # Local env vars</p>
          </div>
        </div>

        {/* netlify.toml */}
        <div style={{ background: "rgba(255,255,255,0.025)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "#faf9f6", margin: "0 0 8px", fontFamily: FN }}>netlify.toml</p>
          <div style={{ background: "rgba(0,0,0,0.35)", borderRadius: 8, padding: 12, fontFamily: MN, fontSize: 10, color: "#ff6b6b", lineHeight: 1.7 }}>
            <p style={{ margin: 0, color: "rgba(255,255,255,0.25)" }}>[build]</p>
            <p style={{ margin: 0 }}>  command = "npm run build"</p>
            <p style={{ margin: 0 }}>  publish = "build"</p>
            <p style={{ margin: 0 }}>  functions = "netlify/functions"</p>
            <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.25)" }}>[functions]</p>
            <p style={{ margin: 0 }}>  node_bundler = "esbuild"</p>
            <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.25)" }}>{"[[redirects]]"}</p>
            <p style={{ margin: 0 }}>  from = "/api/*"</p>
            <p style={{ margin: 0 }}>  to = "/.netlify/functions/:splat"</p>
            <p style={{ margin: 0 }}>  status = 200</p>
            <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.25)" }}>{"[[headers]]"}</p>
            <p style={{ margin: 0 }}>  for = "/manifest.json"</p>
            <p style={{ margin: 0 }}>  [headers.values]</p>
            <p style={{ margin: 0 }}>  Content-Type = "application/manifest+json"</p>
          </div>
        </div>

        {/* iCloud details */}
        <div style={{ background: "rgba(56,189,248,0.04)", borderRadius: 14, padding: 14, border: "1px solid rgba(56,189,248,0.1)" }}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "#38bdf8", margin: "0 0 6px", fontFamily: FN }}>{"☁\uFE0F iCloud Connection Details"}</p>
          {[
            ["IMAP Server", "imap.mail.me.com:993 (SSL)"],
            ["SMTP Server", "smtp.mail.me.com:587 (TLS)"],
            ["CalDAV Server", "caldav.icloud.com"],
            ["Auth", "Apple ID + App-Specific Password"],
            ["Generate Password", "appleid.apple.com \u2192 Security"],
          ].map(([k, v], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: i < 4 ? "1px solid rgba(56,189,248,0.06)" : "none" }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: FN }}>{k}</span>
              <span style={{ fontSize: 11, color: "#38bdf8", fontWeight: 600, fontFamily: FN }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ---- RENDER ----
  const screens = { [S.SETUP]: renderSetup, [S.CONNECT]: renderConnect, [S.SYNCING]: renderSyncing, [S.HOME]: renderHome, [S.INBOX]: renderInbox, [S.EMAIL]: renderEmail, [S.CAL]: renderCal, [S.TASKS]: renderTasks, [S.AUTO]: renderAuto, [S.DEPLOY]: renderDeploy };
  const showTabs = scr >= S.HOME;
  const tabs = [
    { id: S.HOME, i: "\u26A1", l: "Home" }, { id: S.INBOX, i: "\uD83D\uDCEC", l: "Mail", b: unread }, { id: S.TASKS, i: "\u2705", l: "Tasks", b: openTasks },
    { id: S.CAL, i: "\uD83D\uDCC5", l: "Cal" }, { id: S.AUTO, i: "\uD83E\uDD16", l: "Auto" }, { id: S.DEPLOY, i: "\uD83D\uDE80", l: "Ship" },
  ];

  if (platform === "intel") return <Intel onExit={() => setPlatform("cortex")} />;

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "#08080a", padding: 20, fontFamily: FN }}>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"/>
      <div style={{ width: 393, height: 852, borderRadius: 50, background: "linear-gradient(178deg, #151513 0%, #111110 35%, #0d0d0b 100%)", overflow: "hidden", position: "relative", border: "1px solid rgba(255,255,255,0.05)", boxShadow: "0 50px 100px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.03)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 10 }}><div style={{ width: 126, height: 37, borderRadius: 20, background: "#000" }}/></div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 26px 2px", fontSize: 14, fontWeight: 600, color: "#eee" }}>
          <span style={{ fontFamily: FN }}>9:41</span>
          <div style={{ width: 25, height: 12, border: "1.5px solid rgba(255,255,255,0.4)", borderRadius: 3, padding: 1.5 }}><div style={{ width: "75%", height: "100%", background: "#a3e635", borderRadius: 1.5 }}/></div>
        </div>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", opacity: anim ? 1 : 0, transform: anim ? "translateY(0)" : "translateY(5px)", transition: "all 0.2s ease-out" }}>
          {screens[scr] ? screens[scr]() : null}
        </div>
        {showTabs && (
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "linear-gradient(180deg, transparent 0%, rgba(13,13,11,0.98) 32%)", paddingTop: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-around", padding: "4px 8px 24px" }}>
              {tabs.map(tab => {
                const on = scr === tab.id || (scr === S.EMAIL && tab.id === S.INBOX);
                return (
                  <button key={tab.id} onClick={() => { setScr(tab.id); if (tab.id !== S.INBOX) setMail(null); }}
                    style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, position: "relative", padding: "2px 5px" }}>
                    <span style={{ fontSize: 18, filter: on ? "none" : "grayscale(1) opacity(0.25)", transition: "all 0.2s" }}>{tab.i}</span>
                    <span style={{ fontSize: 9, fontWeight: 750, color: on ? "#ff6b6b" : "rgba(255,255,255,0.15)", fontFamily: FN }}>{tab.l}</span>
                    {tab.b > 0 && <div style={{ position: "absolute", top: -4, right: -4, background: "#ff6b6b", color: "#fff", fontSize: 8.5, fontWeight: 800, minWidth: 15, height: 15, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px" }}>{tab.b}</div>}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "center", paddingBottom: 8 }}><div style={{ width: 134, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.12)" }}/></div>
          </div>
        )}
      </div>
    </div>
  );
}
