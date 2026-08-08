// Return a full conversation in threaded order for the review pane
// (docs/DESIGN.md §7). Read-only. Includes reactions; body HTML is loaded
// from Blob by the client/export path. Access is enforced when a caseId is
// provided; global reads require Platform Admin.
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { requireAuth, Principal } from '../lib/auth';
import { query } from '../lib/db';
import { audit } from '../lib/audit';
import { isPlatformAdmin } from '../lib/rbac';

async function getConversation(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const conversationId = req.params.id;
  const caseId = req.query.get('caseId') || undefined;

  if (caseId) {
    if (!isPlatformAdmin(p)) {
      const acc = await query(`SELECT 1 x FROM dbo.CaseMember WHERE case_id=@cid AND member_oid=@oid`,
        { cid: caseId, oid: p.oid });
      if (acc.recordset.length === 0) return { status: 403, jsonBody: { error: 'No access to this case' } };
    }
  } else if (!isPlatformAdmin(p)) {
    return { status: 403, jsonBody: { error: 'Global conversation read requires Platform Admin' } };
  }

  const conv = await query(`SELECT * FROM dbo.Conversation WHERE conversation_id=@id`, { id: conversationId });
  const msgs = await query(
    `SELECT message_id, reply_to_id, from_oid, from_name, body_text, body_blob_ref,
            message_type, created_at, last_edited_at, deleted_at, content_sha256
     FROM dbo.Message WHERE conversation_id=@id ORDER BY created_at ASC`,
    { id: conversationId }
  );
  const reactions = await query(
    `SELECT r.message_id, r.reaction_type, r.actor_name
     FROM dbo.Reaction r
     JOIN dbo.Message m ON m.message_id = r.message_id
     WHERE m.conversation_id=@id`,
    { id: conversationId }
  );
  await audit(p, { action: 'VIEW_CONVERSATION', targetType: 'Conversation', targetId: conversationId, detail: { caseId } });
  return { status: 200, jsonBody: {
    conversation: conv.recordset[0],
    messages: msgs.recordset,
    reactions: reactions.recordset,
  } };
}

app.http('conversation-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'conversations/{id}', handler: requireAuth(getConversation),
});
