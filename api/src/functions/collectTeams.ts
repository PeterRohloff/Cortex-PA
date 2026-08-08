// Teams collection into a case (docs/DESIGN.md §4, §8.2, §8.3).
//   - Backfill a custodian's chat history via the Teams Export API.
//   - Enable continuous silent collection ONLY behind the legal-authorization
//     attestation, which is recorded to the audit log and the subscription row.
// Owner (or Platform Admin) only.
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { createHash } from 'crypto';
import { requireAuth, Principal } from '../lib/auth';
import { query } from '../lib/db';
import { audit } from '../lib/audit';
import { assertCaseAccess, Forbidden } from '../lib/rbac';
import { findUser, getAllUserChatMessages } from '../lib/graph';

const ATTESTATION = "I confirm that the collection of this user's chats has been authorized by legal and is required for an investigation.";

interface CollectBody {
  userOid?: string;
  userTerm?: string;             // display name / email / upn / sam
  from?: string; to?: string;
  continueCollecting?: boolean;
  attestationAccepted?: boolean; // must be true to enable continuous collection
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function upsertMessage(caseId: string, addedBy: string, m: any): Promise<void> {
  const convId: string = m.chatId || m.channelIdentity?.channelId || 'unknown';
  const source = m.channelIdentity ? 'Channel' : 'Group';
  await query(
    `MERGE dbo.Conversation AS t USING (SELECT @id AS conversation_id) s ON t.conversation_id=s.conversation_id
     WHEN NOT MATCHED THEN INSERT (conversation_id, source_type, channel_id) VALUES (@id, @src, @chan);`,
    { id: convId, src: source, chan: m.channelIdentity?.channelId ?? null }
  );
  const bodyContent: string = m.body?.content ?? '';
  await query(
    `MERGE dbo.Message AS t USING (SELECT @mid AS message_id) s ON t.message_id=s.message_id
     WHEN MATCHED THEN UPDATE SET body_text=@bt, last_edited_at=@edit, deleted_at=@del, content_sha256=@hash
     WHEN NOT MATCHED THEN INSERT (message_id, conversation_id, reply_to_id, from_oid, from_name,
        body_text, message_type, created_at, last_edited_at, deleted_at, content_sha256)
       VALUES (@mid, @conv, @reply, @foid, @fname, @bt, @mtype, @created, @edit, @del, @hash);`,
    {
      mid: m.id, conv: convId, reply: m.replyToId ?? null,
      foid: m.from?.user?.id ?? null, fname: m.from?.user?.displayName ?? null,
      bt: bodyContent, mtype: m.messageType ?? 'message',
      created: m.createdDateTime ?? null, edit: m.lastEditedDateTime ?? null,
      del: m.deletedDateTime ?? null, hash: sha(bodyContent),
    }
  );
  for (const r of (m.reactions ?? [])) {
    await query(
      `INSERT INTO dbo.Reaction (message_id, reaction_type, actor_oid, created_at)
       VALUES (@mid, @rt, @actor, @at)`,
      { mid: m.id, rt: r.reactionType, actor: r.user?.user?.id ?? null, at: r.createdDateTime ?? null }
    );
  }
  await query(
    `MERGE dbo.CaseMessage AS t USING (SELECT @cid AS case_id, @mid AS message_id) s
       ON t.case_id=s.case_id AND t.message_id=s.message_id
     WHEN NOT MATCHED THEN INSERT (case_id, message_id, added_by_oid) VALUES (@cid, @mid, @by);`,
    { cid: caseId, mid: m.id, by: addedBy }
  );
}

async function collect(p: Principal, req: HttpRequest): Promise<HttpResponseInit> {
  const caseId = req.params.id;
  try { await assertCaseAccess(p, caseId, 'own'); }
  catch (e) { if (e instanceof Forbidden) { await audit(p, { action: 'COLLECT', targetId: caseId, result: 'Denied' }); return { status: 403, jsonBody: { error: e.message } }; } throw e; }

  const b = (await req.json()) as CollectBody;

  // Resolve custodian.
  let userOid = b.userOid;
  if (!userOid && b.userTerm) {
    const users = await findUser(b.userTerm);
    if (!users.length) return { status: 404, jsonBody: { error: 'No matching user' } };
    userOid = users[0].id;
  }
  if (!userOid) return { status: 400, jsonBody: { error: 'userOid or userTerm required' } };

  // Continuous collection requires the legal attestation.
  if (b.continueCollecting) {
    if (b.attestationAccepted !== true) {
      return { status: 400, jsonBody: { error: 'Legal-authorization attestation required', attestationText: ATTESTATION } };
    }
    await audit(p, { action: 'LEGAL_ATTESTATION', targetType: 'Case', targetId: caseId,
      detail: { userOid, attestation: ATTESTATION } });
    await query(`UPDATE dbo.[Case] SET continue_collecting=1 WHERE case_id=@cid`, { cid: caseId });
    // Record intent; the actual Graph change-notification subscription is created
    // by the subscription manager (needs the public notify URL + KV cert) — see
    // graphNotifications.ts and runbook §7. Recorded here for traceability.
    await query(
      `INSERT INTO dbo.CollectionSubscription (subscription_id, case_id, resource, authorized_by_oid, authorized_by_name)
       VALUES (@sid, @cid, @res, @oid, @name)`,
      { sid: `pending-${caseId}-${userOid}`, cid: caseId, res: '/chats/getAllMessages', oid: p.oid, name: p.name ?? null }
    );
  }

  // Backfill.
  let count = 0;
  for await (const page of getAllUserChatMessages(userOid, { from: b.from, to: b.to })) {
    for (const m of page) { await upsertMessage(caseId, p.oid, m); count++; }
  }
  await query(`UPDATE dbo.[Case] SET update_count = update_count + @n WHERE case_id=@cid`, { n: count, cid: caseId });
  await audit(p, { action: 'COLLECT_BACKFILL', targetType: 'Case', targetId: caseId, detail: { userOid, count, from: b.from, to: b.to } });

  return { status: 200, jsonBody: { collected: count, continueCollecting: !!b.continueCollecting } };
}

app.http('collect-teams', {
  methods: ['POST'], authLevel: 'anonymous', route: 'cases/{id}/collect', handler: requireAuth(collect),
});
