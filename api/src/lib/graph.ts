// Microsoft Graph access for collection (docs/DESIGN.md §4).
// App-only auth via the Function's managed identity — the identity's service
// principal is granted the Graph app roles (Chat.Read.All, ChannelMessage.Read.All,
// User.Read.All) with admin consent (see runbook §6). No client secret.

import { DefaultAzureCredential } from '@azure/identity';

const credential = new DefaultAzureCredential();
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function token(): Promise<string> {
  const t = await credential.getToken('https://graph.microsoft.com/.default');
  return t!.token;
}

// Exposed for the subscription manager (create/renew subscriptions).
export const getGraphToken = token;
export const GRAPH_BASE = GRAPH;

async function graphGet(url: string): Promise<any> {
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    headers: { authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return res.json();
}

// Resolve a person by any of: display name, email/UPN, or sam account name.
export async function findUser(term: string): Promise<any[]> {
  const t = encodeURIComponent(term);
  const filter =
    `startswith(displayName,'${t}') or mail eq '${term}' or ` +
    `userPrincipalName eq '${term}' or onPremisesSamAccountName eq '${term}'`;
  const data = await graphGet(
    `/users?$filter=${encodeURIComponent(filter)}` +
    `&$select=id,displayName,userPrincipalName,mail,onPremisesSamAccountName&$top=25`
  );
  return data.value ?? [];
}

// Teams Export API: all chat messages for a user (backfill), page through.
// Supports date-range + per-user filters (design §4.1). Yields message pages.
export async function* getAllUserChatMessages(
  userId: string,
  opts: { from?: string; to?: string } = {}
): AsyncGenerator<any[]> {
  const filters: string[] = [];
  if (opts.from) filters.push(`lastModifiedDateTime gt ${opts.from}`);
  if (opts.to) filters.push(`lastModifiedDateTime lt ${opts.to}`);
  const q = filters.length ? `?$top=250&$filter=${encodeURIComponent(filters.join(' and '))}` : '?$top=250';
  let url: string | null = `/users/${userId}/chats/getAllMessages${q}`;
  while (url) {
    const page: any = await graphGet(url);
    yield page.value ?? [];
    url = page['@odata.nextLink'] ?? null;
  }
}

// Cached user photo (avatar) as a data URI, or null when none is set.
export async function getUserPhotoDataUri(userId: string): Promise<string | null> {
  const res = await fetch(`${GRAPH}/users/${userId}/photo/$value`, {
    headers: { authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'image/jpeg';
  return `data:${ct};base64,${buf.toString('base64')}`;
}
