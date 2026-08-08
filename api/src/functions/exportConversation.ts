// Export a conversation (docs/DESIGN.md §12). HTML is fully implemented and
// self-contained; Word/Excel are stubbed with a clear 501 until wired to
// OpenXML/xlsx writers. Scope: all | range | selected message ids. Every
// export is written to the immutable 'exports' container and audited.
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { requireAuth, Principal } from '../lib/auth';
import { query } from '../lib/db';
import { audit } from '../lib/audit';
import { assertCaseAccess, Forbidden } from '../lib/rbac';
import { renderConversationHtml, ExportMessage, ExportMeta } from '../lib/export/html';

interface ExportBody {
  caseId: string;
  conversationId: string;
  format: 'html' | 'word' | 'excel';
  scope: 'all' | 'range' | 'selected';
  from?: string; to?: string;
  messageIds?: string[];
}

async function exportConversation(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const b = (await req.json()) as ExportBody;
  try { await assertCaseAccess(p, b.caseId, 'view'); }   // Members may export
  catch (e) { if (e instanceof Forbidden) return { status: 403, jsonBody: { error: e.message } }; throw e; }

  // Build the message set per scope.
  const where: string[] = ['m.conversation_id=@conv'];
  const params: Record<string, any> = { conv: b.conversationId };
  if (b.scope === 'range') {
    if (b.from) { where.push('m.created_at >= @from'); params.from = b.from; }
    if (b.to)   { where.push('m.created_at <= @to');   params.to = b.to; }
  } else if (b.scope === 'selected' && b.messageIds?.length) {
    const list = b.messageIds.map((_, i) => `@mid${i}`).join(',');
    b.messageIds.forEach((m, i) => (params[`mid${i}`] = m));
    where.push(`m.message_id IN (${list})`);
  }
  const rows = await query(
    `SELECT m.message_id, m.reply_to_id, m.from_name, m.body_text, m.created_at,
            m.last_edited_at, m.deleted_at, m.content_sha256
     FROM dbo.Message m WHERE ${where.join(' AND ')} ORDER BY m.created_at ASC`,
    params
  );

  if (b.format !== 'html') {
    // Word/Excel writers are the next implementation step (design §12).
    return { status: 501, jsonBody: { error: `${b.format} export not yet implemented; HTML is available.` } };
  }

  const caseRow = await query(`SELECT case_number, project_codename FROM dbo.[Case] WHERE case_id=@cid`, { cid: b.caseId });
  const conv = await query(`SELECT team_name, channel_name, topic FROM dbo.Conversation WHERE conversation_id=@c`, { c: b.conversationId });
  const rx = await query(`SELECT message_id, reaction_type, actor_name FROM dbo.Reaction WHERE message_id IN
     (SELECT message_id FROM dbo.Message WHERE conversation_id=@c)`, { c: b.conversationId });
  const rxByMsg = new Map<string, any[]>();
  for (const r of rx.recordset) { const a = rxByMsg.get(r.message_id) || []; a.push(r); rxByMsg.set(r.message_id, a); }

  const messages: ExportMessage[] = rows.recordset.map((m: any) => ({
    message_id: m.message_id, reply_to_id: m.reply_to_id, from_name: m.from_name,
    body_html: m.body_text ? `<p>${String(m.body_text)}</p>` : '', // TODO: load sanitized HTML from Blob body_blob_ref
    created_at: m.created_at?.toISOString?.() ?? m.created_at,
    last_edited_at: m.last_edited_at, deleted_at: m.deleted_at, content_sha256: m.content_sha256,
    reactions: rxByMsg.get(m.message_id) ?? [],
  }));

  const meta: ExportMeta = {
    caseNumber: caseRow.recordset[0]?.case_number ?? '',
    projectCodename: caseRow.recordset[0]?.project_codename ?? '',
    conversationLabel: conv.recordset[0]?.channel_name || conv.recordset[0]?.topic || b.conversationId,
    generatedByName: p.name ?? p.upn ?? p.oid,
    generatedAtIso: new Date().toISOString(),
    scope: b.scope === 'range' ? `Range ${b.from ?? ''}–${b.to ?? ''}` :
           b.scope === 'selected' ? `Selected (${messages.length})` : 'All',
  };
  const html = renderConversationHtml(messages, meta);

  // Persist a read-only copy to the immutable exports container.
  try {
    const account = process.env.DATA_STORAGE_ACCOUNT!;
    const svc = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
    const container = svc.getContainerClient('exports');
    const name = `${meta.caseNumber}/${b.conversationId}-${Date.now()}.html`;
    await container.getBlockBlobClient(name).upload(html, Buffer.byteLength(html), {
      blobHTTPHeaders: { blobContentType: 'text/html' },
    });
    await audit(p, { action: 'EXPORT', targetType: 'Conversation', targetId: b.conversationId,
      detail: { format: b.format, scope: b.scope, blob: name, count: messages.length } });
  } catch (e) {
    await audit(p, { action: 'EXPORT', targetType: 'Conversation', targetId: b.conversationId, result: 'Error', detail: { message: String(e) } });
  }

  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
}

app.http('export-conversation', {
  methods: ['POST'], authLevel: 'anonymous', route: 'export', handler: requireAuth(exportConversation),
});
