import React, { useEffect, useMemo, useState } from 'react';
import { useMsal, AuthenticatedTemplate, UnauthenticatedTemplate } from '@azure/msal-react';
import { apiScopes } from './authConfig';
import { makeApi } from './api';

export default function App({ msalInstance }) {
  const { instance } = useMsal();
  const api = useMemo(() => makeApi(instance), [instance]);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">CORTEX-PA <span className="tag">Investigative eDiscovery</span></div>
        <AuthenticatedTemplate><SignOut /></AuthenticatedTemplate>
      </header>
      <UnauthenticatedTemplate>
        <div className="signin">
          <h1>Sign in to continue</h1>
          <p>Access is restricted and every action is audited.</p>
          <button className="primary" onClick={() => instance.loginRedirect({ scopes: apiScopes })}>
            Sign in with Microsoft
          </button>
        </div>
      </UnauthenticatedTemplate>
      <AuthenticatedTemplate>
        <Workspace api={api} instance={instance} />
      </AuthenticatedTemplate>
    </div>
  );
}

function SignOut() {
  const { instance } = useMsal();
  return <button className="ghost" onClick={() => instance.logoutRedirect()}>Sign out</button>;
}

function Workspace({ api, instance }) {
  const account = instance.getActiveAccount();
  const roles = account?.idTokenClaims?.roles || [];
  const isAdmin = roles.includes('Platform.Admin');
  const canCreate = isAdmin || roles.includes('Case.Creator');
  const [cases, setCases] = useState([]);
  const [active, setActive] = useState(null);
  const [error, setError] = useState('');

  const refresh = () => api.listCases().then(setCases).catch(e => setError(String(e)));
  useEffect(() => { refresh(); }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="side-head">
          <span>Cases</span>
          {canCreate && <NewCaseButton api={api} onCreated={refresh} />}
        </div>
        {cases.map(c => (
          <button key={c.case_id} className={`case-item ${active?.case_id === c.case_id ? 'sel' : ''}`}
                  onClick={() => setActive(c)}>
            <div className="codename">{c.project_codename}</div>
            <div className="casenum">{c.case_number} · {c.status}</div>
            {c.update_count > 0 && <span className="bell" title="New items collected">🔔 {c.update_count}</span>}
          </button>
        ))}
        {isAdmin && <AuditLink api={api} />}
      </aside>
      <main className="content">
        {error && <div className="err">{error}</div>}
        {active ? <CaseView api={api} caseRow={active} isAdmin={isAdmin} />
                : <div className="empty">Select or create a case to begin.</div>}
      </main>
    </div>
  );
}

