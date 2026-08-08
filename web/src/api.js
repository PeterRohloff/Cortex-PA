// Thin API client. Acquires an access token silently and attaches it to
// every request to the private Function API.
import { apiScopes, API_BASE } from './authConfig';

export function makeApi(msalInstance) {
  async function token() {
    const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
    const res = await msalInstance.acquireTokenSilent({ scopes: apiScopes, account });
    return res.accessToken;
  }
  async function req(path, options = {}) {
    const t = await token();
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}`, ...(options.headers || {}) },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }
  return {
    listCases: () => req('/cases'),
    createCase: (body) => req('/cases', { method: 'POST', body: JSON.stringify(body) }),
    getCase: (id) => req(`/cases/${id}`),
    updateCase: (id, body) => req(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    addMember: (id, body) => req(`/cases/${id}/members`, { method: 'POST', body: JSON.stringify(body) }),
    search: (body) => req('/search', { method: 'POST', body: JSON.stringify(body) }),
    getConversation: (id, caseId) => req(`/conversations/${id}?caseId=${caseId}`),
    collect: (id, body) => req(`/cases/${id}/collect`, { method: 'POST', body: JSON.stringify(body) }),
    audit: (qs) => req(`/audit?${qs}`),
    // Exports return binary (docx/xlsx) or html — fetch as a blob and hand back
    // the download filename from the content-disposition header.
    exportBlob: async (body) => {
      const t = await token();
      const res = await fetch(`${API_BASE}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename="?([^"]+)"?/);
      return { blob: await res.blob(), filename: m ? m[1] : 'export' };
    },
  };
}