function NewCaseButton({ api, onCreated }) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const create = async () => {
    await api.createCase({ descriptionHtml: desc, custodians: [] });
    setOpen(false); setDesc(''); onCreated();
  };
  if (!open) return <button className="mini" onClick={() => setOpen(true)}>+ New</button>;
  return (
    <div className="modal">
      <h3>New case</h3>
      <p className="hint">A random codename and immutable case number are assigned automatically.</p>
      <textarea placeholder="Rich-text case description…" value={desc} onChange={e => setDesc(e.target.value)} />
      <div className="row">
        <button className="primary" onClick={create}>Create</button>
        <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function CaseView({ api, caseRow, isAdmin }) {
  const [detail, setDetail] = useState(null);
  const [results, setResults] = useState([]);
  const [conv, setConv] = useState(null);
  const [term, setTerm] = useState('');

  useEffect(() => { api.getCase(caseRow.case_id).then(setDetail); setConv(null); setResults([]); }, [caseRow.case_id]);

  const doSearch = async (e) => {
    e.preventDefault();
    const r = await api.search({ caseId: caseRow.case_id, topic: term });
    setResults(r);
  };
  const openConv = async (id) => setConv(await api.getConversation(id, caseRow.case_id));

  return (
    <div className="caseview">
      <div className="case-header">
        <h2>{caseRow.project_codename}</h2>
        <div className="casenum">{caseRow.case_number}</div>
      </div>

      <CollectPanel api={api} caseId={caseRow.case_id} />

      <form className="searchbar" onSubmit={doSearch}>
        <input placeholder="Search within case — name, topic, team, channel…" value={term} onChange={e => setTerm(e.target.value)} />
        <button className="primary">Search</button>
      </form>

      <div className="split">
        <div className="results">
          {results.map(r => (
            <button key={r.conversation_id} className="result" onClick={() => openConv(r.conversation_id)}>
              <div>{r.channel_name || r.topic || r.conversation_id}</div>
              <div className="sub">{r.source_type} · {r.hit_count} hits</div>
            </button>
          ))}
          {results.length === 0 && <div className="empty small">No results yet.</div>}
        </div>
        <div className="reader">
          {conv ? <Conversation api={api} caseId={caseRow.case_id} data={conv} /> : <div className="empty small">Select a conversation.</div>}
        </div>
      </div>
    </div>
  );
}

function CollectPanel({ api, caseId }) {
  const [term, setTerm] = useState('');
  const [cont, setCont] = useState(false);
  const [attest, setAttest] = useState(false);
  const [msg, setMsg] = useState('');
  const ATTESTATION = "I confirm that the collection of this user's chats has been authorized by legal and is required for an investigation.";

  const run = async () => {
    setMsg('Collecting…');
    try {
      const r = await api.collect(caseId, { userTerm: term, continueCollecting: cont, attestationAccepted: cont ? attest : undefined });
      setMsg(`Collected ${r.collected} messages${r.continueCollecting ? ' · continuous collection enabled' : ''}.`);
    } catch (e) { setMsg(String(e)); }
  };

  return (
    <div className="collect">
      <input placeholder="Add custodian by name / email / UPN / SAM…" value={term} onChange={e => setTerm(e.target.value)} />
      <label className="chk"><input type="checkbox" checked={cont} onChange={e => { setCont(e.target.checked); if (!e.target.checked) setAttest(false); }} /> Continue collecting chat data</label>
      {cont && (
        <label className="chk attest"><input type="checkbox" checked={attest} onChange={e => setAttest(e.target.checked)} /> {ATTESTATION}</label>
      )}
      <button className="primary" disabled={!term || (cont && !attest)} onClick={run}>Add chats to case</button>
      {msg && <span className="hint">{msg}</span>}
    </div>
  );
}

function Conversation({ api, caseId, data }) {
  const [mode, setMode] = useState('teams'); // 'teams' | 'imessage'
  const { conversation, messages, reactions } = data;
  const rx = useMemo(() => {
    const map = {}; (reactions || []).forEach(r => { (map[r.message_id] ||= []).push(r); }); return map;
  }, [reactions]);

  const doExport = async (scope) => {
    const html = await api.exportConversation({ caseId, conversationId: conversation.conversation_id, format: 'html', scope });
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${conversation.conversation_id}.html`; a.click();
  };

  return (
    <div>
      <div className="reader-head">
        <div className="modes">
          <button className={mode === 'teams' ? 'sel' : ''} onClick={() => setMode('teams')}>Teams threaded</button>
          <button className={mode === 'imessage' ? 'sel' : ''} onClick={() => setMode('imessage')}>Messages view</button>
        </div>
        <div className="exports">
          <span className="hint">Export:</span>
          <button className="mini" onClick={() => doExport('all')}>All</button>
          <button className="mini" onClick={() => doExport('range')}>Range</button>
          <button className="mini" title="Word/Excel are the next build step">Word / Excel*</button>
        </div>
      </div>
      <div className={`thread ${mode}`}>
        {messages.map(m => (
          <div key={m.message_id} className={`bubble ${m.reply_to_id ? 'reply' : ''}`}>
            <div className="bmeta"><b>{m.from_name || 'Unknown'}</b>
              <span className="time">{fmt(m.created_at)}</span>
              {m.deleted_at && <span className="badge del">Deleted</span>}
              {m.last_edited_at && <span className="badge edit">Edited</span>}
            </div>
            <div className="btext">{m.deleted_at ? <em>This message was deleted.</em> : m.body_text}</div>
            {(rx[m.message_id] || []).length > 0 && (
              <div className="rx">{rx[m.message_id].map((r, i) => <span key={i} className="chip">{r.reaction_type}</span>)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditLink({ api }) {
  const openAudit = async (format) => {
    const out = await api.audit(`format=${format}`);
    const blob = new Blob([out], { type: format === 'csv' ? 'text/csv' : 'text/html' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `cortex-audit.${format}`; a.click();
  };
  return (
    <div className="audit">
      <div className="side-head"><span>Audit log (admin)</span></div>
      <button className="mini" onClick={() => openAudit('html')}>Export HTML</button>
      <button className="mini" onClick={() => openAudit('csv')}>Export CSV</button>
    </div>
  );
}

const fmt = (s) => (s ? new Date(s).toLocaleString() : '');
